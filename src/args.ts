import { validation } from "./errors.js";

export type FlagKind = "value" | "bool" | "multi";
export type FlagSpec = Record<string, FlagKind>;

export interface Parsed {
  positional: string[];
  values: Record<string, string | undefined>;
  bools: Record<string, boolean>;
  multi: Record<string, string[]>;
}

/** Flags accepted by every command in addition to its own. */
export const GLOBAL_FLAGS: FlagSpec = {
  "--json": "bool",
  "--full": "bool",
  "--model": "value",
  "--no-cache": "bool",
  "--act": "value",
  "--confirm": "value",
};

/** Renamed flags get a targeted hint instead of the generic list. */
const RENAMED: Record<string, string> = {
  "--file": "--state",
  "--input": "--state",
  "--limit": "--top",
  "--threshold": "--min",
};

/**
 * Parse argv against a per-command flag spec. Unknown flags fail loud with
 * exit code 2 and the valid flag list inline, per AXI principle 6.
 */
export function parseArgs(args: string[], spec: FlagSpec, command: string): Parsed {
  const all: FlagSpec = { ...GLOBAL_FLAGS, ...spec };
  const out: Parsed = { positional: [], values: {}, bools: {}, multi: {} };
  for (const [flag, kind] of Object.entries(all)) {
    if (kind === "multi") out.multi[flag] = [];
    if (kind === "bool") out.bools[flag] = false;
  }
  const validList = () => `valid flags for \`${command}\`: ${Object.keys(all).join(", ")} (--help always allowed)`;

  let i = 0;
  let passthrough = false;
  while (i < args.length) {
    const arg = args[i]!;
    if (passthrough || arg === "-" || !arg.startsWith("-") || /^-?\d/.test(arg)) {
      out.positional.push(arg);
      i++;
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      i++;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const kind = all[name];
    if (!kind) {
      const renamed = RENAMED[name];
      throw validation(
        `unknown flag ${name} for \`${command}\``,
        renamed ? [`${name} was renamed; use ${renamed} instead`] : [validList()],
      );
    }
    if (kind === "bool") {
      if (inline !== undefined) throw validation(`${name} does not take a value`, [validList()]);
      out.bools[name] = true;
      i++;
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = args[i + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-" && !/^-\d/.test(next))) {
        throw validation(`${name} requires a value`, [`Use ${name} <value> or ${name}=<value>`]);
      }
      value = next;
      i += 2;
    } else {
      i++;
    }
    if (value.trim() === "") throw validation(`${name} requires a value`);
    if (kind === "multi") out.multi[name]!.push(value);
    else {
      if (out.values[name] !== undefined) throw validation(`${name} may only be given once`);
      out.values[name] = value;
    }
  }
  return out;
}

export function numberFlag(p: Parsed, flag: string, fallback: number, min?: number, max?: number): number {
  const raw = p.values[flag];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw validation(`${flag} must be a number, got ${JSON.stringify(raw)}`);
  if (min !== undefined && n < min) throw validation(`${flag} must be >= ${min}`);
  if (max !== undefined && n > max) throw validation(`${flag} must be <= ${max}`);
  return n;
}
