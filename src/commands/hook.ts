import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "../args.js";
import { evaluate, type NoulAnswer, type ScoreAnswer } from "../client.js";
import { ensureDir, paths } from "../config.js";
import { validation } from "../errors.js";
import { SAFETY_QUESTIONS } from "../recipes/questions.js";
import { buildSafetyState, decide, hookOutput, localVerdict, reasonText, redactSecrets, type Decision, type ToolCall } from "../safety.js";
import { isStdinTTY, readStdinSync } from "../stdin.js";
import type { Renderable } from "./common.js";

export const HOOK_HELP = `usage: jev-axi hook pre-tool-use [--agent claude|codex] [--input <json|path>] [--on-error allow|ask|deny] [--explain]
Safety check for a tool call an agent is about to make, run as a PreToolUse hook. Reads the hook JSON on stdin.
Routine calls (read-only commands, the project's tests and builds, edits inside the project) are decided locally with
no API call. Other calls are sent to Jev with secrets redacted and scored for destructive actions, exfiltration,
running downloaded code, weakening security, and changes outside the project.
output: nothing (normal permission flow applies; never auto-approves), or a PreToolUse decision JSON to ask or deny.
flags:
  --agent <name>       output format: claude (default) or codex (Codex supports only deny, so ask becomes deny)
  --input <json|path>  hook JSON instead of stdin, for testing
  --on-error <mode>    when Jev is unreachable or slow: allow (default, normal flow), ask, or deny
  --explain            print the decision, scores, and reason as TOON instead of hook JSON
install: jev-axi setup safety [--project] [--agent claude|codex]
log: every decision that reaches Jev is appended to ~/.config/jev-axi/stats/safety.jsonl
examples:
  echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf ~/"},"cwd":"'"$PWD"'"}' | jev-axi hook pre-tool-use --explain
`;

/** Hooks run on every tool call, so keep the check well inside agent hook timeouts. */
const HOOK_TIMEOUT_MS = 6000;

function readCall(p: ReturnType<typeof parseArgs>): ToolCall {
  const src = p.values["--input"];
  let raw: string;
  if (src !== undefined) raw = src.trim().startsWith("{") ? src : readFileSync(src, "utf8");
  else if (!isStdinTTY()) raw = readStdinSync();
  else throw validation("hook pre-tool-use reads the hook JSON on stdin", ["Pass --input '<json>' to test it by hand"]);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw validation(`hook input is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed["tool_name"] !== "string") throw validation("hook input has no tool_name");
  return {
    tool_name: parsed["tool_name"],
    tool_input: (parsed["tool_input"] as Record<string, unknown>) ?? {},
    cwd: typeof parsed["cwd"] === "string" ? parsed["cwd"] : process.cwd(),
  };
}

function logDecision(entry: Record<string, unknown>): void {
  try {
    const file = join(paths.statsDir(), "safety.jsonl");
    ensureDir(paths.statsDir());
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // best-effort
  }
}

export async function hookCommand(args: string[]): Promise<Renderable> {
  const p = parseArgs(args, { "--agent": "value", "--input": "value", "--on-error": "value", "--explain": "bool" }, "hook");
  if (p.positional[0] !== "pre-tool-use") throw validation("unknown hook", ["jev-axi hook pre-tool-use"]);
  const agent = (p.values["--agent"] ?? "claude") as "claude" | "codex";
  if (agent !== "claude" && agent !== "codex") throw validation("--agent must be claude or codex");
  const onError = (p.values["--on-error"] ?? "allow") as Decision;
  if (!["allow", "ask", "deny"].includes(onError)) throw validation("--on-error must be allow, ask, or deny");
  const call = readCall(p);
  const summary = redactSecrets(String(call.tool_input["command"] ?? call.tool_input["file_path"] ?? "")).slice(0, 200);

  const local = localVerdict(call);
  if (local.decision === "allow") {
    const view = { decision: "allow", source: "local", reason: local.reason };
    return p.bools["--explain"] ? (p.bools["--json"] ? JSON.stringify(view) : view) : "";
  }

  let decision: Decision;
  let reason: string;
  let detail: Record<string, unknown> = {};
  try {
    const r = await evaluate(buildSafetyState(call), SAFETY_QUESTIONS, { command: "hook", timeoutMs: HOOK_TIMEOUT_MS, maxRetries: 0 });
    const hazards = Object.fromEntries(
      Object.entries(r.answers).filter(([, a]) => a.type === "noul").map(([k, a]) => [k, Math.round((a as NoulAnswer).noul * 100) / 100]),
    );
    const risk = Math.round((r.answers["risk"] as ScoreAnswer).score * 100) / 100;
    const verdict = decide({ hazards, risk });
    decision = verdict.decision;
    reason = reasonText(decision, verdict.top, risk);
    detail = { hazards, risk, top: verdict.top[0] };
  } catch (error) {
    decision = onError;
    reason = `jev-axi safety check unavailable (${(error as Error).message}); on-error policy: ${onError}.`;
    detail = { error: (error as Error).message };
  }
  logDecision({ agent, tool: call.tool_name, decision, input: summary, cwd: call.cwd, ...detail });
  if (p.bools["--explain"]) {
    const view = { decision, source: "jev", reason: decision === "allow" ? "no hazard above thresholds" : reason, ...detail };
    return p.bools["--json"] ? JSON.stringify(view) : view;
  }
  return hookOutput(decision, reason, agent);
}

// ------------------------------------------------------------------ installation

export const SAFETY_HOOK_COMMAND = "jev-axi hook pre-tool-use";
const MATCHER = "Bash|Write|Edit|MultiEdit";

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

export function safetyHookPath(agent: "claude" | "codex", project: boolean): string {
  if (agent === "claude") return project ? join(process.cwd(), ".claude", "settings.json") : join(homedir(), ".claude", "settings.json");
  return project ? join(process.cwd(), ".codex", "hooks.json") : join(homedir(), ".codex", "hooks.json");
}

/** Add or remove the PreToolUse safety hook. Idempotent; leaves other hooks untouched. */
export function configureSafetyHook(agent: "claude" | "codex", project: boolean, remove: boolean): { file: string; changed: boolean } {
  const file = safetyHookPath(agent, project);
  const data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8") || "{}") as Record<string, any>) : {};
  const hooks = (data["hooks"] ??= {});
  const list: HookEntry[] = (hooks["PreToolUse"] ??= []);
  const command = agent === "codex" ? `${SAFETY_HOOK_COMMAND} --agent codex` : SAFETY_HOOK_COMMAND;
  const isOurs = (h: { command: string }) => h.command.startsWith(SAFETY_HOOK_COMMAND);
  const present = list.some((e) => e.hooks?.some(isOurs));
  if (remove) {
    if (!present) return { file, changed: false };
    for (const e of list) e.hooks = (e.hooks ?? []).filter((h) => !isOurs(h));
    hooks["PreToolUse"] = list.filter((e) => e.hooks.length > 0);
    if (!hooks["PreToolUse"].length) delete hooks["PreToolUse"];
  } else {
    if (present) return { file, changed: false };
    list.push({ matcher: MATCHER, hooks: [{ type: "command", command, timeout: 15 }] });
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return { file, changed: true };
}
