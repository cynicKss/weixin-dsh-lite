#!/usr/bin/env node
// Install this package into a DSH profile.
//
//   node bin/install.mjs --tgz dist/<name>-<version>.tgz [--profile <dir>]
//   node bin/install.mjs --uninstall [--profile <dir>]
//
// The profile is the directory that carries cordis.yml (normally
// ~/.dsh/profiles/desktop). DSH runs pnpm install against the profile at
// startup, so a package that only exists as loose files in node_modules is
// pruned again. The installer therefore pins the tarball as a `file:`
// dependency, records the bundle name, and runs pnpm itself.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-plugin-weixin-lite'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const args = process.argv.slice(2)
let profile = process.env.DSH_PROFILE_DIR ?? ''
let tgz = ''
let uninstall = false
let noPnpm = false
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--profile') profile = args[++i] ?? profile
  else if (args[i] === '--tgz') tgz = args[++i] ?? ''
  else if (args[i] === '--uninstall') uninstall = true
  else if (args[i] === '--no-pnpm') noPnpm = true
  else if (args[i] === '--help') {
    console.log('usage: node bin/install.mjs --tgz <tarball> [--profile <dir>] [--no-pnpm]')
    console.log('       node bin/install.mjs --uninstall [--profile <dir>]')
    process.exit(0)
  }
}
if (profile === '') profile = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const manifestPath = path.join(profile, 'package.json')
if (!fs.existsSync(manifestPath)) {
  console.error(`not a DSH profile (no package.json): ${profile}`)
  process.exit(1)
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
manifest.dependencies ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
manifest.dsh.profile.bundles = bundles
const writeManifest = () => fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

if (uninstall) {
  manifest.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE)
  delete manifest.dependencies[PACKAGE]
  writeManifest()
  fs.rmSync(path.join(profile, 'node_modules', PACKAGE), { recursive: true, force: true })
  console.log(`removed ${PACKAGE} from ${profile}`)
  console.log('restart DeepSeek Harness. The old plugin, if any, is untouched.')
  process.exit(0)
}

const others = ['dsh-plugin-weixin', 'dsh-plugin-weixin-bind'].filter((name) => bundles.includes(name))
if (others.length > 0) {
  console.warn(`warning: ${others.join(', ')} still enabled in this profile; two Weixin long-polls on one account steal each other's messages.`)
  console.warn(`remove ${others.join(', ')} from dsh.profile.bundles (and dependencies) before restarting.`)
}

if (tgz === '') {
  console.error('missing --tgz <tarball>; run `pnpm pack` first')
  process.exit(1)
}
const tarball = path.resolve(tgz)
if (!fs.existsSync(tarball)) {
  console.error(`tarball not found: ${tarball}`)
  process.exit(1)
}
const packagesDir = path.join(profile, 'packages')
fs.mkdirSync(packagesDir, { recursive: true })
const stored = path.join(packagesDir, path.basename(tarball))
fs.copyFileSync(tarball, stored)

manifest.dependencies[PACKAGE] = `file:${stored.replaceAll('\\', '/')}`
if (!manifest.dsh.profile.bundles.includes(PACKAGE)) manifest.dsh.profile.bundles.push(PACKAGE)
writeManifest()

if (!noPnpm) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawnSync(pnpm, ['install', '--prefer-offline'], { cwd: profile, stdio: 'inherit' })
  if (result.status !== 0) {
    console.warn(`pnpm install exited with ${result.status ?? 'an error'}; run it manually in ${profile}`)
  }
}

const installed = path.join(profile, 'node_modules', PACKAGE)
if (!fs.existsSync(installed)) {
  console.warn(`expected ${installed} after install; check \`pnpm install\` output`)
}
const configFile = path.join(os.homedir(), '.dsh', 'weixin', 'config.json')
if (!fs.existsSync(configFile)) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  fs.writeFileSync(configFile, '{}\n')
}
console.log(`installed ${PACKAGE} into ${installed}`)
console.log('restart DeepSeek Harness completely to load it.')
