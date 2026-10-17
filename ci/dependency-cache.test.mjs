import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cachePlan } from './dependency-cache.mjs'

const testRoot = process.env.MOE4ALL_CI_TEST_ROOT || process.env.RUNNER_TEMP
assert(testRoot, 'Set an isolated MOE4ALL_CI_TEST_ROOT or RUNNER_TEMP')
mkdirSync(testRoot, { recursive: true })
function fixture() {
  const root = mkdtempSync(join(testRoot, 'dependency-cache-'))
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }))
  const config = { schema: 1, npmVersion: '10.9.2', lockfiles: ['package-lock.json'] }
  const env = { os: 'Windows', arch: 'X64', nodeVersion: '24.21.0', temp: root, event: 'push', ref: 'refs/heads/main' }
  return { root, config, env, plan: (overrides = {}) => cachePlan(root, config, { ...env, ...overrides }) }
}

test('main development and tagged releases have identical dependency keys; only main saves', () => {
  const f = fixture(), main = f.plan(), tag = f.plan({ ref: 'refs/tags/release-1.2.3' })
  assert.equal(main.key, tag.key)
  assert.equal(main.restoreKey, tag.restoreKey)
  assert.equal(main.save, true)
  assert.equal(tag.save, false)
  assert.equal(f.plan({ event: 'pull_request' }).save, false)
  assert.equal(f.plan({ event: 'pull_request_target' }).save, false)
  assert.equal(f.plan({ event: 'workflow_call' }).save, false)
  assert.equal(f.plan({ event: 'workflow_dispatch' }).save, true)
  assert.equal(f.plan({ event: 'workflow_dispatch', ref: 'refs/heads/feature' }).save, false)
})

test('lock changes invalidate exact hits but retain the safe content-addressed download prefix', () => {
  const f = fixture(), before = f.plan()
  writeFileSync(join(f.root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { changed: {} } }))
  const after = f.plan()
  assert.notEqual(before.key, after.key)
  assert.equal(before.restoreKey, after.restoreKey)
})

test('OS, architecture, Node and npm versions separate incompatible caches', () => {
  const f = fixture(), key = f.plan().key
  for (const change of [{ os: 'Linux' }, { arch: 'ARM64' }, { nodeVersion: '24.9.0' }]) assert.notEqual(key, f.plan(change).key)
  f.config.npmVersion = '11.0.0'
  assert.notEqual(key, f.plan().key)
})

test('all selected lockfiles and names participate in deterministic keys', () => {
  const f = fixture()
  writeFileSync(join(f.root, 'second.json'), JSON.stringify({ lockfileVersion: 3 }))
  f.config.lockfiles.push('second.json')
  const before = f.plan().key
  f.config.lockfiles.reverse()
  assert.equal(before, f.plan().key)
  writeFileSync(join(f.root, 'second.json'), JSON.stringify({ lockfileVersion: 3, changed: true }))
  assert.notEqual(before, f.plan().key)
})

test('missing, invalid and escaping locks fail instead of creating an empty shared key', () => {
  const f = fixture()
  for (const lockfiles of [[], ['missing.json'], ['../package-lock.json'], ['/package-lock.json'], ['C:/lock.json']]) {
    assert.throws(() => cachePlan(f.root, { ...f.config, lockfiles }, f.env))
  }
  writeFileSync(join(f.root, 'package-lock.json'), '{bad json')
  assert.throws(() => f.plan())
  assert.throws(() => f.plan({ temp: '' }))
})
