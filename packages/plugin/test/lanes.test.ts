/**
 * Lane table + lane-backed routing (docs/ip-pool.md 1.2.4):
 * K fixed local SOCKS5 lanes, N port-less outbounds, a clash-API selector
 * switch at dial time — the port ceiling (user decision: 端口占用恒为 K+1)
 * and every guarantee around it: probe / select / fallback all assign any
 * node into a free lane, nothing is "unmounted".
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { LanePool, laneAddressOf, laneNodeOf } from '../src/pool/lanes.ts'
import { PoolRoutingDispatcher, routingContext } from '../src/pool/dispatcher.ts'
import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import { admitCandidate, type AdmissionDeps } from '../src/pool/admission.ts'

const NODE_A = 'shadowsocks:1.2.3.4:443'
const NODE_B = 'trojan:5.6.7.8:443'
const NODE_C = 'vmess:9.9.9.9:8443'

const OUT_TAGS = new Map([
  [NODE_A, 'out-a'],
  [NODE_B, 'out-b'],
  [NODE_C, 'out-c'],
])

function makeLanes(
  options: { count?: number; switches?: string[]; failSwitch?: () => boolean; acquireTimeoutMs?: number } = {},
): { lanes: LanePool; switches: string[] } {
  const switches: string[] = options.switches ?? []
  const lanes = new LanePool({
    acquireTimeoutMs: options.acquireTimeoutMs,
    switchOutbound: async (apiPort, selectorTag, outboundTag) => {
      switches.push(`${apiPort}|${selectorTag}|${outboundTag}`)
      if (options.failSwitch?.()) throw new Error('clash API down')
    },
  })
  lanes.configure({
    lanePorts: Array.from({ length: options.count ?? 2 }, (_, i) => 31_001 + i),
    apiPort: 31_100,
    outTags: OUT_TAGS,
  })
  return { lanes, switches }
}

test('lane ids round-trip; non-lane addresses stay untouched', () => {
  assert.equal(laneAddressOf(NODE_A), `lane:${NODE_A}`)
  assert.equal(laneNodeOf(`lane:${NODE_A}`), NODE_A)
  assert.equal(laneNodeOf('127.0.0.1:30001'), null)
  assert.equal(laneNodeOf('https://opencode.ai'), null)
})

test('LanePool: first acquire switches once; the same node then takes the sync fast path', async () => {
  const { lanes, switches } = makeLanes()
  assert.equal(lanes.tryAcquire(NODE_A), null, 'unbound node must not hit the fast path')

  const binding = await lanes.acquire(NODE_A)
  assert.ok(binding !== null)
  assert.deepEqual(switches, ['31100|sel-lane0|out-a'], 'first free lane gets the selector switch')

  const fast = lanes.tryAcquire(NODE_A)
  assert.ok(fast !== null)
  assert.equal(fast.port, 31_001)
  assert.equal(fast.epoch, binding.epoch, 'no rebind -> same epoch -> the cached agent stays valid')
  assert.equal(switches.length, 1, 'fast path must not switch again')
  assert.equal(lanes.inFlight(31_001), 2)

  fast.release()
  binding.release()
  assert.equal(lanes.inFlight(31_001), 0, 'release returns the lane')
})

test('LanePool: busy lanes queue and land on the least-recently-used lane after a release', async () => {
  const { lanes, switches } = makeLanes({ count: 2 })
  const a = await lanes.acquire(NODE_A)
  const b = await lanes.acquire(NODE_B)
  assert.ok(a !== null)
  assert.ok(b !== null)
  assert.deepEqual(switches, ['31100|sel-lane0|out-a', '31100|sel-lane1|out-b'])

  // both lanes held: C queues instead of failing
  const queued = lanes.acquire(NODE_C)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(lanes.inFlight(31_001), 1, 'still waiting, nothing granted yet')
  assert.equal(lanes.inFlight(31_002), 1)

  a.release()
  const c = await queued
  assert.ok(c !== null)
  assert.equal(c.port, 31_001, 'released lane is picked (LRU order among idle)')
  assert.ok(switches.some((entry) => entry === '31100|sel-lane0|out-c'))
  b.release()
  c.release()
  assert.equal(lanes.inFlight(31_001), 0)
  assert.equal(lanes.inFlight(31_002), 0)
})

test('LanePool: give up with null when no lane frees within the deadline (dispatcher falls back to direct)', async () => {
  const { lanes } = makeLanes({ count: 1, acquireTimeoutMs: 40 })
  const a = await lanes.acquire(NODE_A)
  assert.ok(a !== null)
  const start = Date.now()
  const c = await lanes.acquire(NODE_C)
  assert.equal(c, null)
  assert.ok(Date.now() - start >= 35, 'waited for the deadline, did not fail instantly')
  a.release()
})

test('LanePool: a failed selector switch returns null and keeps the lane on its node', async () => {
  let fail = false
  const { lanes, switches } = makeLanes({ count: 1, failSwitch: () => fail })
  const a = await lanes.acquire(NODE_A)
  assert.ok(a !== null)
  fail = true
  const c = await lanes.acquire(NODE_C)
  assert.equal(c, null, 'switch failure -> no binding, caller falls back to direct')
  fail = false
  assert.ok(lanes.tryAcquire(NODE_A), 'lane0 still serves NODE_A (the old selector value)')

  // a node absent from the config never binds (no outbound to select)
  const missing = await lanes.acquire('wireguard:nowhere:1')
  assert.equal(missing, null)
  assert.equal(switches.filter((entry) => entry.endsWith('nowhere')).length, 0)

  a.release()
})

test('LanePool: reset voids every binding (epoch bump) until the next configure', async () => {
  const { lanes, switches } = makeLanes()
  const a = await lanes.acquire(NODE_A)
  assert.ok(a !== null)
  a.release()
  const staleEpoch = a.epoch

  lanes.reset()
  assert.equal(lanes.tryAcquire(NODE_A), null, 'after reset nothing is bound')
  assert.equal(await lanes.acquire(NODE_C), null, 'and nothing can bind while the child is down')

  lanes.configure({ lanePorts: [31_001, 31_002], apiPort: 31_100, outTags: OUT_TAGS })
  const again = await lanes.acquire(NODE_A)
  assert.ok(again !== null)
  assert.ok(again.epoch > staleEpoch, 'epoch moved so the dispatcher drops the stale lane agent')
  assert.ok(switches.length >= 2, 'rebinding after configure switches again')
  again.release()
})

// -- dispatcher over lanes ----------------------------------------------------

function node(overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id: `lane:${NODE_A}`,
    protocol: 'socks5',
    source: 'subscription',
    pinned: false,
    exitIP: '1.1.1.1',
    exitLocation: 'US',
    latencyMs: 100,
    quality: 'S',
    addedAt: 0,
    ...overrides,
  }
}

/** Recording fake undici seam (same shape dispatcher.test uses). */
function fakeSeam() {
  const hops: string[] = []
  const makeAgent = (tag: string) => ({
    tag,
    dispatch(_opts: unknown, handler: { onResponseEnd?: (...args: unknown[]) => unknown }): boolean {
      hops.push(tag)
      // terminal callback so the lane hold can be returned
      handler.onResponseEnd?.({}, '')
      return true
    },
    close: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  })
  const direct = makeAgent('direct')
  const seam = {
    Agent: class {
      constructor() {
        return direct
      }
    },
    ProxyAgent: class {
      constructor(options: { uri: string }) {
        return makeAgent(`proxy:${options.uri}`)
      }
    },
    setGlobalDispatcher: () => undefined,
    getGlobalDispatcher: () => direct,
  }
  return { seam, hops }
}

test('dispatcher: a lane exit dials through the assigned lane and releases it on the terminal callback', async () => {
  const pool = new ExitPool()
  pool.add(node())
  pool.markOk(`lane:${NODE_A}`)

  const { seam, hops } = fakeSeam()
  const releases: number[] = []
  let granted = 31_004
  const router = new PoolRoutingDispatcher({
    pool,
    undici: seam as never,
    proxyHosts: ['opencode.ai'],
    lanes: {
      tryAcquire: () => null, // force the async path on purpose
      acquire: async (nodeKey) => {
        assert.equal(nodeKey, NODE_A)
        return { port: granted, epoch: 1, release: () => { releases.push(granted) } }
      },
      inFlight: () => 0,
    },
  })

  routingContext.run({ model: 'm', session: 's' }, () => {
    const handled = router.dispatch({ origin: 'https://opencode.ai/zen/v1/chat/completions' } as never, {} as never)
    assert.equal(handled, true, 'lane assignment is async: dispatch claims the request, not direct-fails it')
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(hops, ['proxy:socks5://127.0.0.1:31004'])
  assert.deepEqual(releases, [31_004], 'the response terminal returned the lane')
  await router.destroy()
})

test('dispatcher: sync fast path keeps the hot dispatch IO-free', () => {
  const pool = new ExitPool()
  pool.add(node())
  pool.markOk(`lane:${NODE_A}`)

  const { seam, hops } = fakeSeam()
  const releases: number[] = []
  let acquired = 0
  const router = new PoolRoutingDispatcher({
    pool,
    undici: seam as never,
    proxyHosts: ['opencode.ai'],
    lanes: {
      tryAcquire: (nodeKey) => {
        assert.equal(nodeKey, NODE_A)
        acquired += 1
        return { port: 31_001, epoch: 7, release: () => { releases.push(31_001) } }
      },
      acquire: async () => {
        throw new Error('fast path must not fall through to acquire')
      },
      inFlight: () => 1,
    },
  })

  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/zen/v1/chat/completions' } as never, {} as never)
  })
  assert.equal(acquired, 1, 'sync binding, no await')
  assert.deepEqual(hops, ['proxy:socks5://127.0.0.1:31001'])
  assert.deepEqual(releases, [31_001])
  void router.destroy()
})

test('dispatcher: child down -> serve direct and wake the core (never fail closed)', () => {
  const pool = new ExitPool()
  pool.add(node())
  pool.markOk(`lane:${NODE_A}`)

  const { seam, hops } = fakeSeam()
  const hooks: string[] = []
  const router = new PoolRoutingDispatcher({
    pool,
    undici: seam as never,
    proxyHosts: ['opencode.ai'],
    localExit: {
      isRunning: () => false,
      onDown: (exitId) => { hooks.push(`down:${exitId}`) },
      onUse: (exitId) => { hooks.push(`use:${exitId}`) },
    },
    lanes: {
      tryAcquire: () => ({ port: 31_001, epoch: 1, release: () => {} }),
      acquire: async () => null,
      inFlight: () => 0,
    },
  })

  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/zen/v1/chat/completions' } as never, {} as never)
  })
  assert.deepEqual(hops, ['direct'])
  assert.deepEqual(hooks, [`down:lane:${NODE_A}`])
  void router.destroy()
})

// -- admission over lanes -----------------------------------------------------

function admissionDeps(bindLane: AdmissionDeps['bindLane']): {
  deps: AdmissionDeps
  uris: string[]
} {
  const uris: string[] = []
  const seam = {
    ProxyAgent: class {
      uri: string
      constructor(options: { uri: string }) {
        this.uri = options.uri
        uris.push(options.uri)
      }
      close() {
        return Promise.resolve()
      }
      destroy() {
        return Promise.resolve()
      }
    },
    request: (async (url: string) => {
      if (url.includes('ip-api')) {
        return {
          statusCode: 200,
          body: { text: async () => JSON.stringify({ status: 'success', query: '7.7.7.7', countryCode: 'US', city: 'c', country: 'c' }) },
        }
      }
      return { statusCode: 200, body: { text: async () => '{"ok":true}' } }
    }) as never,
  }
  const deps = {
    pool: new ExitPool(),
    undici: seam as unknown as AdmissionDeps['undici'],
    bindLane,
    logger: { warn: () => {} },
  } satisfies AdmissionDeps
  return { deps, uris }
}

test('admission: a lane candidate binds a lane, dials 127.0.0.1:<lanePort> and releases afterwards', async () => {
  const released: string[] = []
  const requested: string[] = []
  const { deps, uris } = admissionDeps(async (address) => {
    requested.push(address)
    return { address: '127.0.0.1:31001', release: () => { released.push(address) } }
  })

  const result = await admitCandidate(deps, { address: `lane:${NODE_A}`, protocol: 'socks5', source: 'subscription' })
  assert.equal(result.admitted, true)
  assert.deepEqual(requested, [`lane:${NODE_A}`])
  // coarseScreen (echo) and the admission agent both dial — every dial must
  // hit the bound lane address, never the port-less `lane:` id.
  assert.ok(uris.length > 0, 'the admission agent dialed something')
  assert.ok(
    uris.every((uri) => uri === 'socks5://127.0.0.1:31001'),
    `agents must dial the bound lane, saw: ${uris.join(', ')}`,
  )
  assert.deepEqual(released, [`lane:${NODE_A}`], 'lane returned in the finally, success or failure')
})

test('admission: no lane free -> soft fail lane-busy; missing seam -> lane-bind-missing', async () => {
  const busy = admissionDeps(async () => null)
  const busyResult = await admitCandidate(busy.deps, { address: `lane:${NODE_A}`, protocol: 'socks5', source: 'subscription' })
  assert.equal(busyResult.admitted, false)
  assert.equal(busyResult.reason, 'lane-busy')
  assert.deepEqual(busy.uris, [], 'no dial without a binding')

  const missing = admissionDeps(undefined)
  const missingResult = await admitCandidate(missing.deps, { address: `lane:${NODE_A}`, protocol: 'socks5', source: 'subscription' })
  assert.equal(missingResult.admitted, false)
  assert.equal(missingResult.reason, 'lane-bind-missing')
})
