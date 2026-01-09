import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { loadCredentials, getAccessToken } from "./auth.js";

const ITEMS_BASE_URL = "https://platform.ai.gloo.com/engine/v2/publisher";

export type Item = {
  item_id: string;
  status: string;
  item_title: string;
  filename: string;
};

export type ItemsResponse = Item[];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable.`);
  }
  return value;
}

export function loadPublisherId(): string {
  return requireEnv("GLOO_PUBLISHER_ID");
}

export async function getItems(
  accessToken: string,
  publisherId: string
): Promise<ItemsResponse> {
  const url = `${ITEMS_BASE_URL}/${publisherId}/items`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Items request failed with status ${response.status}: ${text}`
    );
  }

  return (await response.json()) as ItemsResponse;
}

export async function runItemsExample(): Promise<void> {
  const credentials = loadCredentials();
  const publisherId = loadPublisherId();
  const tokenResponse = await getAccessToken(credentials);
  const accessToken = tokenResponse.access_token;

  if (!accessToken) {
    throw new Error("Access token missing from token response.");
  }

  console.log(`Fetching items for publisher "${publisherId}"...`);

  const items = await getItems(accessToken, publisherId);

  console.log(`Found ${items.length} item(s)`);
  console.log(JSON.stringify(items, null, 2));
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  loadEnv({ path: ".env.local" });

  runItemsExample().catch((error) => {
    console.error("Error fetching items:", error);
    process.exitCode = 1;
  });
}
