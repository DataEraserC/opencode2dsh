/**
 * LanePool — K fixed local SOCKS5 lanes over an N-node sing-box config
 * (docs/ip-pool.md 1.2.4).
 *
 * 端口上限（用户决策 2026-09）：每节点一 inbound 是冗余 —— 260 个节点曾把
 * 30001-30262 全段占满。现在配置里 N 个 outbound **不占端口**，只开 K 个
 * socks 车道（默认 16），每个车道挂一个 selector outbound；把某节点放进
 * 某车道 = clash API `PUT /proxies/sel-lane<i>` 毫秒级热切换，零重启、
 * 在飞连接不受影响（拨号时选定，keep-alive 实测证明）。
 *
 * 因此：
 *   - 探测   —— 借任意空闲车道，260 个节点全部可探（不存在「没挂载」）；
 *   - 选择   —— 所有节点常驻配置，随时可切上任意车道；
 *   - 兜底   —— 当前节点全出问题时，轮换把任意健康节点切进释放的车道。
 *
 * 端口占用恒等于 K + 1（K 数据车道 + 1 个 clash 管理端口），且只在
 * sing-box 存活期间存在（ports follow use, 1.2.3 不变）。
 */

import { request as httpRequest } from 'node:http'

/** Pool-id prefix for a converted (lane-backed) exit: `lane:<nodeKey>`. */
export const LANE_PREFIX = 'lane:'

/** Pool id for a node behind a lane (nodeKey = `type:server:port`). */
export function laneAddressOf(nodeKey: string): string {
  return `${LANE_PREFIX}${nodeKey}`
}

/** Inverse of laneAddressOf: null when the address is not lane-backed. */
export function laneNodeOf(address: string): string | null {
  return address.startsWith(LANE_PREFIX) ? address.slice(LANE_PREFIX.length) : null
}

/** Selector outbound tag for lane index i (matches generateConfig). */
export function selectorTagOf(lane: number): string {
  return `sel-lane${lane}`
}

/** One assignment of a node to a lane. `epoch` changes on every rebind so
 *  the dispatcher's per-lane agent cache can never route a stale port. */
export interface LaneBinding {
  port: number
  epoch: number
  release(): void
}

export interface LaneConfigure {
  lanePorts: number[]
  apiPort: number
  /** nodeKey -> sing-box outbound tag (converted nodes only). */
  outTags: Map<string, string>
}

export interface LanePoolOptions {
  /** clash-API switch impl — injectable for tests. Default: HTTP PUT. */
  switchOutbound?: (apiPort: number, selectorTag: string, outboundTag: string) => Promise<void>
  /** Longest wait for a free lane before giving up (default 10s). */
  acquireTimeoutMs?: number
  logger?: { warn(message: string): void }
}

interface Lane {
  port: number
  node: string | null
  epoch: number
  inFlight: number
  lastUsed: number
  /** Rebind in progress (selector switch). While set the lane is reserved. */
  switching: Promise<void> | null
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000

/**
 * clash API switch: `PUT /proxies/<selector>` with `{"name": "<outbound>"}`.
 * Verified live against sing-box 1.13.19 (`external_controller` field name,
 * http 204 on success). One immediate retry covers a transient socket error
 * during a child restart.
 */
export function putSelector(apiPort: number, selectorTag: string, outboundTag: string): Promise<void> {
  const once = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify({ name: outboundTag })
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: apiPort,
          path: `/proxies/${encodeURIComponent(selectorTag)}`,
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
          timeout: 2_000,
        },
        (res) => {
          res.resume()
          const code = res.statusCode ?? 0
          if (code === 204 || code === 200) resolve()
          else reject(new Error(`clash API PUT ${selectorTag} -> HTTP ${code}`))
        },
      )
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error(`clash API PUT ${selectorTag} timeout`)))
      req.end(payload)
    })
  return once().catch(() => once())
}

export class LanePool {
  #lanes: Lane[] = []
  #apiPort = 0
  #outTags = new Map<string, string>()
  #active = false
  /** Monotonic generation: every configure/reset bumps it, so a binding
   *  issued after a respawn can never carry an epoch the dispatcher's
   *  per-lane agent cache (port+epoch) has already seen. */
  #generation = 0
  #waiters: Array<() => void> = []
  #switch: (apiPort: number, selectorTag: string, outboundTag: string) => Promise<void>
  #timeoutMs: number
  #logger?: { warn(message: string): void }

  constructor(options: LanePoolOptions = {}) {
    this.#switch = options.switchOutbound ?? putSelector
    this.#timeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
    this.#logger = options.logger
  }

  /** Rebind the table after the config was regenerated and the child
   *  restarted: old bindings died with the child (epoch bump invalidates
   *  every cached agent). Called only on a real respawn — the sameNodes
   *  idempotent reload path must NOT clear live bindings. */
  configure(next: LaneConfigure): void {
    this.#generation += 1
    this.#lanes = next.lanePorts.map((port) => ({
      port,
      node: null,
      epoch: this.#generation,
      inFlight: 0,
      lastUsed: 0,
      switching: null,
    }))
    this.#apiPort = next.apiPort
    this.#outTags = new Map(next.outTags)
    this.#active = true
    this.#wake()
  }

  /** Child stopped (disable / idle sweep / respawn): bindings are void. */
  reset(): void {
    this.#generation += 1
    for (const lane of this.#lanes) {
      lane.node = null
      lane.epoch = this.#generation
      lane.inFlight = 0
      lane.switching = null
    }
    this.#apiPort = 0
    this.#outTags.clear()
    this.#active = false
    this.#wake()
  }

  /** Lane count / ports for diagnostics (status bridge). */
  info(): { count: number; ports: number[]; apiPort: number } {
    return { count: this.#lanes.length, ports: this.#lanes.map((l) => l.port), apiPort: this.#apiPort }
  }

  /** Synchronous fast path: the node already owns a lane. Acquires a
   *  reference (inFlight++) so the dispatcher hot path stays IO-free. */
  tryAcquire(nodeKey: string): LaneBinding | null {
    if (!this.#active) return null
    const lane = this.#lanes.find((l) => l.node === nodeKey && l.switching === null)
    if (lane === undefined) return null
    lane.inFlight += 1
    lane.lastUsed = Date.now()
    return this.#binding(lane)
  }

  /** Full acquisition: bind the node to a lane (clash PUT) if needed.
   *  - free (never-bound) lanes first, then the least-recently-used idle one;
   *  - all lanes busy: wait for a release (FIFO wake), bounded by timeout;
   *  - returns null when the node is not in the config, the API switch
   *    fails, or no lane frees in time (dispatcher falls back to direct —
   *    never fail closed, 3.3). */
  async acquire(nodeKey: string): Promise<LaneBinding | null> {
    if (!this.#active) return null
    const deadline = Date.now() + this.#timeoutMs
    for (;;) {
      const fast = this.tryAcquire(nodeKey)
      if (fast !== null) return fast
      if (!this.#active) return null
      const idle = this.#lanes.filter((l) => l.inFlight === 0 && l.switching === null)
      const target = idle.find((l) => l.node === null) ?? [...idle].sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (target !== undefined) {
        const outTag = this.#outTags.get(nodeKey)
        if (outTag === undefined) return null
        const index = this.#lanes.indexOf(target)
        const switching = this.#switch(this.#apiPort, selectorTagOf(index), outTag).then(
          () => true,
          (err: unknown) => {
            this.#logger?.warn(
              `opencode2dsh: lane ${index} switch to ${outTag} failed (${err instanceof Error ? err.message : String(err)})`,
            )
            return false
          },
        )
        target.switching = switching.then(() => undefined, () => undefined)
        const ok = await switching
        target.switching = null
        if (!ok) return null
        if (!this.#active || !this.#lanes.includes(target)) return null
        target.node = nodeKey
        // A rebind points the lane at a different node: move the epoch even
        // within one generation so the dispatcher rebuilds its lane agent
        // instead of reusing pooled connections dialed through the old node.
        target.epoch += 1
        target.lastUsed = Date.now()
        target.inFlight = 1
        return this.#binding(target)
      }
      const now = Date.now()
      if (now >= deadline) return null
      await this.#waitForRelease(Math.min(deadline - now, this.#timeoutMs))
    }
  }

  /** Return a lane reference (call once per acquired binding). */
  release(port: number): void {
    const lane = this.#lanes.find((l) => l.port === port)
    if (lane === undefined) return
    lane.inFlight = Math.max(0, lane.inFlight - 1)
    lane.lastUsed = Date.now()
    this.#wake()
  }

  /** Holders on a lane (dispatcher agent-cache eviction guard / tests). */
  inFlight(port: number): number {
    return this.#lanes.find((l) => l.port === port)?.inFlight ?? 0
  }

  #binding(lane: Lane): LaneBinding {
    return { port: lane.port, epoch: lane.epoch, release: () => this.release(lane.port) }
  }

  #waitForRelease(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        const index = this.#waiters.indexOf(done)
        if (index >= 0) this.#waiters.splice(index, 1)
        resolve()
      }
      const timer = setTimeout(done, ms)
      timer.unref?.()
      this.#waiters.push(done)
    })
  }

  #wake(): void {
    const waiters = this.#waiters
    this.#waiters = []
    for (const waiter of waiters) waiter()
  }
}
