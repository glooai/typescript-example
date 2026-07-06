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
 * endpoint returns a lot more (pricing, context_window, speed ratings,
 * etc.) but we deliberately only consume what drives probe construction so
 * a benign upstream field rename doesn't break the canary.
 *
 * `outputModalities` is consumed so the probe builders can skip models
 * that can't return text on the V2 Chat Completions surface (e.g. the
 * image-only FLUX / Seedream / Grok-Imagine models, whose only output is
 * an image). Probing those on `/ai/v2/chat/completions` always yields an
 * empty completion — a self-inflicted RED — because image bytes come back
 * on a field the Chat Completions envelope doesn't carry. Image generation
 * is a `/ai/v1/responses` concern, out of scope for this V2 canary.
 */
export type V2ModelSummary = {
  id: string;
  family: string;
  name: string;
  /**
   * Declared output modalities (e.g. `["text"]`, `["image"]`). Defaults to
   * `["text"]` when the registry omits the field, matching the platform's
   * own convention that a model without declared output modalities is a
   * text model. Optional on the type for backwards-compat with callers
   * that construct summaries inline.
   */
  outputModalities?: string[];
};

/**
 * True when a model can produce text output on the V2 Chat Completions
 * surface. Image-only models (no `"text"` in `output_modalities`) return
 * false. Absent modalities default to text-output (`true`) so a registry
 * that stops advertising the field doesn't silently drop every probe.
 */
export function isTextOutputModel(model: V2ModelSummary): boolean {
  return (model.outputModalities ?? ["text"]).includes("text");
}

/**
 * Zod schema for the subset we consume. `.passthrough()` via `.strip()` is
 * the zod default — extra fields are ignored, not rejected, which is what
 * we want since the canary's job is structural validation not exact-shape.
 */
const ModelEntrySchema = z.object({
  id: z.string().min(1),
  family: z.string().min(1),
  name: z.string().min(1),
  // Optional: the registry has long carried it, but tolerate its absence
  // (older snapshots, partial responses) by defaulting to text-output at
  // the mapping step below rather than rejecting the whole payload.
  output_modalities: z.array(z.string()).optional(),
});

/**
 * Envelope schema. Validates only the top-level shape, deliberately NOT
 * each element. Per-entry validation happens in `fetchV2Models` so one
 * malformed registry row can be dropped without discarding every other
 * probe (see `TangoGroup/gloo#47`). This still throws loudly when `data`
 * is missing, is not an array, or is empty: the total-outage and
 * empty-registry cases a canary must fail on.
 */
const ModelsResponseSchema = z.object({
  data: z.array(z.unknown()).min(1),
});

/**
 * Compact `path: message` summary for a zod error, joined with `; `.
 * Reused across the envelope-failure and per-entry-failure paths.
 */
function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

const EntryIdSchema = z.object({ id: z.string().min(1) });

/** Extracts a usable id from a raw registry row without asserting its shape. */
function extractEntryId(rawEntry: unknown): string {
  const parsed = EntryIdSchema.safeParse(rawEntry);
  return parsed.success ? parsed.data.id : "(no id)";
}

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
    throw new Error(
      `GET ${url} returned a body that does not match the expected shape: ${summarizeIssues(parsed.error)}`
    );
  }

  const entries = parsed.data.data;
  const survivors: V2ModelSummary[] = [];
  const dropped: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entryParsed = ModelEntrySchema.safeParse(entries[index]);
    if (entryParsed.success) {
      const entry = entryParsed.data;
      survivors.push({
        id: entry.id,
        family: entry.family,
        name: entry.name,
        outputModalities: entry.output_modalities ?? ["text"],
      });
      continue;
    }
    // Surface the entry id when the raw row carried a usable one, so the
    // warning names the offending model without dumping the full body.
    const id = extractEntryId(entries[index]);
    dropped.push(
      `[index ${index}, id ${id}] ${summarizeIssues(entryParsed.error)}`
    );
  }

  if (survivors.length === 0) {
    throw new Error(
      `GET ${url} returned ${entries.length} entries but none matched the expected shape: ${dropped.join(" | ")}`
    );
  }

  if (dropped.length > 0) {
    console.warn(
      `v2-models: dropped ${dropped.length} of ${entries.length} registry entries that failed schema validation (non-fatal): ${dropped.join(" | ")}`
    );
  }

  return survivors;
}
