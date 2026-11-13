import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BindingStore, CANDIDATE_TTL_MS, bindingsFile } from '../src/bindings.js'

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-bind-store-'))
  const file = bindingsFile(dir)
  const store = new BindingStore({ file, warn: () => {} })
  return { dir, file, store }
}

test('bind records the session and survives a reload from disk', async () => {
  const { dir, file, store } = await tempStore()
  try {
    assert.deepEqual(store.bind('acct:conv', { sessionId: 'session-1', cwd: 'C:/work', title: 'T', senderId: 'u1', conversationId: 'conv', accountId: 'acct' }), { ok: true })
    assert.equal(store.getByKey('acct:conv').sessionId, 'session-1')
    const reloaded = new BindingStore({ file, warn: () => {} })
    assert.equal(reloaded.getByKey('acct:conv').title, 'T')
    assert.equal(reloaded.getByKey('acct:conv').cwd, 'C:/work')
    // The plan-review answerer resolves a request by session id and needs the
    // conversation back; old records without these fields stay readable.
    assert.equal(reloaded.getByKey('acct:conv').conversationId, 'conv')
    assert.equal(reloaded.getByKey('acct:conv').accountId, 'acct')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a session cannot be bound to two WeChat conversations', async () => {
  const { dir, store } = await tempStore()
  try {
    store.bind('k1', { sessionId: 's1' })
    assert.deepEqual(store.bind('k2', { sessionId: 's1' }), { ok: false, reason: 'already-bound', key: 'k1' })
    // Rebinding the SAME key to the SAME session is idempotent, not a conflict.
    assert.deepEqual(store.bind('k1', { sessionId: 's1' }), { ok: true })
    assert.equal(store.boundTo('s1').key, 'k1')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('unbind only removes the binding it owns', async () => {
  const { dir, store } = await tempStore()
  try {
    assert.equal(store.unbind('missing'), false)
    store.bind('k1', { sessionId: 's1' })
    assert.equal(store.unbind('k1'), true)
    assert.equal(store.getByKey('k1'), undefined)
    assert.equal(store.boundTo('s1'), undefined)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a candidate list expires so a stale "number 3" cannot bind a different session', async () => {
  const { dir, store } = await tempStore()
  try {
    store.setCandidates('k1', [{ sessionId: 'a' }, { sessionId: 'b' }])
    assert.equal(store.getCandidates('k1').length, 2)
    assert.equal(store.getCandidates('k1', Date.now() + CANDIDATE_TTL_MS + 1), undefined)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the candidate list is capped at what a WeChat message can show', async () => {
  const { dir, store } = await tempStore()
  try {
    store.setCandidates('k1', Array.from({ length: 40 }, (_, i) => ({ sessionId: `s${i}` })))
    assert.equal(store.getCandidates('k1').length, 12)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('clearing the candidate list ends the pending-selection gate', async () => {
  const { dir, file, store } = await tempStore()
  try {
    store.setCandidates('k1', [{ sessionId: 'a' }])
    store.clearCandidates('k1')
    assert.equal(store.getCandidates('k1'), undefined)
    // The clear is persisted: a reloaded store must not resurrect the gate.
    assert.equal(new BindingStore({ file, warn: () => {} }).getCandidates('k1'), undefined)
    // Clearing an absent list is a no-op, not an error.
    store.clearCandidates('k1')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
