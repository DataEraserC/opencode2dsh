0.3.5 restores plugin startup on DSH 0.1.7 and 0.2, including desktop profiles. IP-pool settings use the current plugin page and apply live; saving inherited values, read-only forms and older subscription URLs are handled correctly.

Muse Spark 1.3 uses the correct Responses wire format for default and explicit reasoning settings and assistant history. A regional 403 is surfaced as REGION_BLOCKED with the original explanation, rather than DSH's misleading invalid-key message; this does not remove upstream regional restrictions. The missing imageRequestPricing method no longer breaks /compact. Models use their declared context and output budgets rather than one flat window.

Verified MiMo v2.6 models can accept images from the harness attachment store. Offloaded attachments are not reloaded; unreadable attachments become text placeholders.

Validation: frozen-lockfile install with supply-chain checks, TypeScript check, server/client builds and 220 passing plugin tests. scripts/smoke-dsh-compat.mjs checks the actual artifacts with DSH 0.2.0-rc.2's module loader, Cordis and SlotCore; its browser services and external transport are stubbed. The 0.1.7 list slot is also checked with its actual SlotCore package. The local tarball was additionally installed into a real DSH 0.2.0-rc.2 web profile and tested with Chromium: normal browser boot, plugin Running, configuration saves persisting after reload and restoring the original value, and MiMo v2.6 direct text/image replies. Muse Spark 1.3 on this network returns an upstream regional 403; the browser now displays REGION_BLOCKED and that explanation.

Integrated contributor PRs #14, #18, #22 and #23 keep their original authored commits. Existing acknowledgments are unchanged.
