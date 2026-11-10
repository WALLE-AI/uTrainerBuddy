# Historical OpenResearch desktop gateway

This gateway is retained only for the explicitly selected `verify-research-window.mjs --legacy` historical test. It is outside production `src` and is not imported by the main process or preload. The former main-app harness describes the retired integration and is no longer executable through that test command.

The product research entry opens the existing project workbench. Use `verify-research-entry.mjs` to verify its renderer behavior and `verify-research-window.mjs --main-app` for the replacement production smoke. The native build must not expose the old IPC or include this gateway. No existing research data is deleted or migrated by this retirement.
