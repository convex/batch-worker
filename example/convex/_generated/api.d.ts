/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as aggregates from "../aggregates.js";
import type * as e2e from "../e2e.js";
import type * as example from "../example.js";
import type * as executionBenchmark from "../executionBenchmark.js";
import type * as pooled from "../pooled.js";
import type * as rateLimited from "../rateLimited.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  aggregates: typeof aggregates;
  e2e: typeof e2e;
  example: typeof example;
  executionBenchmark: typeof executionBenchmark;
  pooled: typeof pooled;
  rateLimited: typeof rateLimited;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  batchWorker: import("@convex-dev/batch-worker/_generated/component.js").ComponentApi<"batchWorker">;
  workpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"workpool">;
  benchmarkPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"benchmarkPool">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
