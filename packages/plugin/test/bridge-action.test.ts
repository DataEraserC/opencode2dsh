import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { postBridgeAction } from '../src/client/bridge-action.ts'

test('the subscription action reports application refusal even with HTTP 200', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    assert.deepEqual(JSON.parse(init!.body as string), { scope: 'subscriptions' })
    return Response.json({ ok: false, code: 'no-subscriptions', message: 'no subscription URLs are configured' })
  })
  try {
    await assert.rejects(postBridgeAction({ scope: 'subscriptions' }), /no subscription URLs/)
  } finally { fetchMock.mock.restore() }
})

test('the action rejects HTTP failures and accepts a successful response', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }))
  try {
    await postBridgeAction({ scope: 'subscriptions' })
    fetchMock.mock.mockImplementation(async () => Response.json({ error: 'forbidden' }, { status: 403 }))
    await assert.rejects(postBridgeAction({ scope: 'subscriptions' }), /forbidden/)
  } finally { fetchMock.mock.restore() }
})
