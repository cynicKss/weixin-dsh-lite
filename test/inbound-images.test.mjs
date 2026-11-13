/**
 * Inbound images as attachments.
 *
 * The path-based prompt is the contract that must never break: whenever the
 * host cannot take the bytes, the image returns to `describeInboundMedia` and
 * the turn still runs. These tests pin both halves — the native upgrade and the
 * fallback.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { NATIVE_IMAGE_TYPES, buildPromptContent, saveNativeImages } from '../src/inbound-images.js'

test('a text-only message keeps exactly one text block', () => {
  assert.deepEqual(buildPromptContent({ text: '你好', images: [] }), [{ type: 'text', text: '你好' }])
  assert.deepEqual(buildPromptContent({ text: '' }), [{ type: 'text', text: '' }])
})

test('images become image blocks followed by one caption block', () => {
  const a = { attachmentId: 'a' }
  const b = { attachmentId: 'b' }
  assert.deepEqual(buildPromptContent({ text: '这是什么', images: [a, b] }), [
    { type: 'image', attachment: a },
    { type: 'image', attachment: b },
    { type: 'text', text: '这是什么' },
  ])
})

test('an image-only message gets a placeholder caption', () => {
  const a = { attachmentId: 'a' }
  assert.deepEqual(buildPromptContent({ text: '', images: [a] }), [
    { type: 'image', attachment: a },
    { type: 'text', text: '（图片）' },
  ])
})

test('supported images are committed in message order', async () => {
  const committed = []
  const attachments = {
    saveImage: async (input) => {
      committed.push(input)
      return { attachmentId: `att-${committed.length}`, mediaType: input.mediaType, bytes: input.data.byteLength }
    },
  }
  const saved = [
    { kind: 'image', path: 'C:/tmp/1.png', name: '1.png', mime: 'image/png' },
    { kind: 'image', path: 'C:/tmp/2.jpg', name: '2.jpg', mime: 'IMAGE/JPEG' },
  ]
  const result = await saveNativeImages({
    saved,
    attachments,
    readFile: async (file) => new Uint8Array(Buffer.from(file)),
  })
  assert.equal(result.images.length, 2)
  assert.deepEqual(result.fallback, [])
  assert.deepEqual(committed.map((item) => item.mediaType), ['image/png', 'image/jpeg'])
  assert.deepEqual(committed.map((item) => item.name), ['1.png', '2.jpg'])
  assert.equal(NATIVE_IMAGE_TYPES.has('image/gif'), true)
})

test('an unsupported format stays path-described', async () => {
  const attachments = { saveImage: async () => ({ attachmentId: 'x' }) }
  const saved = [{ kind: 'image', path: 'C:/tmp/1.bmp', name: '1.bmp', mime: 'image/bmp' }]
  const result = await saveNativeImages({
    saved,
    attachments,
    readFile: async () => new Uint8Array([1]),
  })
  assert.deepEqual(result.images, [])
  assert.deepEqual(result.fallback, saved)
})

test('a missing attachment service falls back to paths', async () => {
  const saved = [{ kind: 'image', path: 'C:/tmp/1.png', name: '1.png', mime: 'image/png' }]
  const result = await saveNativeImages({ saved, attachments: undefined, readFile: async () => new Uint8Array([1]) })
  assert.deepEqual(result.images, [])
  assert.deepEqual(result.fallback, saved)
})

test('the setting off falls back without touching the host', async () => {
  const saved = [{ kind: 'image', path: 'C:/tmp/1.png', name: '1.png', mime: 'image/png' }]
  const attachments = {
    saveImage: async () => {
      throw new Error('must not be called')
    },
  }
  const result = await saveNativeImages({ saved, attachments, readFile: async () => new Uint8Array([1]), enabled: false })
  assert.deepEqual(result.images, [])
  assert.deepEqual(result.fallback, saved)
})

test('a refused commit falls back to the path instead of failing the turn', async () => {
  const saved = [{ kind: 'image', path: 'C:/tmp/1.png', name: '1.png', mime: 'image/png' }]
  const warnings = []
  const attachments = {
    saveImage: async () => {
      throw new Error('image too large')
    },
  }
  const result = await saveNativeImages({
    saved,
    attachments,
    readFile: async () => new Uint8Array([1]),
    warn: (line) => warnings.push(line),
  })
  assert.deepEqual(result.images, [])
  assert.deepEqual(result.fallback, saved)
  assert.match(warnings[0], /image too large/)
})

test('non-image attachments are ignored entirely', async () => {
  const attachments = { saveImage: async () => ({ attachmentId: 'x' }) }
  const saved = [{ kind: 'file', path: 'C:/tmp/a.pdf', name: 'a.pdf', mime: 'application/pdf' }]
  const result = await saveNativeImages({ saved, attachments, readFile: async () => new Uint8Array([1]) })
  assert.deepEqual(result.images, [])
  assert.deepEqual(result.fallback, [])
})
