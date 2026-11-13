// Remote service for the lite plugin: the GUI settings section may call these.
//
// Deliberately small: status, config, allowlist and the binding list. Login is
// a CLI step (`node bin/login.js`), because the QR flow needs the vendored
// iLink auth client and a terminal to display the image.
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { atomicWriteJson } from './atomic.js'
import { allowlistForAccount, readRegistry, setAccountAllowlist } from './account-registry.js'
import { configFile, readSavedConfig, stateDir } from './state.js'
import { remoteMethods } from './typert-js.js'

const SAVEABLE = new Set([
  'accountId',
  'cwd',
  'allowedSenders',
  'allowedChats',
  'maxMessageLength',
  'markdownMode',
  'mediaEnabled',
  'nativeImageInput',
  'maxMediaBytes',
  'maxInboundMediaBytes',
  'busyMessageMode',
  'progressAfterMs',
  'maxTurnWaitMs',
  'eventPollMs',
  'sendIntervalMs',
  'sendCooldownMs',
  'cdnBaseUrl',
  'bindEnabled',
  'bindIdleWaitMs',
  'planReviewInWechat',
  'planReviewWaitMs',
  'planReviewGuiHandoffMs',
  'approvalInWechat',
  'approvalGuiHandoffMs',
  'autoSendFiles',
  'locale',
])

export class WeixinLiteController extends TypertRemoteService {
  constructor(ctx, { stateRoot, config, bindings, runtime, warn = () => {} }) {
    super(ctx, 'weixinLiteController', { namespace: 'weixin' })
    this.stateRoot = stateRoot
    this.readConfig = config
    this.bindings = bindings
    this.runtime = runtime
    this.warn = warn
  }

  async status() {
    const cfg = this.readConfig()
    return {
      ok: true,
      stateDir: stateDir(),
      accountId: cfg.accountId ?? '',
      listening: [...this.runtime.transports.keys()],
      accounts: this.runtime.accounts.map((account) => ({ accountId: account.accountId, baseUrl: account.baseUrl })),
      errors: Object.fromEntries(this.runtime.errors.entries()),
      bindings: this.bindings.list().map((entry) => ({
        key: entry.key,
        sessionId: entry.sessionId,
        title: entry.title ?? '',
        cwd: entry.cwd ?? '',
        boundAt: entry.boundAt ?? 0,
      })),
    }
  }

  async configGet() {
    const saved = readSavedConfig()
    const config = {}
    for (const key of SAVEABLE) config[key] = saved[key]
    return { ok: true, config }
  }

  async configSave(patch) {
    if (patch === null || typeof patch !== 'object') return { ok: false, error: 'patch must be an object' }
    const next = { ...readSavedConfig() }
    for (const [key, value] of Object.entries(patch)) {
      if (!SAVEABLE.has(key)) continue
      next[key] = value
    }
    atomicWriteJson(configFile(), next, { warn: this.warn })
    await this.runtime.rearm?.()
    return { ok: true }
  }

  async allowlist() {
    const cfg = this.readConfig()
    const registry = readRegistry()
    const accounts = Object.keys(registry)
    if (accounts.length === 0 && cfg.accountId) accounts.push(cfg.accountId)
    return {
      ok: true,
      accounts: accounts.map((accountId) => {
        const entry = registry[accountId] ?? {}
        const merged = allowlistForAccount(accountId, cfg)
        return {
          accountId,
          allowedSenders: merged.allowedSenders,
          allowedChats: merged.allowedChats,
          override: Array.isArray(entry.allowedSenders) || Array.isArray(entry.allowedChats),
          paused: entry.paused === true,
        }
      }),
    }
  }

  async allowlistSave(accountId, senders, chats) {
    if (typeof accountId !== 'string' || accountId === '') return { ok: false, error: 'accountId is required' }
    const clean = (list) =>
      (Array.isArray(list) ? list : [])
        .map((value) => String(value ?? '').trim())
        .filter((value) => value !== '')
    setAccountAllowlist(accountId, clean(senders), clean(chats), this.warn)
    return { ok: true }
  }

  async bindings() {
    return {
      ok: true,
      conversations: this.bindings.list().map((entry) => ({
        key: entry.key,
        sessionId: entry.sessionId,
        title: entry.title ?? '',
        cwd: entry.cwd ?? '',
        boundAt: entry.boundAt ?? 0,
      })),
    }
  }

  async unbind(key) {
    if (typeof key !== 'string' || key === '') return { ok: false, error: 'key is required' }
    const removed = this.bindings.unbind(key)
    return { ok: removed === true }
  }

  async reload() {
    await this.runtime.rearm?.()
    return { ok: true }
  }
}

remoteMethods(WeixinLiteController, [
  'status',
  'configGet',
  'configSave',
  'allowlist',
  'allowlistSave',
  'bindings',
  'unbind',
  'reload',
])
