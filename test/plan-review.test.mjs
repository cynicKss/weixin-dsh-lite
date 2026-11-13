import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  APPROVE_LABEL,
  KEEP_PLANNING_LABEL,
  buildAnswer,
  createPlanReviewBroker,
  findPlanReview,
  listPlanFiles,
  parseReviewReply,
  planFilePath,
  planTitle,
} from '../src/plan-review.js'

const PLAN = '# 把 X 做掉\n\n1. 先写测试\n2. 再改实现\n'

function reviewRequest(overrides = {}) {
  return {
    agent: { id: 'session-1' },
    signal: new AbortController().signal,
    questions: [{
      id: 'plan-review',
      header: 'Plan review',
      question: 'Approve this plan and leave plan mode?',
      detail: PLAN,
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-1' },
    }],
    ...overrides,
  }
}

async function waitFor(check, timeoutMs = 2000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/** A broker with an in-memory transport; `ui` and `files` record what was sent. */
async function brokerFixture({ waitMs = 0, handoffMs = 0, mediaEnabled = true, transport, boundTo } = {}) {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-plan-review-'))
  const ui = []
  const files = []
  const broker = createPlanReviewBroker({
    stateRoot,
    bindings: {
      boundTo: boundTo ?? ((id) => (id === 'session-1'
        ? { key: 'acct:conv', entry: { sessionId: id, conversationId: 'conv', accountId: 'acct', senderId: 'u1' } }
        : undefined)),
    },
    transportFor: (id) => (id === 'acct' ? (transport ?? { sendMedia: async () => {} }) : undefined),
    fallbackTransport: () => undefined,
    sendText: async (t, conversationId, text) => {
      ui.push({ conversationId, text })
    },
    sendFile: async ({ transport: active, conversationId, filePath, caption }) => {
      files.push({ conversationId, filePath, caption })
      await active.sendMedia({ filePath, conversationId, caption })
    },
    readMediaEnabled: () => mediaEnabled,
    readWaitMs: () => waitMs,
    readGuiHandoffMs: () => handoffMs,
    warn: () => {},
    log: () => {},
  })
  return { stateRoot, broker, ui, files }
}

test('findPlanReview picks only the plan-mode question', () => {
  const found = findPlanReview(reviewRequest())
  assert.equal(found.callId, 'call-1')
  assert.equal(found.plan, PLAN)
  assert.equal(found.title, '把 X 做掉')
  assert.equal(findPlanReview({ questions: [{ id: 'ask-1', detail: 'x' }] }), undefined)
  assert.equal(findPlanReview({ questions: [{ id: 'plan-review', detail: PLAN }] }), undefined)
  assert.equal(findPlanReview({ questions: [{ id: 'plan-review', detail: '   ', intent: { kind: 'plan-review' } }] }), undefined)
  assert.equal(findPlanReview(undefined), undefined)
})

test('planTitle falls back and planFilePath stays inside the plans directory', () => {
  assert.equal(planTitle('no heading here'), '计划')
  assert.equal(planTitle('## second level only'), '计划')
  const inside = planFilePath('C:/state', 'call-1')
  assert.equal(path.basename(inside), 'call-1.md')
  assert.equal(path.basename(planFilePath('C:/state', 'a/b c')), 'a-b-c.md')
})

test('parseReviewReply accepts the labels a phone user can type', () => {
  assert.deepEqual(parseReviewReply('1'), { kind: 'approve' })
  assert.deepEqual(parseReviewReply(' 同意 '), { kind: 'approve' })
  assert.deepEqual(parseReviewReply('/approve'), { kind: 'approve' })
  assert.deepEqual(parseReviewReply('approve'), { kind: 'approve' })
  assert.deepEqual(parseReviewReply('2'), { kind: 'reject', feedback: '' })
  assert.deepEqual(parseReviewReply('2 先写测试'), { kind: 'reject', feedback: '先写测试' })
  assert.deepEqual(parseReviewReply('/reject 补上回滚'), { kind: 'reject', feedback: '补上回滚' })
  assert.deepEqual(parseReviewReply('这个方案太冒险'), { kind: 'reject', feedback: '这个方案太冒险' })
  assert.deepEqual(parseReviewReply('/cancel'), { kind: 'cancel' })
  assert.equal(parseReviewReply('   '), undefined)
})

test('buildAnswer matches the shape exit_plan_mode validates', () => {
  assert.deepEqual(buildAnswer({ kind: 'approve' }), {
    answers: [{ id: 'plan-review', selected: [APPROVE_LABEL] }],
  })
  const rejected = buildAnswer({ kind: 'reject', feedback: '先写测试' })
  assert.deepEqual(rejected, {
    answers: [{ id: 'plan-review', selected: [KEEP_PLANNING_LABEL], custom: '先写测试' }],
  })
  assert.equal(buildAnswer({ kind: 'reject', feedback: '' }).answers[0].custom, '（微信端要求继续修改）')
})

test('by default WeChat owns the review and the GUI is never asked', async () => {
  const { stateRoot, broker, ui, files } = await brokerFixture()
  let nextCalls = 0
  try {
    const pending = broker.handleRequest(reviewRequest(), () => {
      nextCalls += 1
      return new Promise(() => {})
    })
    await waitFor(() => broker.pendingCount() === 1)
    assert.equal(files.length, 1)
    assert.equal(await fs.readFile(files[0].filePath, 'utf8'), PLAN)
    assert.match(files[0].caption, /计划待批准/)
    assert.match(files[0].caption, /回复 1 = 批准并继续/)

    assert.equal(
      broker.handleInbound({ key: 'acct:conv', text: '1', senderId: 'u1', bindingSenderId: 'u1' }),
      '已批准计划，Agent 继续执行。',
    )
    assert.deepEqual(await pending, {
      answers: [{ id: 'plan-review', selected: [APPROVE_LABEL] }],
    })
    assert.equal(nextCalls, 0)
    assert.equal(broker.pendingCount(), 0)
    assert.equal(ui.length, 0)
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a delivered plan is listed for its own bound session only', async () => {
  const { stateRoot, broker } = await brokerFixture()
  try {
    const pending = broker.handleRequest(reviewRequest(), () => new Promise(() => {}))
    await waitFor(() => broker.pendingCount() === 1)
    const plans = await listPlanFiles({ stateRoot, sessionId: 'session-1' })
    assert.equal(plans.length, 1)
    assert.equal(plans[0].name, 'call-1.md')
    assert.equal(plans[0].title, planTitle(PLAN))
    assert.equal(await fs.readFile(plans[0].path, 'utf8'), PLAN)
    // The reply has to bypass the conversation chain (see approval-review).
    assert.equal(broker.hasPending('acct:conv'), true)
    // Another conversation's /files must not see this plan.
    assert.deepEqual(await listPlanFiles({ stateRoot, sessionId: 'session-2' }), [])
    broker.handleInbound({ key: 'acct:conv', text: '1', senderId: 'u1', bindingSenderId: 'u1' })
    assert.equal(broker.hasPending('acct:conv'), false)
    broker.handleInbound({ key: 'acct:conv', text: '1', senderId: 'u1', bindingSenderId: 'u1' })
    assert.equal((await pending).answers[0].selected[0], APPROVE_LABEL)
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a rejection carries the feedback back as custom', async () => {
  const { stateRoot, broker } = await brokerFixture()
  try {
    const pending = broker.handleRequest(reviewRequest(), () => new Promise(() => {}))
    await waitFor(() => broker.pendingCount() === 1)
    assert.equal(
      broker.handleInbound({ key: 'acct:conv', text: '2 先写测试', senderId: 'u1', bindingSenderId: 'u1' }),
      '已按「打回」处理：先写测试',
    )
    assert.deepEqual(await pending, {
      answers: [{ id: 'plan-review', selected: [KEEP_PLANNING_LABEL], custom: '先写测试' }],
    })
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a plain message is feedback, not an unknown command', async () => {
  const { stateRoot, broker } = await brokerFixture()
  try {
    const pending = broker.handleRequest(reviewRequest(), () => new Promise(() => {}))
    await waitFor(() => broker.pendingCount() === 1)
    broker.handleInbound({ key: 'acct:conv', text: '补上失败回滚', senderId: 'u1', bindingSenderId: 'u1' })
    assert.equal((await pending).answers[0].custom, '补上失败回滚')
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a handoff lets the desktop answer, and WeChat is told once', async () => {
  const { stateRoot, broker, ui } = await brokerFixture({ handoffMs: 5 })
  try {
    const guiAnswer = { answers: [{ id: 'plan-review', selected: [APPROVE_LABEL] }] }
    const answer = await broker.handleRequest(reviewRequest(), async () => guiAnswer)
    assert.deepEqual(answer, guiAnswer)
    assert.equal(broker.pendingCount(), 0)
    await waitFor(() => ui.some((message) => message.text.includes('桌面端')))
    // After the GUI settled it, a late WeChat message is no longer a verdict.
    assert.equal(
      broker.handleInbound({ key: 'acct:conv', text: '1', senderId: 'u1', bindingSenderId: 'u1' }),
      undefined,
    )
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('after a handoff WeChat gets a notice and does not settle the review', async () => {
  const { stateRoot, broker } = await brokerFixture({ handoffMs: 5 })
  try {
    let release
    const gui = new Promise((resolve) => { release = resolve })
    const pending = broker.handleRequest(reviewRequest(), () => gui)
    await waitFor(() => broker.pendingCount() === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(
      broker.handleInbound({ key: 'acct:conv', text: '1', senderId: 'u1', bindingSenderId: 'u1' }),
      '这条计划已经交给桌面端等待处理，请在桌面端批准或打回。',
    )
    // A slash command that is not a verdict still works normally.
    assert.equal(
      broker.handleInbound({ key: 'acct:conv', text: '/files', senderId: 'u1', bindingSenderId: 'u1' }),
      undefined,
    )
    assert.equal(broker.pendingCount(), 1)
    release({ answers: [{ id: 'plan-review', selected: [APPROVE_LABEL] }] })
    const answer = await pending
    assert.equal(answer.answers[0].selected[0], APPROVE_LABEL)
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a failed handoff (no GUI answerer) keeps waiting for WeChat', async () => {
  const { stateRoot, broker } = await brokerFixture({ handoffMs: 5 })
  try {
    const pending = broker.handleRequest(reviewRequest(), () => Promise.reject(new Error('no answerer available')))
    await waitFor(() => broker.pendingCount() === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    broker.handleInbound({ key: 'acct:conv', text: '同意', senderId: 'u1', bindingSenderId: 'u1' })
    assert.deepEqual(await pending, {
      answers: [{ id: 'plan-review', selected: [APPROVE_LABEL] }],
    })
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a WeChat verdict before the handoff cancels the timer', async () => {
  const { stateRoot, broker } = await brokerFixture({ handoffMs: 1000 })
  let nextCalls = 0
  try {
    const pending = broker.handleRequest(reviewRequest(), () => {
      nextCalls += 1
      return new Promise(() => {})
    })
    await waitFor(() => broker.pendingCount() === 1)
    broker.handleInbound({ key: 'acct:conv', text: '1', senderId: 'u1', bindingSenderId: 'u1' })
    await pending
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(nextCalls, 0)
    assert.equal(broker.pendingCount(), 0)
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('non-review asks and unbound sessions pass through untouched', async () => {
  const { stateRoot, broker, files } = await brokerFixture()
  try {
    const sentinel = { answers: [] }
    assert.deepEqual(
      await broker.handleRequest({ questions: [{ id: 'ask-1', detail: 'plain question' }] }, async () => sentinel),
      sentinel,
    )
    assert.deepEqual(
      await broker.handleRequest(reviewRequest({ agent: { id: 'session-other' } }), async () => sentinel),
      sentinel,
    )
    assert.equal(broker.pendingCount(), 0)
    assert.equal(files.length, 0)
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a second review for the same conversation goes to the GUI', async () => {
  const { stateRoot, broker } = await brokerFixture()
  try {
    const first = broker.handleRequest(reviewRequest(), () => new Promise(() => {}))
    await waitFor(() => broker.pendingCount() === 1)
    const sentinel = { answers: [] }
    assert.deepEqual(await broker.handleRequest(reviewRequest(), async () => sentinel), sentinel)
    broker.handleInbound({ key: 'acct:conv', text: '/cancel', senderId: 'u1', bindingSenderId: 'u1' })
    assert.equal((await first).answers[0].custom, '（微信端要求继续修改）')
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('media disabled falls back to text, and a failed file send does too', async () => {
  const disabled = await brokerFixture({ mediaEnabled: false })
  try {
    const pending = disabled.broker.handleRequest(reviewRequest(), () => new Promise(() => {}))
    await waitFor(() => disabled.broker.pendingCount() === 1)
    assert.equal(disabled.ui.length, 1)
    assert.equal(disabled.files.length, 0)
    assert.match(disabled.ui[0].text, /先写测试/)
    disabled.broker.handleInbound({ key: 'acct:conv', text: '1', senderId: 'u1', bindingSenderId: 'u1' })
    await pending
  } finally {
    await fs.rm(disabled.stateRoot, { recursive: true, force: true })
  }

  const failing = await brokerFixture({
    transport: { sendMedia: async () => { throw new Error('upload refused') } },
  })
  try {
    const pending = failing.broker.handleRequest(reviewRequest(), () => new Promise(() => {}))
    await waitFor(() => failing.broker.pendingCount() === 1)
    assert.equal(failing.ui.length, 1)
    assert.match(failing.ui[0].text, /先写测试/)
    failing.broker.handleInbound({ key: 'acct:conv', text: '1', senderId: 'u1', bindingSenderId: 'u1' })
    await pending
  } finally {
    await fs.rm(failing.stateRoot, { recursive: true, force: true })
  }
})

test('only the binding sender can decide, and a timeout keeps the agent moving', async () => {
  const { stateRoot, broker } = await brokerFixture({ waitMs: 40 })
  try {
    const pending = broker.handleRequest(reviewRequest(), () => new Promise(() => {}))
    await waitFor(() => broker.pendingCount() === 1)
    assert.equal(
      broker.handleInbound({ key: 'acct:conv', text: '1', senderId: 'u2', bindingSenderId: 'u1' }),
      '这条会话绑定给了另一位微信用户，计划审批只能由绑定人回复。',
    )
    assert.equal(broker.pendingCount(), 1)
    const answer = await pending
    assert.equal(answer.answers[0].selected[0], KEEP_PLANNING_LABEL)
    assert.match(answer.answers[0].custom, /超时/)
    assert.equal(broker.pendingCount(), 0)
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('aborting the ask clears the pending review', async () => {
  const { stateRoot, broker } = await brokerFixture()
  try {
    const controller = new AbortController()
    const pending = broker.handleRequest(reviewRequest({ signal: controller.signal }), () => new Promise(() => {}))
    await waitFor(() => broker.pendingCount() === 1)
    controller.abort()
    const answer = await pending
    assert.equal(answer.answers[0].selected[0], KEEP_PLANNING_LABEL)
    assert.equal(broker.pendingCount(), 0)
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})
