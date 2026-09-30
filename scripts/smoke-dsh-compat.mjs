#!/usr/bin/env node
// Usage: node scripts/smoke-dsh-compat.mjs <installed @deepseek-ai/dsh directory>
// Uses the installed host's real module loader, Cordis fibers and SlotCore.
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

const host = resolve(process.argv[2] ?? '')
const hostRequire = createRequire(join(host, 'package.json'))
const hostImport = async (name) => import(pathToFileURL(hostRequire.resolve(name)).href)
const { Context, Service } = await hostImport('@deepseek-ai/cordis')
const { SlotCore } = await hostImport('@deepseek-ai/dsh-client-ui-slots')
const { default: HostSchema } = await hostImport('@deepseek-ai/schemastery')
const { createVolatile, updateVolatile } = await hostImport('@deepseek-ai/cosmokit')
const { LlmRuntime } = await hostImport('@deepseek-ai/dsh-llm')
const pluginRoot = new URL('../packages/plugin/', import.meta.url)
const pluginRequire = createRequire(new URL('package.json', pluginRoot))
const pkg = JSON.parse(readFileSync(new URL('package.json', pluginRoot), 'utf8'))
const bundle = readFileSync(new URL('lib/client.js', pluginRoot), 'utf8')
const loaderPath = hostRequire.resolve('@deepseek-ai/dsh-client-modules/client')
let modulesExports
runInNewContext(readFileSync(loaderPath, 'utf8'), {
  window: { __ModuleLoader__: { load: ({ factory }) => {
    modulesExports = factory(() => { throw new Error('unexpected loader external') })
  } } },
})
const target = { mode: 'queue', pendingQueue: [], load(row) { this.pendingQueue.push(row) } }
const ui = '@deepseek-ai/dsh-client-ui-primitives'
const declarations = [{ id: pkg.name, inject: pkg.dsh.client.inject, external: pkg.dsh.client.external },
  ...pkg.dsh.client.inject.map((id) => ({ id }))]
const manifest = {
  rev: 'smoke', plugins: [],
  modules: declarations.map((row) => ({ ...row, rev: 'smoke', url: row.id, initialUrl: row.id, inject: row.inject ?? [], external: row.external ?? [] })),
}
const modules = new modulesExports.ClientModuleSystem({
  manifest, registrationTarget: target, bootstrapModule: { id: '@deepseek-ai/dsh-client-modules', exports: modulesExports },
  staticModules: {
    react: pluginRequire('react'), 'react/jsx-runtime': pluginRequire('react/jsx-runtime'),
    [ui]: { IconChevronDownOutline14: () => null },
  },
  loadBundle: async (id) => {
    if (id === pkg.name) runInNewContext(bundle, { window: { __ModuleLoader__: target }, console })
    else target.load({ id, factory: () => ({}) })
  },
})
const client = await modules.import(pkg.name)
assert.deepEqual(Array.from(client.inject), ['slots', 'locale'])
const ctx = new Context()
const core = new SlotCore()
core.register({ name: 'root', children: { 'plugins.row.config': { kind: 'keyed', scope: 'root' } } }, () => null)
class Slots extends Service {
  constructor(ctx, core) { super(ctx, 'slots'); this.core = core }
  spec(name) { return this.core.specDynamic(name) }
  register(options, component) { return this.core.register(options, component) }
  inject(name, callback) {
    if (this.core.specDynamic(name) === undefined) return () => {}
    return this.ctx.effect(callback)
  }
}
new Slots(ctx, core)
ctx.reflect.provide('locale', { register: () => () => {}, bind: () => (key) => key })
class ConfigForms extends Service {
  constructor(ctx) { super(ctx, 'configForms') }
  whileServed(names, register) {
    assert.deepEqual(Array.from(names), ['opencode2dsh'])
    return register(new Set(names))
  }
}
new ConfigForms(ctx)
// Reproduce the boot blocker: adding the removed service parks the main fiber.
const old = ctx.plugin({ inject: ['slots', 'locale', 'settingsScope'], apply() {} })
await old.await()
assert.equal(old.state, 0, 'old client must remain PENDING without settingsScope')
const current = ctx.plugin(client)
await current.await()
assert.equal(current.state, 2, 'adapted client must become ACTIVE')
assert.equal(core.entriesOfSlot('plugins.row.config').length, 2)

const withoutForms = new Context()
new Slots(withoutForms, core)
withoutForms.reflect.provide('locale', { register: () => () => {}, bind: () => (key) => key })
const ungated = withoutForms.plugin(client)
await ungated.await()
assert.equal(ungated.state, 2, 'an absent optional configForms service must not block the client')
await withoutForms.fiber.dispose()

// The dev dependency is the actual 0.1.7 SlotCore, whose plugin page uses
// a list entry rather than 0.2's keyed installed-bundle row.
const { SlotCore: LegacySlotCore } = await import(pathToFileURL(pluginRequire.resolve('@deepseek-ai/dsh-client-ui-slots')).href)
const legacyCore = new LegacySlotCore()
legacyCore.register({ name: 'root', children: { 'plugins.item': { kind: 'list', scope: 'root' } } }, () => null)
const legacyContext = new Context()
new Slots(legacyContext, legacyCore)
new ConfigForms(legacyContext)
legacyContext.reflect.provide('locale', { register: () => () => {}, bind: () => (key) => key })
const legacy = legacyContext.plugin(client)
await legacy.await()
assert.equal(legacy.state, 2)
assert.equal(legacyCore.entriesOfSlot('plugins.item').length, 1)
await legacyContext.fiber.dispose()
assert.equal(legacyCore.entriesOfSlot('plugins.item').length, 0)

const entry = await import(new URL('lib/index.js', pluginRoot))
const schema = new HostSchema(entry.Config.toJSON())
const config = entry.Config({ ipPool: { enabled: false } })
assert.equal(typeof schema({}).ipPool.get, 'function')
assert.equal(typeof config.ipPool.get, 'function', 'new Host schema wraps the live pool field')
// These helpers are not the plugin's public exports; import sources for the
// registry contract and lifecycle checks, using the same local build inputs.
const { ZenAdapter: Adapter } = await import(new URL('src/adapter/zen-adapter.ts', pluginRoot))
const { ModelCatalog } = await import(new URL('src/adapter/catalog.ts', pluginRoot))
const { applyIpPoolSettings: applyPool } = await import(new URL('src/ip-pool-settings/apply.ts', pluginRoot))
const adapter = new Adapter(new ModelCatalog())
const registry = { adapters: new Map() }
const routes = LlmRuntime.prototype.prepareRoutes.call(registry, ['opencode2dsh'], adapter, new Set())
assert.equal(routes[0].provider.id, 'opencode2dsh')
registry.adapters.set('opencode2dsh', { adapter })
assert.equal(LlmRuntime.prototype.imageRequestPricing.call(registry, 'opencode2dsh', 'big-pickle'), undefined)

// Load the actual server artifact in a real Cordis fiber, without touching
// the user's DSH profile or making a request to the external Zen service.
const scratch = mkdtempSync(join(os.tmpdir(), 'opencode2dsh-smoke-'))
const savedHomedir = os.homedir
const savedFetch = globalThis.fetch
os.homedir = () => scratch
syncBuiltinESMExports()
globalThis.fetch = async (url) => Response.json(String(url).includes('models.dev')
  ? { opencode: { models: { 'big-pickle': { cost: { input: 0, output: 0 } } } } }
  : { data: [{ id: 'big-pickle' }] })
const serverContext = new Context()
let serverAdapter
class Llm extends Service {
  constructor(ctx) { super(ctx, 'llm') }
  registerAdapter(_providers, adapter) { serverAdapter = adapter }
}
new Llm(serverContext)
try {
  const server = serverContext.plugin(entry, { ipPool: { enabled: false } })
  await server.await()
  assert.equal(server.state, 2, 'server artifact must become ACTIVE without settings or credentials')
  assert.equal(typeof serverAdapter.imageRequestPricing, 'function')
  await new Promise((done) => setTimeout(done, 100))
  await serverContext.fiber.dispose()
} finally {
  globalThis.fetch = savedFetch
  os.homedir = savedHomedir
  syncBuiltinESMExports()
  assert.ok(scratch.startsWith(join(os.tmpdir(), 'opencode2dsh-smoke-')))
  rmSync(scratch, { recursive: true, force: true })
}

const poolContext = new Context()
const logs = { info() {}, warn() {}, error() {} }
let disposed = false
let starts = 0
const reconfigured = []
const live = createVolatile({ enabled: false })
const controller = applyPool(poolContext, {}, () => live.get(), logs, { assemble: async () => {
  starts++
  return { reconfigure: async (value) => { reconfigured.push(value) }, dispose: async () => { disposed = true } }
} })
updateVolatile(live, createVolatile({ enabled: true, manual: ['http://127.0.0.1:7897'] }))
poolContext.emit('loader/volatile-update')
await new Promise((done) => setImmediate(done))
assert.equal(starts, 1)
assert.equal(controller.settings().enabled, true)
assert.equal(reconfigured[0].ipPool.manual[0], 'http://127.0.0.1:7897')
await poolContext.fiber.dispose()
assert.equal(disposed, true)
await ctx.fiber.dispose()
assert.equal(core.entriesOfSlot('plugins.row.config').length, 0)
console.log(JSON.stringify({ host: JSON.parse(readFileSync(join(host, 'package.json'), 'utf8')).version, client: 'ACTIVE (also without optional forms)', server: 'ACTIVE', oldClient: 'PENDING (missing settingsScope)', rowSettings: 'registered and disposed', legacyListSettings: 'registered and disposed using 0.1.7 SlotCore', adapter: 'registered', livePool: 'applied and disposed' }, null, 2))
