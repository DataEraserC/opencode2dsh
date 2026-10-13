import test from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool } from '../src/pool/pool.ts'
import { Prober } from '../src/pool/prober.ts'
import { SubscriptionFetcher } from '../src/pool/subscription-fetcher.ts'

/** A fake undici seam: every admission request answers 200 (smoke passes). */
function seam() {
  return {
    ProxyAgent: class {
      constructor(opts: { uri: string }) {
        this.uri = opts.uri
      }
      uri: string
      close() { return Promise.resolve() }
      destroy() { return Promise.resolve() }
    },
    request: (async (url: string, init: { dispatcher: { uri: string } }) => {
      const address = init.dispatcher.uri.replace(/^https?:\/\//, '')
      if (url.includes('ip-api')) {
        return {
          statusCode: 200,
          body: { text: async () => JSON.stringify({ status: 'success', query: `8.8.${address.length}.1`, countryCode: 'US', city: 'c', country: 'c' }) },
        }
      }
      return { statusCode: 200, body: { text: async () => '{"ok":true}' } }
    }) as never,
  }
}

/** A subscription body fixture: mixed airport content (anytls + plaintext). */
const SUB_BODY = [
  'proxies:',
  '  - name: "机场US"',
  '    type: anytls',
  '    server: us01.example.com',
  '    port: 18888',
  '    password: secret-pw',
  '  - name: "明文HTTP"',
  '    type: http',
  '    server: 1.2.3.4',
  '    port: 8080',
  '  - name: "明文SOCKS"',
  '    type: socks5',
  '    server: 5.6.7.8',
  '    port: 1080',
].join('\n')

function makeFetcher(
  fetchImpl: typeof fetch,
  logger?: { info(message: string): void; warn(message: string): void },
  options: { userAgent?: string } = {},
) {
  const pool = new ExitPool()
  const prober = new Prober({ pool })
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: seam() as never, fetchImpl },
    { logger: logger ?? { info: () => {}, warn: () => {} }, ...options },
  )
  return { pool, fetcher }
}

/** A fetch stub that records the User-Agent of every subscription pull. */
function uaRecorder(seen: Array<string | undefined>): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    seen.push((init?.headers as Record<string, string> | undefined)?.['user-agent'])
    return new Response('')
  }) as unknown as typeof fetch
}

test('subscription refresh: plaintext nodes smoke into the pool, encrypted park as pending', async () => {
  const { pool, fetcher } = makeFetcher((async () => new Response(SUB_BODY)) as unknown as typeof fetch)
  fetcher.setUrls(['https://sub.example.com/token-abcdef-123456'])
  const state = await fetcher.refresh()
  // plaintext nodes admitted through the trusted smoke
  assert.equal(state.plaintextAdmitted, 2)
  assert.ok(pool.has('1.2.3.4:8080'))
  assert.ok(pool.has('5.6.7.8:1080'))
  assert.ok(pool.list().every((n) => n.source === 'subscription'))
  // the anytls node parked for IP-4 conversion, not in the pool
  assert.equal(state.pendingConversion.length, 1)
  assert.equal(state.pendingConversion[0]?.type, 'anytls')
  assert.ok(!pool.has('us01.example.com:18888'))
  assert.equal(state.lastError, '')
})

test('subscription fetch failures are reported, never thrown', async () => {
  const { fetcher } = makeFetcher((async () => { throw new Error('ETIMEDOUT') }) as unknown as typeof fetch)
  fetcher.setUrls(['https://dead.example.com/sub'])
  const state = await fetcher.refresh()
  assert.match(state.lastError, /ETIMEDOUT/)
  assert.equal(state.pendingConversion.length, 0)
})

test('a manual refresh joins an ongoing round and exposes running until completion', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let requests = 0
  const { fetcher } = makeFetcher((async () => {
    requests++
    await gate
    return new Response('proxies:\n  - name: encrypted\n    type: anytls\n    server: example.test\n    port: 443\n    password: test')
  }) as typeof fetch)
  fetcher.setUrls(['https://example.test/sub'])
  const first = fetcher.refresh()
  let completed = false
  const second = fetcher.refreshNow().then((state) => { completed = true; return state })
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(completed, false)
    assert.equal(fetcher.state.running, true)
    assert.equal(requests, 1)
  } finally { release() }
  const results = await Promise.all([first, second])
  assert.equal(fetcher.state.running, false)
  assert.ok(results.every((state) => !state.running && state.lastFetch > 0 && state.pendingConversion.length === 1))
  fetcher.stop()
})

test('subscription URLs are redacted in logs', async () => {
  const logs: string[] = []
  const { fetcher } = makeFetcher(
    (async () => new Response('')) as unknown as typeof fetch,
    { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  )
  fetcher.setUrls(['https://sub.example.com/VerySecretToken1234567890abcdef'])
  await fetcher.refresh()
  // nothing in the log carries the full credential
  assert.ok(logs.every((line) => !line.includes('VerySecretToken1234567890abcdef')))
  assert.ok(logs.some((line) => line.includes('…')))
})

test('stopping during a pull aborts it and prevents fetching later URLs', async () => {
  let calls = 0
  let release!: () => void
  const { pool, fetcher } = makeFetcher((async (_url: string, init: RequestInit) => {
    calls++
    const gate = new Promise<void>((resolve) => { release = resolve })
    await new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => { release(); reject(new Error('aborted')) }, { once: true })
    })
    await gate
    return new Response(SUB_BODY)
  }) as typeof fetch)
  fetcher.setUrls(['https://example.test/a', 'https://example.test/b'])
  const round = fetcher.refresh()
  await new Promise<void>((resolve) => setImmediate(resolve))
  fetcher.stop()
  await round
  assert.equal(calls, 1)
  assert.equal(fetcher.state.running, false)
  assert.equal(fetcher.state.lastFetch, 0)
  assert.equal(pool.snapshot().total, 0, 'cancelled request does not enqueue pool changes')
  await fetcher.refreshNow()
  assert.equal(calls, 1, 'stopped fetcher cannot restart')
})

test('subscription nodes never enter the pool twice (idempotent refresh)', async () => {
  const { pool, fetcher } = makeFetcher((async () => new Response(SUB_BODY)) as unknown as typeof fetch)
  fetcher.setUrls(['https://sub.example.com/x'])
  await fetcher.refresh()
  await fetcher.refresh()
  const rows = pool.list().filter((n) => n.source === 'subscription')
  assert.equal(rows.length, 2) // still the same two plaintext nodes
})

// -- fetch User-Agent (airport allow-lists) -----------------------------------

test('subscription pulls send the default User-Agent, not the 502-ing 1.6.0', async () => {
  const seen: Array<string | undefined> = []
  const { fetcher } = makeFetcher(uaRecorder(seen))
  fetcher.setUrls(['https://sub.example.com/token-abcdef-123456'])
  await fetcher.refresh()
  // One pull per URL; the admission smoke rides deps.undici, not fetchImpl.
  assert.deepEqual(seen, ['clash-verge/v2.0'])
  assert.equal(fetcher.userAgent, 'clash-verge/v2.0')
})

test('the fetch UA is configurable and live-updatable without a restart', async () => {
  const seen: Array<string | undefined> = []
  const { fetcher } = makeFetcher(uaRecorder(seen), undefined, { userAgent: 'clash-verge/v2.0.3' })
  fetcher.setUrls(['https://sub.example.com/x'])
  await fetcher.refresh()
  assert.deepEqual(seen, ['clash-verge/v2.0.3'])

  // A settings save calls setUserAgent and the NEXT refresh must carry it.
  fetcher.setUserAgent('mihomo/1.19.0')
  await fetcher.refresh()
  assert.equal(seen.at(-1), 'mihomo/1.19.0')
})

test('a blank UA falls back to the default instead of sending none', async () => {
  const seen: Array<string | undefined> = []
  const { fetcher } = makeFetcher(uaRecorder(seen), undefined, { userAgent: '   ' })
  assert.equal(fetcher.userAgent, 'clash-verge/v2.0')

  fetcher.setUserAgent('clash-verge/v2.0')
  fetcher.setUserAgent('')
  assert.equal(fetcher.userAgent, 'clash-verge/v2.0')

  fetcher.setUrls(['https://sub.example.com/x'])
  await fetcher.refresh()
  assert.deepEqual(seen, ['clash-verge/v2.0'])
})

