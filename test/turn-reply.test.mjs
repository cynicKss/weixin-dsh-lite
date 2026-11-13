import assert from 'node:assert/strict'
import test from 'node:test'
import { turnReplyAfter } from '../src/agent-bridge.js'

const text = (value) => [{ type: 'text-chunks', texts: [value] }]

function events() {
  return [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'do it' }] } } },
    { seq: 3, type: 'assistant/message', data: { stream: text('before the approval') } },
    { seq: 4, type: 'approval/asked', data: { id: 'a1', toolName: 'pwsh' } },
    { seq: 5, type: 'assistant/message', data: { stream: text('after the approval') } },
    { seq: 6, type: 'tool/call', data: { callId: 'c1', name: 'read' } },
    { seq: 7, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
}

test('turnReplyAfter only reports text produced after the settled request', () => {
  const result = turnReplyAfter({ events: events(), sinceSeq: 4 })
  assert.deepEqual(result, { text: 'after the approval', endSeq: 7 })
})

test('turnReplyAfter keeps the last assistant text of the turn', () => {
  const list = events()
  list.splice(6, 0, { seq: 6.5, type: 'assistant/message', data: { stream: text('final answer') } })
  const result = turnReplyAfter({ events: list, sinceSeq: 4 })
  assert.equal(result.text, 'final answer')
})

test('turnReplyAfter reports an unfinished turn as undefined', () => {
  const list = events().filter((event) => event.type !== 'turn/end')
  assert.equal(turnReplyAfter({ events: list, sinceSeq: 4 }), undefined)
})

test('turnReplyAfter surfaces a failed turn', () => {
  const list = events()
  list[list.length - 1] = {
    seq: 7,
    type: 'turn/end',
    data: { reason: { kind: 'error', error: { message: 'provider exploded' } } },
  }
  const result = turnReplyAfter({ events: list, sinceSeq: 4 })
  assert.equal(result.turnError, 'provider exploded')
})

test('turnReplyAfter reports a closed turn that produced no text', () => {
  const list = [
    { seq: 8, type: 'turn/start', data: { turn: 2 } },
    { seq: 9, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  assert.deepEqual(turnReplyAfter({ events: list, sinceSeq: 7 }), { text: '', endSeq: 9 })
})
