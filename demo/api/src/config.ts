/**
 * Runtime configuration for the proxy Lambda.
 *
 * The Gloo API key is never a Terraform variable and never a plaintext
 * Lambda environment variable. Terraform creates an empty Secrets Manager
 * secret and grants this function `GetSecretValue` on that ARN alone; a
 * human populates the value out of band. The key is fetched once per
 * execution environment and held in module scope.
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

export type Config = {
  tableName: string;
  glooApiKeySecretId: string;
  /**
   * Shared value CloudFront injects as a custom origin header. The Function
   * URL itself is public (auth type NONE, so that response streaming works
   * without SigV4 body signing), so the function rejects anything that did
   * not arrive through our distribution.
   */
  originSecret: string;
};

export function loadConfig(): Config {
  return {
    tableName: requireEnv("DEMO_TABLE_NAME"),
    glooApiKeySecretId: requireEnv("GLOO_API_KEY_SECRET_ID"),
    originSecret: requireEnv("ORIGIN_SECRET"),
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
