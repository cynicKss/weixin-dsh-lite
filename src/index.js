// dsh-plugin-weixin-lite: a WeChat remote control for DeepSeek Harness.
//
// Scope on purpose: one account, bound sessions only. A WeChat conversation is
// attached to one DSH session (/bind), messages drive that session, and its
// replies plus plan reviews, approvals and files come back to WeChat.
//
// What is deliberately absent from this fork: companion persona, memory,
// reminders, digests, stickers, ASR, OCR, group chat, multi-account, backups,
// metrics and the maintenance surface. Those belong to the desktop plugin; the
// lite channel is the phone-side pipe.
import fs from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { allowlistForAccount, enrolFirstContact, isAccountPaused, readRegistry, touchAccount } from './account-registry.js'
import { AgentBridge, isMissingSessionError } from './agent-bridge.js'
import { BindingStore, bindingsFile } from './bindings.js'
import { ILinkTransport } from './transport/ilink.js'
import { MessageDeduper } from './message/dedupe.js'
import { createOutbox } from './message/outbox.js'
import { isAllowedSender } from './security/allowlist.js'
import { isBindSelectionCommand, isInterruptCommand, scopedLineKey } from './sessions.js'
import { configureOutbound, sendChunked, sendFile } from './outbound.js'
import { WeixinLiteController } from './remote.js'
import {
  createFileIndex,
  describeFiles,
  FILE_LOOKBACK_MS,
  FILE_MAX_ENTRIES,
  filesFile,
  filterFileEntries,
  formatBytes,
  mergeFileEntries,
  parseFileExtensions,
  scanRecentFiles,
} from './files.js'
import { createPlanReviewBroker, listPlanFiles, plansDir } from './plan-review.js'
import { describePlanSet, parsePlanCommand } from './plan-command.js'
import { createApprovalBroker } from './approval-review.js'
import { saveNativeImages } from './inbound-images.js'
import {
  DEFAULT_CDN_BASE_URL,
  DEFAULT_MAX_INBOUND_MEDIA_BYTES,
  describeInboundMedia,
  describeMediaFailures,
  downloadInboundMedia,
  downloadInboundVoice,
} from './media/inbound.js'
import { neutralizeTags } from './message/fence.js'
import { configureWeixinStateDir, ensureSessionsDir, withSavedConfig } from './state.js'

export const name = 'dsh-plugin-weixin-lite'
export const inject = ['agents']

const DEFAULT_MAX_QUEUE = 32

export const Config = z.object({
  enabled: z.boolean().default(true).description('Listen on the saved Weixin account.'),
  accountId: z.string().default('').description('Account id to serve; empty serves the first saved account.'),
  cwd: z.string().default('').description('Working directory for sessions created by this plugin; empty inherits the Weixin sessions dir.'),
  allowedSenders: z.array(z.string()).default([]).description('Weixin sender ids allowed to drive the agent. Empty denies everyone.'),
  allowedChats: z.array(z.string()).default([]).description('Conversation ids allowed to reach the agent. Empty allows every chat.'),
  maxMessageLength: z.number().min(1).max(10_000).default(1500).description('Maximum characters per outbound message.'),
  markdownMode: z.union([z.const('strip'), z.const('off')]).default('strip').description('Strip markdown before sending (off keeps it verbatim).'),
  mediaEnabled: z.boolean().default(true).description('Download inbound images and files.'),
  nativeImageInput: z.boolean().default(true).description('Send inbound images as native image blocks when the host can store them.'),
  maxMediaBytes: z.number().min(1).default(100 * 1024 * 1024).description('Largest outbound file.'),
  maxInboundMediaBytes: z.number().min(1).default(DEFAULT_MAX_INBOUND_MEDIA_BYTES).description('Largest inbound download.'),
  busyMessageMode: z.union([z.const('queue'), z.const('steer')]).default('queue').description('What a message does while the bound session is busy.'),
  progressAfterMs: z.number().min(0).max(60000).default(45000).description('Send a progress note after a turn runs this long.'),
  maxTurnWaitMs: z.number().min(1000).max(3_600_000).default(1_200_000).description('How long to wait for the agent reply.'),
  eventPollMs: z.number().min(0).max(60000).default(1000).description('Session event poll interval.'),
  sendIntervalMs: z.number().min(0).default(1200).description('Minimum gap between outbound messages.'),
  sendCooldownMs: z.number().min(0).default(60_000).description('Pause after Weixin rate-limits the account.'),
  cdnBaseUrl: z.string().default('').description('Override the Weixin CDN base URL; empty uses the account value.'),
  bindEnabled: z.boolean().default(true).description('Allow /bind and /unbind.'),
  bindIdleWaitMs: z.number().min(60_000).max(3_600_000).default(600_000).description('How long a bound message waits for the session to become idle.'),
  planReviewInWechat: z.boolean().default(true).description('Send plan reviews to WeChat and accept approve/reject replies.'),
  planReviewWaitMs: z.number().min(0).max(3_600_000).default(0).description('Give up waiting for a WeChat verdict after this long; 0 waits until the turn is cancelled.'),
  planReviewGuiHandoffMs: z.number().min(0).max(3_600_000).default(0).description('Hand a plan review to the desktop GUI after this long; 0 keeps it WeChat-only.'),
  approvalInWechat: z.boolean().default(true).description('Ask for dangerous-operation approval in WeChat.'),
  approvalGuiHandoffMs: z.number().min(0).max(3_600_000).default(0).description('Hand an approval to the desktop GUI after this long; 0 keeps it WeChat-only.'),
  autoSendFiles: z.boolean().default(false).description('Send files the agent produced after each turn (the /files index records them either way).'),
  locale: z.union([z.const('zh'), z.const('en')]).default('zh').description('Locale for fixed replies.'),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 */
export function apply(ctx, config) {
  const stateRoot = configureWeixinStateDir()
  config = withSavedConfig(config ?? {})
  const live = () => withSavedConfig(config)
  const log = (line) => ctx.logger?.info?.(`dsh-weixin-lite: ${line}`)
  const warn = (line) => ctx.logger?.warn?.(`dsh-weixin-lite: ${line}`)
  const bindings = new BindingStore({ file: bindingsFile(stateRoot), warn })
  const fileIndex = createFileIndex({ file: filesFile(stateRoot), warn })

  const runtime = {
    transports: new Map(),
    accounts: [],
    errors: new Map(),
    cwd: '',
    rearm: async () => {},
  }
  const controller = new WeixinLiteController(ctx, { stateRoot, config: live, bindings, fileIndex, runtime, warn })

  ctx.effect(() => {
    let stopped = false
    let bridge
    let cwd = ''
    const seen = new Map()

    /**
     * WeChat can answer a plan review or an approval for a turn it did not
     * start (the desktop did). `deliver()` is normally what sends a turn's
     * reply back; with no delivery in flight that text would stay on the
     * desktop, so the channel follows the turn itself once it settles.
     */
    const mirrorAfterSettle = ({ key, request, outcome, verdict }) => {
      if (outcome !== undefined && outcome !== 'allowed-once' && outcome !== 'rejected') return
      if (verdict !== undefined && verdict?.kind !== 'approve') return
      void (async () => {
        const entry = bindings.getByKey(key)
        if (entry === undefined || bridge === undefined) return
        // A WeChat-delivered turn owns its reply; mirroring it again would
        // send the same text twice.
        if (bridge.isBusyFor(entry.sessionId) === true) return
        let sinceSeq = -1
        try {
          const record = await bridge.attach('', '', { sessionId: entry.sessionId, bound: true })
          const events = record.agent?.session?.snapshotEvents?.() ?? []
          const approvalId = typeof request?.id === 'string' ? request.id : ''
          const callId =
            typeof request?.callId === 'string'
              ? request.callId
              : typeof request?.questions?.[0]?.intent?.callId === 'string'
                ? request.questions[0].intent.callId
                : ''
          const marker = events.find(
            (event) =>
              (approvalId !== '' && event?.type === 'approval/asked' && event?.data?.id === approvalId) ||
              (callId !== '' && event?.type === 'tool/call' && event?.data?.callId === callId),
          )
          const lastSeq = typeof events.at(-1)?.seq === 'number' ? events.at(-1).seq : -1
          sinceSeq = typeof marker?.seq === 'number' ? marker.seq : lastSeq
        } catch (error) {
          warn(`could not locate the reviewed turn: ${String(error?.message ?? error)}`)
          return
        }
        const result = await bridge.awaitTurnReply({
          sessionId: entry.sessionId,
          sinceSeq,
          timeoutMs: Math.max(60_000, live().maxTurnWaitMs ?? 1_200_000),
        })
        if (result === undefined) return
        const text =
          typeof result.turnError === 'string' && result.turnError !== ''
            ? `（审批之后这一轮报错：${result.turnError}）`
            : result.text
        if (String(text ?? '').trim() === '') return
        const transport = runtime.transports.get(entry.accountId) ?? runtime.transports.values().next().value
        if (transport === undefined) return
        await sendChunked(transport, live(), { conversationId: entry.conversationId, text })
        log(`mirrored the settled turn's reply to WeChat for ${key}`)
      })().catch((error) => warn(`mirroring the settled turn failed: ${String(error?.message ?? error)}`))
    }

    const planReviews = createPlanReviewBroker({
      stateRoot,
      bindings,
      transportFor: (id) => runtime.transports.get(id),
      fallbackTransport: () => runtime.transports.values().next().value,
      sendText: (transport, conversationId, text) => sendChunked(transport, live(), { conversationId, text }),
      sendFile: (params) =>
        sendFile(params.transport, { conversationId: params.conversationId, filePath: params.filePath, caption: params.caption }),
      readEnabled: () => live().planReviewInWechat !== false,
      readMediaEnabled: () => live().mediaEnabled !== false,
      readWaitMs: () => live().planReviewWaitMs,
      readGuiHandoffMs: () => live().planReviewGuiHandoffMs,
      onSettled: mirrorAfterSettle,
      warn,
      log,
    })
    const approvals = createApprovalBroker({
      bindings,
      transportFor: (id) => runtime.transports.get(id),
      fallbackTransport: () => runtime.transports.values().next().value,
      sendText: (transport, conversationId, text) => sendChunked(transport, live(), { conversationId, text }),
      readEnabled: () => live().approvalInWechat !== false,
      readGuiHandoffMs: () => live().approvalGuiHandoffMs,
      onSettled: mirrorAfterSettle,
      warn,
      log,
    })
    ctx.on('user-questions/request', (request, next) => planReviews.handleRequest(request, next), { prepend: true })
    ctx.on('approval/request', (request, next) => approvals.handleRequest(request, next), { prepend: true })

    const outbox = createOutbox({
      stateRoot,
      transportFor: (id) => runtime.transports.get(id),
      warn,
      log,
    })
    configureOutbound({ outbox, warn })
    outbox.start()

    const sendText = async (transport, conversationId, text, contextToken) => {
      await sendChunked(transport, live(), { conversationId, text, ...(contextToken === undefined ? {} : { contextToken }) })
    }

    const setup = (async () => {
      cwd = await resolveCwd(ctx, live(), warn)
      runtime.cwd = cwd
      bridge = new AgentBridge({
        ctx,
        cwd,
        log,
        errLog: warn,
        progressAfterMs: live().progressAfterMs,
        maxWaitMs: live().maxTurnWaitMs,
        eventPollMs: live().eventPollMs,
        bindings,
        bindConfig: () => ({ enabled: live().bindEnabled !== false, idleWaitMs: live().bindIdleWaitMs }),
        chatRoute: () => {
          try {
            const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
            if (selection === undefined || selection === null) return undefined
            return { provider: selection.provider, model: selection.model }
          } catch {
            return undefined
          }
        },
      })
    })()

    /** Start one account's long poll. */
    const startAccount = async (account) => {
      const transport = new ILinkTransport({
        accountId: account.accountId,
        maxQueuePerConversation: DEFAULT_MAX_QUEUE,
        baseUrl: account.baseUrl,
        token: account.token,
        userId: account.userId,
        cdnBaseUrl: live().cdnBaseUrl?.trim() || account.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
        sendIntervalMs: live().sendIntervalMs,
        sendCooldownMs: live().sendCooldownMs,
        bypassQueue: (message) => {
          if (message?.type !== 'text') return false
          if (isInterruptCommand(message.text)) return true
          // A turn blocked on an approval or a plan review IS this
          // conversation's running handler. Its reply must not wait behind
          // that chain, or the answer can never reach the broker that is
          // waiting for it.
          const key = scopedLineKey(account.accountId, message.conversationId)
          return approvals.hasPending?.(key) === true || planReviews.hasPending?.(key) === true
        },
        log: (line) => log(line),
        errLog: (line) => warn(line),
        onSessionRejected: (error, rejectedAccountId) => {
          runtime.errors.set(rejectedAccountId ?? account.accountId, String(error?.message ?? error))
          warn(
            error?.sessionExpired === true
              ? `Weixin session expired for ${account.accountId}: log in again with bin/login.js, then restart`
              : `Weixin session rejected for ${account.accountId}: ${String(error?.message ?? error)}`,
          )
        },
      })
      await transport.refreshConfig()
      if (stopped) return
      const handler = createInboundHandler({ accountId: account.accountId, transport, bridge: () => bridge, seen })
      const previous = runtime.transports.get(account.accountId)
      if (previous !== undefined) {
        await previous.stop().catch((error) => warn(`transport stop failed: ${String(error?.message ?? error)}`))
      }
      if (stopped) return
      await transport.start(handler)
      runtime.transports.set(account.accountId, transport)
      runtime.errors.delete(account.accountId)
      log(`listening as account ${account.accountId} (state: ${stateRoot})`)
    }

    /** Resolve saved credentials and arm their loops. */
    const startAll = async (wantedAccountId) => {
      await setup
      const accounts = await resolveAccounts(live(), wantedAccountId, warn)
      runtime.accounts = accounts
      for (const account of accounts) {
        if (wantedAccountId === undefined && runtime.transports.has(account.accountId)) continue
        try {
          await startAccount(account)
        } catch (error) {
          runtime.errors.set(account.accountId, String(error?.message ?? error))
          warn(`could not start the loop for ${account.accountId}: ${String(error?.message ?? error)}`)
        }
      }
    }
    runtime.rearm = async (wantedAccountId) => {
      await startAll(wantedAccountId)
    }

    void startAll().catch((error) => {
      runtime.errors.set('startup', String(error?.message ?? error))
      warn(`starting the Weixin loop failed: ${String(error?.message ?? error)}`)
    })

    const retryTimer = setInterval(() => {
      if (stopped) return
      if (runtime.transports.size < runtime.accounts.length) {
        void startAll().catch((error) => warn(`retrying the Weixin loop failed: ${String(error?.message ?? error)}`))
      }
    }, 60_000)
    retryTimer.unref?.()

    /** One inbound Weixin message through the whole lite pipeline. */
    function createInboundHandler({ accountId, transport, bridge: currentBridge, seen: memories }) {
      const seen = new MessageDeduper()
      memories.set(accountId, seen)
      const ts = () => Date.now()

      const listBindable = () => readBindableSessions({ ctx, warn })

      const bindTo = async (item, bindKey, message) => {
        const result = bindings.bind(bindKey, {
          sessionId: item.sessionId,
          cwd: item.cwd,
          title: item.title,
          senderId: message.senderId,
          conversationId: message.conversationId,
          accountId,
        })
        if (result?.ok === false) {
          if (result.reason === 'already-bound') return `那条会话已经被另一个微信会话绑走了（${result.key}）。`
          return '绑定没有成功，请稍后再试。'
        }
        bindings.clearCandidates(bindKey)
        fileIndex.clear(bindKey)
        let text = `已绑定：「${item.title ?? item.sessionId}」\n${item.sessionId}`
        try {
          const last = String((await currentBridge()?.lastAssistantReply(item.sessionId)) ?? '').trim()
          if (last !== '') text += `\n\n—— 这条会话最后一条回复 ——\n${last}`
        } catch (error) {
          if (isMissingSessionError(error, item.sessionId)) {
            bindings.unbind(bindKey)
            return `那条会话（${item.sessionId}）已经不在了，绑定没有建立。`
          }
          warn(`reading the last reply failed: ${String(error?.message ?? error)}`)
        }
        return text
      }

      const attachBound = async (message, boundEntry) => {
        const target = currentBridge()
        if (target?.attach === undefined) throw new Error('插件还没准备好')
        return await target.attach(message.conversationId, accountId, {
          sessionId: boundEntry.sessionId,
          bound: true,
        })
      }

      const commandReply = async (message, bindKey, boundEntry, text) => {
        const cfg = live()
        if (text === '/help') {
          return [
            '可用命令：',
            '/bind 列出可绑定的工作区会话；/bind <序号> 绑定；/bind <id 前缀> 按 id 绑定',
            '/unbind 解除绑定（工作区那条会话不受影响）',
            '/plan 进入计划模式（这一轮只出方案，不改文件）；/plan off 退出；/plan status 查看',
            '/files 列出这条会话提交过的计划 .md；/files <后缀> 看工作区里的文件，例如 /files docx',
            '/file <序号> 取回最近一次 /files 列表里的文件',
            '/status 连接与绑定状态',
            '/cancel 取消正在跑的回合',
            '/steer <补充要求> 插进正在进行的回复',
            '直接发文字或图片，就会作为那条会话的输入。',
          ].join('\n')
        }
        if (text === '/status') {
          const bound = boundEntry === undefined ? '未绑定（发 /bind 选一条工作区会话）' : `「${boundEntry.title ?? boundEntry.sessionId}」${boundEntry.sessionId}`
          const listening = [...runtime.transports.keys()]
          const errors = [...runtime.errors.entries()].map(([id, reason]) => `${id}: ${reason}`)
          let planStatus
          if (boundEntry !== undefined) {
            try {
              const record = await attachBound(message, boundEntry)
              const state = ctx.get?.('planMode')?.get?.(record.agent)
              if (state !== undefined) {
                planStatus = `计划模式：${state.active === true ? '开' : '关'}${state.pending === true ? '（切换待生效）' : ''}`
              }
            } catch {
              // A status read must never be the reason a message fails.
            }
          }
          return [
            `账号：${accountId}`,
            `监听：${listening.length > 0 ? listening.join(', ') : '未连接'}`,
            ...(errors.length > 0 ? [`错误：${errors.join('；')}`] : []),
            `绑定：${bound}`,
            ...(planStatus === undefined ? [] : [planStatus]),
            `待审批：${approvals.pendingCount?.() ?? 0}`,
          ].join('\n')
        }
        const planAction = parsePlanCommand(text)
        if (planAction !== undefined) {
          if (boundEntry === undefined) return '先 /bind 绑定一条工作区会话，再用 /plan。'
          const planMode = ctx.get?.('planMode')
          if (planMode === undefined || typeof planMode.set !== 'function') {
            return '这个宿主没有提供计划模式服务，暂时不能从微信切换（可以在桌面端切换）。'
          }
          let record
          try {
            record = await attachBound(message, boundEntry)
          } catch (error) {
            return `打不开绑定的会话：${String(error?.message ?? error)}`
          }
          if (planAction === 'status') {
            const state = planMode.get?.(record.agent)
            return state?.active === true ? '当前在计划模式。' : '当前不在计划模式。'
          }
          const active = planAction === 'enter'
          try {
            return describePlanSet(planMode.set(record.agent, active), active)
          } catch (error) {
            return `切换计划模式失败：${String(error?.message ?? error)}`
          }
        }
        if (text === '/unbind') {
          if (boundEntry === undefined) return '现在没有绑定。'
          bindings.clearCandidates(bindKey)
          bindings.unbind(bindKey)
          fileIndex.clear(bindKey)
          return '已解除绑定；工作区那条会话不受影响。'
        }
        if (text === '/cancel') {
          const reply = bridgeCancel(bindKey, message)
          return reply
        }
        if (text.startsWith('/steer ')) {
          return '这一版精简插件不支持 /steer；等这一轮结束再发。'
        }
        if (text === '/bind' || text.startsWith('/bind ')) {
          if (cfg.bindEnabled === false) return '当前配置不允许绑定。'
          const argument = text.slice('/bind'.length).trim()
          if (argument === '') {
            const items = await listBindable()
            if (items.length === 0) return '工作区里还没有可以绑定的会话。先在桌面端开一条对话，再来 /bind。'
            bindings.setCandidates(bindKey, items)
            return [
              '可以绑定的工作区会话：',
              ...items.map((item, index) => `${index + 1}. ${item.title ?? '(无标题)'} — ${item.sessionId}${item.cwd ? ` — ${item.cwd}` : ''}`),
              '',
              '回复 /bind <序号> 绑定（5 分钟内有效）。',
            ].join('\n')
          }
          const candidates = bindings.getCandidates(bindKey)
          if (candidates === undefined) return '候选列表已经过期；先发 /bind 重新列出。'
          if (/^\d+$/.test(argument)) {
            const index = Number(argument)
            if (!Number.isInteger(index) || index < 1 || index > candidates.length) return `序号要在 1 到 ${candidates.length} 之间。`
            return await bindTo(candidates[index - 1], bindKey, message)
          }
          const matches = candidates.filter((item) => String(item.sessionId).toLowerCase().startsWith(argument.toLowerCase()))
          if (matches.length === 1) return await bindTo(matches[0], bindKey, message)
          if (matches.length === 0) return '没有以这个前缀开头的候选；先发 /bind 重新列出。'
          return `有 ${matches.length} 条会话都以这个前缀开头，请再给长一点的前缀。`
        }
        if (text === '/files' || text.startsWith('/files ')) {
          if (boundEntry === undefined) return '先 /bind 绑定一条会话，再 /files。'
          const argument = text.slice('/files'.length).trim()
          // Bare /files answers "what did this conversation plan?", not "what
          // Markdown happens to be on disk": the bound session's plan files are
          // the ones plan-review delivered, and their sidecars say which
          // session submitted them.
          if (argument === '') {
            const plans = await listPlanFiles({ stateRoot, sessionId: boundEntry.sessionId })
            if (plans.length === 0) {
              return '这条会话还没有产生计划文件（进入计划模式、提交计划后才会出现）。要看工作区里的 .md，发 /files md；其他类型写后缀，例如 /files docx。'
            }
            const entries = plans.slice(0, FILE_MAX_ENTRIES)
            fileIndex.setListing(bindKey, { extensions: ['md'], entries })
            return [
              '这条会话提交过的计划（新的在前）：',
              describeFiles(entries, { cwd: plansDir(stateRoot) }),
              '',
              '发 /file <序号> 取回某个计划；要看工作区里的 .md 请发 /files md。',
            ].join('\n')
          }
          const parsed = parseFileExtensions(argument)
          if (parsed === null) return '后缀写法不对：写 docx、md 或 `docx pdf` 这样的一串字母/数字。'
          const dir = boundEntry.cwd || cwd
          const scanned = await scanRecentFiles({ dir, sinceMs: ts() - FILE_LOOKBACK_MS, maxEntries: 200 })
          const merged = mergeFileEntries(fileIndex.list(bindKey), scanned, { limit: 200 })
          fileIndex.record(bindKey, merged)
          const filtered = filterFileEntries(merged, parsed.extensions).slice(0, FILE_MAX_ENTRIES)
          if (filtered.length === 0) {
            return parsed.label === '.md'
              ? '最近 24 小时没有发现 .md 文件。其他类型请写后缀，例如 /files docx。'
              : `最近 24 小时没有发现 ${parsed.label} 文件。`
          }
          fileIndex.setListing(bindKey, { extensions: parsed.extensions, entries: filtered })
          return [
            `当前会话最近的文件（${parsed.label}）：`,
            describeFiles(filtered, { cwd: dir }),
            '',
            '发 /file <序号> 取回某个文件。只扫两层目录，跳过依赖/构建目录。',
          ].join('\n')
        }
        if (text === '/file' || text.startsWith('/file ')) {
          if (boundEntry === undefined) return '先 /bind 绑定一条会话，再 /file。'
          const argument = text.slice('/file'.length).trim()
          const index = Number(argument)
          const listing = fileIndex.getListing(bindKey)
          if (listing === undefined || listing.entries.length === 0) return '还没有文件列表；先发 /files 看列表。'
          if (!Number.isInteger(index) || index < 1 || index > listing.entries.length) {
            return `序号要在 1 到 ${listing.entries.length} 之间；先发 /files 看列表。`
          }
          const entry = listing.entries[index - 1]
          try {
            await sendFile(transport, { conversationId: message.conversationId, filePath: entry.path })
            return `已发送：${entry.name ?? entry.path}（${formatBytes(entry.size ?? 0)}）`
          } catch (error) {
            return `发送失败：${String(error?.message ?? error)}`
          }
        }
        return undefined
      }

      const bridgeCancel = (bindKey, message) => {
        const bound = bindings.getByKey(bindKey)
        if (bound === undefined) return '先 /bind 绑定一条会话。'
        const target = currentBridge()
        if (target?.cancel === undefined) return '这一版桥不支持取消。'
        try {
          const reply = target.cancel(message.conversationId, accountId)
          return reply ?? '（已请求取消）'
        } catch (error) {
          return `取消失败：${String(error?.message ?? error)}`
        }
      }

      return async (message) => {
        const cfg = live()
        const allow = allowlistForAccount(accountId, cfg)
        if (!isAllowedSender(allow, message.senderId, message.conversationId)) {
          const entry = readRegistry()[accountId]
          const hasOverride = () =>
            (Array.isArray(entry?.allowedSenders) && entry.allowedSenders.length > 0) ||
            (Array.isArray(entry?.allowedChats) && entry.allowedChats.length > 0)
          const enrolled = enrolFirstContact(accountId, message.senderId, hasOverride, (line) => log(line), cfg.allowedSenders ?? [])
          if (!enrolled) {
            warn(`refused message from ${message.senderId}: ${denialSummary(allow, message)}`)
            return
          }
        }
        if (seen.accept(message.id) === false) return
        touchAccount(accountId, warn)

        const bindKey = scopedLineKey(accountId, message.conversationId)
        const boundEntry = cfg.bindEnabled !== false ? bindings.getByKey(bindKey) : undefined
        const text = String(message.text ?? '').trim()

        const approvalReply = approvals.handleInbound({
          key: bindKey,
          text,
          senderId: message.senderId,
          bindingSenderId: boundEntry?.senderId,
        })
        if (approvalReply !== undefined) {
          await sendText(transport, message.conversationId, approvalReply, message.contextToken)
          log(`approval answered from WeChat for ${bindKey}`)
          return
        }
        const reviewReply = planReviews.handleInbound({
          key: bindKey,
          text,
          senderId: message.senderId,
          bindingSenderId: boundEntry?.senderId,
        })
        if (reviewReply !== undefined) {
          await sendText(transport, message.conversationId, reviewReply, message.contextToken)
          log(`plan review answered from WeChat for ${bindKey}`)
          return
        }

        const bindPending = cfg.bindEnabled !== false && bindings.getCandidates(bindKey) !== undefined
        if (bindPending && !isBindSelectionCommand(text) && text !== '/unbind') {
          await sendText(
            transport,
            message.conversationId,
            '现在正在等选择要绑定的会话：请发 /bind <序号>。\n发 /bind 可重新列列表，/unbind 退出选择。',
            message.contextToken,
          )
          return
        }

        if (message.unsupported !== undefined) {
          await sendText(transport, message.conversationId, `这条消息的类型（${message.unsupported}）暂时接不了。`, message.contextToken)
          return
        }

        if (text.startsWith('/') || text === '/help') {
          const reply = await commandReply(message, bindKey, boundEntry, text)
          if (reply !== undefined) {
            await sendText(transport, message.conversationId, reply, message.contextToken)
            return
          }
        }

        if (boundEntry === undefined) {
          await sendText(
            transport,
            message.conversationId,
            '这个微信会话还没有绑定到工作区的会话。\n发 /bind 看可绑定的会话，/bind <序号> 绑定。',
            message.contextToken,
          )
          return
        }

        if (text === '' && !(Array.isArray(message.media) && message.media.length > 0)) {
          await sendText(transport, message.conversationId, '这条消息没有文字，也没有附件。', message.contextToken)
          return
        }

        const parts = []
        let nativeImages = []
        if (cfg.mediaEnabled !== false && Array.isArray(message.media) && message.media.length > 0) {
          const cdnBaseUrl = cfg.cdnBaseUrl?.trim() || transport.cdnBaseUrl || DEFAULT_CDN_BASE_URL
          const maxBytes = cfg.maxInboundMediaBytes ?? DEFAULT_MAX_INBOUND_MEDIA_BYTES
          const saved = []
          const failures = []
          for (const media of message.media) {
            const download = media.kind === 'voice' ? downloadInboundVoice : downloadInboundMedia
            const result = await download({ media, cdnBaseUrl, maxBytes, warn })
            if (result?.ok === true) saved.push(result)
            else failures.push({ kind: media.kind, reason: result?.reason ?? 'unknown', code: result?.code ?? 'unknown' })
          }
          const native = await saveNativeImages({
            saved,
            attachments: ctx.get?.('attachments'),
            readFile: (file) => fs.promises.readFile(file),
            enabled: cfg.nativeImageInput !== false,
            warn,
          })
          nativeImages = native.images
          const fallback = new Set(native.fallback)
          const described = saved.filter((item) => item.kind !== 'image' || fallback.has(item))
          if (described.length > 0) parts.push(describeInboundMedia(described, native.images.length > 0 ? undefined : message.text))
          if (failures.length > 0) parts.push(describeMediaFailures(failures))
          if (saved.length === 0 && text === '') {
            await sendText(transport, message.conversationId, `（${describeMediaFailures(failures)}）`, message.contextToken)
            return
          }
        }
        if (text !== '') parts.push(neutralizeTags(text))
        const prompt = parts.join('\n\n')

        const startedAt = Date.now()
        let reply
        try {
          reply = await currentBridge().deliver({
            conversationId: message.conversationId,
            accountId,
            text: prompt,
            images: nativeImages,
            senderId: message.senderId,
            busyMessageMode: cfg.busyMessageMode,
            onProgress: async (note) => {
              await sendText(transport, message.conversationId, `（${note}）`, message.contextToken)
            },
          })
        } catch (error) {
          warn(`deliver failed: ${String(error?.message ?? error)}`)
          await sendText(transport, message.conversationId, `这一轮运行失败：${String(error?.message ?? error)}`, message.contextToken)
          return
        }
        if (reply?.text !== undefined && reply.text !== '') {
          await sendText(transport, message.conversationId, reply.text, message.contextToken)
        }
        if (boundEntry !== undefined) {
          try {
            const produced = await scanRecentFiles({
              dir: boundEntry.cwd || cwd,
              sinceMs: startedAt - 5_000,
              maxEntries: 100,
            })
            fileIndex.record(bindKey, produced)
            if (cfg.autoSendFiles !== false) {
              const fresh = produced.filter((entry) => Number(entry.mtime ?? 0) >= startedAt).slice(0, 5)
              for (const entry of fresh) {
                try {
                  await sendFile(transport, { conversationId: message.conversationId, filePath: entry.path })
                } catch (error) {
                  warn(`sending produced file failed: ${String(error?.message ?? error)}`)
                }
              }
            }
          } catch (error) {
            warn(`recording produced files failed: ${String(error?.message ?? error)}`)
          }
        }
      }
    }

    return () => {
      stopped = true
      clearInterval(retryTimer)
      outbox.stop()
      runtime.rearm = async () => {}
      for (const transport of runtime.transports.values()) {
        void transport.stop().catch(() => {})
      }
      runtime.transports.clear()
      void planReviews
      void approvals
    }
  })
}

function denialSummary(allow, message) {
  return `allowedSenders=${JSON.stringify(allow.allowedSenders)} conversation=${message.conversationId}`
}

/** Resolve the agent working directory (config, sessions dir, host cwd). */
async function resolveCwd(ctx, config, warn) {
  const configured = config.cwd?.trim()
  if (configured !== undefined && configured !== '') return configured
  try {
    return ensureSessionsDir()
  } catch (error) {
    warn(`could not create the sessions directory: ${String(error?.message ?? error)}`)
  }
  try {
    const fsService = ctx.get('fs')
    if (fsService?.resolve !== undefined && fsService?.processPath !== undefined) {
      return fsService.processPath(await fsService.resolve('.'))
    }
  } catch (error) {
    warn(`could not resolve the default working directory: ${String(error?.message ?? error)}`)
  }
  return process.cwd()
}

/** Load the saved credential(s) this pass should serve. */
async function resolveAccounts(config, wantedAccountId, warn) {
  const { DEFAULT_BASE_URL, listWeixinAccountIds, loadWeixinAccount, resolveWeixinAccount } = await import(
    '../vendor/openclaw-weixin/auth/accounts.js'
  )
  const configured = config.accountId?.trim() || wantedAccountId?.trim() || ''
  let ids = configured !== '' ? [configured] : listWeixinAccountIds({})
  if (ids.length === 0) {
    warn('no Weixin account is saved yet; run `node bin/login.js` in the plugin directory first')
    return []
  }
  const accounts = []
  for (const accountId of ids) {
    const data = loadWeixinAccount(accountId)
    if (data === null || !data.token) {
      warn(`account "${accountId}" has no saved token; log in again`)
      continue
    }
    if (isAccountPaused(accountId)) {
      warn(`account "${accountId}" is paused; not starting its loop`)
      continue
    }
    let resolved
    try {
      resolved = resolveWeixinAccount({ channels: { 'openclaw-weixin': { accounts: { [accountId]: {} } } } }, accountId)
    } catch {
      resolved = undefined
    }
    accounts.push({
      accountId,
      baseUrl: data.baseUrl ?? resolved?.baseUrl ?? DEFAULT_BASE_URL,
      cdnBaseUrl: data.cdnBaseUrl?.trim() || undefined,
      token: data.token,
      userId: data.userId,
    })
  }
  return accounts
}

/** Candidate sessions for /bind: every workspace session, with titles. */
export async function readBindableSessions({ ctx, warn, limit = 12 }) {
  const items = []
  try {
    const workspaces = (await ctx.get('workspaceRegistry')?.list?.()) ?? []
    for (const workspace of workspaces) {
      for (const sessionId of workspace.sessionIds ?? []) {
        if (isInternalSessionId(sessionId)) continue
        items.push({ sessionId, cwd: workspace.path, workspace: workspace.title })
      }
    }
  } catch (error) {
    warn(`reading workspaces failed: ${String(error?.message ?? error)}`)
  }
  if (items.length === 0) {
    try {
      const sessions = (await ctx.get('sessionQuery')?.listSessions?.()) ?? []
      for (const record of sessions) {
        const sessionId = record?.header?.id
        if (typeof sessionId !== 'string' || isInternalSessionId(sessionId)) continue
        items.push({ sessionId, cwd: record?.header?.cwd })
      }
    } catch (error) {
      warn(`reading sessions failed: ${String(error?.message ?? error)}`)
    }
  }
  const picked = items.slice(0, limit)
  try {
    const snapshots = await ctx.get('sessionQuery')?.readTitleSnapshots?.(picked.map((item) => item.sessionId))
    for (const [index, item] of picked.entries()) {
      const snapshot = snapshots?.[index]
      if (snapshot?.status === 'fulfilled') item.title = snapshot.value?.title?.title
    }
  } catch (error) {
    warn(`reading session titles failed: ${String(error?.message ?? error)}`)
  }
  return picked
}

function isInternalSessionId(sessionId) {
  return sessionId.startsWith('weixin-') || sessionId.startsWith('wx-mem-')
}
