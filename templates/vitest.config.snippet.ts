/**
 * Reference Vitest config — copy to your plugin root as `vitest.config.ts`.
 * Requires `src/test-harness/setup.ts` and devDeps: vitest, jsdom, @testing-library/react.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-harness/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: false,
  },
});
