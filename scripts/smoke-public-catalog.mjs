#!/usr/bin/env node
// Read public directories without client disguise or session credentials.
import assert from 'node:assert/strict'
import { ModelCatalog, staticFreeModels, FREE_LANE_BLOCKLIST } from '../packages/plugin/src/adapter/catalog.ts'
const catalog = new ModelCatalog({ fetchImpl: (url) => fetch(url, {
  headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000),
}) })
try {
  await catalog.refreshOnce()
  assert.equal(catalog.snapshot().status, 'ready')
  assert.equal(catalog.lastError, '')
  assert.ok(catalog.list().includes('space-bunny-free'))
  for (const id of staticFreeModels) {
    assert.ok(catalog.list().includes(id), `bootstrap model no longer listed: ${id}`)
  }
  assert.ok(!catalog.list().some((id) => FREE_LANE_BLOCKLIST.has(id)))
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), snapshot: catalog.snapshot(), models: catalog.list(),
    transport: 'unauthenticated public directory GETs only; no inference requests' }, null, 2))
} finally { catalog.stop() }
