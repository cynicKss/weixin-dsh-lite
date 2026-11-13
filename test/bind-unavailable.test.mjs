/**
 * A binding whose target session disappeared must clear itself.
 *
 * The GUI can delete a session at any time. Every later WeChat message would
 * then fail the same way, and the only escape would be a `/unbind` the user has
 * no reason to know about. The bridge therefore distinguishes "gone" (clears
 * the binding) from "temporarily unavailable" (keeps it), so a host still
 * starting up never silently drops the user's choice.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentBridge, isMissingSessionError } from '../src/agent-bridge.js'

function makeBridge({ resume, unbind }) {
  const bindings = {
    getByKey: () => ({ sessionId: 'session-gone', cwd: 'C:/work', title: 'old' }),
    unbind: (key) => {
      unbind.push(key)
      return true
    },
  }
  const agents = { get: () => undefined, resume }
  const ctx = { get: (name) => (name === 'agents' ? agents : undefined) }
  return new AgentBridge({
    ctx,
    cwd: 'C:/tmp',
    log: () => {},
    errLog: () => {},
    lines: { active: () => 'session-gone' },
    bindings,
    bindConfig: () => ({ enabled: true, idleWaitMs: 1_000 }),
  })
}

test('a deleted target session unbinds and says so', async () => {
  const unbound = []
  const bridge = makeBridge({
    resume: async () => {
      throw new Error('session not found: session-gone')
    },
    unbind: unbound,
  })
  const settled = await bridge.deliver({ conversationId: 'c1', accountId: 'a1', text: 'hi' })
  assert.match(settled.text, /已经不存在了/)
  assert.match(settled.text, /自动解除/)
  assert.deepEqual(unbound, ['a1:c1'])
})

test('a transient open failure keeps the binding', async () => {
  const unbound = []
  const bridge = makeBridge({
    resume: async () => {
      throw new Error('agents service is still starting')
    },
    unbind: unbound,
  })
  const settled = await bridge.deliver({ conversationId: 'c1', accountId: 'a1', text: 'hi' })
  assert.match(settled.text, /暂时打不开/)
  assert.deepEqual(unbound, [])
})

test('only missing-session errors that name the target count as gone', () => {
  assert.equal(isMissingSessionError(new Error('target session session-gone could not be opened: session not found'), 'session-gone'), true)
  assert.equal(isMissingSessionError(new Error('target session session-gone could not be opened: unknown session'), 'session-gone'), true)
  // A generic "not found" from a sibling service must not clear the binding.
  assert.equal(isMissingSessionError(new Error('model not found'), 'session-gone'), false)
  assert.equal(isMissingSessionError(new Error('model not found'), undefined), false)
  // A transient failure that happens to mention the id keeps the binding.
  assert.equal(isMissingSessionError(new Error('session-gone: ECONNRESET while resuming'), 'session-gone'), false)
  assert.equal(isMissingSessionError(new Error('session-gone: timeout waiting for the host'), 'session-gone'), false)
  assert.equal(isMissingSessionError(undefined, 'session-gone'), false)
})
