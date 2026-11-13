/**
 * `/files` and `/file`: the list must match what a fresh scan would show, and a
 * numbered send must use exactly that list — so the store is persisted on list.
 *
 * These tests use a real temp directory: the code paths that matter are
 * readdir/stat and atomic writes, not a mock of them.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createFileIndex,
  describeFiles,
  filterFileEntries,
  formatBytes,
  mergeFileEntries,
  parseFileExtensions,
  scanRecentFiles,
} from '../src/files.js'

test('scanRecentFiles finds new files and skips ignored trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-'))
  try {
    await writeFile(join(root, 'report.md'), '# hi')
    await mkdir(join(root, 'out'), { recursive: true })
    await writeFile(join(root, 'out', 'result.csv'), 'a,b')
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'x', 'junk.js'), 'x')
    await writeFile(join(root, '.hidden'), 'x')
    const found = await scanRecentFiles({ dir: root, sinceMs: Date.now() - 60_000 })
    const names = found.map((entry) => entry.path.split(/[\\/]/).pop()).sort()
    assert.deepEqual(names, ['report.md', 'result.csv'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scanRecentFiles respects maxDepth and maxEntries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-'))
  try {
    await mkdir(join(root, 'a', 'b', 'c'), { recursive: true })
    await writeFile(join(root, 'top.txt'), '1')
    await writeFile(join(root, 'a', 'one.txt'), '1')
    await writeFile(join(root, 'a', 'b', 'two.txt'), '1')
    await writeFile(join(root, 'a', 'b', 'c', 'three.txt'), '1')
    const found = await scanRecentFiles({ dir: root, sinceMs: 0, maxDepth: 1 })
    const names = found.map((entry) => entry.path.split(/[\\/]/).pop()).sort()
    assert.deepEqual(names, ['one.txt', 'top.txt'])
    const limited = await scanRecentFiles({ dir: root, sinceMs: 0, maxEntries: 1 })
    assert.equal(limited.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('file index records, dedupes, and reloads from disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-'))
  try {
    const file = join(root, 'files.json')
    const now = Date.now()
    const index = createFileIndex({ file })
    index.record('a:b', [{ path: 'C:/w/a.txt', size: 10, mtime: now - 2000 }], now)
    index.record('a:b', [{ path: 'C:/w/a.txt', size: 20, mtime: now - 1000 }], now)
    const rows = index.list('a:b')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].size, 20)
    const reloaded = createFileIndex({ file })
    assert.equal(reloaded.list('a:b').length, 1)
    assert.equal(reloaded.list('a:b')[0].mtime, now - 1000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('file index prunes rows older than a week and caps the row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-'))
  try {
    const file = join(root, 'files.json')
    const index = createFileIndex({ file })
    const now = Date.now()
    index.record('k', [{ path: 'old.txt', size: 1, mtime: now - 8 * 24 * 60 * 60 * 1000 }], now)
    assert.equal(index.list('k').length, 0)
    const many = Array.from({ length: 130 }, (_, i) => ({ path: `f${i}.txt`, size: 1, mtime: now - i }))
    index.record('k', many, now)
    assert.equal(index.list('k').length, 100)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mergeFileEntries prefers the newest copy and keeps order', () => {
  const merged = mergeFileEntries(
    [{ path: 'C:/w/a.txt', size: 1, mtime: 100 }, { path: 'C:/w/b.txt', size: 1, mtime: 300 }],
    [{ path: 'c:/w/A.txt', size: 2, mtime: 200 }, { path: 'C:/w/c.txt', size: 1, mtime: 50 }],
  )
  const paths = merged.map((entry) => entry.path)
  // Windows paths compare case-insensitively, so A is the same file as a.
  assert.equal(paths.length, 3)
  assert.equal(merged[0].path, 'C:/w/b.txt')
})

test('describeFiles numbers rows and shows size and age', () => {
  const now = Date.now()
  const lines = describeFiles(
    [{ path: 'C:/w/out/report.md', size: 2.5 * 1024 * 1024, mtime: now - 3 * 60_000 }],
    { cwd: 'C:/w', now },
  )
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^1\. report\.md — 2\.5 MB，3 分钟前 — out[\\/]report\.md$/)
})

test('formatBytes keeps small files readable', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2 KB')
  assert.equal(formatBytes(1024 * 1024), '1 MB')
})

test('parseFileExtensions defaults to Markdown and normalizes user input', () => {
  assert.deepEqual(parseFileExtensions(''), { extensions: ['md'], label: '.md' })
  assert.deepEqual(parseFileExtensions(undefined), { extensions: ['md'], label: '.md' })
  assert.deepEqual(parseFileExtensions('  DOCX  '), { extensions: ['docx'], label: '.docx' })
  assert.deepEqual(parseFileExtensions('.docx .pdf'), { extensions: ['docx', 'pdf'], label: '.docx / .pdf' })
  assert.deepEqual(parseFileExtensions('docx,docx'), { extensions: ['docx'], label: '.docx' })
  assert.equal(parseFileExtensions('docx;rm'), null)
  assert.equal(parseFileExtensions('../x'), null)
})

test('filterFileEntries matches extensions case-insensitively', () => {
  const entries = [
    { path: 'C:/w/notes.md' },
    { path: 'C:/w/REPORT.MD' },
    { path: 'C:/w/out/plan.docx' },
    { path: 'C:/w/noext' },
  ]
  assert.deepEqual(filterFileEntries(entries, ['md']).map((entry) => entry.path), ['C:/w/notes.md', 'C:/w/REPORT.MD'])
  assert.deepEqual(filterFileEntries(entries, ['docx']).map((entry) => entry.path), ['C:/w/out/plan.docx'])
  assert.deepEqual(filterFileEntries(entries, []), [])
})

test('the listing a user just saw is what /file addresses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-'))
  try {
    const file = join(root, 'files.json')
    const index = createFileIndex({ file })
    const now = Date.now()
    index.setListing('a:b', {
      extensions: ['docx'],
      entries: [{ path: 'C:/w/plan.docx', size: 5, mtime: now }],
    }, now)
    const reloaded = createFileIndex({ file })
    const listing = reloaded.getListing('a:b')
    assert.deepEqual(listing.extensions, ['docx'])
    assert.equal(listing.entries[0].path, 'C:/w/plan.docx')
    // Recording a later turn must not erase the numbering still in the chat.
    reloaded.record('a:b', [{ path: 'C:/w/newer.md', size: 1, mtime: now + 1000 }], now + 1000)
    assert.equal(reloaded.getListing('a:b').entries[0].path, 'C:/w/plan.docx')
    assert.equal(reloaded.list('a:b').length, 1)
    assert.equal(reloaded.list('a:b')[0].path, 'C:/w/newer.md')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
