import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Static SPA build. Output is uploaded verbatim to S3 and served through
 * CloudFront, so there is no server runtime and no bundler-time secret.
 *
 * In development `/api/*` is proxied to whatever `DEMO_API_URL` points at
 * (a deployed Lambda Function URL), which keeps the local app on the same
 * relative paths it uses in production.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    proxy: process.env.DEMO_API_URL
      ? {
          "/api": {
            target: process.env.DEMO_API_URL,
            changeOrigin: true,
            headers: process.env.DEMO_ORIGIN_SECRET
              ? { "x-demo-origin": process.env.DEMO_ORIGIN_SECRET }
              : undefined,
          },
        }
      : undefined,
  },
});
