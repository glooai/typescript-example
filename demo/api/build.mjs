/**
 * Bundle the API service into a single ESM file for the container image.
 *
 * Bundling rather than shipping node_modules keeps the runtime image to a
 * base image plus one file, so the Dockerfile needs no production install
 * stage and the deployed artifact does not shift when a transitive
 * dependency republishes.
 */
import { build } from "esbuild";
import { rm } from "node:fs/promises";

const outdir = "dist/server";

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: `${outdir}/index.mjs`,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: true,
  sourcemap: false,
  // The AWS SDK reaches for `require` in a few CommonJS interop paths that
  // survive bundling to ESM; this gives them one.
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});

console.log(`built ${outdir}/index.mjs`);
