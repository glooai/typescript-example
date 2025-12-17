import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const TOKEN_URL = "https://platform.ai.gloo.com/oauth2/token";
const INGESTION_URL = "https://api.gloo.ai/ingestion/v2/files";

export type IngestionCredentials = {
  clientId: string;
  clientSecret: string;
};

export type IngestionResponse = {
  success: boolean;
  message: string;
  ingesting: string[];
  duplicates: string[];
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable.`);
  }
  return value;
}

function withTimeout(initMs: number): {
  controller: AbortController;
  clearTimer: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), initMs);
  timeout.unref();

  return { controller, clearTimer: () => clearTimeout(timeout) };
}

export function loadIngestionCredentials(): IngestionCredentials {
  return {
    clientId: requireEnv("GLOO_CLIENT_ID"),
    clientSecret: requireEnv("GLOO_CLIENT_SECRET"),
  };
}

export function loadPublisherId(): string {
  return requireEnv("GLOO_PUBLISHER_ID");
}

export async function getIngestionToken(
  credentials: IngestionCredentials
): Promise<string> {
  const { clientId, clientSecret } = credentials;
  const encodedCredentials = Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`
  ).toString("base64");

  const { controller, clearTimer } = withTimeout(10_000);

  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${encodedCredentials}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "api/access",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Token request failed with status ${response.status}: ${text}`
      );
    }

    const data = (await response.json()) as { access_token?: string };
    if (!data.access_token) {
      throw new Error("Access token missing from token response.");
    }

    return data.access_token;
  } finally {
    clearTimer();
  }
}

export type FileInput = {
  name: string;
  content: Buffer | string;
};

export async function uploadFiles(
  token: string,
  publisherId: string,
  files: FileInput[]
): Promise<IngestionResponse> {
  const formData = new FormData();
  formData.append("publisher_id", publisherId);

  for (const file of files) {
    const blob = new Blob(
      [typeof file.content === "string" ? file.content : file.content],
      { type: "text/plain" }
    );
    formData.append("files", blob, file.name);
  }

  const { controller, clearTimer } = withTimeout(60_000);

  try {
    const response = await fetch(INGESTION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Upload failed with status ${response.status}: ${text}`);
    }

    return (await response.json()) as IngestionResponse;
  } finally {
    clearTimer();
  }
}

export async function uploadFilesFromPaths(
  token: string,
  publisherId: string,
  filePaths: string[]
): Promise<IngestionResponse> {
  const files: FileInput[] = await Promise.all(
    filePaths.map(async (filePath) => ({
      name: basename(filePath),
      content: await readFile(filePath),
    }))
  );

  return uploadFiles(token, publisherId, files);
}

async function main(): Promise<void> {
  const filePaths = process.argv.slice(2);

  if (filePaths.length === 0) {
    console.error("Usage: pnpm glooai:ingest <file1> [file2] [file3] ...");
    console.error("Example: pnpm glooai:ingest ./test-files/sample1.txt");
    process.exitCode = 1;
    return;
  }

  const credentials = loadIngestionCredentials();
  const publisherId = loadPublisherId();

  console.log("Gloo AI Ingestion v2 - File Upload");
  console.log("==================================");
  console.log(`Publisher: ${publisherId}`);
  console.log();
  console.log(`Uploading ${filePaths.length} file(s)...`);
  console.log();

  const token = await getIngestionToken(credentials);
  const result = await uploadFilesFromPaths(token, publisherId, filePaths);

  console.log("Response:");
  console.log(`  Success: ${result.success}`);
  console.log(`  Message: ${result.message}`);
  console.log();
  console.log(`  Ingesting (${result.ingesting.length}):`);
  if (result.ingesting.length > 0) {
    for (const file of result.ingesting) {
      console.log(`    - ${file}`);
    }
  } else {
    console.log("    (none)");
  }
  console.log();
  console.log(`  Duplicates (${result.duplicates.length}):`);
  if (result.duplicates.length > 0) {
    for (const file of result.duplicates) {
      console.log(`    - ${file}`);
    }
  } else {
    console.log("    (none)");
  }
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  loadEnv({ path: ".env.local" });

  main().catch((error) => {
    console.error("Error during ingestion:", error);
    process.exitCode = 1;
  });
}
