import assert from 'node:assert/strict'
import test from 'node:test'
import { replyForPrompt } from '../src/agent-bridge.js'
import { promptTextFor } from '../src/inbound-images.js'

const imageBlock = (attachmentId) => ({ type: 'image', attachment: { attachmentId, mediaType: 'image/png' } })
const userEvent = (seq, blocks) => ({
  seq,
  type: 'user/message',
  data: { message: { content: blocks } },
})
const assistantEvent = (seq, text, turn = 1) => ({
  seq,
  type: 'assistant/message',
  data: { turn, step: 1, message: { content: [{ type: 'text', text }] } },
})
const start = (seq, turn = 1) => ({ seq, type: 'turn/start', data: { turn } })
const end = (seq, turn = 1) => ({ seq, type: 'turn/end', data: { turn, reason: { kind: 'done' } } })

test('an image-only prompt is attributed by its attachment id', () => {
  const events = [start(1), userEvent(2, [imageBlock('img-1'), { type: 'text', text: '（图片）' }]), assistantEvent(3, '看过了'), end(4)]
  assert.deepEqual(replyForPrompt({ events, before: 1, text: '', images: [{ attachmentId: 'img-1' }] }), {
    text: '看过了',
    promptSeq: 2,
  })
})

test('an image-only prompt is attributed by its rendered caption when the ids differ', () => {
  const events = [start(1), userEvent(2, [imageBlock('host-copy'), { type: 'text', text: '（图片）' }]), assistantEvent(3, '图里是猫'), end(4)]
  assert.deepEqual(replyForPrompt({ events, before: 1, text: '（图片）', images: [{ attachmentId: 'img-1' }] }), {
    text: '图里是猫',
    promptSeq: 2,
  })
})

test('another image does not claim someone else\'s reply', () => {
  const events = [start(1), userEvent(2, [imageBlock('gui-image'), { type: 'text', text: '（图片）' }]), assistantEvent(3, 'GUI 的答案'), end(4)]
  assert.equal(replyForPrompt({ events, before: 1, text: '', images: [{ attachmentId: 'img-1' }] }), undefined)
})

test('a text prompt still matches while images are supplied', () => {
  const events = [start(1), userEvent(2, [imageBlock('img-1'), { type: 'text', text: '这张图是什么' }]), assistantEvent(3, '一只猫'), end(4)]
  assert.deepEqual(replyForPrompt({ events, before: 1, text: '这张图是什么', images: [{ attachmentId: 'img-1' }] }), {
    text: '一只猫',
    promptSeq: 2,
  })
})

test('promptTextFor mirrors the caption buildPromptContent renders', () => {
  assert.equal(promptTextFor({ text: '', images: [] }), '')
  assert.equal(promptTextFor({ text: '你好', images: [] }), '你好')
  assert.equal(promptTextFor({ text: '', images: [{ attachmentId: 'a' }] }), '（图片）')
  assert.equal(promptTextFor({ text: '看看', images: [{ attachmentId: 'a' }] }), '看看')
})
