import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function releasePlan(pkg, environment) {
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
  assert.equal(environment.repository, 'Headmaster218/' + pkg.name)
  assert.match(environment.sha, /^[a-f0-9]{40}$/u)
  const draft = environment.event === 'workflow_dispatch'
  if (draft) assert.equal(environment.ref, 'refs/heads/main', 'Manual draft validation must run from main')
  else assert.equal(environment.event, 'push', 'Only a release tag push or manual main draft is allowed')
  const tag = draft ? 'release-' + pkg.version : environment.ref.replace(/^refs\/tags\//u, '')
  assert(draft || environment.ref.startsWith('refs/tags/'), 'Public releases require a tag push')
  assert(['release-' + pkg.version, 'v' + pkg.version].includes(tag), 'Release tag must exactly match the package version')
  return { tag, draft, sha: environment.sha, repository: environment.repository }
}

export function publicationSafety(plan, releaseExists, tagCommit) {
  assert(!releaseExists, 'Refusing to overwrite an existing draft or public release')
  if (tagCommit) assert.equal(tagCommit, plan.sha, 'Existing release tag points to another commit')
  else assert(plan.draft, 'Public publication requires an existing pushed tag')
}

function command(root, executable, args, missing = false) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', timeout: 120_000 })
  if (missing && result.status !== 0 && /HTTP 404/u.test(result.stderr ?? '')) return null
  assert.equal(result.status, 0, result.stderr || String(result.error))
  return result.stdout.trim()
}

function localAsset(root, name) {
  assert(typeof name === 'string' && !/[\\:\0\r\n]/u.test(name) && !name.startsWith('/') && !name.split('/').includes('..'))
  const file = resolve(root, name)
  assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Release assets must be regular files')
  return file
}

function publish(root, pkg, plan) {
  const config = JSON.parse(readFileSync(resolve(root, 'ci/release.json'), 'utf8'))
  assert.equal(command(root, 'git', ['rev-parse', 'HEAD']), plan.sha)
  command(root, 'git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'])
  const sums = readFileSync(localAsset(root, 'dist/SHA256SUMS.txt'), 'utf8').replace(/^\uFEFF/u, '')
  for (const name of config.assets) {
    const file = localAsset(root, 'dist/' + name)
    if (name === 'SHA256SUMS.txt') continue
    const row = sums.split(/\r?\n/u).find(line => line.slice(66) === name)
    assert(row && /^[a-f0-9]{64}  /u.test(row), 'Missing release checksum: ' + name)
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), row.slice(0, 64), 'Release checksum mismatch')
  }
  let prerelease = pkg.version.includes('-')
  if (config.assets.includes('plugin-release.json')) {
    const metadata = JSON.parse(readFileSync(localAsset(root, 'dist/plugin-release.json'), 'utf8'))
    assert.equal(metadata.name, pkg.name)
    assert.equal(metadata.version, pkg.version)
    assert.equal(metadata.tag, plan.tag)
    assert.equal(metadata.commit, plan.sha)
    assert.equal(typeof metadata.prerelease, 'boolean')
    prerelease = metadata.prerelease
  }
  const endpoint = 'repos/' + plan.repository
  const gh = (args, missing = false) => command(root, 'gh', args, missing)
  const existingRelease = gh(['api', endpoint + '/releases/tags/' + encodeURIComponent(plan.tag)], true)
  const tag = gh(['api', endpoint + '/git/ref/tags/' + encodeURIComponent(plan.tag)], true)
  let object = tag ? JSON.parse(tag).object : null
  for (let depth = 0; object?.type === 'tag' && depth < 4; depth++) object = JSON.parse(gh(['api', endpoint + '/git/tags/' + object.sha])).object
  if (object) assert.equal(object.type, 'commit', 'Release tag must resolve to a commit')
  publicationSafety(plan, existingRelease !== null, object?.sha)
  if (!object) {
    // GITHUB_TOKEN-created refs do not trigger another tag workflow or publish publicly.
    gh(['api', '--method', 'POST', endpoint + '/git/refs', '-f', 'ref=refs/tags/' + plan.tag, '-f', 'sha=' + plan.sha])
  }
  const args = ['release', 'create', plan.tag, ...config.assets.map(name => 'dist/' + name),
    '--repo', plan.repository, '--verify-tag', '--title', pkg.name + ' ' + pkg.version]
  if (plan.draft) args.push('--draft')
  if (prerelease) args.push('--prerelease')
  if (config.notesFile) args.push('--notes-file', localAsset(root, config.notesFile))
  else args.push('--generate-notes')
  console.log(gh(args))
  console.log(JSON.stringify({ ...plan, prerelease, assets: config.assets }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const plan = releasePlan(pkg, { event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
    repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA })
  if (process.argv[2] === 'publish') publish(root, pkg, plan)
  else {
    assert.equal(process.argv[2], 'plan')
    assert(process.env.GITHUB_OUTPUT)
    for (const [key, value] of Object.entries(plan)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
    console.log(JSON.stringify(plan))
  }
}
