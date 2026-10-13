export type BridgeAction = { scope: 'all' | 'refill' | 'subscriptions' } | { scope: 'exit'; exitId: string }

/** HTTP 200 can carry a refused action; surface both transport and application errors. */
export async function postBridgeAction(body: BridgeAction): Promise<void> {
  const response = await fetch('/api/opencode2dsh/ip-pool/probe', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const result = await response.json() as { ok?: boolean; message?: string; error?: string }
  if (!response.ok || result.ok !== true) {
    throw new Error(result.message || result.error || `HTTP ${response.status}`)
  }
}
