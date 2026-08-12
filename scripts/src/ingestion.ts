import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { loadApiKey, loadPublisherId, withTimeout } from "./auth.js";

export { loadPublisherId };

const INGESTION_URL = "https://platform.ai.gloo.com/ingestion/v2/files";

export type IngestionResponse = {
  success: boolean;
  message: string;
  ingesting: string[];
  duplicates: string[];
};

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
    const blob = new Blob([file.content], { type: "text/plain" });
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

function logFileList(label: string, files: string[]): void {
  console.log(`  ${label} (${files.length}):`);
  if (files.length > 0) {
    for (const file of files) {
      console.log(`    - ${file}`);
    }
  } else {
    console.log("    (none)");
  }
}

async function main(): Promise<void> {
  const filePaths = process.argv.slice(2);

  if (filePaths.length === 0) {
    console.error("Usage: pnpm glooai:ingest <file1> [file2] [file3] ...");
    console.error("Example: pnpm glooai:ingest ./test-files/sample1.txt");
    process.exitCode = 1;
    return;
  }

  const apiKey = loadApiKey();
  const publisherId = loadPublisherId();

  console.log("Gloo AI Ingestion v2 - File Upload");
  console.log("==================================");
  console.log(`Publisher: ${publisherId}`);
  console.log();
  console.log(`Uploading ${filePaths.length} file(s)...`);
  console.log();

  const result = await uploadFilesFromPaths(apiKey, publisherId, filePaths);

  console.log("Response:");
  console.log(`  Success: ${result.success}`);
  console.log(`  Message: ${result.message}`);
  console.log();
  logFileList("Ingesting", result.ingesting);
  console.log();
  logFileList("Duplicates", result.duplicates);
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  loadEnv({ path: ".env.local" });

  main().catch((error) => {
    console.error("Error during ingestion:", error);
    process.exitCode = 1;
  });
}
