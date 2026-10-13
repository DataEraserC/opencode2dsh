/** Shared by the host and browser; keep this module free of parser dependencies. */
export const DEFAULT_SUBSCRIPTION_USER_AGENT = 'clash-verge/v2.0'

export function normalizeSubscriptionUserAgent(value: string | undefined): string {
  return value?.trim() || DEFAULT_SUBSCRIPTION_USER_AGENT
}
