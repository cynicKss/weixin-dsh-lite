/**
 * Bindings between one WeChat conversation and one EXISTING DSH session.
 *
 * The stock plugin always owns the DSH session it talks to: every WeChat chat
 * gets a `weixin-*` session created (or resumed) by the bridge, and the sidebar
 * shows it. That is the right default, but it is not remote control of a
 * conversation you already have — a workspace session you started in the GUI
 * cannot be reached from the phone.
 *
 * A binding is deliberately small: it only records WHICH session a WeChat
 * conversation should drive, and what the session's working directory is (so
 * produced files are scanned in the right place). Everything else — the text,
 * the image paths, the reply chunks — still flows through the normal pipeline.
 *
 * Storage lives beside the rest of the account state:
 *
 *   <state>/bindings.json
 *   {
 *     "schemaVersion": 1,
 *     "conversations": {
 *       "<scopedLineKey>": { "sessionId", "cwd", "title", "boundAt", "senderId", "conversationId", "accountId" }
 *     },
 *     "candidates": {
 *       "<scopedLineKey>": { "at": <epoch ms>, "items": [ { sessionId, title, cwd, workspace } ] }
 *     }
 *   }
 *
 * `candidates` exists because `/bind` is a two-step command: the bot cannot ask
 * a follow-up question outside a turn, so the first call prints a numbered list
 * and remembers it; `/bind 3` resolves against that snapshot. The snapshot
 * expires because a list from yesterday selecting "number 3" would bind to a
 * different conversation than the one the user saw.
 */
import { join } from 'node:path'
import { atomicWriteJson, readJsonFile } from './atomic.js'
import { scopedLineKey } from './sessions.js'

/** How long a `/bind` numbered list stays resolvable. */
export const CANDIDATE_TTL_MS = 5 * 60_000
/** Upper bound on the numbered list: a long list is unreadable in WeChat. */
export const MAX_CANDIDATES = 12

/** Where the bindings file lives for one state root. */
export function bindingsFile(stateRoot) {
  return join(stateRoot, 'bindings.json')
}

/**
 * One JSON-file store; every mutation rewrites the whole (tiny) document.
 *
 * Reads go through `atomic.readJsonFile`, which caches the parsed text, so the
 * hot path (every inbound message consults `get`) does not re-read the disk
 * until something writes. Writes are `atomicWriteJson` (tmp + rename, 0600),
 * matching sessions.json and the other state files.
 */
export class BindingStore {
  /**
   * @param {{ file: string, warn?: (message: string) => void }} options
   */
  constructor({ file, warn = () => {} }) {
    this.file = file
    this.warn = warn
    const data = readJsonFile(file, {
      version: 1,
      fallback: () => ({ schemaVersion: 1, conversations: {}, candidates: {} }),
      warn,
    })
    this.data = {
      ...data,
      schemaVersion: 1,
      conversations: isRecord(data?.conversations) ? data.conversations : {},
      candidates: isRecord(data?.candidates) ? data.candidates : {},
    }
  }

  /** The binding for a raw (accountId, conversationId) pair, or undefined. */
  get(accountId, conversationId) {
    return this.getByKey(scopedLineKey(accountId, conversationId))
  }

  /** @param {string} key result of `scopedLineKey` */
  getByKey(key) {
    const entry = this.data.conversations[key]
    if (!isRecord(entry) || typeof entry.sessionId !== 'string' || entry.sessionId === '') return undefined
    return entry
  }

  /** The conversation already bound to this session, if any. */
  boundTo(sessionId) {
    for (const [key, entry] of Object.entries(this.data.conversations)) {
      if (entry?.sessionId === sessionId) return { key, entry }
    }
    return undefined
  }

  /** Every live binding, for `/status` / diagnostics. */
  list() {
    return Object.entries(this.data.conversations).map(([key, entry]) => ({ key, ...entry }))
  }

  /**
   * Bind one conversation to one session. Refuses when a DIFFERENT WeChat
   * conversation already drives that session — two phones steering one turn
   * would interleave replies, and the second one would get the first one's
   * answer.
   *
   * `conversationId` / `accountId` are kept for the plan-review delivery: a
   * host-side `user-questions/request` only carries the session id, so the
   * answerer needs a way back to the conversation that owns it. Older records
   * created before these fields existed stay readable — the plan-review broker
   * falls back to parsing the scoped key.
   *
   * @param {string} key
   * @param {{ sessionId: string, cwd?: string, title?: string, senderId?: string, conversationId?: string, accountId?: string }} entry
   * @returns {{ ok: true } | { ok: false, reason: 'already-bound', key: string }}
   */
  bind(key, entry) {
    const existing = this.boundTo(entry.sessionId)
    if (existing !== undefined && existing.key !== key) {
      return { ok: false, reason: 'already-bound', key: existing.key }
    }
    this.data.conversations[key] = {
      sessionId: entry.sessionId,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      title: typeof entry.title === 'string' ? entry.title : '',
      senderId: typeof entry.senderId === 'string' ? entry.senderId : '',
      conversationId: typeof entry.conversationId === 'string' ? entry.conversationId : '',
      accountId: typeof entry.accountId === 'string' ? entry.accountId : '',
      boundAt: Date.now(),
    }
    this.#save()
    return { ok: true }
  }

  /** Remove the binding for one conversation; false when there was none. */
  unbind(key) {
    if (this.data.conversations[key] === undefined) return false
    delete this.data.conversations[key]
    this.#save()
    return true
  }

  /** Remember the list `/bind` just printed so `/bind <n>` can resolve it. */
  setCandidates(key, items) {
    this.data.candidates[key] = { at: Date.now(), items: items.slice(0, MAX_CANDIDATES) }
    this.#save()
  }

  /** The remembered list, or undefined when missing/expired. */
  getCandidates(key, now = Date.now()) {
    const snapshot = this.data.candidates[key]
    if (!isRecord(snapshot) || !Array.isArray(snapshot.items)) return undefined
    if (typeof snapshot.at !== 'number' || now - snapshot.at > CANDIDATE_TTL_MS) return undefined
    return snapshot.items
  }

  /**
   * Forget one conversation's `/bind` list.
   *
   * Called when the list has served its purpose (a selection was made) or was
   * abandoned (`/unbind`). Without this, the pending-selection gate in the
   * inbound handler would keep rejecting ordinary messages until the TTL ran
   * out — the list is exactly what makes a conversation "waiting for a number".
   */
  clearCandidates(key) {
    if (this.data.candidates[key] === undefined) return
    delete this.data.candidates[key]
    this.#save()
  }

  #save() {
    try {
      atomicWriteJson(this.file, this.data, { warn: this.warn })
    } catch (error) {
      this.warn(`could not save bindings: ${String(error?.message ?? error)}`)
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
