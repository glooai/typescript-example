import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // The handler is an I/O shell (Lambda streaming, DynamoDB, fetch);
      // the logic worth covering lives in the pure modules it calls.
      exclude: [
        "src/handler.ts",
        "src/aws.ts",
        "src/config.ts",
        "src/**/*.d.ts",
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
