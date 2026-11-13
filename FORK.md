# Provenance: dsh-plugin-weixin-lite

This package is a **trimmed derivative** of `dsh-plugin-weixin-bind`, which is
itself a fork of
[`panqing0313/dsh-plugin-weixin`](https://github.com/panqing0313/dsh-plugin-weixin)
(the Weixin/iLink channel plugin for DeepSeek Harness).

- Upstream commit: `eecb640` (`feat(host): verify 0.2.2-rc.1 ...`), fetched 2026-11-05.
- Upstream npm release: `dsh-plugin-weixin@1.5.12`.
- License: MIT (`LICENSE`), plus the vendored Tencent transport
  (`vendor/openclaw-weixin/LICENSE`, MIT). Both files are kept as-is.
- Lite version: `0.1.5` (independent line; the fork's `1.5.12-bind.*` history
  is documented in the fork's own CHANGELOG, not in this repository).

## What lite keeps

Only the remote-control path: WeChat conversation → bound DSH session → reply.

- `src/transport/ilink.js`, `src/vendor/*` — long-poll transport (unchanged).
- `src/agent-bridge.js` — bound turns, last-reply catch-up, cancel, queueing.
- `src/bindings.js`, `src/sessions.js` — binding store and command parsing.
- `src/plan-review.js`, `src/approval-review.js` — WeChat-exclusive review
  waterfalls with optional GUI handoff.
- `src/files.js`, `src/inbound-images.js` — file index/list and native images.
- `src/index.js`, `src/outbound.js`, `src/remote.js` — lite wiring (rewritten).
- `src/state.js`, `src/account-registry.js`, `src/security/allowlist.js`,
  `src/message/*`, `src/media/*` — state, allowlist, chunking, outbound queue,
  inbound media.

## What lite drops

Persona/companion, memory, knowledge base, reminders, digest/reports,
stickers, proactive messaging, journal/metrics/stats, group summaries,
multi-account fan-out logic, ASR/OCR, backups, webhook/notify, GUI card and
settings tabs, and the fork's wide command surface. The card package entry
(`dsh.client`) is gone; configuration is edited in
`~/.dsh/weixin/config.json`.

## Maintenance

- The transport and vendor code are copied from the fork, not re-derived;
  upstream fixes can be re-applied by diffing those directories.
- Tests in `test/*.test.mjs` cover the lite surface only. Host-package tests
  from the fork (`config-remote`, `host-wiring`, `client-remote`) were removed
  with the client bundle.
- Install with `bin/install.mjs --tgz ...`; DSH's startup `pnpm install` needs
  the `file:` dependency so it does not prune the package.
- Never enable this package together with `dsh-plugin-weixin` or
  `dsh-plugin-weixin-bind` for the same WeChat account: each opens its own
  long-poll and messages are split between them.
