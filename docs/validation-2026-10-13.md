# Issue / PR review and validation — 2026-10-13

Integrated PRs #61 and #64, preserving their commits and resolving the overlapping URL-reading changes with the shared resolver from #64. Fixed #59's catalog publication race. For #62, corrected the misleading error classification; upstream free-tier access restrictions still apply.

## Review findings addressed

- Subscription URL resolution handles schema-injected empty legacy arrays and preserves legacy profiles. Host and browser use the same resolver.
- Subscription UA normalization and its default now live in a dependency-free module shared by host and browser.
- HTTP 200 action failures previously vanished in the card. The client now checks the JSON result and displays refusals and refresh failures.
- Manual refresh previously returned old state during an active round. Callers now await one shared round, with `subscription.running` available through status.
- Clearing URLs or disabling the pool previously retained a live fetcher. It now stops, aborts its pull and suppresses subsequent admission work after disposal.
- Catalog changes atomically replace the existing host registration, preserving one provider while emitting `llm/adapters-updated`. Unchanged rosters do not emit duplicate updates; capability changes do. Late callbacks after disposal cannot republish.
- Failed cold catalog fetches advertise no models and report `error`. Failed refreshes retain a known roster and report `stale`.
- `FreeTierError` is classified as non-retryable `FREE_TIER_RESTRICTED`, preserving the upstream explanation. Authentication failures retain `AUTH`.

## Validation

Environment: Windows, Node 24.12.0, installed DSH 0.2.0-rc.2.

| Check | Result |
| --- | --- |
| TypeScript `tsc --noEmit` | Passed |
| All Node tests | 291 passed, 0 failed |
| Host and client builds | Passed |
| `pnpm pack` including prepack | Passed |
| Extracted npm tarball loaded in real Cordis / DSH | Passed |
| Real host module loader and client slots | Passed |
| Actual host registry update after the real 4-second warm deadline | Passed; late `space-bunny-free` appears with one provider |
| Schema → volatile save → runtime → HTTP subscription → parser → status | Passed |
| Client action → HTTP bridge → subscription refresh | Passed; updated UA and running/result state |
| HTTP 502, no URL, disabled pool | Failures propagated to client |
| URL clearing / fiber disposal | Pulls stopped; bridge routes removed |
| Public Zen and models.dev directory GETs | Passed; 84 public ids, 8 exposed, including `space-bunny-free` |

Repeat the local HTTP and host checks with:

```powershell
node scripts/smoke-issues.mjs <installed-dsh-directory> [extracted-package-directory]
node scripts/smoke-dsh-compat.mjs <installed-dsh-directory>
node scripts/smoke-public-catalog.mjs
```

The subscription test uses a real local HTTP server and the actual packaged plugin. External catalog requests use plain public GETs without client disguise or session credentials. No paid subscription account, sing-box conversion, browser click automation, or upstream inference request was exercised. Existing unit tests cover conversion and stream-event translation. The test does not establish that an upstream restricted inference route is available; #62 remains open for that reason. No npm release was published.
