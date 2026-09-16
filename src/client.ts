import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  RateLimitError,
  TypeSafeClient,
  UnprocessableEntityError,
  type Fetch,
  type EntryType,
  type Question,
  type Usage,
} from "@typesafe-ai/sdk";
import { AxiError } from "./errors.js";
import { ensureDir, paths, readConfig, resolveApiKey, resolveModel, resolveThresholds } from "./config.js";
import { projectName, recordUsage, type BandCounts } from "./usage.js";
import { bandForConfidence, bandForNoul } from "./bands.js";

export type QuestionMap = Record<string, Question>;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface NoulAnswer {
  type: "noul";
  noul: number;
}
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface EvalResult {
  model: string;
  answers: Record<string, Answer>;
  usage: Usage;
  ms: number;
  cached: boolean;
}

export interface EvalOptions {
  command: string;
  model?: string;
  cache?: boolean;
  fetch?: Fetch;
}

let fetchOverride: Fetch | undefined;
/** Test hook: route all API traffic through a custom fetch. */
export function configureFetch(fetch: Fetch | undefined): void {
  fetchOverride = fetch;
}

let client: TypeSafeClient | undefined;
function getClient(fetch?: Fetch): TypeSafeClient {
  const f = fetch ?? fetchOverride;
  if (client && !f) return client;
  const { key } = resolveApiKey();
  if (!key) {
    throw new AxiError("TYPESAFE_API_KEY is not set", "AUTH_REQUIRED", [
      "Export TYPESAFE_API_KEY, add it to a .env in this directory, or run `jev-axi config set apiKey <key>`",
      "Create a key at https://console.typesafe.ai/settings/keys",
    ]);
  }
  const c = new TypeSafeClient({ apiKey: key, timeout: 60_000, logLevel: "error", ...(f ? { fetch: f } : {}) });
  if (!f) client = c;
  return c;
}

/** Band counts across a response's answers, using the configured thresholds. */
export function countBands(answers: Record<string, Answer>): BandCounts {
  const t = resolveThresholds({});
  const b: BandCounts = { act: 0, confirm: 0, escalate: 0 };
  for (const a of Object.values(answers)) {
    const band = a.type === "noul" ? bandForNoul(a.noul, t) : bandForConfidence(a.confidence, t);
    b[band]++;
  }
  return b;
}

function cacheKey(model: string, state: EntryType, questions: QuestionMap): string {
  return createHash("sha256").update(JSON.stringify({ model, state, questions })).digest("hex");
}

export function cacheEnabled(): boolean {
  return process.env["JEV_AXI_NO_CACHE"] !== "1";
}

/**
 * Evaluate one state against a map of questions. Handles caching, timing,
 * the usage ledger, and translating SDK errors into structured AXI errors.
 */
export async function evaluate(
  state: EntryType,
  questions: QuestionMap,
  opts: EvalOptions,
): Promise<EvalResult> {
  const model = resolveModel(opts.model);
  const useCache = (opts.cache ?? true) && cacheEnabled();
  const key = cacheKey(model, state, questions);
  const cacheFile = join(paths.cacheDir(), `${key}.json`);
  const qCount = Object.keys(questions).length;

  if (useCache && existsSync(cacheFile)) {
    try {
      const hit = JSON.parse(readFileSync(cacheFile, "utf8")) as Omit<EvalResult, "ms" | "cached">;
      recordUsage({
        ts: new Date().toISOString(),
        cmd: opts.command,
        model: hit.model,
        in: hit.usage.input_tokens,
        out: hit.usage.output_tokens,
        ms: 0,
        q: qCount,
        cached: true,
        project: projectName(),
        bands: countBands(hit.answers),
      });
      return { ...hit, ms: 0, cached: true };
    } catch {
      // fall through to a live call
    }
  }

  const started = performance.now();
  let raw;
  try {
    raw = await getClient(opts.fetch).systemOne({ state, questions, model });
  } catch (error) {
    throw translateError(error);
  }
  const ms = Math.round(performance.now() - started);
  const result: EvalResult = {
    model: raw.model,
    answers: raw.answers as unknown as Record<string, Answer>,
    usage: raw.usage,
    ms,
    cached: false,
  };
  recordUsage({
    ts: new Date().toISOString(),
    cmd: opts.command,
    model: raw.model,
    in: raw.usage.input_tokens,
    out: raw.usage.output_tokens,
    ms,
    q: qCount,
    cached: false,
    project: projectName(),
    bands: countBands(result.answers),
  });
  if (useCache) {
    try {
      ensureDir(paths.cacheDir());
      writeFileSync(cacheFile, JSON.stringify({ model: result.model, answers: result.answers, usage: result.usage }));
    } catch {
      // cache is best-effort
    }
  }
  return result;
}

function translateError(error: unknown): AxiError {
  if (error instanceof AxiError) return error;
  if (error instanceof AuthenticationError) {
    return new AxiError("API key was rejected (401)", "AUTH_REQUIRED", [
      "Check TYPESAFE_API_KEY or run `jev-axi config set apiKey <key>`",
    ]);
  }
  if (error instanceof RateLimitError) {
    return new AxiError("Rate limited by the TypeSafe API after retries (429)", "RATE_LIMITED", [
      "Wait a few seconds and rerun; batch more questions per call to reduce request count",
    ]);
  }
  if (error instanceof UnprocessableEntityError) {
    return new AxiError(`Request rejected by the API (422): ${detail(error.body)}`, "VALIDATION_ERROR", [
      "Check question shapes: choice needs `criteria` map, score needs >= 2 levels, noul needs `instructions`",
    ]);
  }
  if (error instanceof APIError && error.status === 400 && detail(error.body).includes("max_tokens_exceeded")) {
    return new AxiError("Request exceeds the model's token limit (~32k tokens for state plus questions)", "VALIDATION_ERROR", [
      "Send less state: lower --preview, --tail, or the number of items; batch commands chunk automatically but a single item can still be too large",
    ]);
  }
  if (error instanceof APIError) {
    const code = error.status === 529 ? "OVERLOADED" : "API_ERROR";
    return new AxiError(`TypeSafe API error (${error.status}): ${detail(error.body) || error.message}`, code, [
      error.status === 529 ? "TypeSafe is overloaded; retry shortly" : "Retry; if it persists check https://status.typesafe.ai",
    ]);
  }
  if (error instanceof APIConnectionError) {
    return new AxiError(`Could not reach the TypeSafe API: ${error.message}`, "NETWORK", [
      "Check network access to api.typesafe.ai and retry",
    ]);
  }
  return new AxiError(error instanceof Error ? error.message : String(error), "UNKNOWN");
}

function detail(body: unknown): string {
  if (!body) return "";
  if (typeof body === "string") return body.slice(0, 300);
  try {
    const b = body as Record<string, unknown>;
    const d = b["detail"] ?? b["error"] ?? b["message"] ?? body;
    return (typeof d === "string" ? d : JSON.stringify(d)).slice(0, 300);
  } catch {
    return "";
  }
}

export async function listModels(fetch?: Fetch): Promise<{ name: string; description: string; release_date: string }[]> {
  try {
    return await getClient(fetch).models.list();
  } catch (error) {
    throw translateError(error);
  }
}

export { readConfig };
