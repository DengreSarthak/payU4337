import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    isolate: true,
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
