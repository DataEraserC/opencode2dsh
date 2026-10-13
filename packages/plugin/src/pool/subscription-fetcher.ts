/**
 * Subscription fetcher — pulls airport/Clash subscription URLs, parses them
 * with the three-format auto-detector (subscription.ts) and routes the
 * parsed nodes (docs/ip-pool.md 1.2 source 3):
 *
 *   - plaintext nodes (http/socks5) -> admission smoke -> ExitPool
 *   - encrypted nodes (vmess/vless/trojan/ss/hysteria2/anytls/tuic) ->
 *     parked as pending-conversion until the sing-box layer lands (IP-4)
 *
 * Deliberately gentle: subscription servers are paid account resources
 * (ban risk), so one request per URL per refresh — no retries, no fan-out
 * (docs 4.1: subscription never goes hot).
 *
 * The fetch User-Agent is settings-driven (docs 5.1 `subscription.userAgent`,
 * default DEFAULT_SUBSCRIPTION_USER_AGENT): airports gate on it and a UA their
 * panel does not list can come back as an error page or a 502 rather than a
 * subscription body — one airport measured here answers 502 for
 * `clash-verge/1.6.0` and serves normally for `clash-verge/v2.0`.
 */

import { ExitPool, type ExitNode } from './pool.ts'
import { Prober, type ProbeTask } from './prober.ts'
import { admitCandidate, admitTrusted, type AdmissionDeps } from './admission.ts'
import { parseSubscription, type ParsedNode } from './subscription.ts'
import { DEFAULT_SUBSCRIPTION_USER_AGENT, normalizeSubscriptionUserAgent } from './subscription-defaults.ts'
import { SingBoxSupervisor, type ConvertedExit } from './singbox.ts'

/**
 * The fetch UA the settings layer and the runtime both default to; re-exported
 * so callers wiring the fetcher need not reach into the parser module.
 */
export { DEFAULT_SUBSCRIPTION_USER_AGENT }

export interface SubscriptionDeps extends AdmissionDeps {
  pool: ExitPool
  prober: Prober
  fetchImpl?: typeof fetch
  /** sing-box supervisor for encrypted-node conversion; when null the
   *  encrypted nodes simply park as pending (no binary configured). */
  supervisor?: {
    reload(nodes: ParsedNode[]): Promise<ConvertedExit[]>
    stop(): Promise<void>
    readonly running: boolean
    /** Ports follow use (docs 1.2.3): start the child when it is stopped. */
    ensureRunning?(): Promise<ConvertedExit[]>
  }
  /**
   * Spawn gate (ports follow use, docs 1.2.3): while the pool is disabled
   * nothing may open local ports — encrypted nodes park instead of
   * converting, and convertPending() stays closed too. Absent = allowed.
   */
  maySpawn?: () => boolean
}

export interface SubscriptionState {
  running: boolean
  /** Parsed nodes needing an external core; empty once conversion ran. */
  pendingConversion: ParsedNode[]
  /** Converted local exits admitted into the pool this round. */
  convertedAdmitted: number
  lastFetch: number
  lastError: string
  plaintextAdmitted: number
}

export interface SubscriptionOptions {
  /** Refresh interval (docs 4.6, default 30min). */
  intervalMs?: number
  timeoutMs?: number
  /**
   * User-Agent for subscription fetches (docs 5.1 `subscription.userAgent`).
   * Airports gate on this — an unlisted UA returns an error page instead of a
   * body, and may also select the returned format. Empty/unset falls back to
   * DEFAULT_SUBSCRIPTION_USER_AGENT.
   */
  userAgent?: string
  logger?: { info(message: string): void; warn(message: string): void }
}

export class SubscriptionFetcher {
  readonly #deps: SubscriptionDeps
  #urls: string[] = []
  #state: SubscriptionState = {
    running: false,
    pendingConversion: [],
    convertedAdmitted: 0,
    lastFetch: 0,
    lastError: '',
    plaintextAdmitted: 0,
  }
  #timer: NodeJS.Timeout | null = null
  #refreshing: Promise<SubscriptionState> | null = null
  #stopped = false
  #controller: AbortController | null = null
  #intervalMs: number
  #timeoutMs: number
  #userAgent: string
  #logger?: SubscriptionOptions['logger']

  constructor(deps: SubscriptionDeps, options: SubscriptionOptions = {}) {
    this.#deps = deps
    this.#intervalMs = options.intervalMs ?? 30 * 60_000
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#userAgent = normalizeSubscriptionUserAgent(options.userAgent)
    this.#logger = options.logger
  }

  get state(): SubscriptionState {
    return { ...this.#state, running: this.#refreshing !== null, pendingConversion: [...this.#state.pendingConversion] }
  }

  /** Configured URL count (status bridge; the URLs themselves never ride out). */
  get urlCount(): number {
    return this.#urls.length
  }

  /** Update the subscription URL list (settings change); refresh follows. */
  setUrls(urls: string[]): void {
    this.#urls = urls.filter((url) => url.trim().length > 0)
  }

  /** Live re-apply of the refresh interval (settings page, docs §5.1). */
  setIntervalMs(ms: number): void {
    this.#intervalMs = Math.max(60_000, ms)
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = setInterval(() => void this.refresh(), this.#intervalMs)
      this.#timer.unref?.()
    }
  }

  /**
   * Live re-apply of the fetch User-Agent (settings page, docs §5.1). Takes
   * effect on the next refresh — the in-flight round keeps the UA it started
   * with. Empty falls back to the default rather than sending no UA at all.
   */
  setUserAgent(userAgent: string | undefined): void {
    this.#userAgent = normalizeSubscriptionUserAgent(userAgent)
  }

  /** The UA the next fetch will send (settings card echo / diagnostics). */
  get userAgent(): string {
    return this.#userAgent
  }

  /** Manual refresh trigger (settings page 立即刷新, /probe scope: 'subscriptions'). */
  async refreshNow(): Promise<SubscriptionState> {
    return this.refresh()
  }

  start(): void {
    if (this.#timer !== null || this.#stopped) return
    void this.refresh()
    this.#timer = setInterval(() => void this.refresh(), this.#intervalMs)
    this.#timer.unref?.()
  }

  stop(): void {
    this.#stopped = true
    this.#controller?.abort()
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    void this.#deps.supervisor?.stop().catch(() => {})
  }

  /** One refresh round over every URL; never overlaps itself. */
  refresh(): Promise<SubscriptionState> {
    if (this.#refreshing !== null) return this.#refreshing
    if (this.#stopped) return Promise.resolve(this.state)
    this.#refreshing = this.#refreshRound()
      .finally(() => { this.#refreshing = null })
      .then(() => this.state)
    return this.#refreshing
  }

  async #refreshRound(): Promise<void> {
    const urls = [...this.#urls]
    const userAgent = this.#userAgent
    const pending: ParsedNode[] = []
    const plaintext: Array<{ address: string; protocol: 'http' | 'socks5' }> = []
    let lastError = ''
    for (const url of urls) {
      try {
        const body = await this.#fetch(url, userAgent)
        if (this.#stopped) return
        const report = parseSubscription(body)
        for (const node of report.nodes) {
          if (node.type === 'http' || node.type === 'socks5') {
            plaintext.push({
              address: `${node.server}:${node.port}`,
              protocol: node.type,
            })
          } else {
            pending.push(node)
          }
        }
        this.#logger?.info(`opencode2dsh: subscription parsed ${report.nodes.length} node(s) (${report.detected}) from ${this.#redact(url)}`)
      } catch (err) {
        if (this.#stopped) return
        lastError = err instanceof Error ? err.message : String(err)
        this.#logger?.warn(`opencode2dsh: subscription fetch failed for ${this.#redact(url)}: ${lastError}`)
      }
    }
    this.#state = {
      running: false,
      pendingConversion: pending,
      convertedAdmitted: 0,
      lastFetch: Date.now(),
      lastError,
      plaintextAdmitted: 0,
    }
    // Encrypted nodes -> sing-box conversion -> local SOCKS5 exits (IP-4).
    // Parked when no supervisor exists (no binary) or when the pool is
    // disabled (ports follow use: nothing opens ports while off, docs
    // 1.2.3); the enable flip converts the parked set via convertPending().
    if (pending.length > 0 && this.#deps.supervisor && this.#deps.maySpawn?.() !== false) {
      await this.#convertEncrypted(pending)
    } else if (pending.length > 0) {
      this.#logger?.info(
        `opencode2dsh: ${pending.length} encrypted node(s) parked (${this.#deps.supervisor === undefined ? 'no sing-box supervisor' : 'pool disabled'}); they convert on enable`,
      )
    }
    // Plaintext nodes go through the trusted admission smoke (never the
    // hot coarse screen: subscription nodes are paid resources, docs 4.1).
    if (this.#stopped) return
    const tasks: ProbeTask[] = plaintext
      .filter((candidate) => !this.#deps.pool.has(candidate.address))
      .map((candidate): ProbeTask => ({
        exitId: candidate.address,
        kind: 'subscription-smoke',
        run: async () => {
          if (this.#stopped) return
          const verdict = await admitTrusted(this.#deps, {
            address: candidate.address,
            protocol: candidate.protocol,
            source: 'subscription',
          })
          if (!this.#stopped && verdict.admitted && verdict.node) {
            if (this.#deps.pool.add(verdict.node)) {
              this.#deps.pool.markOk(verdict.node.id)
              this.#state.plaintextAdmitted += 1
            }
          }
        },
      }))
    if (tasks.length > 0) await this.#deps.prober.enqueueAll(tasks)
  }

  /**
   * Convert one pending set through the supervisor and smoke the new local
   * exits into the pool (shared by the refresh round and convertPending; the
   * CALLER owns the `#refreshing` single-flight).
   */
  async #convertEncrypted(pending: ParsedNode[]): Promise<void> {
    const supervisor = this.#deps.supervisor
    if (supervisor === undefined) return
    try {
      const exits = await supervisor.reload(pending)
      if (this.#stopped) return
      const tasks: ProbeTask[] = exits
        .filter((exit) => !this.#deps.pool.has(exit.address))
        .map((exit): ProbeTask => ({
          exitId: exit.address,
          kind: 'subscription-smoke',
          run: async () => {
            if (this.#stopped) return
            const verdict = await admitTrusted(this.#deps, {
              address: exit.address,
              protocol: exit.protocol,
              source: 'subscription',
            })
            if (!this.#stopped && verdict.admitted && verdict.node) {
              if (this.#deps.pool.add(verdict.node)) {
                this.#deps.pool.markOk(verdict.node.id)
                this.#state.convertedAdmitted += 1
                const served = exit.node
                this.#state.pendingConversion = this.#state.pendingConversion.filter(
                  (node) => node !== served,
                )
              }
            }
          },
        }))
      if (tasks.length > 0) await this.#deps.prober.enqueueAll(tasks)
      this.#logger?.info(`opencode2dsh: sing-box converted ${exits.length} encrypted node(s); ${this.#state.convertedAdmitted} admitted`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.#state.lastError = message
      this.#logger?.warn(`opencode2dsh: sing-box conversion failed: ${message}`)
    }
  }

  /**
   * Ports follow use (docs 1.2.3): called on the settings enable flip so
   * nodes parked while disabled convert immediately instead of waiting for
   * the next subscription refresh. Joins the refresh single-flight, so it
   * no-ops while a round is running; also closed with nothing parked, after
   * stop(), or while the spawn gate is shut.
   */
  async convertPending(): Promise<SubscriptionState> {
    const pending = this.#state.pendingConversion
    if (
      this.#refreshing !== null
      || this.#stopped
      || pending.length === 0
      || this.#deps.supervisor === undefined
      || this.#deps.maySpawn?.() === false
    ) {
      return this.state
    }
    this.#refreshing = this.#convertEncrypted(pending)
      .finally(() => { this.#refreshing = null })
      .then(() => this.state)
    return this.#refreshing
  }

  async #fetch(url: string, userAgent: string): Promise<string> {
    const controller = new AbortController()
    this.#controller = controller
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const response = await (this.#deps.fetchImpl ?? fetch)(url, {
        signal: controller.signal,
        headers: { accept: '*/*', 'user-agent': userAgent },
      })
      if (!response.ok) throw new Error(`subscription HTTP ${response.status}`)
      return await response.text()
    } finally {
      clearTimeout(timer)
      this.#controller = null
    }
  }

  /** Subscriptions embed account credentials; never log them in full. */
  #redact(url: string): string {
    if (url.length <= 24) return url
    return url.slice(0, 12) + '…' + url.slice(-6)
  }
}
