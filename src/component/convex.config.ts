import { defineComponent } from "convex/server";
import { logLevel } from "./logging.js";
import { v } from "convex/values";

export default defineComponent("batchWorker", {
  env: {
    LOG_LEVEL: v.optional(logLevel),
  },
});
