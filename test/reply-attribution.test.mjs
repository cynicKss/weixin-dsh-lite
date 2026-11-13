import assert from 'node:assert/strict'
import test from 'node:test'
import { isAgentBusy, replyForPrompt } from '../src/agent-bridge.js'

const userEvent = (seq, text) => ({
  seq,
  type: 'user/message',
  data: { message: { content: [{ type: 'text', text }] } },
})
const assistantEvent = (seq, text, turn = 1) => ({
  seq,
  type: 'assistant/message',
  data: { turn, step: 1, message: { content: [{ type: 'text', text }] } },
})
const start = (seq, turn = 1) => ({ seq, type: 'turn/start', data: { turn } })
const end = (seq, turn = 1) => ({ seq, type: 'turn/end', data: { turn, reason: { kind: 'done' } } })

const agentWith = (events) => ({ session: { snapshotEvents: () => events } })

test('isAgentBusy follows the last turn boundary', () => {
  assert.equal(isAgentBusy(agentWith([])), false)
  assert.equal(isAgentBusy(agentWith([start(1), assistantEvent(2, 'hi')])), true)
  assert.equal(isAgentBusy(agentWith([start(1), end(2), start(3)])), true)
  assert.equal(isAgentBusy(agentWith([start(1), end(2)])), false)
  // A snapshot without a session (an agent being disposed) is not "busy".
  assert.equal(isAgentBusy({}), false)
})

test('a reply is attributed to the prompt that caused it', () => {
  const events = [start(1), userEvent(2, '你好'), assistantEvent(3, '在的'), end(4)]
  assert.deepEqual(replyForPrompt({ events, before: 1, text: '你好' }), { text: '在的', promptSeq: 2 })
})

test('a prompt that has not been seen yet cannot claim an older reply', () => {
  const events = [start(1), userEvent(2, '你好'), assistantEvent(3, '在的'), end(4)]
  // before=4 means "everything up to and including the previous turn": the
  // prompt is not there yet, so no reply may be attributed.
  assert.equal(replyForPrompt({ events, before: 4, text: '你好' }), undefined)
})

test('someone else\'s prompt does not match', () => {
  const events = [start(1), userEvent(2, '来自 GUI 的消息'), assistantEvent(3, '答案'), end(4)]
  assert.equal(replyForPrompt({ events, before: -1, text: '来自微信的消息' }), undefined)
})

test('the earliest unclaimed identical prompt wins (cursor, not newest)', () => {
  const events = [
    start(1), userEvent(2, '几点了'), assistantEvent(3, '旧答案'), end(4),
    start(5), userEvent(6, '几点了'), assistantEvent(7, '新答案'), end(8),
  ]
  // before=-1 claims the first copy; before=4 (the cursor the first bound turn
  // leaves behind) claims the second. A "newest match" rule would answer the
  // second question with the first question's text.
  assert.deepEqual(replyForPrompt({ events, before: -1, text: '几点了' }), { text: '旧答案', promptSeq: 2 })
  assert.deepEqual(replyForPrompt({ events, before: 4, text: '几点了' }), { text: '新答案', promptSeq: 6 })
})

test('a turn that ended without text is reported as done, not as a pending result', () => {
  const events = [start(1), userEvent(2, '继续'), end(3)]
  assert.deepEqual(replyForPrompt({ events, before: -1, text: '继续' }), { text: '', done: true, promptSeq: 2 })
})

test('a failed turn surfaces the model error instead of waiting out the timeout', () => {
  const events = [
    start(1),
    userEvent(2, '继续'),
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'context overflow' } } } },
  ]
  const reply = replyForPrompt({ events, before: -1, text: '继续' })
  assert.equal(reply.text, '')
  assert.match(reply.turnError, /context overflow/)
})
