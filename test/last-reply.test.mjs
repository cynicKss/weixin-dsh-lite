/**
 * `/bind` catch-up: read the last assistant text out of the bound session.
 *
 * The bridge is exercised with a fake agents service so the test never touches
 * the host: the point is that binding opens the session read-only and returns
 * the newest assistant text, and that an empty history is '' rather than a
 * thrown error (a bind must still succeed when there is nothing to quote).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentBridge } from '../src/agent-bridge.js'

function makeAgent(events) {
  return {
    options: {},
    session: { id: 'session-x', snapshotEvents: () => events },
  }
}

function makeBridge(agent) {
  const agents = {
    get: () => undefined,
    resume: async () => ({ agent, dispose: async () => {} }),
  }
  const ctx = { get: (name) => (name === 'agents' ? agents : undefined) }
  return new AgentBridge({
    ctx,
    cwd: 'C:/tmp',
    log: () => {},
    errLog: () => {},
    // The default would read the operator's real sessions.json.
    lines: { active: () => 'session-x' },
  })
}

function assistantTurn(seq, text) {
  return [
    { seq: seq + 0, type: 'turn/start', data: { turn: 1 } },
    { seq: seq + 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'go' }] } } },
    { seq: seq + 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } },
    { seq: seq + 3, type: 'turn/end', data: { reason: { kind: 'ok' } } },
  ]
}

test('returns the most recent assistant text', async () => {
  const bridge = makeBridge(makeAgent(assistantTurn(1, '最新一条回复')))
  assert.equal(await bridge.lastAssistantReply('session-x'), '最新一条回复')
})

test('returns the LAST reply when the session has several turns', async () => {
  const events = [...assistantTurn(1, '旧回复'), ...assistantTurn(5, '新回复')]
  const bridge = makeBridge(makeAgent(events))
  assert.equal(await bridge.lastAssistantReply('session-x'), '新回复')
})

test('an empty session yields an empty string instead of throwing', async () => {
  const bridge = makeBridge(makeAgent([]))
  assert.equal(await bridge.lastAssistantReply('session-x'), '')
})

test('a user-only session yields an empty string', async () => {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'ok' } } },
  ]
  const bridge = makeBridge(makeAgent(events))
  assert.equal(await bridge.lastAssistantReply('session-x'), '')
})

test('an empty session id short-circuits without attaching', async () => {
  const bridge = makeBridge(makeAgent(assistantTurn(1, 'x')))
  assert.equal(await bridge.lastAssistantReply(''), '')
})
