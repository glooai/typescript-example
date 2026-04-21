import { config as loadEnv } from "dotenv";
import jwt from "jsonwebtoken";
import { loadCredentials, getAccessToken } from "./auth.js";

// Org UUID the current credentials are expected to resolve to. Set via env
// or edit locally when you need to verify a specific tenant — the default
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

async function runJwtCheck(): Promise<void> {
  console.log("=== JWT Token Validation ===\n");

  const credentials = loadCredentials();
  console.log("Credentials:");
  console.log(`  Client ID: ${credentials.clientId}\n`);

  const tokenResponse = await getAccessToken(credentials);
  const accessToken = tokenResponse.access_token;

  if (!accessToken) {
    throw new Error("Access token missing from token response.");
  }

  const decoded = jwt.decode(accessToken) as JwtPayload | null;

  if (!decoded) {
    throw new Error("Failed to decode JWT token.");
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

runJwtCheck().catch((error) => {
  console.error("Error validating JWT:", error);
  process.exitCode = 1;
});
