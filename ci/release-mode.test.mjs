import test from 'node:test'
import assert from 'node:assert/strict'
import { publicationSafety, releasePlan } from './release-mode.mjs'

const pkg = { name: 'test-plugin', version: '1.2.3-moe4all.3' }
const env = { repository: 'Headmaster218/test-plugin', sha: 'a'.repeat(40), event: 'workflow_dispatch', ref: 'refs/heads/main' }

test('manual main validation is always a draft; regular version tags retain public release behavior', () => {
  const draft = releasePlan(pkg, env)
  assert.equal(draft.draft, true)
  assert.equal(draft.tag, 'release-' + pkg.version)
  const tagged = releasePlan(pkg, { ...env, event: 'push', ref: 'refs/tags/' + draft.tag })
  assert.equal(tagged.draft, false)
  assert.equal(tagged.sha, draft.sha)
})

test('manual branches, PRs, forged repositories and mismatched tags cannot publish', () => {
  for (const change of [
    { ref: 'refs/heads/feature' }, { event: 'pull_request' }, { event: 'push' },
    { repository: 'other/test-plugin' }, { sha: 'bad' }, { event: 'push', ref: 'refs/tags/release-9.9.9' },
  ]) assert.throws(() => releasePlan(pkg, { ...env, ...change }))
})

test('never overwrite existing releases or tags; only manual drafts can create a new tag', () => {
  const draft = releasePlan(pkg, env)
  assert.doesNotThrow(() => publicationSafety(draft, false, undefined))
  assert.doesNotThrow(() => publicationSafety(draft, false, env.sha))
  assert.throws(() => publicationSafety(draft, true, env.sha))
  assert.throws(() => publicationSafety(draft, false, 'b'.repeat(40)))
  assert.throws(() => publicationSafety({ ...draft, draft: false }, false, undefined))
})
