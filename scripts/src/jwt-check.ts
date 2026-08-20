import { config as loadEnv } from "dotenv";
import jwt from "jsonwebtoken";
import { loadApiKey } from "./auth.js";

// Org UUID the current credentials are expected to resolve to. Set via env
// or edit locally when you need to verify a specific tenant; the default
// here is a placeholder so this file doesn't bake a production identifier
// into the repo.
const EXPECTED_ORG_ID =
  process.env.EXPECTED_ORG_ID ?? "00000000-0000-0000-0000-000000000000";

type JwtPayload = {
  client_id?: string;
  sub?: string;
  exp?: number;
  iat?: number;
  scope?: string;
  [key: string]: unknown;
};

function formatTimestamp(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return date.toISOString();
}

function formatTimeRemaining(epochSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const remaining = epochSeconds - now;

  if (remaining <= 0) {
    return "EXPIRED";
  }

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  if (minutes > 0) {
    return `valid for ${minutes} minute${minutes !== 1 ? "s" : ""}`;
  }
  return `valid for ${seconds} second${seconds !== 1 ? "s" : ""}`;
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return "*".repeat(apiKey.length);
  return `${apiKey.slice(0, 4)}${"*".repeat(apiKey.length - 8)}${apiKey.slice(-4)}`;
}

async function runKeyCheck(): Promise<void> {
  console.log("=== Gloo AI API Key Inspection ===\n");

  const apiKey = loadApiKey();
  console.log(`API key: ${maskApiKey(apiKey)} (${apiKey.length} chars)\n`);

  // WorkOS API keys are opaque bearer credentials, not JWTs, so there are
  // no claims to decode. Report that plainly instead of failing.
  const decoded = jwt.decode(apiKey) as JwtPayload | null;
  if (!decoded) {
    console.log(
      "This key does not decode as a JWT (expected: WorkOS API keys are opaque)."
    );
    return;
  }

  console.log("Token Claims:");
  console.log(`  client_id: ${decoded.client_id ?? "(not present)"}`);
  console.log(`  sub: ${decoded.sub ?? "(not present)"}`);

  if (decoded.exp) {
    console.log(
      `  exp: ${formatTimestamp(decoded.exp)} (${formatTimeRemaining(decoded.exp)})`
    );
  }

  if (decoded.iat) {
    console.log(`  iat: ${formatTimestamp(decoded.iat)}`);
  }

  if (decoded.scope) {
    console.log(`  scope: ${decoded.scope}`);
  }

  // Display any other claims
  const standardClaims = new Set([
    "client_id",
    "sub",
    "exp",
    "iat",
    "scope",
    "iss",
    "aud",
    "jti",
  ]);
  for (const [key, value] of Object.entries(decoded)) {
    if (!standardClaims.has(key)) {
      console.log(`  ${key}: ${JSON.stringify(value)}`);
    }
  }

  // Organization ID validation
  const orgId = decoded.org_id as string | undefined;

  console.log("\nOrganization Check:");
  console.log(`  org_id: ${orgId ?? "(not present)"}`);

  if (orgId === EXPECTED_ORG_ID) {
    console.log("  ✓  org_id matches the expected organization.");
  } else {
    console.log(
      "  ⚠️  WARNING: org_id does not match the expected organization!"
    );
    console.log(`  Expected: ${EXPECTED_ORG_ID}`);
  }
}

loadEnv({ path: ".env.local" });

runKeyCheck().catch((error) => {
  console.error("Error inspecting API key:", error);
  process.exitCode = 1;
});
