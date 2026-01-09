import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { loadCredentials, getAccessToken } from "./index.js";

const SEARCH_URL = "https://platform.ai.gloo.com/ai/data/v1/search";
const COLLECTION = "GlooProd";
const DEFAULT_CERTAINTY = 0.5;

type SearchResultProperties = {
  title?: string;
  snippet?: string;
  url?: string;
  primary_url?: string;
  published_date?: string;
  publisher?: string;
};

type SearchResult = {
  uuid: string;
  metadata: {
    certainty: number;
    score: number;
  };
  properties: SearchResultProperties;
};

type SearchResponse = {
  data: SearchResult[];
  intent: number;
};

export async function search(
  accessToken: string,
  query: string,
  tenant: string,
  limit?: number
): Promise<SearchResponse> {
  const payload: Record<string, unknown> = {
    query,
    collection: COLLECTION,
    tenant,
    certainty: DEFAULT_CERTAINTY,
  };

  if (typeof limit === "number" && limit > 0) {
    payload.limit = limit;
  }

  const response = await fetch(SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Search request failed with status ${response.status}: ${text}`
    );
  }

  return (await response.json()) as SearchResponse;
}

export async function runSearchExample(
  query = "leadership",
  tenant = "CareyNieuwhof"
): Promise<void> {
  const credentials = loadCredentials();
  const tokenResponse = await getAccessToken(credentials);
  const accessToken = tokenResponse.access_token;

  if (!accessToken) {
    throw new Error("Access token missing from token response.");
  }

  console.log(`Searching for "${query}" in tenant "${tenant}"...`);

  const results = await search(accessToken, query, tenant, 5);

  console.log(
    `Found ${results.data.length} results (intent: ${results.intent})`
  );
  console.log(JSON.stringify(results, null, 2));
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  loadEnv({ path: ".env.local" });

  const query = process.argv[2] || "leadership";
  const tenant = process.argv[3] || "CareyNieuwhof";

  runSearchExample(query, tenant).catch((error) => {
    console.error("Error running search example:", error);
    process.exitCode = 1;
  });
}
