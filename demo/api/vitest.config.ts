import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // The server and its entrypoint are an I/O shell (sockets, DynamoDB,
      // fetch); the logic worth covering lives in the pure modules they call.
      exclude: [
        "src/server.ts",
        "src/index.ts",
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
