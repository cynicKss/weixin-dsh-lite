import assert from 'node:assert/strict'
import test from 'node:test'

import {
  approvalText,
  createApprovalBroker,
  parseApprovalReply,
} from '../src/approval-review.js'

const KEY = 'acct:conv'
const SESSION = 'session-1'
const SENDER = 'wx-user'

function bindingsFor({ sessionId = SESSION, entry } = {}) {
  return {
    boundTo(candidate) {
      if (candidate !== sessionId) return undefined
      return {
        key: KEY,
        entry: entry ?? {
          sessionId,
          accountId: 'acct',
          conversationId: 'conv',
          senderId: SENDER,
          title: 'demo',
          cwd: 'C:/work',
        },
      }
    },
  }
}

function requestFor(overrides = {}) {
  return {
    agent: { session: { id: SESSION } },
    toolName: 'bash',
    callId: 'call-1',
    reason: 'needs sandbox escalation',
    ...overrides,
  }
}

function harness({ handoffMs = 0, enabled = true, send } = {}) {
  const sent = []
  const broker = createApprovalBroker({
    bindings: bindingsFor(),
    transportFor: () => ({ name: 'transport' }),
    fallbackTransport: () => ({ name: 'fallback' }),
    sendText: send ?? ((transport, conversationId, text) => {
      sent.push({ transport, conversationId, text })
      return Promise.resolve()
    }),
    readEnabled: () => enabled,
    readGuiHandoffMs: () => handoffMs,
  })
  return { broker, sent }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('parseApprovalReply maps 1/2/3 and keywords, ignores everything else', () => {
  assert.equal(parseApprovalReply('1'), 'allowed-once')
  assert.equal(parseApprovalReply(' /allow '), 'allowed-once')
  assert.equal(parseApprovalReply('同意'), 'allowed-once')
  assert.equal(parseApprovalReply('2'), 'rejected')
  assert.equal(parseApprovalReply('/reject'), 'rejected')
  assert.equal(parseApprovalReply('拒绝'), 'rejected')
  assert.equal(parseApprovalReply('3'), 'cancelled')
  assert.equal(parseApprovalReply('取消'), 'cancelled')
  assert.equal(parseApprovalReply('1 顺便把日志也发我'), undefined)
  assert.equal(parseApprovalReply(''), undefined)
})

test('approvalText names the tool, the bound session and the reason', () => {
  const text = approvalText(requestFor(), { sessionId: SESSION, title: 'demo' })
  assert.match(text, /危险操作待审批/)
  assert.match(text, /bash/)
  assert.match(text, /demo/)
  assert.match(text, /needs sandbox escalation/)
  assert.match(text, /1 允许一次/)
})

test('WeChat approval wins and the desktop answerer is never called', async () => {
  const { broker, sent } = harness()
  let nextCalls = 0
  const next = async () => {
    nextCalls += 1
    return 'rejected'
  }
  const running = broker.handleRequest(requestFor(), next)
  await tick()
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /bash/)
  // The transport asks this before scheduling, so the reply can bypass the
  // conversation chain that the blocked turn handler is holding.
  assert.equal(broker.hasPending(KEY), true)
  assert.equal(broker.handleInbound({ key: KEY, text: '1', senderId: SENDER, bindingSenderId: SENDER }), '已允许一次；这次操作会继续执行（只对本次生效）。')
  assert.equal(await running, 'allowed-once')
  assert.equal(nextCalls, 0)
  assert.equal(broker.pendingCount(), 0)
  assert.equal(broker.hasPending(KEY), false)
})

test('reject and cancel map to the host outcomes', async () => {
  const rejected = harness()
  const rejectedRun = rejected.broker.handleRequest(requestFor(), async () => 'allowed-once')
  await tick()
  rejected.broker.handleInbound({ key: KEY, text: '2', senderId: SENDER, bindingSenderId: SENDER })
  assert.equal(await rejectedRun, 'rejected')

  const cancelled = harness()
  const cancelledRun = cancelled.broker.handleRequest(requestFor(), async () => 'allowed-once')
  await tick()
  cancelled.broker.handleInbound({ key: KEY, text: '3', senderId: SENDER, bindingSenderId: SENDER })
  assert.equal(await cancelledRun, 'cancelled')
})

test('an unbound session is passed straight to the next answerer', async () => {
  const broker = createApprovalBroker({ bindings: { boundTo: () => undefined } })
  let called = 0
  const outcome = await broker.handleRequest(requestFor(), async () => {
    called += 1
    return 'allowed-once'
  })
  assert.equal(outcome, 'allowed-once')
  assert.equal(called, 1)
})

test('disabling the feature passes approvals to the desktop', async () => {
  const { broker } = harness({ enabled: false })
  const outcome = await broker.handleRequest(requestFor(), async () => 'rejected')
  assert.equal(outcome, 'rejected')
})

test('plain chat while an approval waits is not consumed', async () => {
  const { broker } = harness()
  const running = broker.handleRequest(requestFor(), async () => 'rejected')
  await tick()
  assert.equal(broker.handleInbound({ key: KEY, text: '帮我看看日志', senderId: SENDER, bindingSenderId: SENDER }), undefined)
  assert.equal(broker.pendingCount(), 1)
  broker.handleInbound({ key: KEY, text: '1', senderId: SENDER, bindingSenderId: SENDER })
  assert.equal(await running, 'allowed-once')
})

test('only the bound WeChat user can decide', async () => {
  const { broker } = harness()
  const running = broker.handleRequest(requestFor(), async () => 'rejected')
  await tick()
  const notice = broker.handleInbound({ key: KEY, text: '1', senderId: 'someone-else', bindingSenderId: SENDER })
  assert.match(notice, /另一位微信用户/)
  assert.equal(broker.pendingCount(), 1)
  broker.handleInbound({ key: KEY, text: '2', senderId: SENDER, bindingSenderId: SENDER })
  assert.equal(await running, 'rejected')
})

test('a second approval for the same conversation goes to the desktop', async () => {
  const { broker, sent } = harness()
  const first = broker.handleRequest(requestFor(), async () => 'rejected')
  await tick()
  const second = await broker.handleRequest(requestFor({ callId: 'call-2' }), async () => 'allowed-once')
  assert.equal(second, 'allowed-once')
  assert.ok(sent.some((item) => /已有一条危险操作/.test(item.text)))
  broker.handleInbound({ key: KEY, text: '1', senderId: SENDER, bindingSenderId: SENDER })
  assert.equal(await first, 'allowed-once')
})

test('an aborted request resolves as cancelled', async () => {
  const controller = new AbortController()
  const { broker } = harness()
  const running = broker.handleRequest(requestFor({ signal: controller.signal }), async () => 'allowed-once')
  await tick()
  controller.abort()
  assert.equal(await running, 'cancelled')
  assert.equal(broker.pendingCount(), 0)
})

test('a send failure falls back to the desktop instead of blocking the turn', async () => {
  const { broker } = harness({
    send: () => Promise.reject(new Error('transport down')),
  })
  const outcome = await broker.handleRequest(requestFor(), async () => 'rejected')
  assert.equal(outcome, 'rejected')
})

test('with handoff the desktop can take over, and WeChat is told the window closed', async () => {
  const { broker, sent } = harness({ handoffMs: 5 })
  const running = broker.handleRequest(requestFor(), async () => 'rejected')
  await sleep(10)
  assert.equal(await running, 'rejected')
  assert.ok(sent.some((item) => /已在桌面端处理/.test(item.text)))
  assert.equal(broker.handleInbound({ key: KEY, text: '1', senderId: SENDER, bindingSenderId: SENDER }), undefined)
  assert.equal(broker.pendingCount(), 0)
})

test('when the handoff answerer is unavailable WeChat keeps waiting', async () => {
  const { broker, sent } = harness({ handoffMs: 5 })
  const running = broker.handleRequest(requestFor(), async () => {
    throw new Error('no desktop answerer')
  })
  await sleep(15)
  assert.ok(sent.some((item) => /桌面端现在接不了/.test(item.text)))
  broker.handleInbound({ key: KEY, text: '1', senderId: SENDER, bindingSenderId: SENDER })
  assert.equal(await running, 'allowed-once')
})

test('statusLine reports the pending count', async () => {
  const { broker } = harness()
  assert.equal(broker.statusLine(), '')
  const running = broker.handleRequest(requestFor(), async () => 'rejected')
  await tick()
  assert.match(broker.statusLine(), /待审批：1 条/)
  broker.handleInbound({ key: KEY, text: '2', senderId: SENDER, bindingSenderId: SENDER })
  await running
  assert.equal(broker.statusLine(), '')
})
