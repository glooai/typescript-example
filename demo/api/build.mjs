/**
 * Bundle the Lambda handler into a single ESM file that Terraform zips.
 *
 * Dependencies are bundled rather than left to the runtime's built-in AWS
 * SDK so the deployed artifact is reproducible and does not shift when AWS
 * updates the managed runtime's SDK version.
 */
import { build } from "esbuild";
import { rm } from "node:fs/promises";

const outdir = "dist/lambda";

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/handler.ts"],
  outfile: `${outdir}/index.mjs`,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: true,
  sourcemap: false,
  // `awslambda` is injected by the Lambda runtime, not importable.
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});

console.log(`built ${outdir}/index.mjs`);
