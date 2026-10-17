import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const implementationVersion = 1

export function cachePlan(root, config, environment) {
  assert.equal(config.schema, 1)
  assert.match(config.npmVersion, /^\d+\.\d+\.\d+$/u)
  assert(Array.isArray(config.lockfiles) && config.lockfiles.length > 0, 'At least one frozen lockfile is required')
  const digest = createHash('sha256')
  const base = realpathSync(root)
  for (const name of [...new Set(config.lockfiles)].sort()) {
    assert(typeof name === 'string' && !isAbsolute(name) && !/[\\:\0\r\n]/u.test(name) && !name.split('/').includes('..'), 'Unsafe lockfile path')
    const file = realpathSync(resolve(base, name))
    assert(!relative(base, file).startsWith('..' + sep) && !isAbsolute(relative(base, file)), 'Lockfile escapes repository')
    const bytes = readFileSync(file)
    assert.equal(JSON.parse(bytes).lockfileVersion, 3, 'A frozen npm v3 lockfile is required')
    digest.update(name + '\0').update(bytes).update('\0')
  }
  const { os, arch, nodeVersion, temp, event, ref } = environment
  for (const value of [os, arch, nodeVersion]) assert.match(value, /^[0-9A-Za-z._-]+$/u)
  assert(temp && isAbsolute(temp) && !/[\r\n]/u.test(temp), 'An explicit absolute cache directory is required')
  const prefix = `moe4all-npm-v${implementationVersion}-${os}-${arch}-node-${nodeVersion}-npm-${config.npmVersion}-`
  return {
    key: prefix + digest.digest('hex'), restoreKey: prefix,
    path: resolve(temp, 'moe4all-dependency-cache', 'npm'),
    save: ref === 'refs/heads/main' && ['push', 'workflow_dispatch'].includes(event),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const config = JSON.parse(readFileSync(resolve(root, 'ci/cache.json'), 'utf8'))
  const plan = cachePlan(root, config, {
    os: process.env.RUNNER_OS, arch: process.env.RUNNER_ARCH, nodeVersion: process.versions.node,
    temp: process.env.MOE4ALL_CI_CACHE_ROOT || process.env.RUNNER_TEMP,
    event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
  })
  mkdirSync(plan.path, { recursive: true })
  assert(process.env.GITHUB_OUTPUT && process.env.GITHUB_ENV, 'Run this entry point from a GitHub Actions step')
  for (const [name, value] of Object.entries(plan)) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
  appendFileSync(process.env.GITHUB_ENV, `NPM_CONFIG_CACHE=${plan.path}\n`)
  console.log(JSON.stringify({ implementationVersion, ...plan }))
}
