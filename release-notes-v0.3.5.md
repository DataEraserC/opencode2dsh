0.3.5 restores plugin startup on DSH 0.1.7 and 0.2, including desktop profiles. IP-pool settings use the current plugin page and apply live; saving inherited values, read-only forms and older subscription URLs are handled correctly.

Muse Spark 1.3 works with default and explicit reasoning settings. Responses requests and assistant history use the correct wire format. The missing imageRequestPricing method no longer breaks /compact. Models use their declared context and output budgets rather than one flat window.

Verified MiMo v2.6 models can accept images from the harness attachment store. Offloaded attachments are not reloaded; unreadable attachments become text placeholders.

Validation: frozen-lockfile install with supply-chain checks, TypeScript check, server/client builds, 218 passing plugin tests, and scripts/smoke-dsh-compat.mjs against installed DSH 0.2.0-rc.2. The smoke script loads the actual artifacts with the host module loader, Cordis and SlotCore, and verifies server/client activation plus pool update/disposal. Browser services and external transport are stubbed there. Live Muse Spark 1.3 probes with default and minimal reasoning both returned OK. A synthetic red PNG sent through the MiMo v2.6 image route returned Red. The 0.1.7 list slot is also checked with its actual SlotCore package.

Integrated contributor PRs #14, #18, #22 and #23 keep their original authored commits. Existing acknowledgments are unchanged.
