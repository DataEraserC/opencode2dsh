/**
 * DSH 0.1.7 host-contract regression tests.
 *
 * These pin the SHAPE of the host the plugin must survive, not internal
 * details: a 0.1.7 Loader hands `apply()` a stable volatile reference for the
 * `Config` field marked `.volatile()` and announces saves with
 * `loader/volatile-update`; `SettingsForms` offers `describe`/`mutate`/
 * `configure` and no longer has `register(ns, schema)` or `get(ns)`.
 *
 * The fake below is deliberately 0.1.7-only — every deleted 0.1.1 seam is
 * either absent or throws if touched, so a regression toward the old protocol
 * fails here instead of silently working in tests and breaking on a real host.
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, Config, type PluginContext } from '../src/index.ts'
import { resolveIpPoolSettings, type AnyIpPoolSection, type IpPoolSettings, type VolatileRef } from '../src/ip-pool-settings/namespace.ts'
import { ModelCatalog } from '../src/adapter/catalog.ts'

// These tests exercise registration and settings contracts, not transport or
// the user's on-disk catalog. Real fiber startup is covered by the smoke script.
mock.method(ModelCatalog.prototype, 'start', async () => {})

/**
 * What cosmokit gives the plugin: a STABLE object whose `get()` returns the
 * current immutable snapshot, so a consumer can hold the reference across
 * saves. `set` stands in for the Loader's commit (not part of the seam), and
 * `reads` counts snapshots taken, so a test can prove the consumer re-reads
 * the reference on every event instead of caching one value.
 */
function volatileRef(initial: AnyIpPoolSection = {}): VolatileRef<IpPoolSettings> & { set(next: AnyIpPoolSection): void; reads: number } {
  let snapshot = resolveIpPoolSettings(initial)
  const ref = {
    reads: 0,
    get() { ref.reads++; return snapshot },
    set(next: AnyIpPoolSection) { snapshot = resolveIpPoolSettings(next) },
  }
  return ref
}

/** A DSH 0.1.7 SettingsForms, with the removed seams made poisonous. */
function settings17() {
  const configureCalls: Array<{ presentation: unknown; owner: unknown }> = []
  const mutations: Array<{ ns: string; ops: unknown }> = []
  const namespaces: Array<{ ns: string; value: unknown }> = []
  return {
    configureCalls,
    mutations,
    namespaces,
    service: {
      describe: () => namespaces,
      mutate: async (ns: string, ops: unknown) => { mutations.push({ ns, ops }) },
      configure: (presentation: unknown, owner?: unknown) => {
        configureCalls.push({ presentation, owner })
        return () => {}
      },
      // Removed in 0.1.7. If anything still reaches for these, fail loudly.
      get: () => { throw new Error('0.1.7 removed settings.get(ns)') },
      register: () => { throw new Error('0.1.7 removed settings.register(ns, schema)') },
    } as never,
  }
}

/** Records the adapter registrations a host would see. */
function host() {
  const registrations: string[][] = []
  const injections: string[][] = []
  const effects: Array<() => void> = []
  const volatileListeners: Array<() => void> = []
  const ipPool = volatileRef({ enabled: false, manual: [] })
  const base: PluginContext = {    logger: { info() {}, warn() {}, error() {} },
    llm: { registerAdapter: (providers) => { registrations.push([...providers]); return () => {} } },
    on(event, listener) {
      if (event === 'loader/volatile-update') volatileListeners.push(listener as () => void)
      return () => {}
    },
    inject(services, callback) {
      injections.push([...services])
      void callback(base)
      return Promise.resolve()
    },
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
  }
  return { base, registrations, injections, effects, volatileListeners, ipPool }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

test('the plugin serves exactly one volatile node and the fiber needs only llm', async () => {
  assert.deepEqual([...inject], ['llm'], 'settings must not gate the fiber: SettingsForms is disabled headless')

  // Config is what DSH 0.1.7 reads to decide what is editable, and ipPool must
  // be the one `.volatile()` node: dsh-settings' volatileForm() selects a
  // node's whole plain schema, and a nested volatile is a schemastery error.
  const resolved = Config({ mode: 'adapter' })
  const ipPool = resolved.ipPool as unknown as { get(): unknown }
  assert.equal(typeof ipPool.get, 'function', 'ipPool is a volatile reference')
  assert.equal((resolved as { mode: unknown }).mode, 'adapter')
})

test('a 0.1.7-shaped host registers the provider and claims its own settings page', async () => {
  const h = host()
  const s = settings17()
  h.base.settings = s.service

  apply(h.base, { ...Config({ mode: 'adapter' }), ipPool: h.ipPool })
  await settle()

  assert.deepEqual(h.registrations, [['opencode2dsh']], 'exactly one route, and it needed no settings API')
  assert.deepEqual(s.configureCalls.map((c) => c.presentation), [{ auto: false }], 'the IP 池 card is served by this plugin')
  assert.ok(h.injections.some((list) => list.includes('settings')), 'settings is requested on demand, not up front')
  assert.equal(h.volatileListeners.length, 1, 'one live-update listener')
})

test('a settings save reaches the pool through loader/volatile-update', async () => {
  const h = host()
  const s = settings17()
  h.base.settings = s.service

  apply(h.base, { ...Config({ mode: 'adapter' }), ipPool: h.ipPool })
  await settle()
  assert.equal(h.volatileListeners.length, 1)
  const before = h.ipPool.reads

  // A save: commit into the same reference, then announce — the Loader's order.
  // `enabled` stays false so this stays hermetic: the assembled runtime installs
  // a global dispatcher and a refresh loop, which is covered with the assemble
  // seam in ip-pool-apply.test.ts rather than here.
  h.ipPool.set({ enabled: false, manual: ['http://10.0.0.1:3128'] })
  h.volatileListeners[0]!()
  await settle()

  assert.ok(h.ipPool.reads > before, 'the handler re-reads the reference instead of caching a snapshot')
})

test('the stale sidecar route is swept through describe(), not a removed get(ns)', async () => {
  const h = host()
  const s = settings17()
  s.namespaces.push({ ns: 'llm-pi-ai', value: { providers: { opencode2dsh: { baseURL: 'http://127.0.0.1:1' } } } })
  h.base.settings = s.service

  apply(h.base, { ...Config({ mode: 'adapter' }), ipPool: h.ipPool })
  await settle()

  assert.equal(s.mutations.length, 1)
  assert.equal(s.mutations[0]!.ns, 'llm-pi-ai')
  assert.deepEqual(s.mutations[0]!.ops, [{ op: 'unset', path: ['providers', 'opencode2dsh'] }])
})

test('a legacy 0.1.1 host with register()/get() still gets a provider route', async () => {
  // Nothing here is called, so the absence of describe/configure only means the
  // page is not claimed — the route must survive regardless.
  const h = host()
  h.base.settings = {
    get: () => ({}),
    mutate: async () => {},
    register: () => { throw new Error('must not re-register under 0.1.7') },
  } as never

  apply(h.base, { ...Config({ mode: 'adapter' }), ipPool: h.ipPool })
  await settle()
  assert.deepEqual(h.registrations, [['opencode2dsh']])
})

test('a headless composition with no settings service at all still registers', async () => {
  const h = host()
  delete h.base.settings
  apply(h.base, { ...Config({ mode: 'adapter' }), ipPool: h.ipPool })
  await settle()
  assert.deepEqual(h.registrations, [['opencode2dsh']])
})

test('a host predating the Config export (plain ipPool object) still registers', async () => {
  const h = host()
  h.base.settings = settings17().service
  apply(h.base, { mode: 'adapter', ipPool: { enabled: false, manual: [] } })
  await settle()
  assert.deepEqual(h.registrations, [['opencode2dsh']])
})

test('an inject that never fires its callback does not block the route', async () => {
  const h = host()
  h.base.inject = () => Promise.resolve()
  apply(h.base, { ...Config({ mode: 'adapter' }), ipPool: h.ipPool })
  await settle()
  assert.deepEqual(h.registrations, [['opencode2dsh']])
})
