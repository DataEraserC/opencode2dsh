/**
 * Client-bundle build check (dsh-llm-proxy's client-build.test.js adapted):
 * verifies lib/client.js exists (run `pnpm build:client` first) and carries
 * the loader handoff, the plugin id, the Plugins page (`plugins.item`)
 * registration gated on the Host serving the entry, the apply/inject exports
 * the shell expects, and that the bridge URL is baked in.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

/** The built client bundle, with a clear failure when it is missing. */
const bundle = (): string => {
  const path = new URL('../lib/client.js', import.meta.url)
  assert.ok(existsSync(path), 'lib/client.js missing — run `pnpm build:client` first')
  return readFileSync(path, 'utf8')
}

/** The bundle with prose (comments) stripped, so prose cannot satisfy an assertion. */
const code = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('/*'))
    .join('\n')

test('client bundle is built and well-formed', () => {
  const source = bundle()
  assert.ok(source.includes('window.__ModuleLoader__.load'), 'loader handoff present')
  assert.ok(source.includes('"@opencode2dsh/dsh-plugin"'), 'scoped bundle id stamped')
  assert.ok(source.includes('plugins.item'), 'plugins.item registration present')
  assert.ok(source.includes('/api/opencode2dsh/ip-pool'), 'bridge prefix baked in')
  assert.ok(/exports\.apply\s*=/.test(source), 'apply exported')
  assert.ok(/exports\.inject\s*=/.test(source), 'inject exported')
})

test('client mounts on the Plugins page while the Host serves the entry', () => {
  const source = bundle()
  // DSH 0.1.7: the entry is a `plugins.item` LIST slot (id-keyed) owned by the
  // Plugins page, not the old keyed `settings.plugin.item` card slot.
  assert.ok(/name:\s*"plugins\.item"/.test(source), 'registers the plugins.item list entry')
  assert.ok(/id:\s*SETTINGS_NAMESPACE/.test(source), 'entry is keyed by the settings entry id')
  // The gate: without it the page would show even where the Host serves no
  // settings, so the page mounts only while the namespace is served.
  assert.ok(source.includes('whileServed'), 'registration is gated on whileServed')
  assert.ok(/whileServed\(\[SETTINGS_NAMESPACE\]/.test(source), 'gated on this entry\'s namespace')
  // The entry id is the Loader entry id (the plugin name), not the old
  // `ip-pool` namespace the Host registered.
  assert.ok(source.includes('"opencode2dsh"'), 'the served entry id is the plugin name')

  const stripped = code(source)
  assert.ok(!stripped.includes('settings.plugin.item'), 'the removed card slot is not registered')
  assert.ok(!/key:\s*SETTINGS_NAMESPACE/.test(stripped), 'no keyed-era registration shape remains')
})

test('client reads and writes settings through the page-supplied ConfigPageForm', () => {
  const source = bundle()
  // DSH 0.1.7 removed `settingsScope` and the injected `scope/useSnapshot`
  // pair. The Plugins page now hands the page a ConfigPageForm
  // (`{ state, mutate }`) for the served entry.
  assert.ok(source.includes('configForms'), 'the configForms service is used')
  assert.ok(/state\.status/.test(source) || /status === "ready"/.test(source), 'reads the served form state')
  assert.ok(source.includes('.mutate('), 'writes through mutate(ops, revision)')
  // The served value is the whole entry: the editable section is the `ipPool`
  // volatile node, so every write path keeps that field in front.
  assert.ok(/\[\s*IP_POOL_FIELD\s*,\s*write\.field\s*\]/.test(source), 'write paths nest under the ipPool field')
  assert.ok(/\[\s*IP_POOL_FIELD\s*,\s*"pinnedExitId"\s*\]/.test(source), 'pinned-exit write nests under ipPool too')
  // The save control belongs to the shared form chrome, not this page.
  assert.ok(source.includes('SettingsForm'), 'the page renders inside the shared form chrome')

  const stripped = code(source)
  assert.ok(!stripped.includes('settingsScope'), 'no runtime reference to the removed settingsScope service')
  assert.ok(!stripped.includes('useSnapshot'), 'no injected snapshot hook remains')
  assert.ok(!stripped.includes('.bind({ namespace'), 'no settingsScope.bind({ namespace }) call shape remains')
})

test('client externals stay inside the host platform table', () => {
  const source = bundle()
  const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]!)
  const allowed = new Set([
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ])
  for (const specifier of required) {
    assert.ok(
      allowed.has(specifier),
      `bundle requires "${specifier}" which is not in the host module table — it would miss at runtime`,
    )
  }
})

test('client manifest is declared in package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.dsh?.client, 'dsh.client manifest missing')
  assert.equal(pkg.dsh.client.platform, 'web')
  // `dsh.client.inject` names PACKAGE ROWS, not services: client-modules
  // resolves each entry as a row id and uses the edges for factory arrival and
  // plugin composition. A service name is not a row, so the edge silently
  // resolves to nothing and the bundle loads before the services it needs.
  // The service list is the client ENTRY's own `inject` instead.
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-plugin-manager',
  ])
  for (const entry of pkg.dsh.client.inject) {
    assert.ok(entry.startsWith('@deepseek-ai/'), `manifest inject entry "${entry}" is a package name, not a service`)
  }
  // `settingsScope` was removed in 0.1.7; `configForms` replaced it.
  assert.ok(!pkg.dsh.client.inject.some((e: string) => e.includes('settingsScope')), 'the service DSH removed is not requested')

  const entry = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.match(entry, /export const inject = \['slots', 'locale'\]/, 'only stable services gate the main client fiber')
  assert.ok(bundle().includes('plugins.row.config'), 'the DSH 0.2 row configuration is registered')
  assert.deepEqual(pkg.exports?.['./client'], './lib/client.js')
})
