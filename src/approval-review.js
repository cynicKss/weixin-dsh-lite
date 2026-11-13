/**
 * WeChat approval for a bound session's dangerous-operation prompts.
 *
 * The host dispatches `approval/request` over a waterfall (see
 * `@deepseek-ai/dsh-user-approval`): an answerer returns one of
 * `allowed-once` / `rejected` / `cancelled` / `unavailable`, and the pair
 * `approval/asked` + `approval/decided` is appended to the session log.
 *
 * We answer that waterfall for sessions a WeChat conversation is bound to.
 * The workflow deliberately mirrors the plan-review broker:
 *
 * - Default (handoff 0) WeChat owns the request and the request is NEVER
 *   passed to `next()`. Forwarding a request makes the desktop client render
 *   a card that only that client's own waterfall can remove; answering on
 *   WeChat first would leave the desktop card pending forever.
 * - `handoffMs > 0` hands the request to the desktop after the delay. The
 *   desktop card appears then, and a WeChat reply afterwards only gets a
 *   notice. If no desktop answerer is available `next()` rejects and we keep
 *   waiting in WeChat instead of failing the tool closed.
 * - `request.signal` aborts (turn cancelled / finished) resolve as
 *   `cancelled`, so a turn never waits on an answerer that can no longer
 *   arrive.
 *
 * Only bound sessions are intercepted; unbounded conversations keep the
 * normal desktop approval card.
 */

/** Outcomes the host waterfall accepts. */
const OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

/** Reply acknowledgement per decision. */
const ACK = {
  'allowed-once': '已允许一次；这次操作会继续执行（只对本次生效）。',
  rejected: '已拒绝这次操作。',
  cancelled: '已取消这次审批；这一轮会被中断。',
}

/**
 * Parse a WeChat reply into an approval outcome.
 * @param {string} text inbound message text
 * @returns {'allowed-once' | 'rejected' | 'cancelled' | undefined}
 */
export function parseApprovalReply(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return undefined
  const value = raw.toLowerCase()
  if (value === '1' || value === '/allow' || value === '/approve' || raw === '同意' || raw === '允许' || raw === '批准') {
    return 'allowed-once'
  }
  if (value === '2' || value === '/deny' || value === '/reject' || raw === '拒绝' || raw === '不允许' || raw === '驳回') {
    return 'rejected'
  }
  if (value === '3' || value === '/cancel' || value === '/stop' || raw === '取消') {
    return 'cancelled'
  }
  return undefined
}

/**
 * Human-readable reason, preferring the host's localized copy.
 * @param {object} request approval request
 * @returns {string}
 */
export function approvalReason(request) {
  const display = request?.displayReason
  if (display !== null && typeof display === 'object') {
    if (typeof display.zh === 'string' && display.zh !== '') return display.zh
    if (typeof display.en === 'string' && display.en !== '') return display.en
  }
  if (typeof request?.reason === 'string' && request.reason !== '') return request.reason
  return ''
}

/**
 * Build the WeChat prompt for one request.
 * @param {object} request approval request
 * @param {object} [entry] binding entry (`sessionId`, `title`, ...)
 * @returns {string}
 */
export function approvalText(request, entry) {
  const title = typeof entry?.title === 'string' && entry.title !== '' ? `「${entry.title}」` : ''
  const sessionId = typeof entry?.sessionId === 'string' ? entry.sessionId : ''
  const reason = approvalReason(request)
  const tool = typeof request?.toolName === 'string' && request.toolName !== '' ? request.toolName : '未知工具'
  return [
    '🔐 危险操作待审批',
    `会话：${title}${sessionId}`,
    `工具：${tool}`,
    `原因：${reason === '' ? '（未提供）' : reason}`,
    '',
    '回复：1 允许一次 / 2 拒绝 / 3 取消（只对本次操作生效）',
  ].join('\n')
}

/**
 * Split the scoped line key when the binding predates the accountId field.
 * @param {string} key `scopedLineKey` value
 * @returns {{ accountId: string, conversationId: string }}
 */
function splitKey(key) {
  const value = String(key ?? '')
  const at = value.lastIndexOf(':')
  if (at <= 0) return { accountId: '', conversationId: value }
  return { accountId: value.slice(0, at), conversationId: value.slice(at + 1) }
}

/**
 * Resolve the transport and conversation a binding entry belongs to.
 * @param {object} args broker dependencies
 * @param {string} key binding key
 * @param {object} entry binding entry
 * @returns {{ transport: object, conversationId: string, accountId: string } | undefined}
 */
function resolveTarget({ transportFor, fallbackTransport }, key, entry) {
  const fallback = splitKey(key)
  const accountId = typeof entry?.accountId === 'string' && entry.accountId !== '' ? entry.accountId : fallback.accountId
  const conversationId = typeof entry?.conversationId === 'string' && entry.conversationId !== ''
    ? entry.conversationId
    : fallback.conversationId
  if (conversationId === '') return undefined
  const transport = (accountId !== '' ? transportFor?.(accountId) : undefined) ?? fallbackTransport?.()
  if (transport === undefined) return undefined
  return { transport, conversationId, accountId }
}

/**
 * Build a pending decision record.
 * @param {object} args the request, its key and the target transport
 * @returns {object} pending entry
 */
function createPending({ key, request, target, pending }) {
  const decision = Promise.withResolvers()
  const entry = {
    key,
    request,
    target,
    settled: false,
    handedOff: false,
    handoffTimer: undefined,
    cleanup: () => {},
    settle: () => false,
    resolveHandoff: undefined,
  }
  const finish = (outcome) => {
    if (entry.settled) return false
    entry.settled = true
    decision.resolve(OUTCOMES.has(outcome) ? outcome : 'unavailable')
    return true
  }
  entry.settle = finish
  entry.decision = decision.promise
  const onAbort = () => finish('cancelled')
  if (request?.signal !== undefined) {
    request.signal.addEventListener?.('abort', onAbort, { once: true })
    if (request.signal.aborted) onAbort()
  }
  entry.cleanup = () => {
    if (entry.handoffTimer !== undefined) {
      clearTimeout(entry.handoffTimer)
      entry.handoffTimer = undefined
    }
    request?.signal?.removeEventListener?.('abort', onAbort)
    if (pending.get(key) === entry) pending.delete(key)
  }
  return entry
}

/**
 * Create the approval broker used by the plugin.
 * @param {object} deps broker dependencies
 * @param {object} [deps.bindings] BindingStore instance
 * @param {(accountId: string) => object | undefined} [deps.transportFor] transport lookup
 * @param {() => object | undefined} [deps.fallbackTransport] any live transport
 * @param {(transport: object, conversationId: string, text: string) => Promise<void>} [deps.sendText] text sender
 * @param {() => boolean} [deps.readEnabled] live config switch
 * @param {() => number} [deps.readGuiHandoffMs] live handoff delay
 * @param {(message: string) => void} [deps.warn] warning sink
 * @param {(message: string) => void} [deps.log] info sink
 * @returns {{ handleRequest: Function, handleInbound: Function, statusLine: Function, pendingCount: Function }}
 */
export function createApprovalBroker({
  bindings,
  transportFor,
  fallbackTransport,
  sendText,
  readEnabled = () => true,
  readGuiHandoffMs = () => 0,
  onSettled = () => {},
  warn = () => {},
  log = () => {},
} = {}) {
  const pending = new Map()
  const deps = { transportFor, fallbackTransport }

  const notify = async (entry, text) => {
    try {
      await sendText?.(entry.target.transport, entry.target.conversationId, text)
    } catch (error) {
      warn(`approval: sending a notice failed: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Answer one host approval request, or pass it to the next answerer.
   * @param {object} request host approval request
   * @param {Function} next next waterfall answerer
   * @returns {Promise<string>} outcome
   */
  async function handleRequest(request, next) {
    if (readEnabled() === false) return next()
    const sessionId = request?.agent?.session?.id
    const bound = typeof sessionId === 'string' && sessionId !== '' ? bindings?.boundTo?.(sessionId) : undefined
    if (bound === undefined) return next()
    const key = bound.key
    if (pending.has(key)) {
      const current = pending.get(key)
      await notify(current, '已有一条危险操作在等你审批；这一条交给桌面端处理。')
      return next()
    }
    const target = resolveTarget(deps, key, bound.entry)
    if (target === undefined) return next()
    try {
      await sendText?.(target.transport, target.conversationId, approvalText(request, bound.entry))
    } catch (error) {
      warn(`approval: sending the prompt failed, falling back to the desktop: ${String(error?.message ?? error)}`)
      return next()
    }
    const entry = createPending({ key, request, target, pending })
    pending.set(key, entry)
    log(`approval: forwarded ${request?.toolName ?? 'tool'} for ${key}`)

    const wechat = entry.decision.then((outcome) => ({ via: 'wechat', outcome }))
    const handoffMs = Number(readGuiHandoffMs?.() ?? 0)
    if (!(handoffMs > 0)) {
      const settled = await wechat
      entry.cleanup()
      return settled.outcome
    }

    const handoff = new Promise((resolve) => {
      entry.resolveHandoff = resolve
    })
    entry.handoffTimer = setTimeout(() => {
      if (entry.settled) return
      entry.handedOff = true
      log(`approval: handing ${key} to the desktop after ${handoffMs}ms`)
      Promise.resolve()
        .then(() => next())
        .then(
          (outcome) => entry.resolveHandoff?.({ via: 'downstream', outcome }),
          (error) => entry.resolveHandoff?.({ via: 'downstream-error', error }),
        )
    }, handoffMs)

    const first = await Promise.race([wechat, handoff])
    if (first.via === 'wechat') {
      entry.cleanup()
      return first.outcome
    }
    if (first.via === 'downstream') {
      entry.settled = true
      await notify(entry, '（这条危险操作已在桌面端处理，微信审批已关闭。）')
      entry.cleanup()
      return OUTCOMES.has(first.outcome) ? first.outcome : 'unavailable'
    }
    entry.handedOff = false
    await notify(entry, '（桌面端现在接不了这条审批，继续在微信回复 1/2/3。）')
    const settled = await wechat
    entry.cleanup()
    return settled.outcome
  }

  /**
   * Consume a WeChat reply that decides a pending approval.
   * @param {object} args inbound facts
   * @param {string} args.key binding key
   * @param {string} args.text trimmed message text
   * @param {string} [args.senderId] WeChat sender id
   * @param {string} [args.bindingSenderId] sender the binding belongs to
   * @returns {string | undefined} acknowledgement text, or undefined to keep the normal pipeline
   */
  function handleInbound({ key, text, senderId, bindingSenderId } = {}) {
    const entry = pending.get(key)
    if (entry === undefined) return undefined
    const trimmed = String(text ?? '').trim()
    if (entry.handedOff) {
      if (trimmed === '' || parseApprovalReply(trimmed) === undefined) return undefined
      return '这条审批已经交给桌面端等待处理，请在桌面端允许或拒绝。'
    }
    if (typeof bindingSenderId === 'string' && bindingSenderId !== '' && typeof senderId === 'string' && senderId !== '' && bindingSenderId !== senderId) {
      return '这条会话绑定给了另一位微信用户，危险操作的审批只能由绑定人回复。'
    }
    const outcome = parseApprovalReply(trimmed)
    if (outcome === undefined) return undefined
    if (!entry.settle(outcome)) return undefined
    entry.cleanup()
    // A WeChat approval can be answering a turn that was started on the
    // desktop. Nothing is waiting to send that turn's answer back here, so the
    // channel has to follow the turn itself once it settles.
    try {
      onSettled({ key, request: entry.request, outcome })
    } catch (error) {
      warn(`approval: post-verdict hook failed: ${String(error?.message ?? error)}`)
    }
    return ACK[outcome]
  }

  /** @returns {string} a `/status` line, or '' when nothing is pending */
  function statusLine() {
    if (pending.size === 0) return ''
    return `待审批：${pending.size} 条（在微信回复 1 允许一次 / 2 拒绝 / 3 取消）`
  }

  /** @returns {number} how many approvals wait for a WeChat reply */
  function pendingCount() {
    return pending.size
  }

  /**
   * Whether this conversation has an approval waiting for a WeChat reply.
   *
   * The inbound dispatcher serializes one conversation's messages so a turn's
   * handler cannot be re-entered — but a turn blocked on an approval IS the
   * handler that is running, so the reply has to bypass that chain. This
   * predicate is what lets the transport pick the reply out of the queue.
   * @param {string} key binding key
   */
  function hasPending(key) {
    return pending.has(key)
  }

  return { handleRequest, handleInbound, statusLine, pendingCount, hasPending }
}
