import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, symlinkSync, renameSync, cpSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve, join, extname, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const manifest = json(join(root, 'package.json'))
const config = json(join(root, 'ci/config.json'))
const hostRoot = join(root, 'ci/host')
const requireHost = createRequire(join(hostRoot, 'package.json'))
const semver = requireHost('semver'), yaml = requireHost('js-yaml'), tar = requireHost('tar')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const { positionals, values } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, tag: { type: 'string' } } })
const action = positionals[0] ?? 'check'
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 600_000, ...options })
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error))
  return result.stdout
}
function npm(args) {
  assert(process.env.npm_execpath, 'Run through an npm script')
  return run(process.execPath, [process.env.npm_execpath, ...args, '--ignore-scripts', '--no-audit', '--no-fund'])
}
function localFile(file) {
  assert(typeof file === 'string' && file.length > 0 && !/[\\:\0]/u.test(file) && !posix.isAbsolute(file))
  assert(!file.split('/').includes('..'), 'Unsafe package path: ' + file)
  return join(root, file)
}
function exportedFiles(value) {
  if (typeof value === 'string') return value.startsWith('./') ? [value.slice(2)] : []
  return value && typeof value === 'object' ? Object.values(value).flatMap(exportedFiles) : []
}
function validateTag(tag, version) {
  assert(semver.valid(version), 'Package version must be valid SemVer')
  assert(tag === 'v' + version || tag === 'release-' + version, 'Tag must exactly match package version')
}
function isPrerelease(version) {
  const parts = semver.prerelease(version)
  return parts !== null && !(parts.length === 2 && parts[0] === 'moe4all' && Number.isSafeInteger(parts[1]))
}
function sourceCommit() {
  const override = process.env.MOE4ALL_CI_SOURCE_COMMIT
  if (override) {
    assert.match(override, /^[a-f0-9]{40}$/u)
    return override
  }
  const top = resolve(run('git', ['rev-parse', '--show-toplevel']).trim())
  assert.equal(process.platform === 'win32' ? top.toLowerCase() : top,
    process.platform === 'win32' ? root.toLowerCase() : root, 'Snapshot requires MOE4ALL_CI_SOURCE_COMMIT')
  return run('git', ['rev-parse', 'HEAD']).trim()
}
function ensureHost() {
  assert(existsSync(join(hostRoot, 'node_modules')), 'Install the frozen ci/host lock first')
  if (!existsSync(join(root, 'node_modules'))) symlinkSync(join(hostRoot, 'node_modules'), join(root, 'node_modules'), 'junction')
}
function packList() {
  const [pack] = JSON.parse(npm(['pack', '--dry-run', '--json']))
  assert.equal(pack.name, manifest.name)
  assert.equal(pack.version, manifest.version)
  return pack
}
function patchRows(rows) {
  assert(Array.isArray(rows), 'Bundle patch must be an array')
  return rows.flatMap(row => [...(row.insert ? patchRows(row.insert) : []), row])
}
async function check() {
  ensureHost()
  assert.equal(manifest.name, config.package)
  assert.equal(manifest.repository.url, 'git+https://github.com/Headmaster218/' + manifest.name + '.git')
  assert(semver.valid(manifest.version))
  const lock = json(join(hostRoot, 'package-lock.json'))
  assert.equal(lock.lockfileVersion, 3)
  assert.deepEqual(lock.packages[''].dependencies, json(join(hostRoot, 'package.json')).dependencies)
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name) assert(entry.integrity && /^https:\/\/registry\.npmjs\.org\//u.test(entry.resolved ?? ''), 'Unfrozen CI dependency: ' + name)
  }
  const pack = packList(), files = new Set(pack.files.map(file => file.path))
  const required = [manifest.main, manifest.types, manifest.dsh?.bundle?.patch].filter(Boolean)
    .map(file => file.replace(/^\.\//u, '')).concat(exportedFiles(manifest.exports))
  for (const file of required) assert(files.has(file), 'Missing public package entry: ' + file)
  assert(files.has('LICENSE'), 'Published package must include its license')
  assert([...files].some(file => /^README(?:\.|$)/u.test(file)))
  for (const file of files) {
    localFile(file)
    assert(!/(?:^|\/)(?:node_modules|\.git|\.env(?:\..*)?|agent-state|kv-sessions)(?:\/|$)/u.test(file), 'Private payload: ' + file)
    assert(!/\.(?:log|sqlite|db|gguf|pth|onnx|pem|key)$/iu.test(file), 'Runtime data in package: ' + file)
    if (!['.js', '.mjs', '.cjs'].includes(extname(file))) continue
    const code = readFileSync(localFile(file), 'utf8')
    const module = extname(file) === '.cjs' ? new vm.Script(code, { filename: file }) : new vm.SourceTextModule(code, { identifier: file })
    for (const specifier of module.dependencySpecifiers ?? []) {
      if (specifier.startsWith('.')) {
        const imported = posix.normalize(posix.join(posix.dirname(file), specifier))
        assert(files.has(imported), 'Missing packaged import: ' + file + ' -> ' + imported)
      }
    }
  }
  const patch = manifest.dsh.bundle.patch.replace(/^\.\//u, '')
  assert(patchRows(yaml.load(readFileSync(localFile(patch), 'utf8'))).some(row => row.name === manifest.name), 'Bundle must register its package')
  if (manifest.exports?.['./client']) {
    const client = exportedFiles(manifest.exports['./client']).find(file => file.endsWith('.js'))
    assert(client)
    const code = readFileSync(localFile(client), 'utf8')
    const ids = [...code.matchAll(/__ModuleLoader__\.load\(\{\s*id:\s*["']([^"']+)["']/gu)].map(match => match[1])
    assert(ids.includes(manifest.name), 'Client loader id must match package name')
    for (const match of code.matchAll(/\brequire\(["']([^"']+)["']\)/gu)) assert(config.clientRequires.includes(match[1]), 'Unmaterialized client dependency: ' + match[1])
  }
  if (config.syncCheck) run(process.execPath, [config.syncCheck])
  const plugin = await import(pathToFileURL(localFile(manifest.main)).href)
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.name, 'string')
  if (plugin.inject !== undefined) assert(Array.isArray(plugin.inject) || typeof plugin.inject === 'object')
  console.log('Verified committed runtime: ' + manifest.name + ', ' + pack.files.length + ' files; host import only, not full Agent integration.')
}
function tests() {
  ensureHost()
  for (const command of config.tests) {
    if (command.kind === 'node-test') {
      const files = readdirSync(join(root, command.directory)).filter(file => command.extensions.some(extension => file.endsWith(extension)))
        .sort().map(file => join(command.directory, file))
      assert(files.length > 0, 'No tests found: ' + command.directory)
      run(process.execPath, ['--test', ...files], { stdio: 'inherit' })
    } else run(process.execPath, command.args, {
      stdio: 'inherit',
      ...(command.preload ? { env: { ...process.env,
        NODE_OPTIONS: ((process.env.NODE_OPTIONS ?? '') + ' --import=' + pathToFileURL(localFile(command.preload)).href).trim(),
      } } : {}),
    })
  }
}
async function verifyRelease(out) {
  const info = json(join(out, 'plugin-release.json'))
  assert.equal(info.schema, 'moe4all/plugin-release/v1')
  assert.equal(info.name, manifest.name)
  assert.equal(info.version, manifest.version)
  validateTag(info.tag, info.version)
  assert.equal(info.repository, 'Headmaster218/' + manifest.name)
  assert.match(info.commit, /^[a-f0-9]{40}$/u)
  assert.equal(info.commit, sourceCommit(), 'Release commit does not match source')
  assert.equal(info.prerelease, isPrerelease(info.version))
  assert.equal(info.archive.name, manifest.name + '.tgz')
  const archive = join(out, info.archive.name), bytes = readFileSync(archive)
  assert.equal(info.archive.bytes, bytes.length)
  assert.equal(info.archive.sha256, hash(bytes))
  assert.equal(info.archive.integrity, 'sha512-' + createHash('sha512').update(bytes).digest('base64'))
  const packed = new Map(), pending = []
  await tar.t({ file: archive, onReadEntry(entry) {
    if (entry.type === 'Directory') return
    assert.equal(entry.type, 'File', 'No archive links or special entries')
    assert(entry.path.startsWith('package/'))
    const name = entry.path.slice(8)
    localFile(name)
    assert(!packed.has(name), 'Duplicate tar entry: ' + name)
    const chunks = []
    packed.set(name, null)
    pending.push(new Promise((done, reject) => {
      entry.on('error', reject)
      entry.on('data', chunk => chunks.push(chunk))
      entry.on('end', () => {
        try {
          const content = Buffer.concat(chunks)
          assert.equal(hash(content), hash(readFileSync(localFile(name))), 'Stale package content: ' + name)
          packed.set(name, content)
          done()
        } catch (error) { reject(error) }
      })
    }).catch(error => error))
  } })
  const error = (await Promise.all(pending)).find(result => result instanceof Error)
  if (error) throw error
  assert.deepEqual([...packed.keys()].sort(), packList().files.map(file => file.path).sort())
  assert.equal(JSON.parse(packed.get('package.json')).version, info.version)
  const expected = [info.archive.name, 'plugin-release.json'].map(file => hash(readFileSync(join(out, file))) + '  ' + file).join('\n') + '\n'
  assert.equal(readFileSync(join(out, 'SHA256SUMS.txt'), 'utf8'), expected)
  console.log('Release verified: exact payload, version, repository, commit, SHA256 and integrity')
}
async function pack(out, tag) {
  validateTag(tag, manifest.version)
  await check()
  mkdirSync(out, { recursive: true })
  for (const file of [manifest.name + '.tgz', 'plugin-release.json', 'SHA256SUMS.txt']) assert(!existsSync(join(out, file)), 'Do not overwrite release assets: ' + file)
  const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', out]))
  const archive = join(out, manifest.name + '.tgz')
  renameSync(join(out, packed.filename), archive)
  const bytes = readFileSync(archive)
  const info = {
    schema: 'moe4all/plugin-release/v1', name: manifest.name, version: manifest.version,
    tag, repository: 'Headmaster218/' + manifest.name,
    commit: sourceCommit(),
    prerelease: isPrerelease(manifest.version),
    runtime: { node: manifest.engines?.node ?? null, dsh: manifest.engines?.dsh ?? null, peers: manifest.peerDependencies ?? {} },
    validation: { mode: 'committed-runtime', hostImport: json(join(hostRoot, 'package.json')).dependencies['@deepseek-ai/dsh'], fullAgentIntegration: false, gpu: false },
    archive: { name: manifest.name + '.tgz', bytes: bytes.length, sha256: hash(bytes),
      integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') },
  }
  writeFileSync(join(out, 'plugin-release.json'), JSON.stringify(info, null, 2) + '\n')
  writeFileSync(join(out, 'SHA256SUMS.txt'), [info.archive.name, 'plugin-release.json'].map(file => hash(readFileSync(join(out, file))) + '  ' + file).join('\n') + '\n')
  await verifyRelease(out)
}
if (action === 'check') await check()
else if (action === 'test') tests()
else if (action === 'pack') await pack(resolve(values.out ?? 'dist'), values.tag ?? '')
else if (action === 'verify-release') await verifyRelease(resolve(values.out ?? 'dist'))
else if (action === 'test-contract') {
  for (const version of ['1.2.3', '1.2.3-moe4all.1', '1.2.3-moe4all.2']) assert.equal(isPrerelease(version), false, version)
  for (const version of ['1.2.3-beta.1', '1.2.3-rc.1', '1.2.3-preview.1', '1.2.3-moe4all.2.beta.1']) assert.equal(isPrerelease(version), true, version)
  validateTag('release-1.2.3', '1.2.3')
  validateTag('v1.2.3-beta.1', '1.2.3-beta.1')
  for (const tag of ['release-1.2.4', '../1.2.3', '1.2.3', 'v1.2.3;exit']) assert.throws(() => validateTag(tag, '1.2.3'))
  for (const file of ['../secret', '/secret', 'lib\\secret', 'C:/secret', '']) assert.throws(() => localFile(file))
  if (values.out) {
    const out = resolve(values.out)
    await verifyRelease(out)
    const scratch = mkdtempSync(join(tmpdir(), 'moe4all-release-contract-'))
    try {
      for (const fault of ['checksum', 'archive', 'version', 'commit', 'tag']) {
        const copy = join(scratch, fault)
        cpSync(out, copy, { recursive: true })
        const info = json(join(copy, 'plugin-release.json'))
        if (fault === 'checksum') writeFileSync(join(copy, 'SHA256SUMS.txt'), 'invalid\n')
        else if (fault === 'archive') writeFileSync(join(copy, info.archive.name), 'invalid archive')
        else {
          info[fault] = fault === 'commit' ? '0'.repeat(40) : 'invalid'
          writeFileSync(join(copy, 'plugin-release.json'), JSON.stringify(info))
        }
        await assert.rejects(() => verifyRelease(copy), 'Must reject corrupted ' + fault)
      }
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  }
  console.log('Release contract negative cases passed')
} else throw new Error('Unknown CI action: ' + action)
