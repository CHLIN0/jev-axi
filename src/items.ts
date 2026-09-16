import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { validation } from "./errors.js";
import { isStdinTTY, readStdinSync } from "./stdin.js";

export interface Item {
  id: string;
  /** Human-readable label: a path, a stdin line number, or a JSONL id. */
  label: string;
  text: string;
  /** Full text length before preview truncation. */
  total: number;
}

/** Hard limits from the API: 255 options per Choice, ~32k tokens per request. */
export const MAX_CHOICE_OPTIONS = 255;
export const REQUEST_TOKEN_BUDGET = 32_000;
/** Leave headroom for question text and JSON overhead. */
export const STATE_TOKEN_BUDGET = 24_000;

/** Conservative: code and diffs tokenize at roughly 2.7 chars per token, prose nearer 4. */
export const CHARS_PER_TOKEN = 2.6;
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".cache", "target", "__pycache__", ".venv", "venv"]);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|bz2|xz|7z|jar|war|class|o|so|dylib|dll|exe|bin|woff2?|ttf|otf|eot|mp[34]|mov|avi|mkv|wasm|lock|sqlite|db)$/i;

export interface GatherOptions {
  preview: number;
  maxItems?: number;
}

/**
 * Turn CLI sources into items. Sources: `-` (stdin), file paths, directories
 * (recursed, common junk skipped), or `.jsonl` files with `{id?, text}` rows.
 * Stdin is split per line unless it parses as JSON lines with a `text` field.
 */
export function gatherItems(sources: string[], opts: GatherOptions): Item[] {
  const items: Item[] = [];
  const cwd = process.cwd();
  const push = (label: string, text: string) => {
    const id = `I${String(items.length + 1).padStart(3, "0")}`;
    items.push({ id, label, text: preview(text, opts.preview), total: text.length });
  };

  const effective = sources.length === 0 && !isStdinTTY() ? ["-"] : sources;
  if (effective.length === 0) {
    throw validation("no items given", [
      "Pass file or directory paths, or pipe items on stdin (one per line, or JSONL with a `text` field)",
    ]);
  }

  for (const src of effective) {
    if (src === "-") {
      if (isStdinTTY()) throw validation("stdin is a terminal; pipe items in or pass paths");
      const raw = readStdinSync();
      for (const row of parseLines(raw)) push(row.label, row.text);
      continue;
    }
    if (!existsSync(src)) throw validation(`path not found: ${src}`);
    const st = statSync(src);
    if (st.isDirectory()) {
      for (const file of walk(src)) push(displayPath(cwd, file), readText(file));
    } else if (src.endsWith(".jsonl")) {
      for (const row of parseLines(readFileSync(src, "utf8"))) push(row.label, row.text);
    } else {
      push(displayPath(cwd, src), readText(src));
    }
  }
  if (opts.maxItems !== undefined && items.length > opts.maxItems) {
    throw validation(`${items.length} items exceeds the maximum of ${opts.maxItems}`, [
      "Narrow the sources or pass a subdirectory",
    ]);
  }
  return items;
}

const IMPORT_LINE = /^\s*(import\b|from\s+\S+\s+import\b|export\s+\*\s+from\b|const\s+.*=\s*require\(|require\(|#include\b|using\s+\S+;|package\s+\S+;?$)/;

/**
 * First `max` chars of substance: a leading block of import/require lines is
 * skipped so a code file's preview shows what it does, not what it depends on.
 */
export function preview(text: string, max: number): string {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && (IMPORT_LINE.test(lines[i]!) || lines[i]!.trim() === "" || /^\s*[})\]](\s*from\s+\S+)?;?\s*$/.test(lines[i]!) || /^\s+[\w$"'./-]+,?\s*$/.test(lines[i]!))) i++;
  const body = i > 0 && i < lines.length ? lines.slice(i).join("\n") : text;
  return body.slice(0, max);
}

/** Relative to cwd when inside it; otherwise the path as given. */
function displayPath(cwd: string, file: string): string {
  const rel = relative(cwd, file);
  return rel === "" || rel.startsWith("..") ? file : rel;
}

function parseLines(raw: string): { label: string; text: string }[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
  const out: { label: string; text: string }[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        const text = typeof obj["text"] === "string" ? obj["text"] : JSON.stringify(obj);
        const label = String(obj["id"] ?? obj["path"] ?? obj["label"] ?? `line ${i + 1}`);
        out.push({ label, text });
        return;
      } catch {
        // not JSON, fall through
      }
    }
    out.push({ label: `line ${i + 1}`, text: line });
  });
  return out;
}

function* walk(dir: string): Generator<string> {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith(".") && e.isDirectory()) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && !BINARY_EXT.test(e.name)) yield full;
  }
}

function readText(file: string): string {
  const buf = readFileSync(file);
  // Cheap binary sniff: NUL byte in the first 8k.
  if (buf.subarray(0, 8192).includes(0)) return "";
  return buf.toString("utf8");
}

/**
 * Split items into request-sized chunks: at most `maxItems` per chunk and at
 * most STATE_TOKEN_BUDGET estimated tokens of item text.
 */
export function chunkItems(items: Item[], maxItems = MAX_CHOICE_OPTIONS, tokenBudget = STATE_TOKEN_BUDGET): Item[][] {
  const chunks: Item[][] = [];
  let current: Item[] = [];
  let tokens = 0;
  for (const item of items) {
    const t = estimateTokens(item.text) + estimateTokens(item.label) + 8;
    if (current.length > 0 && (current.length >= maxItems || tokens + t > tokenBudget)) {
      chunks.push(current);
      current = [];
      tokens = 0;
    }
    current.push(item);
    tokens += t;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** State object for a chunk: item id -> {label, text}. */
export function itemsState(chunk: Item[]): Record<string, { label: string; text: string }> {
  return Object.fromEntries(chunk.map((i) => [i.id, { label: i.label, text: i.text }]));
}
