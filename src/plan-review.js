/**
 * Plan-mode review over WeChat.
 *
 * `exit_plan_mode` asks the host a `user-questions/request` and waits for one
 * answer. The stock way to answer is the GUI card; a WeChat-only user has no
 * way in, because `userQuestions.answer()` only works for questions the GUI has
 * already released ("continued"). This module therefore answers the request
 * from the HOST side: it registers as the outermost waterfall listener and
 * sends the plan Markdown to the WeChat conversation bound to that session.
 *
 * WeChat owns the review by default. The request is NOT forwarded to `next()`
 * up front: a forwarded request makes the desktop client render a plan card,
 * and that card is removed only when the client's own waterfall settles — if
 * WeChat answers first the card would sit pending forever. So `next()` runs
 * only after `planReviewGuiHandoffMs` expires (0 disables the handoff and keeps
 * the review exclusively on the phone). Once handed off, WeChat replies are
 * acknowledged with a notice instead of settling the review; if the handoff
 * itself fails (no GUI connected, or the client disappears) the review falls
 * back to waiting for WeChat.
 *
 * The answer shape is the one `exit_plan_mode` validates:
 *
 *   approve  -> { answers: [{ id: 'plan-review', selected: ['Approve'] }] }
 *   reject   -> { answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: <feedback> }] }
 *
 * Approve must have exactly `selected: ['Approve']` and NO `custom`; any other
 * shape makes the tool throw "the user chose to keep planning".
 *
 * @module dsh-weixin/plan-review
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PLAN_REVIEW_ID = 'plan-review'
export const APPROVE_LABEL = 'Approve'
export const KEEP_PLANNING_LABEL = 'Keep planning'

/** How many plan Markdown files the state directory keeps. */
const PLANS_KEEP = 50

const APPROVE_RE = /^(?:\/approve|1|同意|批准|通过|approve)$/i
const REJECT_RE = /^(?:2|打回|驳回|keep\s+planning)$/i
const REJECT_PREFIX_RE = /^\/reject(?:\s+([\s\S]*))?$/i
const CANCEL_RE = /^\/(?:cancel|stop)$/i

/**
 * Pick the plan review out of a user-questions request.
 *
 * Only questions carrying the plan-mode intent qualify; a plain
 * `ask_user_question` must keep flowing to the GUI untouched.
 *
 * @param {any} request
 * @returns {{ question: any, plan: string, callId: string, title: string } | undefined}
 */
export function findPlanReview(request) {
  if (!isRecord(request) || !Array.isArray(request.questions)) return undefined
  for (const question of request.questions) {
    if (!isRecord(question) || question.id !== PLAN_REVIEW_ID) continue
    const intent = question.intent
    if (!isRecord(intent) || intent.kind !== 'plan-review') continue
    const plan = typeof question.detail === 'string' ? question.detail : ''
    if (plan.trim() === '') continue
    return {
      question,
      plan,
      callId: typeof intent.callId === 'string' ? intent.callId : '',
      title: planTitle(plan),
    }
  }
  return undefined
}

/** Title = first Markdown heading, so the file name and the notice agree. */
export function planTitle(plan) {
  for (const raw of String(plan ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (/^#\s+\S/.test(line)) return line.replace(/^#\s+/, '').trim().slice(0, 80)
  }
  return '计划'
}

/** Directory holding the delivered plan files. */
export function plansDir(stateRoot) {
  return join(stateRoot, 'plans')
}

/** One deterministic file per review call, so a resubmit cannot pile up. */
export function planFilePath(stateRoot, callId) {
  const safe = String(callId ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 80)
  return join(plansDir(stateRoot), `${safe === '' ? 'plan' : safe}.md`)
}

/**
 * Sidecar metadata for a delivered plan.
 *
 * `/files` lists the plans of ONE bound conversation, and the Markdown files
 * carry no session id of their own — the sidecar is what ties a plan back to
 * the conversation that submitted it.
 */
export function planMetaPath(stateRoot, callId) {
  const safe = String(callId ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 80)
  return join(plansDir(stateRoot), `${safe === '' ? 'plan' : safe}.json`)
}

/**
 * Plan files delivered for one bound session, newest first.
 *
 * @param {{ stateRoot: string, sessionId: string }} params
 * @returns {Promise<Array<{ path: string, name: string, size: number, mtime: number, title: string, at: number }>>}
 */
export async function listPlanFiles({ stateRoot, sessionId }) {
  const dir = plansDir(stateRoot)
  let names
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  const rows = []
  for (const name of names) {
    let meta
    try {
      meta = JSON.parse(await readFile(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    if (!isRecord(meta) || meta.schemaVersion !== 1) continue
    if (typeof sessionId === 'string' && sessionId !== '' && meta.sessionId !== sessionId) continue
    const mdPath = typeof meta.filePath === 'string' ? meta.filePath : join(dir, name.replace(/\.json$/, '.md'))
    let info
    try {
      info = await stat(mdPath)
    } catch {
      continue
    }
    rows.push({
      path: mdPath,
      name: name.replace(/\.json$/, '.md'),
      size: info.size,
      mtime: info.mtimeMs,
      title: typeof meta.title === 'string' ? meta.title : '',
      at: typeof meta.at === 'number' ? meta.at : info.mtimeMs,
    })
  }
  return rows.sort((left, right) => right.at - left.at)
}

/**
 * Parse a WeChat reply into a review verdict.
 *
 * Anything that is not an explicit approval/label is treated as feedback — a
 * phone user who types "先写测试再改" is rejecting the plan with a reason, not
 * asking the bot a question.
 *
 * @param {string} text
 * @returns {{ kind: 'approve' } | { kind: 'reject', feedback: string } | { kind: 'cancel' } | undefined}
 */
export function parseReviewReply(text) {
  const value = String(text ?? '').trim()
  if (value === '') return undefined
  if (APPROVE_RE.test(value)) return { kind: 'approve' }
  if (CANCEL_RE.test(value)) return { kind: 'cancel' }
  const explicit = REJECT_PREFIX_RE.exec(value)
  if (explicit !== null) return { kind: 'reject', feedback: (explicit[1] ?? '').trim() }
  const labelled = /^(?:2|打回|驳回|keep\s+planning)\s+([\s\S]+)$/i.exec(value)
  if (labelled !== null) return { kind: 'reject', feedback: labelled[1].trim() }
  if (REJECT_RE.test(value)) return { kind: 'reject', feedback: '' }
  return { kind: 'reject', feedback: value }
}

/** Build the exact answer object `exit_plan_mode` validates. */
export function buildAnswer(verdict) {
  if (verdict?.kind === 'approve') {
    return { answers: [{ id: PLAN_REVIEW_ID, selected: [APPROVE_LABEL] }] }
  }
  const feedback = typeof verdict?.feedback === 'string' ? verdict.feedback.trim() : ''
  return {
    answers: [{
      id: PLAN_REVIEW_ID,
      selected: [KEEP_PLANNING_LABEL],
      custom: feedback === '' ? '（微信端要求继续修改）' : feedback,
    }],
  }
}

/** The short text sent with the plan file. */
export function planReviewInstructions(title) {
  return [
    `「计划待批准」${title}`,
    '回复 1 = 批准并继续；回复 2 + 意见 = 打回重做（也可以直接发意见）；/cancel = 取消本次评审。',
    '计划正文已作为 Markdown 文件发送，可保存后查看。',
  ].join('\n')
}

/** What the user sees after a verdict was accepted. */
export function planReviewAck(verdict) {
  if (verdict?.kind === 'approve') return '已批准计划，Agent 继续执行。'
  if (verdict?.kind === 'cancel') return '已取消本次计划评审（按打回处理）。'
  const feedback = typeof verdict?.feedback === 'string' ? verdict.feedback.trim() : ''
  return feedback === '' ? '已按「打回」处理。' : `已按「打回」处理：${feedback}`
}

/**
 * The host-side answerer and the WeChat verdict router.
 *
 * Registration is deliberately split from the I/O: the caller supplies
 * `sendFile`/`sendText`, so this module stays testable without a transport.
 *
 * @param {{
 *   stateRoot: string,
 *   bindings: { boundTo: (sessionId: string) => ({ key: string, entry: any } | undefined) },
 *   transportFor?: (accountId: string) => any,
 *   fallbackTransport?: () => any,
 *   sendText?: (transport: any, conversationId: string, text: string) => Promise<void> | void,
 *   sendFile?: (params: { transport: any, conversationId: string, filePath: string, caption: string }) => Promise<void> | void,
 *   readMediaEnabled?: () => boolean,
 *   readWaitMs?: () => number,
 *   readGuiHandoffMs?: () => number,
 *   warn?: (line: string) => void,
 *   log?: (line: string) => void,
 *   now?: () => number,
 * }} deps
 */
export function createPlanReviewBroker({
  stateRoot,
  bindings,
  transportFor = () => undefined,
  fallbackTransport = () => undefined,
  sendText = async () => {},
  sendFile = async () => {},
  readEnabled = () => true,
  readMediaEnabled = () => true,
  readWaitMs = () => 0,
  readGuiHandoffMs = () => 0,
  onSettled = () => {},
  warn = () => {},
  log = () => {},
  now = Date.now,
}) {
  /** @type {Map<string, { key: string, resolve: (verdict: any) => void, finish: () => void }>} */
  const pending = new Map()

  /**
   * Waterfall listener: send the plan, then race WeChat against `next()`.
   *
   * @param {any} request
   * @param {() => any} next
   */
  async function handleRequest(request, next) {
    const review = findPlanReview(request)
    if (review === undefined) return next()
    if (readEnabled() === false) return next()

    const sessionId = typeof request?.agent?.id === 'string' ? request.agent.id : ''
    const binding = sessionId === '' ? undefined : bindings?.boundTo?.(sessionId)
    if (binding === undefined) {
      log(`plan review skipped: session ${sessionId === '' ? '(none)' : sessionId} is not bound to WeChat`)
      return next()
    }
    if (pending.has(binding.key)) {
      log(`plan review skipped: ${binding.key} already has a pending review`)
      return next()
    }

    const target = resolveTarget(binding, transportFor, fallbackTransport)
    if (target === undefined) {
      log(`plan review skipped: no live transport for ${binding.key}`)
      return next()
    }

    try {
      await deliverPlan({ review, target, stateRoot, sendFile, sendText, readMediaEnabled, warn, sessionId, key: binding.key })
    } catch (error) {
      warn(`plan review delivery failed: ${String(error?.message ?? error)}`)
      return next()
    }

    const entry = createPending(binding.key, now)
    entry.request = request
    pending.set(binding.key, entry)

    const onAbort = () => settle({ kind: 'reject', feedback: '（计划评审已取消）' })
    entry.cleanup = () => {
      pending.delete(binding.key)
      if (entry.waitTimer !== undefined) clearTimeout(entry.waitTimer)
      if (entry.handoffTimer !== undefined) clearTimeout(entry.handoffTimer)
      try {
        request?.signal?.removeEventListener?.('abort', onAbort)
      } catch {}
    }

    function settle(verdict) {
      if (entry.settled) return
      entry.settled = true
      entry.cleanup?.()
      entry.resolve(verdict)
    }
    entry.settle = settle

    if (request?.signal?.aborted) onAbort()
    else request?.signal?.addEventListener?.('abort', onAbort, { once: true })

    const wechat = entry.promise.then((verdict) => ({ via: 'wechat', verdict }))

    // The exclusive window is the only time planReviewWaitMs counts: after a
    // handoff the desktop owns the wait and the tool's own signal ends it.
    const waitMs = Math.max(0, Number(readWaitMs()) || 0)
    if (waitMs > 0) {
      entry.waitTimer = setTimeout(() => {
        settle({ kind: 'reject', feedback: '（微信端等待批准超时）' })
      }, waitMs)
      entry.waitTimer.unref?.()
    }

    const handoffMs = Math.max(0, Number(readGuiHandoffMs()) || 0)
    if (handoffMs <= 0) {
      // WeChat-exclusive: the GUI never sees this request, so it cannot leave
      // a pending plan card behind. The tool's signal still ends the review.
      const settled = await wechat
      entry.cleanup?.()
      return buildAnswer(settled.verdict)
    }

    let resolveHandoff
    const handoff = new Promise((resolve) => { resolveHandoff = resolve })
    const beginHandoff = () => {
      if (entry.settled || entry.handedOff) return
      entry.handedOff = true
      // The desktop owns the wait from here; the exclusive timer no longer
      // applies, and an abort of the tool must not settle WeChat against the
      // forwarded request (that would leave the desktop card pending).
      if (entry.waitTimer !== undefined) clearTimeout(entry.waitTimer)
      try {
        request?.signal?.removeEventListener?.('abort', onAbort)
      } catch {}
      entry.downstream = Promise.resolve()
        .then(() => next())
        .then(
          (answer) => ({ via: 'downstream', answer }),
          (error) => ({ via: 'downstream-error', error }),
        )
      resolveHandoff(entry.downstream)
    }
    entry.handoffTimer = setTimeout(beginHandoff, handoffMs)
    entry.handoffTimer.unref?.()

    const winner = await Promise.race([wechat, handoff])

    if (winner.via === 'wechat') {
      entry.cleanup?.()
      return buildAnswer(winner.verdict)
    }
    if (winner.via === 'downstream-error') {
      // Nobody on the desktop answered (no client, or it went away): keep the
      // review on the phone instead of failing it.
      entry.handedOff = false
      const settled = await wechat
      entry.cleanup?.()
      return buildAnswer(settled.verdict)
    }

    entry.settled = true
    entry.cleanup?.()
    // The desktop answered. Tell the phone, without failing the review.
    try {
      await sendText(target.transport, target.conversationId, '（这条计划已在桌面端处理，微信评审已关闭。）')
    } catch (error) {
      warn(`plan review notice failed: ${String(error?.message ?? error)}`)
    }
    return winner.answer
  }

  /**
   * Route a WeChat message into a pending review, when this conversation has
   * one. Returns the acknowledgement to send back, or undefined when the
   * message is not a review reply (it then flows through the normal pipeline).
   *
   * @param {{ key: string, text: string, senderId?: string, bindingSenderId?: string }} params
   * @returns {string | undefined}
   */
  function handleInbound({ key, text, senderId, bindingSenderId }) {
    const entry = pending.get(key)
    if (entry === undefined) return undefined
    const value = String(text ?? '').trim()
    // After a handoff the desktop owns the verdict. Slash commands still work
    // (they are not answers); everything else gets a notice instead of being
    // queued as a message behind the pending review.
    if (entry.handedOff === true) {
      if (value.startsWith('/') && !/^\/(?:approve|reject|cancel|stop)\b/i.test(value)) {
        return undefined
      }
      return '这条计划已经交给桌面端等待处理，请在桌面端批准或打回。'
    }
    // `/files`, `/status`, … are commands, not plan feedback. Only the review
    // commands themselves reach the verdict parser as slash text.
    if (value.startsWith('/') && !/^\/(?:approve|reject|cancel|stop)\b/i.test(value)) {
      return undefined
    }
    if (typeof bindingSenderId === 'string' && bindingSenderId !== ''
      && typeof senderId === 'string' && senderId !== '' && bindingSenderId !== senderId) {
      return '这条会话绑定给了另一位微信用户，计划审批只能由绑定人回复。'
    }
    const verdict = parseReviewReply(value)
    if (verdict === undefined) return undefined
    entry.settle?.(verdict)
    try {
      onSettled({ key, request: entry.request, verdict })
    } catch (error) {
      warn(`plan review: post-verdict hook failed: ${String(error?.message ?? error)}`)
    }
    return planReviewAck(verdict)
  }

  /** Number of reviews currently waiting; useful in tests and diagnostics. */
  function pendingCount() {
    return pending.size
  }

  /**
   * Whether this conversation has a plan review waiting for a WeChat reply.
   * The inbound dispatcher serializes one conversation's messages, and the
   * review request blocks the turn handler, so the reply must bypass it.
   * @param {string} key binding key
   */
  function hasPending(key) {
    return pending.has(key)
  }

  return { handleRequest, handleInbound, pendingCount, hasPending }
}

/**
 * Write the plan file and push it (or its text) to WeChat.
 *
 * The file is the primary form — WeChat keeps it as a document the user can
 * open or forward — and the text fallback exists so a media failure never costs
 * the review itself.
 */
async function deliverPlan({ review, target, stateRoot, sendFile, sendText, readMediaEnabled, warn, sessionId, key }) {
  const filePath = planFilePath(stateRoot, review.callId)
  let fileReady = false
  try {
    await mkdir(plansDir(stateRoot), { recursive: true })
    await writeFile(filePath, review.plan, 'utf8')
    // The sidecar is best-effort: a failed metadata write must not cost the
    // delivery, it only hides the plan from the default `/files` listing.
    await writeFile(
      planMetaPath(stateRoot, review.callId),
      JSON.stringify({
        schemaVersion: 1,
        callId: review.callId,
        sessionId: typeof sessionId === 'string' ? sessionId : '',
        key: typeof key === 'string' ? key : '',
        conversationId: target.conversationId,
        title: review.title,
        filePath,
        at: Date.now(),
      }),
      'utf8',
    ).catch(() => {})
    fileReady = true
    await prunePlans(plansDir(stateRoot))
  } catch (error) {
    warn(`could not write plan file: ${String(error?.message ?? error)}`)
  }

  const caption = planReviewInstructions(review.title)
  if (fileReady && readMediaEnabled() !== false) {
    try {
      await sendFile({ transport: target.transport, conversationId: target.conversationId, filePath, caption })
      return
    } catch (error) {
      warn(`plan file send failed, falling back to text: ${String(error?.message ?? error)}`)
    }
  }
  await sendText(target.transport, target.conversationId, `${caption}\n\n${review.plan}`)
}

/** Keep the plans directory bounded; old plans are only a convenience. */
async function prunePlans(dir, keep = PLANS_KEEP) {
  let names
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.md'))
  } catch {
    return
  }
  if (names.length <= keep) return
  const rows = await Promise.all(names.map(async (name) => {
    try {
      return { name, mtimeMs: (await stat(join(dir, name))).mtimeMs }
    } catch {
      return undefined
    }
  }))
  const sorted = rows.filter(Boolean).sort((left, right) => right.mtimeMs - left.mtimeMs)
  for (const row of sorted.slice(keep)) {
    await rm(join(dir, row.name), { force: true }).catch(() => {})
    // Drop the sidecar with its plan, otherwise `/files` would list a plan
    // whose Markdown no longer exists.
    await rm(join(dir, row.name.replace(/\.md$/, '.json')), { force: true }).catch(() => {})
  }
}

/** Turn a binding record into a transport + conversation pair. */
function resolveTarget(binding, transportFor, fallbackTransport) {
  const entry = isRecord(binding.entry) ? binding.entry : {}
  let conversationId = typeof entry.conversationId === 'string' ? entry.conversationId : ''
  let accountId = typeof entry.accountId === 'string' ? entry.accountId : ''
  if (conversationId === '') {
    const separator = binding.key.lastIndexOf(':')
    if (separator >= 0) {
      conversationId = binding.key.slice(separator + 1)
      accountId = accountId === '' ? binding.key.slice(0, separator) : accountId
    } else {
      conversationId = binding.key
    }
  }
  if (conversationId === '') return undefined
  const transport = (accountId !== '' ? transportFor(accountId) : undefined) ?? fallbackTransport()
  if (transport === undefined || transport === null) return undefined
  return { transport, conversationId }
}

function createPending(key, now) {
  /** @type {any} */
  const entry = {
    key,
    settled: false,
    handedOff: false,
    waitTimer: undefined,
    handoffTimer: undefined,
    downstream: undefined,
    cleanup: undefined,
    settle: undefined,
  }
  entry.promise = new Promise((resolve) => {
    entry.resolve = resolve
  })
  entry.at = now()
  return entry
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
