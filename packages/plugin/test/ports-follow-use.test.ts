/**
 * Ports follow use (docs/ip-pool.md 1.2.3) — lifecycle regression tests:
 *
 *  - the spawn gate: while the pool is disabled no local port may open,
 *    encrypted nodes park, and convertPending() converts them on enable;
 *  - the dispatcher seam: a local exit whose child is down serves direct
 *    (never fail closed) and wakes the core; a live one touches the clock;
 *  - admission wakes the local endpoints before probing a loopback exit;
 *  - sameNodes: reload idempotency identity (same list = no respawn).
 */

import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool } from '../src/pool/pool.ts'
import { Prober } from '../src/pool/prober.ts'
import { SubscriptionFetcher } from '../src/pool/subscription-fetcher.ts'
import {
  PoolRoutingDispatcher,
  routingContext,
  type LocalExitHooks,
} from '../src/pool/dispatcher.ts'
import { sameNodes, nodeKeyOf, SingBoxSupervisor } from '../src/pool/singbox.ts'
import { admitCandidate } from '../src/pool/admission.ts'
import type { ParsedNode } from '../src/pool/subscription.ts'
import type { ExitNode } from '../src/pool/pool.ts'
import {
  IpPoolConfigSchema,
  resolveIpPoolSettings,
  toIpPoolConfig,
} from '../src/ip-pool-settings/namespace.ts'

const fixtureUrl = () => new URL('./fixtures/sub_1775301718713.yaml', import.meta.url)

/** The admission seam used by the conversion pipeline tests: a fake
 *  ProxyAgent + request that admits every local exit (echo derives a
 *  distinct exit IP per local port, smoke always passes). */
function admissionSeam() {
  return {
    ProxyAgent: class {
      uri: string
      constructor(opts: { uri: string }) {
        this.uri = opts.uri
      }
      close(): Promise<void> {
        return Promise.resolve()
      }
      destroy(): Promise<void> {
        return Promise.resolve()
      }
    },
    request: (async (url: string, init: { dispatcher: { uri: string } }) => {
      const address = init.dispatcher.uri.replace(/^[a-z0-9+.-]+:\/\//, '')
      if (url.includes('ip-api')) {
        const port = address.split(':')[1] ?? '0'
        return {
          statusCode: 200,
          body: {
            text: async () =>
              JSON.stringify({
                status: 'success',
                query: `7.7.${Number(port) % 250}.${(Number(port) / 250) | 0}`,
                countryCode: 'US',
                city: 'c',
                country: 'c',
              }),
          },
        }
      }
      return { statusCode: 200, body: { text: async () => '{"ok":true}' } }
    }) as never,
  }
}

test('spawn gate: disabled refresh parks encrypted nodes; convertPending converts on enable', async () => {
  const fixture = readFileSync(fixtureUrl(), 'utf8')
  const pool = new ExitPool()
  const prober = new Prober({ pool })
  let enabled = false
  let reloads = 0
  const supervisor = {
    async reload(nodes: ParsedNode[]) {
      reloads += 1
      return nodes.map((node, index) => ({
        address: `127.0.0.1:${31000 + index}`,
        protocol: 'socks5' as const,
        node,
      }))
    },
    async stop() {},
    get running() {
      return reloads > 0
    },
    async ensureRunning() {
      return []
    },
  }
  const fetcher = new SubscriptionFetcher(
    {
      pool,
      prober,
      undici: admissionSeam() as never,
      supervisor,
      fetchImpl: (async () => new Response(fixture)) as unknown as typeof fetch,
      maySpawn: () => enabled,
    },
    { logger: { info: () => {}, warn: () => {} } },
  )
  fetcher.setUrls(['https://sub.example.com/token'])

  // Gate closed (pool disabled): refresh parses but no port may open.
  const parked = await fetcher.refresh()
  assert.equal(reloads, 0)
  assert.equal(parked.pendingConversion.length, 38)
  assert.equal(parked.convertedAdmitted, 0)
  assert.equal(pool.list().length, 0)

  // Gate opens (settings enable flip): the parked set converts now, without
  // waiting for the next subscription refresh.
  enabled = true
  const converted = await fetcher.convertPending()
  assert.equal(reloads, 1)
  assert.equal(converted.pendingConversion.length, 0)
  assert.equal(pool.list().length, 38)

  // Idempotent: nothing parked anymore -> a second convert is a no-op.
  const again = await fetcher.convertPending()
  assert.equal(reloads, 1)
  assert.equal(again.convertedAdmitted, 38)
})

test('spawn gate: convertPending stays closed while disabled even with nodes parked', async () => {
  const fixture = readFileSync(fixtureUrl(), 'utf8')
  const pool = new ExitPool()
  const prober = new Prober({ pool })
  let reloads = 0
  const fetcher = new SubscriptionFetcher(
    {
      pool,
      prober,
      undici: admissionSeam() as never,
      supervisor: {
        async reload(nodes: ParsedNode[]) {
          reloads += 1
          return nodes.map((node, index) => ({ address: `127.0.0.1:${32000 + index}`, protocol: 'socks5' as const, node }))
        },
        async stop() {},
        get running() {
          return false
        },
      },
      fetchImpl: (async () => new Response(fixture)) as unknown as typeof fetch,
      maySpawn: () => false,
    },
    { logger: { info: () => {}, warn: () => {} } },
  )
  fetcher.setUrls(['https://sub.example.com/token'])
  await fetcher.refresh()
  await fetcher.convertPending()
  assert.equal(reloads, 0)
  assert.equal(pool.list().length, 0)
})

function localNode(overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id: '127.0.0.1:30001',
    protocol: 'socks5',
    source: 'subscription',
    pinned: false,
    exitIP: '7.7.0.1',
    exitLocation: 'US city',
    latencyMs: 100,
    quality: 'S',
    addedAt: 0,
    ...overrides,
  }
}

/** Recording fake undici seam (same shape as dispatcher.test.ts). */
function fakeSeam() {
  const hops: string[] = []
  const makeAgent = (tag: string) => ({
    tag,
    dispatch(): boolean {
      hops.push(tag)
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

test('dispatcher: local exit down -> direct + wake; up -> route + touch the idle clock', () => {
  const pool = new ExitPool()
  pool.add(localNode())
  pool.markOk('127.0.0.1:30001')

  const { seam, hops } = fakeSeam()
  let running = false
  const hooks: string[] = []
  const localExit: LocalExitHooks = {
    isRunning: () => running,
    onDown: (exitId) => {
      hooks.push(`down:${exitId}`)
      running = true // the wake brings the core up for the next request
    },
    onUse: (exitId) => {
      hooks.push(`use:${exitId}`)
    },
  }
  const router = new PoolRoutingDispatcher({
    pool,
    undici: seam as never,
    proxyHosts: ['opencode.ai'],
    localExit,
  })

  // Core idle-stopped: serve direct (never fail closed) and wake it.
  routingContext.run({}, () => {
    router.dispatch({ origin: 'https://opencode.ai/zen/v1/chat/completions' } as never, {} as never)
  })
  assert.deepEqual(hops, ['direct'])
  assert.deepEqual(hooks, ['down:127.0.0.1:30001'])

  // Core up: route through the local SOCKS5 exit and reset the clock.
  routingContext.run({}, () => {
    router.dispatch({ origin: 'https://opencode.ai/zen/v1/chat/completions' } as never, {} as never)
  })
  assert.equal(hops.length, 2)
  assert.match(hops[1]!, /^proxy:/)
  assert.deepEqual(hooks, ['down:127.0.0.1:30001', 'use:127.0.0.1:30001'])

  // Non-local exits never consult the seam (fresh pool so pick order is
  // deterministic — rotation would otherwise choose either exit).
  const externalPool = new ExitPool()
  externalPool.add(localNode({ id: '203.0.113.5:1080', protocol: 'http', source: 'manual', exitIP: '203.0.113.5' }))
  externalPool.markOk('203.0.113.5:1080')
  const externalRouter = new PoolRoutingDispatcher({
    pool: externalPool,
    undici: seam as never,
    proxyHosts: ['opencode.ai'],
    localExit,
  })
  routingContext.run({}, () => {
    externalRouter.dispatch({ origin: 'https://opencode.ai/zen/v1/chat/completions' } as never, {} as never)
  })
  assert.equal(hooks.length, 2)
  assert.equal(hops.length, 3)
  assert.match(hops[2]!, /^proxy:/)
})

test('admission: a loopback candidate wakes the local endpoints before any probe byte', async () => {
  const pool = new ExitPool()
  let wakes = 0
  const deps = {
    pool,
    undici: {
      ProxyAgent: class {
        constructor(_options: { uri: string }) {}
        close(): Promise<void> {
          return Promise.resolve()
        }
        destroy(): Promise<void> {
          return Promise.resolve()
        }
      },
      // Echo fails fast; only the wake ordering matters here.
      request: async () => ({ statusCode: 500, body: { text: async () => '' } }),
    },
    ensureLocalEndpoints: async () => {
      wakes += 1
    },
  }

  await admitCandidate(deps as never, { address: '127.0.0.1:30001', protocol: 'socks5', source: 'subscription' })
  assert.equal(wakes, 1)

  await admitCandidate(deps as never, { address: '203.0.113.5:1080', protocol: 'http', source: 'manual' })
  assert.equal(wakes, 1) // external hosts never touch the local core
})

test('sameNodes: order-sensitive node identity behind reload idempotency', () => {
  const a: ParsedNode = {
    name: 'a',
    type: 'trojan',
    server: 'a.example.com',
    port: 443,
    raw: { type: 'trojan', name: 'a', server: 'a.example.com', port: 443, password: 'x' },
  }
  const b: ParsedNode = { ...a, name: 'b', server: 'b.example.com' }
  const aCopy: ParsedNode = { ...a, name: 'different-label', raw: { type: 'trojan', password: 'rotated' } }

  assert.ok(sameNodes([], []))
  assert.ok(sameNodes([a, b], [a, b]))
  // Same key set, different order -> different port assignment -> respawn.
  assert.ok(!sameNodes([a, b], [b, a]))
  assert.ok(!sameNodes([a], []))
  // nodeKey is type:server:port — label/credential drift alone does not
  // change the config shape (generateConfig derives outbounds from raw,
  // but reload idempotency deliberately keys on the identity sequence).
  assert.equal(nodeKeyOf(a), nodeKeyOf(aCopy))
  assert.ok(sameNodes([a], [aCopy]))
  assert.ok(!sameNodes([a], [b]))
})

test('supervisor: ensureRunning with no converted nodes is a clean no-op', async () => {
  const supervisor = new SingBoxSupervisor({ binPath: 'definitely-not-a-real-binary-xyz', dataDir: 'test-tmp-singbox' })
  assert.deepEqual(await supervisor.ensureRunning(), [])
  assert.equal(supervisor.running, false)
})

test('settings: a custom idle stop and lane budget survive resolve -> config mapping', () => {
  const raw = IpPoolConfigSchema({ singbox: { path: '/usr/bin/sing-box', idleStopMs: 120_000, lanes: 8 } }) as never
  const value = resolveIpPoolSettings({ singbox: { path: '/usr/bin/sing-box', idleStopMs: 120_000, lanes: 8 } })
  assert.equal(value.singbox.idleStopMs, 120_000)
  assert.equal(value.singbox.lanes, 8)
  assert.deepEqual(toIpPoolConfig(value).singbox, { path: '/usr/bin/sing-box', idleStopMs: 120_000, lanes: 8 })
  // The schema default fills a missing key (boot path through the Loader).
  const defaulted = IpPoolConfigSchema({}) as { singbox: { idleStopMs: number; lanes: number } }
  assert.equal(defaulted.singbox.idleStopMs, 600_000)
  assert.equal(defaulted.singbox.lanes, 16)
  assert.ok(raw) // schema accepts the explicit knobs
})
