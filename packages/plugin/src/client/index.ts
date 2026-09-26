/**
 * opencode2dsh — browser half. Registers the IP 池 page on the Plugins page
 * (设置 → 插件) through the `plugins.item` slot, which
 * @deepseek-ai/dsh-client-ui-plugin-manager owns, while the Host serves this
 * plugin's entry settings.
 *
 * DSH 0.1.7 moved the card: the Plugins page now owns the card chrome, the
 * one-liner and the save control, and hands the page a `ConfigPageForm`
 * (`{ state, mutate }`) for the served entry. So this half only
 *  - registers the entry's one-liner and page, and
 *  - registers while the Host serves the namespace, so a deployment that
 *    serves no `opencode2dsh` settings shows no trace of the card.
 *
 * The editable section is the `ipPool` volatile node, so the served form's
 * value is `{ ipPool: ... }` and every write path is `['ipPool', <field>]`.
 *
 * Export discipline: cross-plugin collaboration goes through cordis services
 * (`slots`, `locale`, `configForms`); the bundle purity gate forbids value
 * imports of other @deepseek-ai packages (type-only imports are erased).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge (whileServed / served entries).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.slots Context merge, which the renderer plugin declares
// (SlotRegistry: register / inject the list entry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' list entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { IpPoolCard } from './IpPoolCard.tsx'
import type { IpPoolKey } from './locales.ts'
import { en, zh } from './locales.ts'

export type { IpPoolCardProps, IpPoolSettingsValue } from './IpPoolCard.tsx'
export type { IpPoolKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The IP 池 page copy. */
    'settings.ip-pool': IpPoolKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.ip-pool'

/**
 * The Host settings entry this page edits: the Loader entry id, which is the
 * plugin name. The editable field inside it is `ipPool`.
 */
export const SETTINGS_NAMESPACE = 'opencode2dsh'

/** Where this page sorts among the Plugins page's official entries. */
const ORDER = 20

/**
 * Required services (cordis fiber inject).
 *
 * `configForms` carries `whileServed`, the 0.1.7 way to mount a page only while
 * the Host serves its namespace. `settingsScope` and the old
 * `settings.plugin.item` slot are gone.
 */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the IP 池 page whenever the Host serves this entry's settings.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'opencode2dsh: copy dictionaries')
  ctx.effect(
    () => ctx.configForms.whileServed(
      [SETTINGS_NAMESPACE],
      () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
        name: 'plugins.item',
        id: SETTINGS_NAMESPACE,
        order: ORDER,
        label: () => t('title'),
        locale: NS,
      }, IpPoolCard)),
    ),
    'opencode2dsh: settings page',
  )
}
