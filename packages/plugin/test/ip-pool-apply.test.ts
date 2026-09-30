/**
 * IP-5 live-apply tests: the apply controller over the DSH 0.1.7 settings
 * model — a stable volatile reference plus `loader/volatile-update` instead of
 * the 0.1.1 `ctx.settings.register()/watch()` scope. Boot-time enable,
 * event-driven reconfigure (enabled flip included) and the section-shape
 * mapping from either layer's spelling. The real startIpPool is replaced
 * through the assemble seam, so no undici or global dispatcher is ever
 * installed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyIpPoolSettings, type AssembleIpPool } from '../src/ip-pool-settings/apply.ts'
import { IP_POOL_NAMESPACE, resolveIpPoolSettings, type AnyIpPoolSection, type IpPoolSettings, type VolatileRef } from '../src/ip-pool-settings/namespace.ts'
import { resolveConfig, type OrdinaryPluginConfig } from '../src/config.ts'
import type { PluginContext } from '../src/index.ts'

/** Recorded assembly + reconfigure calls (reset per test). */
let starts: Array<{ config: Record<string, unknown> }> = []
let reconfigures: Array<Record<string, unknown>> = []

function resetCalls(): void {
  starts = []
  reconfigures = []
}

/** Test assembly seam: a runtime face with just what apply.ts touches. */
const assemble: AssembleIpPool = async (config) => {
  const runtime = {
    pool: { snapshot: () => ({ total: 1 }), targetSize: 20, list: () => [], has: () => true },
    installer: { enabled: false, install() { this.enabled = true }, disable() { this.enabled = false }, dispose() {} },
    prober: { stats: { queued: 0, inFlight: 0, enqueued: 0, completed: 0 }, setMaxConcurrent() {} },
    refill: null,
    subscriptions: null,
    reconfigure: async (next: Record<string, unknown>) => { reconfigures.push(next) },
    probeAll: async () => 0,
    probeExit: async () => 1,
    refillNow: async () => {},
    refreshSubscriptions: async () => {},
    dispose: async () => {},
  }
  starts.push({ config: config as Record<string, unknown> })
  return runtime as never
}

/** The ordinary half of a config, as the Loader would resolve it. */
const ordinary = (over: Partial<OrdinaryPluginConfig> = {}): OrdinaryPluginConfig =>
  resolveConfig({ ...over } as never)

/**
 * A DSH 0.1.7-shaped host: the Loader hands `apply()` a stable volatile
 * reference, commits a settings save into it, and announces it with
 * `loader/volatile-update`. No `register`, no `watch` — the 0.1.7 contract.
 */
function makeVolatileHost(initial?: AnyIpPoolSection) {
  let current: IpPoolSettings = resolveIpPoolSettings(initial)
  const listeners = new Set<() => void>()
  const ref: VolatileRef<IpPoolSettings> = { get: () => current }

  const ctx: PluginContext = {
    logger: { info() {}, warn() {}, error() {} },
    on(event: string, listener: () => void) {
      assert.equal(event, 'loader/volatile-update')
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  return {
    ctx,
    ref,
    get value(): IpPoolSettings { return current },
    /** Simulate a settings-page save: commit into the ref, then announce. */
    commit(next: AnyIpPoolSection): void {
      current = resolveIpPoolSettings({ ...current, ...next })
      for (const listener of [...listeners]) listener()
    },
  }
}

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('the served namespace is the Loader entry id, not a hand-registered "ip-pool"', () => {
  assert.equal(IP_POOL_NAMESPACE, 'opencode2dsh')
})

test('disabled at boot: nothing assembles', async () => {
  resetCalls()
  const host = makeVolatileHost()
  const controller = applyIpPoolSettings(host.ctx, ordinary(), () => host.ref.get(), host.ctx.logger, { assemble })
  await tick(20)
  assert.equal(starts.length, 0)
  assert.equal(controller.runtime, null)
})

test('boot-enabled: runtime assembles once from the resolved volatile value', async () => {
  resetCalls()
  const host = makeVolatileHost({ enabled: true, manual: ['http://1.1.1.1:1'] })
  const controller = applyIpPoolSettings(host.ctx, ordinary(), () => host.ref.get(), host.ctx.logger, { assemble })
  await tick(30)
  assert.equal(starts.length, 1)
  assert.ok(controller.runtime !== null)
  const passed = starts[0]!.config as { ipPool?: { manual?: string[] } }
  assert.deepEqual(passed.ipPool?.manual, ['http://1.1.1.1:1'])
})

test('a persisted enabled:true assembles at boot even with a disabled entry config', async () => {
  // The old namespace model got this for free (register() took the persisted
  // document as its base). The volatile reference carries the same fact, and
  // reading only the entry config would strand the pool until the next save.
  resetCalls()
  const host = makeVolatileHost({ enabled: true })
  applyIpPoolSettings(host.ctx, ordinary(), () => host.ref.get(), host.ctx.logger, { assemble })
  await tick(30)
  assert.equal(starts.length, 1)
})

test('settings-page enable: volatile-update assembles, later commits reconfigure live', async () => {
  resetCalls()
  const host = makeVolatileHost()
  const controller = applyIpPoolSettings(host.ctx, ordinary(), () => host.ref.get(), host.ctx.logger, { assemble })
  await tick(10)
  assert.equal(starts.length, 0)

  host.commit({ enabled: true, manual: ['http://2.2.2.2:2'], maxConcurrentProbes: 5 })
  await tick(30)
  assert.equal(starts.length, 1, 'enable commit assembles the runtime')
  assert.ok(controller.runtime !== null)

  // A later commit (no enable flip) goes through reconfigure, never re-assembles.
  const before = starts.length
  host.commit({ pinnedExitId: 'http://127.0.0.1:7897', pinnedStrict: true })
  await tick(30)
  assert.equal(starts.length, before, 'no re-assembly without an enable flip')
  assert.equal(reconfigures.length, 2)
  const applied = reconfigures[1]!.ipPool as Record<string, unknown>
  assert.equal(applied.pinnedExitId, 'http://127.0.0.1:7897')
  assert.equal(applied.pinnedStrict, true)
})

test('every field the runtime reads survives the settings->config round trip', async () => {
  // Reconfigure consumes this shape, so a field dropped by toIpPoolConfig()
  // resets to its default on every commit — silently, and only in adapter
  // mode, which is the shipped default.
  resetCalls()
  const host = makeVolatileHost()
  applyIpPoolSettings(host.ctx, ordinary(), () => host.ref.get(), host.ctx.logger, { assemble })
  host.commit({
    enabled: true,
    maxConcurrentProbes: 7,
    subscription: { urls: ['https://x/y'], refreshMs: 60_000 },
  })
  await tick(30)
  const applied = starts[0]!.config.ipPool as Record<string, unknown>
  assert.equal(applied.maxConcurrentProbes, 7, 'probe concurrency must reach the runtime')
  assert.deepEqual(applied.subscription, { refreshMs: 60_000 }, 'subscription interval must reach the runtime')
  assert.deepEqual(applied.subscriptions, ['https://x/y'])
})

test('subscription urls from the settings shape flow into the config assembly', async () => {
  resetCalls()
  const host = makeVolatileHost()
  applyIpPoolSettings(host.ctx, ordinary(), () => host.ref.get(), host.ctx.logger, { assemble })
  host.commit({ enabled: true, subscription: { urls: ['https://x/y'] } })
  await tick(30)
  assert.equal(starts.length, 1)
  const passed = starts[0]!.config as { ipPool?: { subscriptions?: string[] } }
  assert.deepEqual(passed.ipPool?.subscriptions, ['https://x/y'])
})

test('an absent volatile reference degrades to defaults instead of throwing', async () => {
  // A host predating the `Config` export hands over no reference at all.
  resetCalls()
  const host = makeVolatileHost()
  const controller = applyIpPoolSettings(host.ctx, ordinary(), () => undefined, host.ctx.logger, { assemble })
  await tick(20)
  assert.equal(controller.settings().enabled, false)
  assert.equal(starts.length, 0)
})

test('the settings page is claimed lazily and never gates the fiber', async () => {
  // `settings` stays out of `inject`: SettingsForms needs a profileContext and
  // ships disabled headless, so demanding it up front kept the provider route
  // from ever activating. configure({ auto: false }) is requested on demand.
  resetCalls()
  const configureCalls: Array<unknown> = []
  const injections: string[][] = []
  const host = makeVolatileHost()
  const ctx: PluginContext = {
    logger: { info() {}, warn() {}, error() {} },
    on: host.ctx.on,
    inject(services, callback) {
      injections.push([...services])
      if (services.includes('settings')) {
        callback({
          logger: { info() {}, warn() {}, error() {} },
          settings: { configure: (presentation: unknown) => { configureCalls.push(presentation); return () => {} } },
        })
      }
    },
  }
  applyIpPoolSettings(ctx, ordinary(), () => undefined, ctx.logger, { assemble })
  await tick(10)
  assert.ok(injections.some((list) => list.includes('settings')), 'settings is requested on demand')
  assert.equal(injections.some((list) => list.includes('webServer')), true, 'webServer is still requested for the bridge')
  assert.deepEqual(configureCalls, [{ auto: false }], 'the plugin serves its own IP 池 card')
})
