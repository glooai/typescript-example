/**
 * Runtime configuration for the proxy service.
 *
 * The Gloo API key is never a Terraform variable and never a plaintext
 * container environment variable. Terraform creates an empty Secrets Manager
 * secret and grants the ECS task role `GetSecretValue` on that ARN alone; a
 * human populates the value out of band. The key is fetched once at startup
 * and held in module scope.
 */
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable`);
  }
  return value;
}

/**
 * Matches the port the ALB target group forwards to, which follows the
 * convention already set by the `genesis` service on this cluster.
 */
const DEFAULT_PORT = 5174;

export type Config = {
  tableName: string;
  glooApiKeySecretId: string;
  port: number;
  /**
   * Shared value CloudFront injects as a custom origin header. This service
   * sits behind a shared internet-facing ALB with no origin-access-control
   * equivalent, so the header is what tells traffic that came through our
   * distribution apart from anyone who finds the origin hostname.
   */
  originSecret: string;
  /**
   * Salt for the client IP hash written to the ledger. Terraform generates
   * one random value per deployment, so the hashes cannot be reversed with a
   * precomputed table and do not correlate across a rebuild. See
   * `visitor.ts` for why the address itself is not stored.
   */
  visitorSalt: string;
};

export function loadConfig(): Config {
  const port = Number.parseInt(process.env.PORT ?? "", 10);
  return {
    tableName: requireEnv("DEMO_TABLE_NAME"),
    glooApiKeySecretId: requireEnv("GLOO_API_KEY_SECRET_ID"),
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT,
    originSecret: requireEnv("ORIGIN_SECRET"),
    visitorSalt: requireEnv("VISITOR_SALT"),
  };
}

let cachedApiKey: string | null = null;

/**
 * Read the Gloo API key from Secrets Manager. Accepts either a raw string
 * secret or a JSON secret with a `GLOO_AI_API_KEY` key, so operators can
 * populate it either way.
 */
export async function loadGlooApiKey(
  secretId: string,
  client = new SecretsManagerClient({})
): Promise<string> {
  if (cachedApiKey) {
    return cachedApiKey;
  }

  const result = await client.send(
    new GetSecretValueCommand({ SecretId: secretId })
  );
  const raw = result.SecretString;
  if (!raw) {
    throw new Error(`Secret ${secretId} has no string value`);
  }

  let key = raw.trim();
  if (key.startsWith("{")) {
    const parsed = JSON.parse(key) as Record<string, unknown>;
    const fromJson = parsed.GLOO_AI_API_KEY;
    if (typeof fromJson !== "string" || fromJson.length === 0) {
      throw new Error(`Secret ${secretId} is JSON without a GLOO_AI_API_KEY`);
    }
    key = fromJson;
  }

  cachedApiKey = key;
  return key;
}
