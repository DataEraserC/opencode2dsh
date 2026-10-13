#!/usr/bin/env node
// node scripts/smoke-issues.mjs <installed @deepseek-ai/dsh directory>
// Real host registry, Cordis lifetimes, volatile saves, HTTP bridge and
// subscription fetches. External inference and user profiles are never used.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const host = resolve(process.argv[2])
const hostRequire = createRequire(join(host, 'package.json'))
const hostImport = (name) => import(pathToFileURL(hostRequire.resolve(name)).href)
const { Context, Service } = await hostImport('@deepseek-ai/cordis')
const { LlmRuntime } = await hostImport('@deepseek-ai/dsh-llm')
const { default: HostSchema } = await hostImport('@deepseek-ai/schemastery')
const { createVolatile, updateVolatile } = await hostImport('@deepseek-ai/cosmokit')
const entry = process.argv[3]
  ? await import(pathToFileURL(join(resolve(process.argv[3]), 'lib/index.js')))
  : await import('../packages/plugin/lib/index.js')
const { postBridgeAction } = await import('../packages/plugin/src/client/bridge-action.ts')
const { Config: pluginSchema, ...configuredEntry } = entry
const schema = new HostSchema(pluginSchema.toJSON())
const savedFetch = globalThis.fetch
const savedHomedir = os.homedir
const scratch = await mkdtemp(join(os.tmpdir(), 'opencode2dsh-issues-'))
const ctx = new Context()
const routes = new Map()
const seenUAs = []
let subscriptionError = false
let releaseSubscription = null
let releaseZen
let zenIds = ['big-pickle', 'space-bunny-free']
const zenGate = new Promise((done) => { releaseZen = done })
let listReads = []
let currentList = []
let topologyEvents = 0
let subscriptionRound = 0
let httpOrigin
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(check, label, ms = 5000) {
  const deadline = Date.now() + ms
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`)
    await pause(20)
  }
}
const fixture = createServer(async (req, res) => {
  if (req.url === '/models') {
    await zenGate
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: zenIds.map((id) => ({ id })) }))
    return
  }
  if (req.url === '/metadata') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ opencode: { models: {
      'big-pickle': { cost: { input: 0, output: 0 } },
      'space-bunny-free': { cost: { input: 0, output: 0 } },
    } } }))
    return
  }
  if (req.url === '/subscription') {
    seenUAs.push(req.headers['user-agent'])
    subscriptionRound++
    if (releaseSubscription) await releaseSubscription.promise
    res.writeHead(subscriptionError ? 502 : 200, { 'content-type': 'text/yaml' })
    res.end(subscriptionError ? 'Bad Gateway' : `proxies:\n  - name: round-${subscriptionRound}\n    type: anytls\n    server: fixture.example.test\n    port: 443\n    password: fixture-only\n`)
    return
  }
  const route = routes.get(req.url)
  if (!route) { res.writeHead(404); res.end(); return }
  try { await route.handler(req, res) } catch (error) {
    res.writeHead(500); res.end(JSON.stringify({ error: error.message }))
  }
})
class WebServer extends Service {
  constructor(context) { super(context, 'webServer') }
  register(route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  }
}
try {
  await new Promise((done) => fixture.listen(0, '127.0.0.1', done))
  httpOrigin = `http://127.0.0.1:${fixture.address().port}`
  os.homedir = () => scratch
  syncBuiltinESMExports()
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/zen/v1/models')) {
      return savedFetch(`${httpOrigin}/models`, init)
    }
    if (String(url).includes('models.dev')) return savedFetch(`${httpOrigin}/metadata`, init)
    return savedFetch(new URL(String(url), httpOrigin), init)
  }
  const llm = new LlmRuntime(ctx)
  new WebServer(ctx)
  ctx.on('llm/adapters-updated', () => {
    topologyEvents++
    if (llm.listProviders().length) listReads.push(llm.listModels('opencode2dsh').then((rows) => {
      currentList = rows.map((row) => row.id)
    }))
  })
  const config = schema({ ipPool: { enabled: false, free: { enabled: false }, singbox: { path: '' } } })
  const plugin = ctx.plugin(configuredEntry, config)
  await plugin.await()
  assert.equal(plugin.state, 2)
  const cold = (await llm.listModels('opencode2dsh')).map((row) => row.id)
  assert.ok(!cold.includes('space-bunny-free'), 'first read hit the real 4s warm deadline')
  releaseZen()
  await until(() => currentList.includes('space-bunny-free'), 'picker republished after late Zen response')
  await Promise.all(listReads)
  assert.ok(topologyEvents >= 2, 'real host registration handle emitted an update')
  assert.equal(llm.listProviders().length, 1, 'no duplicate route')
  const commit = (values) => {
    const next = schema({ ipPool: { ...config.ipPool.get(), ...values } }).ipPool.get()
    updateVolatile(config.ipPool, createVolatile(next))
    ctx.emit('loader/volatile-update')
  }
  const status = async () => {
    const response = await savedFetch(`${httpOrigin}/api/opencode2dsh/ip-pool/status`, {
      method: 'POST', headers: { origin: httpOrigin, 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.ok, true)
    return result.value
  }
  commit({ enabled: true, subscription: { urls: [`${httpOrigin}/subscription`], refreshMs: 60000, userAgent: 'fixture-client/1' } })
  let view
  for (let i = 0; i < 250; i++) {
    view = await status()
    if (view.subscription?.lastFetch && !view.subscription.running) break
    await pause(20)
  }
  assert.equal(view.subscription.urlCount, 1)
  assert.equal(view.subscription.pendingConversion, 1)
  assert.ok(seenUAs.every((ua) => ua === 'fixture-client/1'), 'initial pull uses saved UA')
  assert.ok(!JSON.stringify(view).includes('fixture-only'), 'status hides node credentials')
  const before = view.subscription.lastFetch
  commit({ subscription: { urls: [`${httpOrigin}/subscription`], refreshMs: 60000, userAgent: 'fixture-client/2' } })
  await pause(50)
  let release
  releaseSubscription = { promise: new Promise((done) => { release = done }) }
  const refreshing = postBridgeAction({ scope: 'subscriptions' })
  await until(() => seenUAs.at(-1) === 'fixture-client/2', 'manual pull uses updated UA')
  assert.equal((await status()).subscription.running, true)
  release()
  await refreshing
  releaseSubscription = null
  view = await status()
  assert.ok(view.subscription.lastFetch > before)
  assert.equal(view.subscription.running, false)
  subscriptionError = true
  await assert.rejects(postBridgeAction({ scope: 'subscriptions' }), /subscription HTTP 502/)
  assert.equal((await status()).subscription.lastError, 'subscription HTTP 502')
  const countBeforeClear = subscriptionRound
  commit({ subscription: { urls: [], refreshMs: 60000, userAgent: '' } })
  await pause(50)
  assert.equal((await status()).subscription, null, 'clearing URLs stops the old fetcher')
  await assert.rejects(postBridgeAction({ scope: 'subscriptions' }), /no subscription URLs/)
  assert.equal(subscriptionRound, countBeforeClear, 'deleted URL is not fetched again')
  commit({ enabled: false })
  await pause(50)
  await assert.rejects(postBridgeAction({ scope: 'subscriptions' }), /enabled off/)
  console.log(JSON.stringify({ host: hostRequire('./package.json').version,
    catalog: '4s cold snapshot -> late live roster via actual adapters-updated event',
    subscriptions: 'schema -> volatile save -> runtime -> real HTTP fetch -> parse -> status',
    refresh: 'client request -> HTTP bridge -> updated UA and running/result state',
    failures: 'HTTP 502, no URLs and disabled pool surfaced to client',
    cleanup: 'deleted URLs stopped; credentials hidden', subscriptionRequests: subscriptionRound }, null, 2))
} finally {
  releaseZen?.()
  await ctx.fiber.dispose()
  assert.equal(routes.size, 0, 'bridge routes disposed with plugin fiber')
  globalThis.fetch = savedFetch
  os.homedir = savedHomedir
  syncBuiltinESMExports()
  fixture.closeAllConnections()
  await new Promise((done) => fixture.close(done))
  assert.ok(scratch.startsWith(join(os.tmpdir(), 'opencode2dsh-issues-')))
  await rm(scratch, { recursive: true, force: true })
}
