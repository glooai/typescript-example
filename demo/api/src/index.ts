/**
 * Container entrypoint.
 *
 * Everything the process needs is resolved once, before the listener opens:
 * the environment variables the ECS task definition sets, the DynamoDB
 * client, and the Gloo API key from Secrets Manager (via the task role, not
 * a Lambda execution role). A missing variable or an unpopulated secret
 * exits non-zero rather than starting a server that would 500 every request,
 * which lets ECS surface the failure as a task that will not stay up.
 */
import { createGlooClient } from "./gloo.js";
import { loadConfig, loadGlooApiKey } from "./config.js";
import { createServer } from "./server.js";
import { createStore } from "./store.js";

/** ECS gives a stopping task 30s by default; finish in-flight streams inside it. */
const SHUTDOWN_GRACE_MS = 20_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer({
    config,
    store: createStore(config.tableName),
    gloo: createGlooClient({
      apiKey: await loadGlooApiKey(config.glooApiKeySecretId),
    }),
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port, "0.0.0.0", resolve);
  });
  console.log(`demo api listening on ${config.port}`);

  // ECS sends SIGTERM, waits, then SIGKILLs. Closing the listener stops new
  // connections while in-flight chat streams finish, so a deploy does not
  // truncate someone's completion mid-token.
  const stop = (signal: string): void => {
    console.log(`${signal} received, draining`);
    const timer = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
    timer.unref();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "startup failed");
  process.exit(1);
});
