export type Renderable = string | Record<string, unknown>;

import { numberFlag, type Parsed } from "../args.js";
import type { EvalResult } from "../client.js";
import { resolveThresholds, type Thresholds } from "../config.js";
import { mergedUsageLine } from "../format.js";
import { encode } from "@toon-format/toon";

export function thresholdsFrom(p: Parsed): Thresholds {
  const act = p.values["--act"] === undefined ? undefined : numberFlag(p, "--act", 0, 0, 1);
  const confirm = p.values["--confirm"] === undefined ? undefined : numberFlag(p, "--confirm", 0, 0, 1);
  const t = resolveThresholds({ act, confirm });
  return t;
}

export function evalOptions(p: Parsed, command: string): { command: string; model?: string; cache: boolean } {
  return { command, model: p.values["--model"], cache: !p.bools["--no-cache"] };
}

/**
 * Finish a command: attach the usage line, then render as TOON (default) or
 * JSON (--json). Raw API responses are included under `raw` in JSON mode.
 */
export function finish(
  p: Parsed,
  output: Record<string, unknown>,
  results: EvalResult[],
  help: string[] = [],
): Renderable {
  const usage = results.length ? mergedUsageLine(results) : undefined;
  if (p.bools["--json"]) {
    return JSON.stringify(
      {
        ...output,
        ...(usage ? { usage } : {}),
        raw: results.map((r) => ({ model: r.model, answers: r.answers, usage: r.usage, ms: r.ms, cached: r.cached })),
      },
      null,
      2,
    );
  }
  return renderWithHelp({ ...output, ...(usage ? { usage } : {}), help });
}

/** gh-axi style: `help[n]:` followed by one indented line per hint, unquoted. */
export function renderHelp(lines: string[]): string {
  if (lines.length === 0) return "";
  return `help[${lines.length}]:\n${lines.map((l) => `  ${l}`).join("\n")}`;
}

/** Encode an output object as TOON, rendering a `help` array as a readable block. */
export function renderWithHelp(output: Record<string, unknown>): string {
  const { help, ...rest } = output;
  const lines = Array.isArray(help) ? (help as string[]) : [];
  const body = Object.keys(rest).length ? encode(rest) : "";
  return [body, renderHelp(lines)].filter(Boolean).join("\n");
}

export function quote(s: string): string {
  return JSON.stringify(s);
}
