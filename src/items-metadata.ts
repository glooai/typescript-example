import { config as loadEnv } from "dotenv";
import { createWriteStream, WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCredentials, getAccessToken } from "./auth.js";
import { getItems, loadPublisherId } from "./items.js";

const ITEM_METADATA_BASE_URL = "https://platform.ai.gloo.com/engine/v2/items";

export type CollectionMembership = {
  type: string;
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type ItemMetadata = {
  item_id: string;
  status: string;
  updated_at: string;
  etag: string;
  restore_by: string;
  item_title: string;
  item_subtitle: string;
  filename: string;
  publication_date: string;
  type: string;
  item_image: string;
  item_url: string;
  item_file: string;
  item_summary: string;
  item_number: string;
  item_extra: string;
  isbn: string;
  author: string[];
  item_tags: string[];
  evergreen: boolean;
  visible_in_search: boolean;
  visible_in_chat: boolean;
  collection_memberships: CollectionMembership[];
};

export async function getItemMetadata(
  accessToken: string,
  itemId: string
): Promise<ItemMetadata | null> {
  const url = `${ITEM_METADATA_BASE_URL}/${itemId}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Item metadata request failed with status ${response.status}: ${text}`
    );
  }

  return (await response.json()) as ItemMetadata;
}

export async function* fetchAllMetadata(
  accessToken: string,
  publisherId: string
): AsyncGenerator<{ metadata: ItemMetadata; index: number; total: number }> {
  const items = await getItems(accessToken, publisherId);
  const total = items.length;

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const metadata = await getItemMetadata(accessToken, item.item_id);

    if (metadata === null) {
      console.warn(
        `Warning: Item ${item.item_id} not found (may have been deleted), skipping...`
      );
      continue;
    }

    yield { metadata, index, total };
  }
}

function writeToStream(stream: WriteStream, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const canContinue = stream.write(data);
    if (canContinue) {
      resolve();
    } else {
      stream.once("drain", resolve);
      stream.once("error", reject);
    }
  });
}

export async function streamMetadataToFile(
  generator: AsyncGenerator<{
    metadata: ItemMetadata;
    index: number;
    total: number;
  }>,
  outputPath: string
): Promise<number> {
  const stream = createWriteStream(outputPath);
  let count = 0;
  let isFirst = true;

  await writeToStream(stream, "[\n");

  for await (const { metadata, index, total } of generator) {
    console.log(
      `[${index + 1}/${total}] ${metadata.item_title || metadata.item_id}`
    );

    const prefix = isFirst ? "  " : ",\n  ";
    const json = JSON.stringify(metadata, null, 2).replace(/\n/g, "\n  ");
    await writeToStream(stream, prefix + json);

    isFirst = false;
    count++;
  }

  await writeToStream(stream, "\n]\n");

  return new Promise((resolve, reject) => {
    stream.end(() => resolve(count));
    stream.once("error", reject);
  });
}

export async function runItemsMetadataExample(): Promise<void> {
  const credentials = loadCredentials();
  const publisherId = loadPublisherId();
  const tokenResponse = await getAccessToken(credentials);
  const accessToken = tokenResponse.access_token;

  if (!accessToken) {
    throw new Error("Access token missing from token response.");
  }

  console.log(`Fetching items for publisher "${publisherId}"...`);

  const outputDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "output"
  );
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, "items-metadata.json");

  console.log("Fetching metadata...");

  const generator = fetchAllMetadata(accessToken, publisherId);
  const count = await streamMetadataToFile(generator, outputPath);

  console.log(`\nSaved ${count} metadata records to ${outputPath}`);
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  loadEnv({ path: ".env.local" });

  runItemsMetadataExample().catch((error) => {
    console.error("Error fetching items metadata:", error);
    process.exitCode = 1;
  });
}
