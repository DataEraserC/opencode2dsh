/**
 * The ip-pool settings draft diff: which field writes land the form on the
 * served value. Pure logic with no JSX so tests can drive it directly —
 * this is where the "save button stays disabled" class of bug lives, because
 * the button's dirty state is `writes.length > 0`.
 */
import type { FormState, IpPoolSettingsValue } from './IpPoolCard.tsx'

/** One settings write landing the form on the served value. */
export interface FieldWrite { field: string; op: 'set'; value: unknown }

/** JSON deep-equal over the card's plain values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** CSV input → upper-case code list (blocked countries). */
export function splitCsv(line: string): string[] {
  return line.split(',').map((part) => part.trim().toUpperCase()).filter((part) => part.length > 0)
}

/**
 * Field writes landing the form on the served value, in write order.
 *
 * A field that differs from the served current is ALWAYS written — even when
 * the new value equals the composition base. The served section sits ABOVE
 * the base (volatile overlay), so "equal to base" is not "already applied":
 * skipping such writes made a revert unsavable, and since the pool's base
 * default is `enabled: false`, turning the switch OFF could never be saved
 * (the original "save button stays disabled after toggling off" bug — the
 * skip also contradicted its own comment about needing an explicit set).
 */
export function diffWrites(form: FormState, value: IpPoolSettingsValue): FieldWrite[] {
  const writes: FieldWrite[] = []
  const push = (field: string, next: unknown, current: unknown): void => {
    if (deepEqual(next, current)) return
    writes.push({ field, op: 'set', value: next })
  }
  push('enabled', form.enabled, value.enabled)
  push('free', { enabled: form.freeEnabled, targetSize: Number(form.targetSize), blockedCountries: splitCsv(form.blockedCountries) }, value.free)
  push('manual', form.manual, value.manual)
  push('subscription', { urls: form.subscriptionUrls, refreshMs: Number(form.refreshMs) }, value.subscription)
  push('singbox', { path: form.singboxPath, idleStopMs: Number(form.singboxIdleStopMs) }, value.singbox)
  push('pinnedExitId', form.pinnedExitId, value.pinnedExitId)
  push('pinnedStrict', form.pinnedStrict, value.pinnedStrict)
  push('probeModels', form.probeModels, value.probeModels)
  push('maxConcurrentProbes', Number(form.maxConcurrentProbes), value.maxConcurrentProbes)
  return writes
}
