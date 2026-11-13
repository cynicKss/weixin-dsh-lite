/**
 * Files a bound session produced, for `/files` and `/file <n>`.
 *
 * Two sources are merged:
 *
 *  - a per-conversation index, written after every turn the plugin drives, so
 *    a file is remembered even after it leaves the scan window;
 *  - an on-demand scan of the session cwd, so files produced by a GUI turn (or
 *    by anything else while the user was away) are visible too.
 *
 * The scan is deliberately bounded: two directory levels, no dot entries, no
 * symlinks, an ignore list for dependency/build trees, and a hard cap on the
 * number of entries inspected. A huge repository must not stall a WeChat
 * message, and a partial list is better than no reply.
 *
 * @module dsh-weixin/files
 */
import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { atomicWriteJson, readJsonFile } from './atomic.js'

/** How far back an on-demand scan looks. */
export const FILE_LOOKBACK_MS = 24 * 60 * 60 * 1000
/** Directory levels below the scan root that are considered. */
export const FILE_MAX_DEPTH = 2
/** Entries (files + directories) inspected per scan. */
export const FILE_MAX_SCAN = 400
/** Rows `/files` shows, and files one reply may name. */
export const FILE_MAX_ENTRIES = 20
/** Entries kept per conversation in the index. */
export const FILE_MAX_PER_CONVERSATION = 100
/** Index rows older than this are dropped when the index is written. */
export const FILE_PRUNE_MS = 7 * 24 * 60 * 60 * 1000
/** Extensions `/files` lists when the user names none. */
export const DEFAULT_FILE_EXTENSIONS = ['md']

/** Dependency/build trees that are never deliverables by default. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  '__pycache__',
  '.next',
  '.cache',
  'coverage',
  'vendor',
  '.turbo',
  '.pnpm-store',
  'dist',
  'build',
])

/** `<state>/files.json`. */
export function filesFile(stateRoot) {
  return join(stateRoot, 'files.json')
}

/**
 * Parse the `/files` argument into a lowercase extension list.
 *
 * Empty means the default (Markdown only). `docx`, `.docx` and `docx pdf` all
 * work; anything that is not a plain alphanumeric extension is rejected so a
 * typo cannot silently widen the list.
 *
 * @param {string} [argument]
 * @returns {{ extensions: string[], label: string } | null}
 */
export function parseFileExtensions(argument) {
  const raw = String(argument ?? '').trim()
  if (raw === '') {
    return { extensions: DEFAULT_FILE_EXTENSIONS.slice(), label: '.md' }
  }
  const extensions = [...new Set(
    raw.split(/[\s,]+/)
      .map((part) => part.replace(/^\.+/, '').toLowerCase())
      .filter((part) => part !== ''),
  )]
  if (extensions.length === 0) return null
  if (extensions.some((ext) => !/^[a-z0-9]{1,16}$/.test(ext))) return null
  return { extensions, label: extensions.map((ext) => `.${ext}`).join(' / ') }
}

/**
 * Rows whose extension is in `extensions` (case-insensitive).
 *
 * @param {Array<{ path: string }>} entries
 * @param {string[]} extensions
 */
export function filterFileEntries(entries, extensions) {
  const wanted = new Set((extensions ?? []).map((ext) => String(ext).toLowerCase()))
  if (wanted.size === 0) return []
  return (entries ?? []).filter((entry) => wanted.has(extensionOf(entry.path)))
}

function extensionOf(filePath) {
  const name = String(filePath ?? '').split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * Absolute paths of regular files under `dir` modified at/after `sinceMs`,
 * newest first.
 *
 * @param {{ dir?: string, sinceMs?: number, maxEntries?: number, maxScan?: number, maxDepth?: number }} [options]
 * @returns {Promise<Array<{ path: string, size: number, mtime: number }>>}
 */
export async function scanRecentFiles(options = {}) {
  const dir = options.dir
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : 0
  const maxEntries = positive(options.maxEntries, FILE_MAX_ENTRIES)
  const maxScan = positive(options.maxScan, FILE_MAX_SCAN)
  const maxDepth = positive(options.maxDepth, FILE_MAX_DEPTH)
  if (typeof dir !== 'string' || dir === '') return []

  let scanned = 0
  const found = []
  const queue = [{ dir, depth: 0 }]
  while (queue.length > 0 && scanned < maxScan) {
    const current = queue.shift()
    let entries
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      scanned += 1
      if (scanned > maxScan) break
      const name = entry.name
      if (name.startsWith('.')) continue
      if (entry.isSymbolicLink()) continue
      const full = join(current.dir, name)
      if (entry.isDirectory()) {
        if (current.depth >= maxDepth) continue
        if (IGNORED_DIRS.has(name)) continue
        queue.push({ dir: full, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      let info
      try {
        info = await stat(full)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      if (info.mtimeMs < sinceMs) continue
      found.push({ path: full, size: info.size, mtime: info.mtimeMs })
    }
  }
  found.sort((left, right) => right.mtime - left.mtime)
  return found.slice(0, maxEntries)
}

/**
 * The persisted per-conversation file index.
 *
 * `record` is called after a turn; `list` backs `/files`. The file is small
 * (at most a few hundred rows) and written atomically, so a crash can only
 * lose the newest turn, never corrupt the store.
 *
 * @param {{ file: string, warn?: (line: string) => void }} options
 */
export function createFileIndex({ file, warn = () => {} }) {
  const loaded = readJsonFile(file, {
    version: 1,
    fallback: () => ({ conversations: {} }),
    warn,
  })
  const data = normalizeStore(loaded)

  function save() {
    try {
      atomicWriteJson(file, data, { warn })
    } catch (error) {
      warn(`writing file index failed: ${String(error?.message ?? error)}`)
    }
  }

  return {
    /**
     * Merge this turn's products into the conversation's row.
     *
     * @param {string} key
     * @param {Array<{ path: string, size?: number, mtime?: number }>} entries
     * @param {number} [now]
     */
    record(key, entries, now = Date.now()) {
      if (typeof key !== 'string' || key === '' || !Array.isArray(entries)) return
      const row = data.conversations[key] ?? { updatedAt: 0, files: [] }
      const byPath = new Map()
      for (const entry of row.files) byPath.set(normalizeKey(entry.path), entry)
      let changed = false
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue
        if (typeof entry.path !== 'string' || entry.path === '') continue
        const size = Number.isFinite(entry.size) ? entry.size : 0
        const mtime = Number.isFinite(entry.mtime) ? entry.mtime : now
        const next = { path: entry.path, size, mtime, at: now }
        const pathKey = normalizeKey(entry.path)
        const previous = byPath.get(pathKey)
        if (previous === undefined || previous.mtime !== mtime || previous.size !== size) {
          byPath.set(pathKey, next)
          changed = true
        }
      }
      if (!changed) return
      const cutoff = now - FILE_PRUNE_MS
      const files = [...byPath.values()]
        .filter((entry) => Number(entry.mtime) >= cutoff)
        .sort((left, right) => right.mtime - left.mtime)
        .slice(0, FILE_MAX_PER_CONVERSATION)
      data.conversations[key] = { updatedAt: now, files, ...(row.listing === undefined ? {} : { listing: row.listing }) }
      save()
    },

    /** @param {string} key @returns {Array<{ path: string, size: number, mtime: number, at: number }>} */
    list(key) {
      const row = data.conversations[key]
      if (row === undefined) return []
      return row.files.slice().sort((left, right) => right.mtime - left.mtime)
    },

    /**
     * Remember the exact list `/files` just sent, so `/file <n>` addresses the
     * numbering the user saw even if a newer file appears in between.
     *
     * @param {string} key
     * @param {{ extensions: string[], entries: Array<{ path: string, size?: number, mtime?: number }> }} listing
     * @param {number} [now]
     */
    setListing(key, listing, now = Date.now()) {
      if (typeof key !== 'string' || key === '' || listing === null || typeof listing !== 'object') return
      if (!Array.isArray(listing.entries)) return
      const row = data.conversations[key] ?? { updatedAt: 0, files: [] }
      row.listing = {
        at: now,
        extensions: Array.isArray(listing.extensions) ? listing.extensions.map((ext) => String(ext).toLowerCase()) : [],
        entries: listing.entries
          .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
          .map((entry) => ({
            path: entry.path,
            size: Number.isFinite(entry.size) ? entry.size : 0,
            mtime: Number.isFinite(entry.mtime) ? entry.mtime : 0,
          }))
          .slice(0, FILE_MAX_ENTRIES),
      }
      data.conversations[key] = row
      save()
    },

    /** @param {string} key @returns {{ at: number, extensions: string[], entries: Array<{ path: string, size: number, mtime: number }> } | undefined} */
    getListing(key) {
      const row = data.conversations[key]
      if (row === undefined || row.listing === undefined) return undefined
      return row.listing
    },

    /** @param {string} key @returns {boolean} */
    clear(key) {
      if (data.conversations[key] === undefined) return false
      delete data.conversations[key]
      save()
      return true
    },

    /** Test/diagnostic view. */
    all() {
      return data.conversations
    },
  }
}

/**
 * Merge the index with a fresh scan, de-duplicated, newest first.
 *
 * @param {Array<{ path: string, size?: number, mtime?: number }>} indexed
 * @param {Array<{ path: string, size?: number, mtime?: number }>} scanned
 * @param {{ limit?: number }} [options]
 */
export function mergeFileEntries(indexed, scanned, options = {}) {
  const limit = positive(options.limit, FILE_MAX_ENTRIES)
  const byPath = new Map()
  for (const entry of [...(indexed ?? []), ...(scanned ?? [])]) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.path !== 'string' || entry.path === '') continue
    const pathKey = normalizeKey(entry.path)
    const candidate = {
      path: entry.path,
      size: Number.isFinite(entry.size) ? entry.size : 0,
      mtime: Number.isFinite(entry.mtime) ? entry.mtime : 0,
    }
    const previous = byPath.get(pathKey)
    if (previous === undefined || candidate.mtime > previous.mtime) byPath.set(pathKey, candidate)
  }
  return [...byPath.values()].sort((left, right) => right.mtime - left.mtime).slice(0, limit)
}

/**
 * The numbered list `/files` sends.
 *
 * @param {Array<{ path: string, size: number, mtime: number }>} entries
 * @param {{ cwd?: string, now?: number }} [options]
 */
export function describeFiles(entries, options = {}) {
  const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : ''
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  return (entries ?? []).map((entry, index) => {
    const name = entry.path.split(/[\\/]/).pop() ?? entry.path
    const where = cwd === '' ? entry.path : relative(cwd, entry.path) || name
    return `${index + 1}. ${name} — ${formatBytes(entry.size)}，${formatAge(now - entry.mtime)} — ${where}`
  })
}

/** Human file size; one decimal for MB, whole KB. */
export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
  }
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}

/** "刚刚 / 3 分钟前 / 2 小时前 / 4 天前". */
export function formatAge(ageMs) {
  const value = Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0
  if (value < 60_000) return '刚刚'
  if (value < 60 * 60_000) return `${Math.floor(value / 60_000)} 分钟前`
  if (value < 24 * 60 * 60_000) return `${Math.floor(value / (60 * 60_000))} 小时前`
  return `${Math.floor(value / (24 * 60 * 60_000))} 天前`
}

/** Windows paths compare case-insensitively; POSIX ones do not. */
function normalizeKey(filePath) {
  const value = String(filePath ?? '')
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function normalizeStore(value) {
  const store = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const conversations = store.conversations !== null && typeof store.conversations === 'object'
    && !Array.isArray(store.conversations) ? store.conversations : {}
  const normalized = {}
  for (const [key, row] of Object.entries(conversations)) {
    if (row === null || typeof row !== 'object') continue
    const files = Array.isArray(row.files)
      ? row.files.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
        .map((entry) => ({
          path: entry.path,
          size: Number.isFinite(entry.size) ? entry.size : 0,
          mtime: Number.isFinite(entry.mtime) ? entry.mtime : 0,
          at: Number.isFinite(entry.at) ? entry.at : 0,
        }))
      : []
    const listing = row.listing !== null && typeof row.listing === 'object' && Array.isArray(row.listing.entries)
      ? {
          at: Number.isFinite(row.listing.at) ? row.listing.at : 0,
          extensions: Array.isArray(row.listing.extensions)
            ? row.listing.extensions.filter((ext) => typeof ext === 'string').map((ext) => ext.toLowerCase())
            : [],
          entries: row.listing.entries
            .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
            .map((entry) => ({
              path: entry.path,
              size: Number.isFinite(entry.size) ? entry.size : 0,
              mtime: Number.isFinite(entry.mtime) ? entry.mtime : 0,
            })),
        }
      : undefined
    normalized[key] = {
      updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
      files,
      ...(listing === undefined ? {} : { listing }),
    }
  }
  return { conversations: normalized }
}

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
