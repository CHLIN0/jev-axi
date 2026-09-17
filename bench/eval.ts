/**
 * Recipe evals: run every labeled case in bench/cases through the CLI and
 * score it. This is the loop for improving questions in
 * src/recipes/questions.ts: edit, run `pnpm eval`, compare to the baseline.
 *
 *   pnpm eval                         # all recipes, cached responses reused
 *   pnpm eval --only guard,triage     # a subset
 *   pnpm eval --fresh                 # bypass the response cache
 *   pnpm eval --model jev-preview     # A/B another model
 *   pnpm eval --save                  # write bench/results/<timestamp>-<model>.json
 *   pnpm eval --save baseline         # write bench/results/baseline.json
 *   pnpm eval --compare bench/results/baseline.json
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { main } from "../src/cli.js";

type Expect = Record<string, unknown>;
interface Case {
  name: string;
  file?: string;
  text?: string;
  task?: string;
  question?: string;
  command?: string;
  options?: string[];
  levels?: string[];
  expect: Expect;
}
interface Suite {
  recipe: string;
  description?: string;
  dir?: string;
  cases: Case[];
}
interface CaseResult {
  recipe: string;
  name: string;
  pass: boolean;
  detail: string;
  input_tokens: number;
  output_tokens: number;
  ms: number;
  cached: boolean;
  calls: number;
}
interface Report {
  ts: string;
  model: string;
  results: CaseResult[];
}

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name: string) => argv.includes(name);
const only = flag("--only")?.split(",").map((s) => s.trim());
const model = flag("--model");
const fresh = has("--fresh");
const verbose = has("--verbose");
const saveArg = has("--save") ? (flag("--save")?.startsWith("--") ? undefined : flag("--save")) ?? "timestamp" : undefined;
const compare = flag("--compare");

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const CASES_DIR = join(ROOT, "bench", "cases");
const RESULTS_DIR = join(ROOT, "bench", "results");

/** Run the CLI in-process with --json and parse the result. */
async function run(args: string[]): Promise<Record<string, any>> {
  let out = "";
  const stdout = { write: (s: string) => ((out += s), true) };
  const extra = ["--json", ...(model ? ["--model", model] : []), ...(fresh ? ["--no-cache"] : [])];
  process.exitCode = 0;
  await main([...args, ...extra], stdout);
  process.exitCode = 0;
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`non-JSON output: ${out.slice(0, 300)}`);
  }
}

function usageOf(r: Record<string, any>): Pick<CaseResult, "input_tokens" | "output_tokens" | "ms" | "cached" | "calls"> {
  const raw: any[] = Array.isArray(r["raw"]) ? r["raw"] : [];
  return {
    input_tokens: raw.reduce((s, x) => s + (x.usage?.input_tokens ?? 0), 0),
    output_tokens: raw.reduce((s, x) => s + (x.usage?.output_tokens ?? 0), 0),
    ms: raw.reduce((s, x) => s + (x.ms ?? 0), 0),
    cached: raw.length > 0 && raw.every((x) => x.cached),
    calls: raw.length,
  };
}

const num = (s: unknown): number => {
  const m = /-?\d+(\.\d+)?/.exec(String(s));
  return m ? Number(m[0]) : NaN;
};
const word = (s: unknown): string => String(s).split(" ")[0]!;

type Check = { pass: boolean; detail: string };
const ok = (detail: string): Check => ({ pass: true, detail });
const fail = (detail: string): Check => ({ pass: false, detail });

function checkGuard(r: any, e: Expect): Check {
  const allowed = e["verdict_in"] as string[];
  return allowed.includes(r.verdict) ? ok(`${r.verdict}; top ${r.top_hazard}`) : fail(`verdict ${r.verdict}, wanted ${allowed.join("|")}; top ${r.top_hazard}`);
}

function checkTriage(r: any, e: Expect): Check {
  const a = r.raw[0].answers;
  const problems: string[] = [];
  const cat = a.category.choice as string;
  if (e["category"] && cat !== e["category"]) problems.push(`category ${cat} != ${e["category"]}`);
  if (e["category_in"] && !(e["category_in"] as string[]).includes(cat)) problems.push(`category ${cat} not in ${(e["category_in"] as string[]).join("|")}`);
  if (e["root_cause_regex"] && !new RegExp(String(e["root_cause_regex"])).test(r.root_cause.text)) problems.push(`root cause line ${r.root_cause.line} "${String(r.root_cause.text).slice(0, 60)}" !~ /${e["root_cause_regex"]}/`);
  const flaky = a.flaky.noul as number;
  if (e["flaky_max"] !== undefined && flaky > Number(e["flaky_max"])) problems.push(`flaky ${flaky} > ${e["flaky_max"]}`);
  if (e["flaky_min"] !== undefined && flaky < Number(e["flaky_min"])) problems.push(`flaky ${flaky} < ${e["flaky_min"]}`);
  const hasErr = a.has_error.noul as number;
  if (e["has_error_max"] !== undefined && hasErr > Number(e["has_error_max"])) problems.push(`has_error ${hasErr} > ${e["has_error_max"]}`);
  return problems.length ? fail(problems.join("; ")) : ok(`${cat}, line ${r.root_cause.line}, flaky ${flaky}`);
}

function checkDiff(r: any, e: Expect): Check {
  const problems: string[] = [];
  if (e["verdict"] && r.verdict !== e["verdict"]) problems.push(`verdict ${r.verdict} != ${e["verdict"]}`);
  if (e["kind"] && word(r.kind) !== e["kind"]) problems.push(`kind ${word(r.kind)} != ${e["kind"]}`);
  const files: any[] = Array.isArray(r.files) ? r.files : [];
  for (const [path, wanted] of Object.entries((e["flags"] as Record<string, string[]>) ?? {})) {
    const row = files.find((f) => String(f.file).startsWith(path));
    const got = row ? String(row.flags).split(",") : [];
    for (const w of wanted) if (!got.includes(w)) problems.push(`${path}: missing flag ${w} (got ${got.join(",") || "-"})`);
  }
  return problems.length ? fail(problems.join("; ")) : ok(`${r.verdict}, ${word(r.kind)}, ${files.map((f) => `${f.file}:${f.flags}`).join(" ")}`);
}

function checkFiles(r: any, e: Expect): Check {
  const top = Number(e["top"] ?? 3);
  const wanted = e["file_any"] as string[];
  const ranked: string[] = (r.files ?? []).slice(0, top).map((f: any) => String(f.file));
  const hit = ranked.find((f) => wanted.some((w) => f === w || f.endsWith(w)));
  return hit ? ok(`#${ranked.indexOf(hit) + 1} ${hit}`) : fail(`top ${top}: ${ranked.join(", ") || "none"}; wanted ${wanted.join("|")}`);
}

function checkFind(r: any, e: Expect, file: string): Check {
  const top = Number(e["top"] ?? 3);
  // A statement often spans lines (`throw validation(` then the message), so a hit
  // counts when the pattern appears within `window` lines of it.
  const window = Number(e["window"] ?? 2);
  const re = new RegExp(String(e["line_regex"]));
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const hits: any[] = (r.hits ?? []).slice(0, top);
  const near = (line: number) => lines.slice(Math.max(0, line - 1 - window), line + window).some((l) => re.test(l));
  const hit = hits.find((h) => near(Number(h.line)));
  return hit
    ? ok(`line ${hit.line} (p ${hit.p}, rank ${hits.indexOf(hit) + 1})`)
    : fail(`top ${top} lines ${hits.map((h) => h.line).join(",") || "none"}: no /${e["line_regex"]}/ within ${window} lines`);
}

function checkPrimitive(r: any, e: Expect): Check {
  if (e["verdict"] !== undefined) return String(r.verdict) === String(e["verdict"]) ? ok(`${r.verdict} (p ${r.p_yes})`) : fail(`verdict ${r.verdict} != ${e["verdict"]} (p ${r.p_yes})`);
  if (e["pick"] !== undefined) return r.pick === e["pick"] ? ok(`${r.pick} (${r.confidence})`) : fail(`pick ${r.pick} != ${e["pick"]}`);
  if (e["nearest"] !== undefined) return num(r.nearest) === Number(e["nearest"]) ? ok(`${r.nearest} (score ${r.score})`) : fail(`nearest ${r.nearest} != ${e["nearest"]} (score ${r.score})`);
  return fail("no expectation");
}

async function runCase(suite: Suite, c: Case): Promise<CaseResult> {
  const base = { recipe: suite.recipe, name: c.name };
  try {
    let r: Record<string, any>;
    let check: Check;
    switch (suite.recipe) {
      case "guard":
        r = await run(["guard", "--state", join(ROOT, c.file!)]);
        check = checkGuard(r, c.expect);
        break;
      case "triage":
        r = await run(["triage", join(ROOT, c.file!)]);
        check = checkTriage(r, c.expect);
        break;
      case "diff":
        r = await run(["diff", "--file", join(ROOT, c.file!), "--full"]);
        check = checkDiff(r, c.expect);
        break;
      case "files":
        r = await run(["files", c.task!, join(ROOT, suite.dir ?? "src"), "--top", String(c.expect["top"] ?? 3)]);
        check = checkFiles(r, c.expect);
        break;
      case "find":
        r = await run(["find", c.question!, join(ROOT, c.file!), "--top", String(c.expect["top"] ?? 3)]);
        check = checkFind(r, c.expect, join(ROOT, c.file!));
        break;
      case "primitives": {
        const args = [c.command!, c.question!, "--text", c.text!];
        if (c.command === "pick") args.push("--options", c.options!.join(","));
        if (c.command === "rate") for (const l of c.levels!) args.push("--level", l);
        r = await run(args);
        check = checkPrimitive(r, c.expect);
        break;
      }
      default:
        throw new Error(`unknown recipe ${suite.recipe}`);
    }
    return { ...base, pass: check.pass, detail: check.detail, ...usageOf(r) };
  } catch (err) {
    return { ...base, pass: false, detail: `error: ${(err as Error).message}`, input_tokens: 0, output_tokens: 0, ms: 0, cached: false, calls: 0 };
  }
}

function loadSuites(): Suite[] {
  return readdirSync(CASES_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => parseYaml(readFileSync(join(CASES_DIR, f), "utf8")) as Suite)
    .filter((s) => !only || only.includes(s.recipe));
}

function pct(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : "-";
}

async function mainEval(): Promise<void> {
  process.chdir(ROOT); // rank/files labels become repo-relative
  const suites = loadSuites();
  const results: CaseResult[] = [];
  for (const suite of suites) {
    for (const c of suite.cases) {
      const r = await runCase(suite, c);
      results.push(r);
      if (verbose || !r.pass) console.log(`${r.pass ? "PASS" : "FAIL"}  ${suite.recipe}/${c.name}: ${r.detail}`);
    }
  }

  const byRecipe = new Map<string, CaseResult[]>();
  for (const r of results) byRecipe.set(r.recipe, [...(byRecipe.get(r.recipe) ?? []), r]);
  console.log("\nrecipe        pass     tokens_in   avg_ms  calls");
  for (const [recipe, list] of byRecipe) {
    const passed = list.filter((r) => r.pass).length;
    const tokens = list.reduce((s, r) => s + r.input_tokens, 0);
    const live = list.filter((r) => !r.cached && r.calls > 0);
    const ms = live.length ? Math.round(live.reduce((s, r) => s + r.ms, 0) / live.length) : 0;
    console.log(`${recipe.padEnd(12)} ${`${passed}/${list.length}`.padStart(5)} ${pct(passed, list.length).padStart(5)} ${String(tokens).padStart(10)} ${String(ms).padStart(8)} ${String(list.reduce((s, r) => s + r.calls, 0)).padStart(6)}`);
  }
  const passed = results.filter((r) => r.pass).length;
  const tokens = results.reduce((s, r) => s + r.input_tokens, 0);
  const cost = (tokens * 0.042) / 1_000_000;
  console.log(`${"total".padEnd(12)} ${`${passed}/${results.length}`.padStart(5)} ${pct(passed, results.length).padStart(5)} ${String(tokens).padStart(10)}   ~$${cost.toFixed(4)} at $0.042/1M in${results.some((r) => r.cached) ? " (some cached)" : ""}`);

  const report: Report = { ts: new Date().toISOString(), model: model ?? "jev-latest", results };

  if (compare) {
    const prev = JSON.parse(readFileSync(resolve(compare), "utf8")) as Report;
    const prevMap = new Map(prev.results.map((r) => [`${r.recipe}/${r.name}`, r]));
    const regressions = results.filter((r) => !r.pass && prevMap.get(`${r.recipe}/${r.name}`)?.pass);
    const fixes = results.filter((r) => r.pass && prevMap.get(`${r.recipe}/${r.name}`)?.pass === false);
    const prevPassed = prev.results.filter((r) => r.pass).length;
    console.log(`\ncompare to ${compare} (${prev.model}, ${prev.ts.slice(0, 10)}): ${prevPassed}/${prev.results.length} -> ${passed}/${results.length}`);
    for (const r of fixes) console.log(`  fixed      ${r.recipe}/${r.name}: ${r.detail}`);
    for (const r of regressions) console.log(`  regressed  ${r.recipe}/${r.name}: ${r.detail}`);
    if (!fixes.length && !regressions.length) console.log("  no case changed outcome");
    if (regressions.length) process.exitCode = 1;
  }

  if (saveArg) {
    if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
    const name = saveArg === "timestamp" ? `${report.ts.replace(/[:.]/g, "-")}-${report.model}.json` : saveArg.endsWith(".json") ? saveArg : `${saveArg}.json`;
    const file = join(RESULTS_DIR, name);
    writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
    console.log(`\nsaved ${file}`);
  }
}

await mainEval();
