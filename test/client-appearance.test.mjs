import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('settings card dispatches the registered host namespace', () => {
  const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const namespace = host.match(/settingsNamespace\('([^']+)'\)/)[1]
  const card = client.slice(client.indexOf('var d4 = ctx.slots.inject("settings.plugin.item"'))
  assert.equal(card.match(/key: "([^"]+)"/)[1], namespace)
  assert.match(client, /--dsw-alias-label-primary-foreground/)
  assert.doesNotMatch(client, /disabledInputStyle[^\n]*opacity: 0\.45/)
  const settings = client.slice(client.indexOf('function EasyRewriteSettingsCard'))
  assert.ok(settings.indexOf('var sOrigImg = React.useState') < settings.indexOf('return React.createElement("li"'), 'image preference hook must run before the conditional card body')
})
