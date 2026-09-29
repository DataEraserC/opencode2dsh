/**
 * sing-box child-process supervision — the TS port of GoProxy
 * custom/singbox.go (docs/ip-pool.md 1.2.2). The one external binary this
 * plugin will ever spawn, and only when the user's subscriptions carry
 * encrypted nodes:
 *
 *   ParsedNode[] -> config JSON (K fixed SOCKS5 lane inbounds, 30001+
 *   ascending, plus N port-less outbounds behind per-lane selectors —
 *   端口上限: 占用恒等于 K+1 而不是 N, docs 1.2.4) -> `sing-box check`
 *   preflight -> `sing-box run` -> lane-port readiness wait. The converted
 *   nodes return as `lane:` pool ids and join the pool through the trusted
 *   admission path (smoke rides a borrowed lane).
 *
 * Process supervision: interrupt -> 5s grace -> kill (Windows: taskkill /T
 * since signals are not deliverable), exit-watch so crashes surface, and
 * the caller (subscription layer) drives Reload on every refresh — a new
 * node list regenerates the config and restarts the process, same as
 * GoProxy's Reload.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ParsedNode } from './subscription.ts'
import { LanePool, laneAddressOf, selectorTagOf, type LaneConfigure } from './lanes.ts'

export interface SingBoxOptions {
  /** sing-box binary: PATH name or absolute path. */
  binPath: string
  /** Directory for config + working dir. */
  dataDir: string
  /** First local SOCKS5 port (default 30000; lanes take basePort+1..+K). */
  basePort?: number
  /** Lane count K — the local port budget (default 16; docs 1.2.4). */
  lanes?: number
  /** Port-readiness wait (default 10s). */
  readyTimeoutMs?: number
  logger?: { info(message: string): void; warn(message: string): void }
}

export interface ConvertedExit {
  /** Lane-backed pool id: `lane:<type>:<server>:<port>` (no local port —
   *  the lane is assigned at dial time, docs 1.2.4). */
  address: string
  protocol: 'socks5'
  /** The source node this exit serves (diagnostics + dedupe key). */
  node: ParsedNode
}

// -- outbound mapping (GoProxy buildOutbound, verbatim semantics) ----------

const getStr = (raw: Record<string, unknown>, key: string): string => {
  const value = raw[key]
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}
const getStrDefault = (raw: Record<string, unknown>, key: string, fallback: string): string => {
  const value = getStr(raw, key)
  return value !== '' ? value : fallback
}
const getInt = (raw: Record<string, unknown>, key: string): number => {
  const value = Number(raw[key])
  return Number.isFinite(value) ? value : 0
}
const getBool = (raw: Record<string, unknown>, key: string): boolean => raw[key] === true

function applyTLS(raw: Record<string, unknown>, out: Record<string, unknown>): void {
  const hasTLS =
    getBool(raw, 'tls') ||
    getStr(raw, 'sni') !== '' ||
    getStr(raw, 'client-fingerprint') !== '' ||
    // reality implies TLS even without an explicit sni (vless reality nodes
    // sometimes carry only reality-opts)
    (raw['reality-opts'] !== undefined && typeof raw['reality-opts'] === 'object')
  if (!hasTLS) return
  const tls: Record<string, unknown> = { enabled: true }
  const sni = getStr(raw, 'sni') || getStr(raw, 'servername')
  if (sni !== '') tls.server_name = sni
  if (getBool(raw, 'skip-cert-verify')) tls.insecure = true
  const alpn = raw.alpn
  if (Array.isArray(alpn)) {
    const list = alpn.filter((entry): entry is string => typeof entry === 'string')
    if (list.length > 0) tls.alpn = list
  }
  const fingerprint = getStr(raw, 'client-fingerprint')
  if (fingerprint !== '') tls.utls = { enabled: true, fingerprint }
  const reality = raw['reality-opts']
  if (reality && typeof reality === 'object') {
    const opts = reality as Record<string, unknown>
    tls.reality = {
      enabled: true,
      public_key: getStr(opts, 'public-key'),
      short_id: getStr(opts, 'short-id'),
    }
  }
  out.tls = tls
}

function applyTransport(raw: Record<string, unknown>, out: Record<string, unknown>): void {
  const network = getStrDefault(raw, 'network', 'tcp')
  if (network === 'ws') {
    const transport: Record<string, unknown> = { type: 'ws' }
    const opts = raw['ws-opts']
    if (opts && typeof opts === 'object') {
      const ws = opts as Record<string, unknown>
      const path = getStr(ws, 'path')
      if (path !== '') transport.path = path
      const headers = ws.headers
      if (headers && typeof headers === 'object') transport.headers = headers
    }
    out.transport = transport
  } else if (network === 'grpc') {
    const transport: Record<string, unknown> = { type: 'grpc' }
    const opts = raw['grpc-opts']
    if (opts && typeof opts === 'object') {
      const sn = getStr(opts as Record<string, unknown>, 'grpc-service-name')
      if (sn !== '') transport.service_name = sn
    }
    out.transport = transport
  } else if (network === 'h2') {
    const transport: Record<string, unknown> = { type: 'http' }
    const opts = raw['h2-opts']
    if (opts && typeof opts === 'object') {
      const h2 = opts as Record<string, unknown>
      const path = getStr(h2, 'path')
      if (path !== '') transport.path = path
      const host = h2.host
      if (Array.isArray(host) && typeof host[0] === 'string') transport.host = [host[0]]
    }
    out.transport = transport
  } else if (network === 'httpupgrade') {
    const transport: Record<string, unknown> = { type: 'httpupgrade' }
    const opts = raw['ws-opts']
    if (opts && typeof opts === 'object') {
      const ws = opts as Record<string, unknown>
      const path = getStr(ws, 'path')
      if (path !== '') transport.path = path
      const headers = ws.headers
      if (headers && typeof headers === 'object') {
        const host = (headers as Record<string, unknown>).Host
        if (typeof host === 'string') transport.host = host
      }
    }
    out.transport = transport
  }
}

/** One ParsedNode -> one sing-box outbound (GoProxy buildOutbound). */
export function buildOutbound(node: ParsedNode, tag: string): Record<string, unknown> | null {
  const raw = node.raw
  const out: Record<string, unknown> = {
    tag,
    server: node.server,
    server_port: node.port, // sing-box uses server_port, not port
  }
  switch (node.type) {
    case 'vmess':
      out.type = 'vmess'
      out.uuid = getStr(raw, 'uuid')
      out.alter_id = getInt(raw, 'alterId')
      out.security = getStrDefault(raw, 'cipher', 'auto')
      applyTLS(raw, out)
      applyTransport(raw, out)
      break
    case 'vless':
      out.type = 'vless'
      out.uuid = getStr(raw, 'uuid')
      const flow = getStr(raw, 'flow')
      if (flow !== '') out.flow = flow
      applyTLS(raw, out)
      applyTransport(raw, out)
      break
    case 'trojan':
      out.type = 'trojan'
      out.password = getStr(raw, 'password')
      applyTLS(raw, out)
      applyTransport(raw, out)
      break
    case 'shadowsocks': {
      out.type = 'shadowsocks'
      out.method = getStr(raw, 'cipher') || getStr(raw, 'method')
      out.password = getStr(raw, 'password')
      const plugin = getStr(raw, 'plugin')
      if (plugin !== '') {
        out.plugin = plugin
        const opts = raw['plugin-opts']
        if (opts && typeof opts === 'object') {
          out.plugin_opts = Object.entries(opts as Record<string, unknown>)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(';')
        }
      }
      break
    }
    case 'hysteria2':
      out.type = 'hysteria2'
      out.password = getStr(raw, 'password')
      // hysteria2 is TLS-mandatory (QUIC + TLS; sing-box check rejects it
      // with "TLS required"), and Clash entries for it often carry neither
      // a `tls` flag nor an `sni` field — force TLS on like anytls so the
      // generated config always passes `sing-box check`.
      applyTLS({ ...raw, tls: true }, out)
      break
    case 'tuic':
      out.type = 'tuic'
      out.uuid = getStr(raw, 'uuid')
      out.password = getStr(raw, 'password')
      out.congestion_control = getStrDefault(raw, 'congestion-controller', 'bbr')
      // tuic is TLS-mandatory too (QUIC + TLS, same as hysteria2 above).
      applyTLS({ ...raw, tls: true }, out)
      break
    case 'anytls':
      out.type = 'anytls'
      out.password = getStr(raw, 'password')
      // anytls is TLS-mandatory (GoProxy forceTLS)
      applyTLS({ ...raw, tls: true }, out)
      break
    default:
      return null
  }
  return out
}

// -- config generation --------------------------------------------------------

/** Default lane count K (the local port budget: K lanes + 1 clash API). */
export const DEFAULT_LANES = 16

export interface GeneratedConfig {
  config: Record<string, unknown>
  /** nodeKey -> sing-box outbound tag (convertible nodes only). */
  outTags: Map<string, string>
  /** The K lane inbound ports (basePort+1 .. basePort+K). */
  lanePorts: number[]
  /** clash-API control port (basePort+K+1) — the selector switches live on. */
  apiPort: number
}

/** nodeKey (GoProxy): type:server:port. */
export function nodeKeyOf(node: ParsedNode): string {
  return `${node.type}:${node.server}:${node.port}`
}

/** Same node set in the same order (ports derive from the index, so an
 *  identical sequence means an identical config — reload can stay idle). */
export function sameNodes(a: ParsedNode[], b: ParsedNode[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (nodeKeyOf(a[i]!) !== nodeKeyOf(b[i]!)) return false
  }
  return true
}

/** The full sing-box config for a node list (docs 1.2.4):
 *  K lane inbounds (fixed port budget) + N port-less node outbounds +
 *  one selector per lane + the clash API controller. */
export function generateConfig(
  nodes: ParsedNode[],
  basePort = 30_000,
  lanes = DEFAULT_LANES,
): GeneratedConfig {
  const laneCount = Math.max(1, Math.floor(lanes))
  const lanePorts = Array.from({ length: laneCount }, (_, i) => basePort + 1 + i)
  const apiPort = basePort + 1 + laneCount
  const outTags = new Map<string, string>()
  const nodeTags: string[] = []
  const outbounds: Array<Record<string, unknown>> = []
  for (const node of nodes) {
    const key = nodeKeyOf(node)
    if (outTags.has(key)) continue
    // Stable, content-derived tag: survives reordering so selectors and
    // clash-API names never shift under a refresh.
    const tag = `out-${key.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const outbound = buildOutbound(node, tag)
    if (outbound === null) continue
    outbounds.push(outbound)
    outTags.set(key, tag)
    nodeTags.push(tag)
  }
  const inbounds = lanePorts.map((port, i) => ({
    type: 'socks',
    tag: `lane${i}`,
    listen: '127.0.0.1',
    listen_port: port,
  }))
  const rules = lanePorts.map((_, i) => ({ inbound: [`lane${i}`], outbound: selectorTagOf(i) }))
  const selectors = lanePorts.map((_, i) => ({
    type: 'selector',
    tag: selectorTagOf(i),
    outbounds: [...nodeTags, 'direct'],
    default: nodeTags[0] ?? 'direct',
  }))
  return {
    config: {
      log: { level: 'warn' },
      experimental: { clash_api: { external_controller: `127.0.0.1:${apiPort}` } },
      inbounds,
      outbounds: [...selectors, ...outbounds, { type: 'direct', tag: 'direct' }],
      route: { rules, final: 'direct' },
    },
    outTags,
    lanePorts,
    apiPort,
  }
}

// -- process supervision -------------------------------------------------------

const STOP_GRACE_MS = 5_000

function canConnect(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export class SingBoxSupervisor {
  readonly #options: SingBoxOptions
  readonly #lanes: LanePool
  #child: ChildProcess | null = null
  #running = false
  #configPath: string
  #dataDir: string
  #outTags = new Map<string, string>()
  #lanePorts: number[] = []
  #apiPort = 0
  #nodes: ParsedNode[] = []
  /** Reload serialization chain (see reload): concurrent reloads collapse. */
  #reloadChain: Promise<unknown> = Promise.resolve()

  constructor(options: SingBoxOptions) {
    this.#options = options
    this.#dataDir = options.dataDir
    this.#configPath = join(options.dataDir, 'singbox-config.json')
    this.#lanes = new LanePool(options.logger ? { logger: options.logger } : {})
  }

  /** The lane table (dispatcher + admission bind through it). */
  get lanes(): LanePool {
    return this.#lanes
  }

  /** Live re-apply of the binary path (settings page, docs §5.1). The next
   *  reload() resolves through it; a running child keeps serving until then. */
  setBinPath(path: string): void {
    this.#options.binPath = path
  }

  /** Live re-apply of the lane count (settings page). A changed K changes
   *  the config shape, so a running child respawns on the next reload —
   *  documented as dropping in-flight streams (same as a node refresh). */
  setLaneCount(count: number): boolean {
    const next = Math.max(1, Math.floor(count))
    if ((this.#options.lanes ?? DEFAULT_LANES) === next) return false
    this.#options.lanes = next
    return this.#running
  }

  get running(): boolean {
    return this.#running
  }

  /** Lane budget + ports for diagnostics (status bridge, docs 1.2.4). */
  get laneInfo(): { count: number; ports: number[]; apiPort: number } {
    return this.#lanes.info()
  }

  /** The binary location: absolute path as-is; bare name must exist on PATH
   *  (verified through `sing-box version` — LookPath equivalent). */
  async #resolveBinary(): Promise<string> {
    const bin = this.#options.binPath
    if (bin.includes('/') || bin.includes('\\') || bin.includes(':')) {
      if (existsSync(bin)) return bin
      throw new Error(`sing-box not found at ${bin}`)
    }
    // bare name: check via version output (LookPath semantics)
    const probe = await new Promise<boolean>((resolve) => {
      const child = spawn(bin, ['version'], { stdio: 'ignore' })
      child.once('error', () => resolve(false))
      child.once('exit', (code) => resolve(code === 0))
    })
    if (!probe) throw new Error(`sing-box not found on PATH ("${bin}"); install it or set singbox.path`)
    return bin
  }

  /** Full reload: regenerate the config for the node list and (re)start.
   *  Serialized on purpose (ports follow use, docs 1.2.3): a subscription
   *  refresh and an on-demand wake can race — the follower waits for the
   *  leader and then lands on the sameNodes idempotency check, reusing the
   *  child the leader just started instead of double-spawning. */
  reload(nodes: ParsedNode[]): Promise<ConvertedExit[]> {
    const run = this.#reloadChain.then(
      () => this.#reloadLocked(nodes),
      () => this.#reloadLocked(nodes),
    )
    this.#reloadChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** The serialized reload body (see reload). */
  async #reloadLocked(nodes: ParsedNode[]): Promise<ConvertedExit[]> {
    // no tunnel nodes -> stop and clean (GoProxy Reload empty case)
    if (nodes.length === 0) {
      await this.stop()
      this.#nodes = []
      this.#outTags = new Map()
      this.#lanePorts = []
      this.#apiPort = 0
      return []
    }
    const laneCount = Math.max(1, Math.floor(this.#options.lanes ?? DEFAULT_LANES))
    // Idempotent reload (ports follow use, docs 1.2.3): the same node set in
    // the same order (and the same lane budget) yields the same config, so a
    // subscription refresh with unchanged nodes must NOT recycle the child —
    // a respawn would only drop in-flight streams every refresh interval.
    if (this.#running && sameNodes(this.#nodes, nodes) && this.#lanePorts.length === laneCount) {
      return this.#exitsFor(this.#nodes)
    }
    const binary = await this.#resolveBinary()
    const { config, outTags, lanePorts, apiPort } = generateConfig(
      nodes,
      this.#options.basePort ?? 30_000,
      laneCount,
    )

    // atomic config write (tmp + rename)
    await mkdir(this.#dataDir, { recursive: true })
    const tmp = `${this.#configPath}.tmp`
    await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
    await rm(this.#configPath, { force: true })
    await rename(tmp, this.#configPath)

    // preflight: `sing-box check`
    const checkOk = await new Promise<boolean>((resolve) => {
      const child = spawn(binary, ['check', '-c', this.#configPath, '-D', this.#dataDir], { stdio: 'ignore' })
      child.once('error', () => resolve(false))
      child.once('exit', (code) => resolve(code === 0))
    })
    if (!checkOk) {
      throw new Error('sing-box config check failed (run `sing-box check` on the generated config for details)')
    }

    await this.stop()
    this.#child = spawn(binary, ['run', '-c', this.#configPath, '-D', this.#dataDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const child = this.#child
    this.#nodes = nodes
    this.#outTags = outTags
    this.#lanePorts = lanePorts
    this.#apiPort = apiPort
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text.length > 0) this.#options.logger?.info(`[sing-box] ${text}`)
    })
    child.once('exit', () => {
      if (this.#child === child) {
        this.#running = false
        this.#lanes.reset()
      }
    })
    child.once('error', () => {
      if (this.#child === child) {
        this.#running = false
        this.#lanes.reset()
      }
    })

    // lane-port readiness (same 20 x 500ms budget over the first lane port)
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? 10_000)
    let ready = false
    while (Date.now() < deadline && !ready) {
      // Crash detection while #running is still false (ports follow use:
      // the flag flips only after readiness, so a warm child never routes
      // into not-yet-listening ports). "Exited" = no longer OUR live child.
      if (this.#child !== child || child.exitCode !== null) throw new Error('sing-box exited immediately after start (see logs)')
      await new Promise((resolve) => setTimeout(resolve, 500))
      for (const port of lanePorts) {
        // eslint-disable-next-line no-await-in-loop
        if (await canConnect(port)) {
          ready = true
          break
        }
      }
    }
    if (!ready) this.#options.logger?.warn('opencode2dsh: sing-box lanes not ready in time; converted nodes may be unreachable')

    // Up AND answering: only now are the lanes routable (the dispatcher's
    // isRunning() gates on this) — and only now may bindings be claimed.
    this.#lanes.configure({ lanePorts, apiPort, outTags })
    this.#running = true
    return this.#exitsFor(nodes)
  }

  /**
   * Ports follow use (docs 1.2.3): make sure the child is up for the node
   * list this supervisor already owns — a full spawn when it was stopped
   * (idle-stop / disable), an idempotent pass-through while it runs.
   * Returns the local exits the list maps to (empty when none converted).
   */
  async ensureRunning(): Promise<ConvertedExit[]> {
    if (this.#nodes.length === 0) return []
    return this.reload(this.#nodes)
  }

  /** Map a node list through the outbound tags to lane-backed pool ids. */
  #exitsFor(nodes: ParsedNode[]): ConvertedExit[] {
    const exits: ConvertedExit[] = []
    for (const node of nodes) {
      const key = nodeKeyOf(node)
      if (!this.#outTags.has(key)) continue
      exits.push({ address: laneAddressOf(key), protocol: 'socks5', node })
    }
    return exits
  }

  /** Graceful stop: interrupt -> grace -> kill (taskkill /T on Windows). */
  async stop(): Promise<void> {
    const child = this.#child
    this.#lanes.reset()
    if (child === null || child.exitCode !== null) {
      this.#running = false
      return
    }
    this.#child = null
    if (process.platform === 'win32' && child.pid) {
      // graceful attempt first, then /T /F
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/T', '/PID', String(child.pid)], { stdio: 'ignore' })
        killer.once('exit', () => resolve())
        killer.once('error', () => resolve())
      })
    } else {
      child.kill('SIGINT')
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    const grace = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), STOP_GRACE_MS))
    if ((await Promise.race([exited.then(() => 'exit' as const), grace])) === 'timeout') {
      if (process.platform === 'win32' && child.pid) {
        await new Promise<void>((resolve) => {
          const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
          killer.once('exit', () => resolve())
          killer.once('error', () => resolve())
        })
      } else {
        child.kill('SIGKILL')
      }
      await exited
    }
    this.#running = false
  }
}
