import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSessionCommand, runSessionCommand } from '../src/sessions.js'

const lines = {
  create: () => 2,
  render: () => '/list output',
  clear: () => 1,
  use: () => 'session-2',
  title: () => undefined,
  active: () => 'session-1',
  list: () => [{ sessionId: 'session-1' }],
}

const filesContext = () => ({
  files: {
    list: async (argument) => (argument === '' ? 'md list' : `list:${argument}`),
    send: async (index) => `sent:${index}`,
  },
})

test('/files and /file parse', () => {
  assert.deepEqual(parseSessionCommand('/files'), { command: 'files', argument: '' })
  assert.deepEqual(parseSessionCommand('/files docx'), { command: 'files', argument: 'docx' })
  assert.deepEqual(parseSessionCommand('/file 3'), { command: 'file', argument: '3' })
  assert.deepEqual(parseSessionCommand('/file'), { command: 'file', argument: '' })
})

test('/files lists and /file sends by number', async () => {
  assert.equal(await runSessionCommand(lines, 'conv', '/files', undefined, filesContext()), 'md list')
  assert.equal(await runSessionCommand(lines, 'conv', '/files docx', undefined, filesContext()), 'list:docx')
  assert.equal(await runSessionCommand(lines, 'conv', '/file 3', undefined, filesContext()), 'sent:3')
})

test('a non-numeric /file argument is refused without calling send', async () => {
  let called = 0
  const context = { files: { list: async () => 'x', send: async () => { called += 1; return 'sent' } } }
  const reply = await runSessionCommand(lines, 'conv', '/file abc', undefined, context)
  assert.match(reply, /\/file <序号>/)
  assert.equal(called, 0)
})

test('without a files bundle the commands refuse instead of touching disk', async () => {
  assert.match(await runSessionCommand(lines, 'conv', '/files', undefined, {}), /没有文件列表能力/)
  assert.match(await runSessionCommand(lines, 'conv', '/file 1', undefined, {}), /没有文件列表能力/)
})
