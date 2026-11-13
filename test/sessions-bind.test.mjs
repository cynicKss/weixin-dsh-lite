import assert from 'node:assert/strict'
import test from 'node:test'
import { isBindSelectionCommand, parseSessionCommand, runSessionCommand } from '../src/sessions.js'

const lines = {
  create: () => 2,
  render: () => '/list output',
  clear: () => 1,
  use: () => 'session-2',
  title: () => undefined,
  active: () => 'session-1',
  list: () => [{ sessionId: 'session-1' }],
}

const bindContext = (bound = '') => ({
  bind: {
    sessionId: () => bound,
    listCandidates: async () => 'candidate list',
    select: (n) => `selected:${n}`,
    selectByIdPrefix: (prefix) => `prefix:${prefix}`,
    unbind: () => 'unbound',
  },
})

test('/bind parses with and without an argument', () => {
  assert.deepEqual(parseSessionCommand('/bind'), { command: 'bind', argument: '' })
  assert.deepEqual(parseSessionCommand('/bind 3'), { command: 'bind', argument: '3' })
  assert.deepEqual(parseSessionCommand('/unbind'), { command: 'unbind' })
})

test('/bind prints the candidate list and selects from it', async () => {
  assert.equal(await runSessionCommand(lines, 'conv', '/bind', undefined, bindContext()), 'candidate list')
  assert.equal(await runSessionCommand(lines, 'conv', '/bind 3', undefined, bindContext()), 'selected:3')
  assert.equal(await runSessionCommand(lines, 'conv', '/bind session-', undefined, bindContext()), 'prefix:session-')
  assert.equal(await runSessionCommand(lines, 'conv', '/unbind', undefined, bindContext()), 'unbound')
})

test('without a bind bundle the commands refuse instead of touching state', async () => {
  assert.match(await runSessionCommand(lines, 'conv', '/bind', undefined, {}), /没有绑定能力/)
  assert.match(await runSessionCommand(lines, 'conv', '/unbind', undefined, {}), /没有绑定能力/)
})

test('a bound conversation cannot switch itself onto another session line', async () => {
  const context = bindContext('session-abc')
  for (const text of ['/new', '/clear', '/use 1']) {
    const reply = await runSessionCommand(lines, 'conv', text, undefined, context)
    assert.match(reply, /已经绑定到工作区的一条会话/, `expected ${text} to be refused`)
    assert.match(reply, /\/unbind/)
  }
})

test('the same commands work again once the binding is gone', async () => {
  const reply = await runSessionCommand(lines, 'conv', '/new', undefined, bindContext(''))
  assert.match(reply, /已开启/)
})

test('the pending-selection gate accepts only /bind forms', () => {
  for (const text of ['/bind', '/bind 3', '/BIND 12', ' /bind   session-abc ']) {
    assert.equal(isBindSelectionCommand(text), true, `expected ${JSON.stringify(text)} to pass`)
  }
  for (const text of ['', '你好', '/status', '/cancel', '/new', '/bind3', '/unbind', '/bind 3 4']) {
    assert.equal(isBindSelectionCommand(text), false, `expected ${JSON.stringify(text)} to be rejected`)
  }
})
