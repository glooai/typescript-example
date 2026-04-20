import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        // Entry point — exercised by Cloud Run Job integration, not unit tests.
        "src/index.ts",
        // Pure static fixtures (constants only).
        "src/fixtures/**",
        // Pure type declarations.
        "src/probes/types.ts",
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
