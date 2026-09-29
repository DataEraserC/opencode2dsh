import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildOutbound, generateConfig, nodeKeyOf, SingBoxSupervisor } from '../src/pool/singbox.ts'
import { parseSubscription, type ParsedNode } from '../src/pool/subscription.ts'
import { ExitPool } from '../src/pool/pool.ts'
import { Prober } from '../src/pool/prober.ts'
import { SubscriptionFetcher } from '../src/pool/subscription-fetcher.ts'

// -- outbound mapping matrix --------------------------------------------------

function vmessNode(overrides: Partial<ParsedNode> = {}): ParsedNode {
  return {
    name: 'vmess-node',
    type: 'vmess',
    server: 'v.example.com',
    port: 443,
    raw: {
      type: 'vmess', name: 'vmess-node', server: 'v.example.com', port: 443,
      uuid: 'uuid-1', alterId: 0, cipher: 'auto',
      tls: true, network: 'ws', 'ws-opts': { path: '/ws', headers: { Host: 'cdn.example.com' } },
    },
    ...overrides,
  }
}

test('buildOutbound: vmess maps uuid/security/TLS/ws transport', () => {
  const out = buildOutbound(vmessNode(), 'out-node-0')
  assert.deepEqual(out, {
    tag: 'out-node-0', type: 'vmess', server: 'v.example.com', server_port: 443,
    uuid: 'uuid-1', alter_id: 0, security: 'auto',
    tls: { enabled: true },
    transport: { type: 'ws', path: '/ws', headers: { Host: 'cdn.example.com' } },
  })
})

test('buildOutbound: trojan/vless/hysteria2/tuic map their credentials', () => {
  const trojan = buildOutbound({
    name: 't', type: 'trojan', server: 't.example.com', port: 443,
    raw: { type: 'trojan', password: 'pw', sni: 't.example.com', 'skip-cert-verify': true },
  }, 'out-t')
  assert.equal(trojan?.type, 'trojan')
  assert.equal(trojan?.password, 'pw')
  assert.deepEqual(trojan?.tls, { enabled: true, server_name: 't.example.com', insecure: true })

  const vless = buildOutbound({
    name: 'v', type: 'vless', server: 'vl.example.com', port: 443,
    raw: { type: 'vless', uuid: 'u1', flow: 'xtls-rprx-vision', 'reality-opts': { 'public-key': 'pk', 'short-id': 'sid' } },
  }, 'out-v')
  assert.equal(vless?.flow, 'xtls-rprx-vision')
  assert.deepEqual(vless?.tls, {
    enabled: true,
    reality: { enabled: true, public_key: 'pk', short_id: 'sid' },
  })

  const hy2 = buildOutbound({
    name: 'h', type: 'hysteria2', server: 'h.example.com', port: 443,
    raw: { type: 'hysteria2', password: 'pw2' },
  }, 'out-h')
  // hysteria2 is TLS-mandatory: TLS is forced on even with no sni/tls flags
  assert.deepEqual(hy2, {
    tag: 'out-h', type: 'hysteria2', server: 'h.example.com', server_port: 443,
    password: 'pw2', tls: { enabled: true },
  })

  const tuic = buildOutbound({
    name: 'tu', type: 'tuic', server: 'q.example.com', port: 443,
    raw: { type: 'tuic', uuid: 'u', password: 'p' },
  }, 'out-tu')
  assert.equal(tuic?.congestion_control, 'bbr')
  // tuic is TLS-mandatory too
  assert.deepEqual(tuic?.tls, { enabled: true })
})

test('buildOutbound: anytls forces TLS on (GoProxy forceTLS)', () => {
  const out = buildOutbound({
    name: 'a', type: 'anytls', server: 'a.example.com', port: 18888,
    raw: { type: 'anytls', password: 'pw', sni: 'a.example.com' },
  }, 'out-a')
  assert.equal(out?.type, 'anytls')
  assert.deepEqual(out?.tls, { enabled: true, server_name: 'a.example.com' })
})

test('buildOutbound: unknown types return null (skipped)', () => {
  assert.equal(buildOutbound({
    name: 'x', type: 'wireguard', server: 'x', port: 1, raw: {},
  }, 'out-x'), null)
})

test('generateConfig: K lane inbounds + selectors + clash API (docs 1.2.4 port ceiling)', () => {
  const nodes = [vmessNode(), vmessNode({ name: 'second', server: 'v2.example.com', raw: { type: 'vmess', uuid: 'u2' } })]
  const { config, outTags, lanePorts, apiPort } = generateConfig(nodes, 30_000, 4)
  const cfg = config as {
    inbounds: Array<{ tag: string; listen: string; listen_port: number; type: string }>
    outbounds: Array<{ tag: string; type: string; outbounds?: string[]; default?: string }>
    route: { rules: Array<{ inbound: string[]; outbound: string }>; final: string }
    experimental: { clash_api: { external_controller: string } }
  }
  // K lane ports, then the clash API port: 2 nodes hold 5 ports, not 2
  assert.deepEqual(lanePorts, [30_001, 30_002, 30_003, 30_004])
  assert.equal(apiPort, 30_005)
  assert.equal(cfg.inbounds.length, 4)
  assert.ok(cfg.inbounds.every((inbound) => inbound.listen === '127.0.0.1' && inbound.type === 'socks'))
  assert.deepEqual(cfg.inbounds.map((inbound) => inbound.listen_port), lanePorts)
  assert.deepEqual(cfg.inbounds.map((inbound) => inbound.tag), ['lane0', 'lane1', 'lane2', 'lane3'])
  // 4 selectors + 2 node outbounds + direct
  assert.equal(cfg.outbounds.length, 7)
  const first = cfg.outbounds[0]!
  assert.equal(first.type, 'selector')
  assert.equal(first.tag, 'sel-lane0')
  assert.equal(first.default, outTags.get(nodeKeyOf(nodes[0]!)))
  assert.ok((first.outbounds ?? []).includes('direct'))
  // route: every lane dials its own selector; final stays direct
  assert.deepEqual(
    cfg.route.rules,
    lanePorts.map((_, i) => ({ inbound: [`lane${i}`], outbound: `sel-lane${i}` })),
  )
  assert.equal(cfg.route.final, 'direct')
  assert.equal(cfg.outbounds[cfg.outbounds.length - 1]?.tag, 'direct')
  assert.equal(cfg.experimental.clash_api.external_controller, '127.0.0.1:30005')
  // nodeKey -> stable content-derived outbound tag (no index drift)
  assert.equal(outTags.size, 2)
  assert.equal(outTags.get(nodeKeyOf(nodes[0]!)), outTags.get('vmess:v.example.com:443'))
})

test('generateConfig: default lane budget is 16 (port ceiling K + 1, any node count)', () => {
  const one = generateConfig([vmessNode()], 30_000)
  const many = generateConfig(Array.from({ length: 60 }, (_, i) => vmessNode({ server: `n${i}.example.com` })), 30_000)
  assert.equal(one.lanePorts.length, 16)
  assert.equal(one.apiPort, 30_017)
  assert.equal(many.lanePorts.length, 16)
  assert.equal(many.apiPort, 30_017)
  assert.equal(many.outTags.size, 60)
})

test('generateConfig: unsupported nodes are skipped without burning an outbound', () => {
  const nodes = [
    { name: 'bad', type: 'wireguard', server: 'x', port: 1, raw: {} },
    vmessNode(),
  ] satisfies ParsedNode[]
  const { config, outTags, lanePorts } = generateConfig(nodes, 30_000, 2)
  const cfg = config as { inbounds: unknown[]; outbounds: Array<{ type: string; outbounds?: string[]; default?: string }> }
  assert.equal(cfg.inbounds.length, 2) // lanes exist regardless
  assert.equal(cfg.outbounds.length, 4) // 2 selectors + vmess + direct
  assert.equal(outTags.size, 1)
  assert.ok(lanePorts.length === 2)
})

test('generateConfig: all-unsupported node list still yields a runnable config (selectors fall back to direct)', () => {
  const nodes = [{ name: 'bad', type: 'wireguard', server: 'x', port: 1, raw: {} }] satisfies ParsedNode[]
  const { config, outTags } = generateConfig(nodes, 30_000, 3)
  const cfg = config as { outbounds: Array<{ type: string; outbounds?: string[]; default?: string }> }
  assert.equal(outTags.size, 0)
  const selectors = cfg.outbounds.filter((out) => out.type === 'selector')
  assert.equal(selectors.length, 3)
  for (const selector of selectors) {
    assert.deepEqual(selector.outbounds, ['direct'])
    assert.equal(selector.default, 'direct')
  }
})

// -- conversion pipeline (fetcher + supervisor seam) ---------------------------

test('subscription refresh with supervisor: encrypted nodes convert and smoke into the pool', async () => {
  const fixture = readFileSync(new URL('./fixtures/sub_1775301718713.yaml', import.meta.url), 'utf8')
  const report = parseSubscription(fixture)
  assert.equal(report.nodes.length, 38)

  const pool = new ExitPool()
  const prober = new Prober({ pool })
  // A fake supervisor: converts every node to a local address without a
  // real binary (the SingBoxSupervisor's process paths are covered by the
  // config-generation tests; the fetcher only needs the seam contract).
  const converted: Array<{ address: string; protocol: 'socks5'; node: ParsedNode }> = []
  const supervisor = {
    async reload(nodes: ParsedNode[]) {
      for (const [index, node] of nodes.entries()) {
        converted.push({ address: `127.0.0.1:${31000 + index}`, protocol: 'socks5', node })
      }
      return converted
    },
    async stop() {},
    get running() {
      return true
    },
  }
  const seam = {
    ProxyAgent: class {
      constructor(opts: { uri: string }) {
        this.uri = opts.uri
      }
      uri: string
      close() { return Promise.resolve() }
      destroy() { return Promise.resolve() }
    },
    request: (async (url: string, init: { dispatcher: { uri: string } }) => {
      const address = init.dispatcher.uri.replace(/^[a-z0-9+.-]+:\/\//, '')
      if (url.includes('ip-api')) {
        // exit IP derived from the port so distinct local ports are
        // distinct quota buckets (the pool dedupes shared exit IPs, 3.1)
        const port = address.split(':')[1] ?? '0'
        return {
          statusCode: 200,
          body: { text: async () => JSON.stringify({ status: 'success', query: `7.7.${Number(port) % 250}.${(Number(port) / 250) | 0}`, countryCode: 'US', city: 'c', country: 'c' }) },
        }
      }
      return { statusCode: 200, body: { text: async () => '{"ok":true}' } }
    }) as never,
  }
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: seam as never, supervisor, fetchImpl: (async () => new Response(fixture)) as unknown as typeof fetch },
    { logger: { info: () => {}, warn: () => {} } },
  )
  fetcher.setUrls(['https://sub.example.com/token'])
  const state = await fetcher.refresh()
  // all 38 anytls nodes converted and admitted (trusted smoke always passes here)
  assert.equal(state.convertedAdmitted, 38)
  assert.equal(state.pendingConversion.length, 0)
  assert.equal(pool.list().length, 38)
  assert.ok(pool.list().every((entry) => entry.source === 'subscription'))
  // addresses are the local converted ports
  assert.ok(pool.has('127.0.0.1:31000'))
  assert.ok(pool.has('127.0.0.1:31037'))
})

test('subscription refresh without supervisor: encrypted nodes park as pending', async () => {
  const fixture = readFileSync(new URL('./fixtures/sub_1775301718713.yaml', import.meta.url), 'utf8')
  const pool = new ExitPool()
  const prober = new Prober({ pool })
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: {} as never, fetchImpl: (async () => new Response(fixture)) as unknown as typeof fetch },
    { logger: { info: () => {}, warn: () => {} } },
  )
  fetcher.setUrls(['https://sub.example.com/token'])
  const state = await fetcher.refresh()
  assert.equal(state.pendingConversion.length, 38)
  assert.equal(state.convertedAdmitted, 0)
  assert.equal(pool.list().length, 0)
})

test('supervisor: reload([]) stops cleanly; missing binary surfaces a clear error', async () => {
  const supervisor = new SingBoxSupervisor({
    binPath: 'definitely-not-on-path-sing-box',
    dataDir: 'test-tmp-singbox',
    logger: { info: () => {}, warn: () => {} },
  })
  // empty node list never touches the binary
  const exits = await supervisor.reload([])
  assert.deepEqual(exits, [])
  assert.ok(!supervisor.running)
  // a binary that cannot be resolved rejects with an actionable message
  await assert.rejects(() => supervisor.reload([vmessNode()]), /not found/i)
})
