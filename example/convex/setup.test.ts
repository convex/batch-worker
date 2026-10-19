/// <reference types="vite/client" />
import { test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema.js";
import component from "@convex-dev/batch-worker/test";
import rateLimiter from "@convex-dev/rate-limiter/test";
import workpool from "@convex-dev/workpool/test";

const modules = import.meta.glob("./**/*.*s");
// When users want to write tests that use your component, they need to
// explicitly register it with its schema and modules.
export function initConvexTest() {
  const t = convexTest(schema, modules);
  component.register(t);
  rateLimiter.register(t);
  workpool.register(t);
  return t;
}

test("setup", () => {});
