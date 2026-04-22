/**
 * Live fetcher for the authoritative V2 model registry.
 *
 * The canary's direct-model probe list is hydrated from
 *   GET https://platform.ai.gloo.com/platform/v2/models
 * at probe-run time. This is the same unauthenticated endpoint that
 * `TangoGroup/gloo#2049` wired the public Mintlify docs to, and it is
 * defined by the Gloo platform team as the single authoritative source of
 * truth for "what models are callable on V2 right now." Hydrating from it
 * (instead of a checked-in fixture list) means the canary can never drift
 * from the platform registry — retired models disappear from our probes
 * the same minute they disappear from the docs.
 *
 * If this endpoint is unreachable or returns a malformed body, we throw.
 * A canary that silently runs zero direct-model probes would be strictly
 * worse than a canary that fails loudly and surfaces the outage in Cloud
 * Run logs (which page ops).
 */
import { withTimeout } from "@glooai/scripts";
import { z } from "zod";

/**
 * Default endpoint. Overridable via the `modelsUrl` option — primarily so
 * tests can point at a stubbed URL without monkey-patching global fetch.
 */
export const DEFAULT_V2_MODELS_URL =
  "https://platform.ai.gloo.com/platform/v2/models";

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Every field the canary uses from the /platform/v2/models response. The
 * endpoint returns a lot more (pricing, context_window, modalities, speed
 * ratings, etc.) but we deliberately only consume what drives probe
 * construction so a benign upstream field rename doesn't break the canary.
 */
export type V2ModelSummary = {
  id: string;
  family: string;
  name: string;
};

/**
 * Zod schema for the subset we consume. `.passthrough()` via `.strip()` is
 * the zod default — extra fields are ignored, not rejected, which is what
 * we want since the canary's job is structural validation not exact-shape.
 */
const ModelEntrySchema = z.object({
  id: z.string().min(1),
  family: z.string().min(1),
  name: z.string().min(1),
});

const ModelsResponseSchema = z.object({
  data: z.array(ModelEntrySchema).min(1),
});

export type FetchV2ModelsOptions = {
  modelsUrl?: string;
  timeoutMs?: number;
  /** Injectable for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export async function fetchV2Models(
  options: FetchV2ModelsOptions = {}
): Promise<V2ModelSummary[]> {
  const url = options.modelsUrl ?? DEFAULT_V2_MODELS_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const { controller, clearTimer } = withTimeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimer();
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GET ${url} failed with status ${response.status}: ${body.slice(0, 500)}`
    );
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    throw new Error(
      `GET ${url} returned non-JSON body: ${(error as Error).message}`
    );
  }

  const parsed = ModelsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(
      `GET ${url} returned a body that does not match the expected shape: ${issues}`
    );
  }

  return parsed.data.data.map((entry) => ({
    id: entry.id,
    family: entry.family,
    name: entry.name,
  }));
}
