import test from 'node:test'
import assert from 'node:assert/strict'

import { AgentBridge } from '../src/agent-bridge.js'

const AGENT_OPTIONS = { provider: 'deepseek-account', model: 'deepseek-flash' }

function makeBridge({ readSession, defaultRoute, mount } = {}) {
  const resumed = []
  const mounted = []
  const ctx = {
    get(name) {
      if (name === 'agents') {
        return {
          get: () => undefined,
          resume: async (options) => {
            resumed.push(options)
            return {
              agent: {
                id: options.resumeSessionId,
                options: options.agentOptions ?? { provider: 'fallback-provider', model: 'fallback-model' },
                inbox: { clear() {} },
                session: { snapshotEvents: () => [] },
              },
              dispose: async () => {},
            }
          },
        }
      }
      if (name === 'sessionQuery') return { readSession }
      if (name === 'agentDefaultModel') return { currentSelection: () => defaultRoute }
      if (name === 'agentPresets') {
        return {
          mount: async (agentCtx, id) => {
            mounted.push([agentCtx, id])
            if (mount) await mount(agentCtx, id)
          },
        }
      }
      return undefined
    },
  }
  const bridge = new AgentBridge({ ctx, cwd: process.cwd(), lines: { active: () => 'session-x' } })
  return { bridge, resumed, mounted }
}

function snapshot({ preset, config }) {
  return {
    session: { id: 'session-target', agentPreset: preset },
    events: config === undefined ? [] : [{ type: 'request/header', data: { header: { config } } }],
  }
}

test('a cold bound attach restores the session preset and its last model', async () => {
  const { bridge, resumed, mounted } = makeBridge({
    readSession: async () => snapshot({ preset: 'deployment', config: AGENT_OPTIONS }),
    defaultRoute: undefined,
  })

  const record = await bridge.attach('wechat-conversation', 'account', { sessionId: 'session-target', bound: true })

  assert.equal(resumed.length, 1)
  assert.equal(resumed[0].resumeSessionId, 'session-target')
  assert.deepEqual(resumed[0].agentOptions, AGENT_OPTIONS, 'the target route, not the plugin route')
  assert.equal(typeof resumed[0].setup, 'function', 'setup is supplied so {{model}} resolves')

  const agentCtx = { id: 'ctx' }
  await resumed[0].setup(agentCtx)
  assert.deepEqual(mounted.map((entry) => entry[1]), ['deployment'])
  assert.equal(record.bound, true)
})

test('a session that never made a request falls back to the default selection', async () => {
  const { bridge, resumed } = makeBridge({
    readSession: async () => snapshot({ preset: undefined }),
    defaultRoute: { provider: 'deepseek-account', model: 'deepseek-flash' },
  })

  await bridge.attach('wechat-conversation', 'account', { sessionId: 'session-target', bound: true })

  assert.deepEqual(resumed[0].agentOptions, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(typeof resumed[0].setup, 'function')
})

test('an unreadable session log still resumes with the default route', async () => {
  const { bridge, resumed } = makeBridge({
    readSession: async () => {
      throw new Error('replay validation failed')
    },
    defaultRoute: { provider: 'deepseek-account', model: 'deepseek-flash' },
  })

  await bridge.attach('wechat-conversation', 'account', { sessionId: 'session-target', bound: true })

  assert.equal(resumed.length, 1)
  assert.deepEqual(resumed[0].agentOptions, { provider: 'deepseek-account', model: 'deepseek-flash' })
})

test('a missing preset does not stop the model selection from being installed', async () => {
  const { bridge, resumed } = makeBridge({
    readSession: async () => snapshot({ preset: 'deleted-preset', config: AGENT_OPTIONS }),
    defaultRoute: undefined,
    mount: async () => {
      throw new Error('unknown preset')
    },
  })

  await bridge.attach('wechat-conversation', 'account', { sessionId: 'session-target', bound: true })

  assert.equal(typeof resumed[0].setup, 'function')
  // The mount failure is swallowed; attach itself must still succeed.
  await resumed[0].setup({ id: 'ctx' })
})
