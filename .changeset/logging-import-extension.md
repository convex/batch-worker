---
"@convex-dev/batch-worker": patch
---

Import `./logging.js` with its extension in the component config, so Node can
load `@convex-dev/batch-worker/convex.config.js` without a bundler.
