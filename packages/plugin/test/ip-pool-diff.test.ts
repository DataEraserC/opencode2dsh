/**
 * The save-button dirty computation is `writes.length > 0` (IpPoolCard), so
 * a dropped write disables Save — that is exactly how "toggle the pool off,
 * Save stays disabled" reached users: the old diff skipped any value equal
 * to the composition base, and the pool's base default is enabled: false.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffWrites } from '../src/client/ip-pool-diff.ts'
import type { FormState, IpPoolSettingsValue } from '../src/client/IpPoolCard.tsx'

/** A served value with defaults filled, as servedSection() renders it. */
function served(over: Partial<IpPoolSettingsValue> = {}): IpPoolSettingsValue {
  return {
    enabled: false,
    probeModels: [],
    maxConcurrentProbes: 3,
    free: { enabled: true, targetSize: 20, blockedCountries: ['CN'] },
    manual: [],
    subscription: { urls: [], refreshMs: 30 * 60_000 },
    singbox: { path: 'sing-box', idleStopMs: 600_000, lanes: 16 },
    pinnedExitId: '',
    pinnedStrict: false,
    proxyHosts: [],
    ...over,
  }
}

/** The draft hydrated from a served value, as formFromValue() builds it. */
function form(over: Partial<FormState> = {}): FormState {
  return {
    enabled: false,
    freeEnabled: true,
    targetSize: '20',
    blockedCountries: 'CN',
    manual: [],
    subscriptionUrls: [],
    refreshMs: String(30 * 60_000),
    singboxPath: 'sing-box',
    singboxIdleStopMs: '600000',
    singboxLanes: '16',
    pinnedExitId: '',
    pinnedStrict: false,
    probeModels: [],
    maxConcurrentProbes: '3',
    ...over,
  }
}

test('turning the pool off writes even though the composition base is off (regression: Save stayed disabled)', () => {
  const writes = diffWrites(form({ enabled: false }), served({ enabled: true }))
  assert.deepEqual(writes, [{ field: 'enabled', op: 'set', value: false }])
})

test('turning the pool on writes against an off served value', () => {
  const writes = diffWrites(form({ enabled: true }), served({ enabled: false }))
  assert.deepEqual(writes, [{ field: 'enabled', op: 'set', value: true }])
})

test('an untouched draft produces no writes', () => {
  const value = served({ enabled: true })
  assert.deepEqual(diffWrites(form({ enabled: true }), value), [])
})

test('reverting idleStopMs to the default still writes (the old base-skip swallowed it)', () => {
  const value = served({ singbox: { path: 'sing-box', idleStopMs: 120_000, lanes: 16 } })
  const writes = diffWrites(form({ singboxIdleStopMs: '600000' }), value)
  assert.deepEqual(writes, [{ field: 'singbox', op: 'set', value: { path: 'sing-box', idleStopMs: 600_000, lanes: 16 } }])
})

test('a singbox edit writes path, idleStopMs and lanes together', () => {
  const writes = diffWrites(form({ singboxIdleStopMs: '120000' }), served())
  assert.deepEqual(writes, [{ field: 'singbox', op: 'set', value: { path: 'sing-box', idleStopMs: 120_000, lanes: 16 } }])
})

test('a lanes edit lands as a singbox write (docs 1.2.4)', () => {
  const writes = diffWrites(form({ singboxLanes: '8' }), served())
  assert.deepEqual(writes, [{ field: 'singbox', op: 'set', value: { path: 'sing-box', idleStopMs: 600_000, lanes: 8 } }])
})

test('the off flip and an idle edit land as ordered writes', () => {
  const writes = diffWrites(form({ enabled: false, singboxIdleStopMs: '300000' }), served({ enabled: true }))
  assert.deepEqual(writes, [
    { field: 'enabled', op: 'set', value: false },
    { field: 'singbox', op: 'set', value: { path: 'sing-box', idleStopMs: 300_000, lanes: 16 } },
  ])
})
