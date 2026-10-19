import { defineApp } from "convex/server";
import batchWorker from "@convex-dev/batch-worker/convex.config.js";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import staticHosting from "@convex-dev/static-hosting/convex.config.js";
import workpool from "@convex-dev/workpool/convex.config.js";

// The static-hosting component owns `/` and serves the built demo UI; any app
// HTTP routes would move under `/api`. This is its fastest serving mode.
const app = defineApp({ httpPrefix: "/api" });
app.use(batchWorker);
// Shared by the per-user workers in pooled.ts.
app.use(workpool);
// Isolated from example workloads while comparing execution cadence.
app.use(workpool, { name: "benchmarkPool" });
// Used by the rate-limited worker example in rateLimited.ts.
app.use(rateLimiter);
// Serves the Vite app in example/src — see `npm run deploy`.
app.use(staticHosting, { httpPrefix: "/" });

export default app;
