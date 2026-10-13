import { createHash, randomBytes } from 'node:crypto'

/**
 * Port of agent/internal/ids (opencode2api ids.go, verbatim semantics):
 * stable session/project ids derived from the conversation's first user turn,
 * and a per-request random id. The upstream sees CLI-identical correlation
 * headers built from these (zen-adapter.ts).
 */

export interface RequestIDs {
  session: string
  request: string
  project: string
  parentSession: string
}

/** sha256("prefix\0value") truncated to 12 bytes: stable, non-reversible. */
export function stableID(prefix: string, value: string): string {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest()
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`
}

export function randomID(prefix: string, size: number): string {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

export function firstString(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/**
 * The conversation signal: JSON of the first user message's content. Using the
 * first user turn keeps a multi-turn conversation stable as its history grows
 * while separating conversations with different beginnings (ids.go:59-76).
 */
export function conversationSeed(messages: Array<{ role: string; content: unknown }>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0) return encoded
  }
  return ''
}

/**
 * Derive the correlation ids for one upstream request. In adapter mode there
 * are no inbound opencode headers, so the seed is the conversation itself.
 */
export function deriveRequestIDs(messages: Array<{ role: string; content: unknown }>): RequestIDs {
  let signal = conversationSeed(messages)
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16)
  return {
    session: canonicalSessionID(signal),
    request: randomID('req', 16),
    project: stableID('prj', 'opencode2dsh:default-project'),
    parentSession: '',
  }
}

/**
 * OpenCode's canonical session shape: "ses_" + 12 lowercase hex timestamp
 * characters + 14 Base62 characters. Since 2026-09-16 the Zen free tier
 * rejects any other session shape with 403 FreeTierError ("free tier can
 * only be used from within OpenCode") — the plain User-Agent gate stopped
 * being sufficient (upstream fix: jasonxu114514/opencode2api 8185202).
 * Live-probed 2026-09-18: the gate has a second, body-shape half (streaming
 * + bash/read tools, adapter/messages.ts); both must pass.
 *
 * Since 2026-10-13 the gate also DECODES the 12-hex time field, which turned
 * a digest-derived prefix into a 403 for every non-CLI client (issue #62);
 * see sessionTimeField below.
 */
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function base62Fixed(value: bigint, width: number): string {
  const base = 62n
  let n = value
  const out = new Array<string>(width)
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % base))
    n /= base
  }
  return out.join('')
}

/**
 * The 12-hex time field OpenCode puts in front of every `ses_` id: the low 48
 * bits of `~((Date.now() * 0x1000) + counter)`, big-endian
 * (packages/schema/src/identifier.ts create(), descending branch). The counter
 * disambiguates ids minted in the same millisecond and resets when the clock
 * moves, exactly as upstream.
 *
 * The field used to be sha256 digest bytes, which decode to an arbitrary point
 * in the 795-day 48-bit wrap — so the free-tier gate, which since 2026-10-13
 * validates that the field names a plausible instant, rejected nearly every
 * request with 403 FreeTierError (issue #62; same defect as
 * decolua/9router#4780).
 *
 * Memoized per conversation. OpenCode mints a session id once and keeps it for
 * the session's life, and our derived session must likewise not move between
 * turns or upstream loses prompt-cache affinity and per-session quota
 * continuity. Oldest-first eviction bounds the table; an evicted conversation
 * that returns simply mints a fresh id.
 */
const SESSION_TIME_CACHE_LIMIT = 1024
const sessionTimeFields = new Map<string, string>()
let lastMintMs = 0
let mintCounter = 0

function sessionTimeField(conversationKey: string): string {
  const cached = sessionTimeFields.get(conversationKey)
  if (cached !== undefined) return cached
  const timestamp = Date.now()
  if (timestamp !== lastMintMs) {
    lastMintMs = timestamp
    mintCounter = 0
  }
  mintCounter++
  const current = BigInt(timestamp) * 0x1000n + BigInt(mintCounter)
  const field = ((~current) & 0xffffffffffffn).toString(16).padStart(12, '0')
  if (sessionTimeFields.size >= SESSION_TIME_CACHE_LIMIT) {
    const oldest = sessionTimeFields.keys().next().value
    if (oldest !== undefined) sessionTimeFields.delete(oldest)
  }
  sessionTimeFields.set(conversationKey, field)
  return field
}

/**
 * The session id sent upstream. A signal that already carries an official
 * OpenCode session passes through unchanged (preserving upstream prompt-cache
 * affinity); any other identity — the conversation seed in adapter mode,
 * foreign client sessions, admission probes — is deterministically hashed
 * into the canonical shape, so the same conversation keeps a stable session.
 * The time field is minted from the clock (sessionTimeField), the random half
 * from the digest.
 */
export function canonicalSessionID(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal
  const sum = createHash('sha256').update('ses\x00' + signal).digest()
  const timePart = sessionTimeField(sum.toString('hex'))
  const randomPart = base62Fixed(BigInt('0x' + sum.subarray(6, 16).toString('hex')), 14)
  return `ses_${timePart}${randomPart}`
}

/** CLI-identical user agent (ids.go opencodeUserAgent, node runtime values). */
export function opencodeUserAgent(): string {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

/**
 * The full disguise header set sent with every upstream request
 * (design.md 2.4; gateway.go newUpstreamRequest:640-669).
 */
export function disguiseHeaders(ids: RequestIDs): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  }
}
