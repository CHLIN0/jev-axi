#!/usr/bin/env bash
# Agent benchmark: the same tasks with and without jev-axi available.
# Usage: REPEATS=3 MODEL=claude-sonnet-4-6 bench/agent/run.sh <repo-url> <tasks.yaml>
set -euo pipefail

REPO_URL="${1:?repo url}"
TASKS="${2:?tasks.yaml}"
REPEATS="${REPEATS:-1}"
MODEL="${MODEL:-claude-sonnet-4-6}"
OUT_DIR="$(dirname "$0")/results"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$(date -u +%Y%m%dT%H%M%SZ).jsonl"

command -v claude >/dev/null || { echo "claude CLI not found" >&2; exit 1; }
command -v jev-axi >/dev/null || { echo "jev-axi not on PATH (npm install -g jev-axi)" >&2; exit 1; }

# Parse tasks.yaml into TSV: name<TAB>prompt<TAB>check (requires node + yaml from this repo).
TSV="$(node --input-type=module -e '
import { readFileSync } from "node:fs";
import { parse } from "yaml";
const t = parse(readFileSync(process.argv[1], "utf8")).tasks;
for (const x of t) console.log([x.name, x.prompt.replace(/\s+/g, " ").trim(), x.check].join("\t"));
' "$TASKS")"

run_one() {
  local condition="$1" name="$2" prompt="$3" check="$4" rep="$5"
  local work; work="$(mktemp -d)"
  git clone -q --depth 1 "$REPO_URL" "$work/repo"
  if [ "$condition" = "jev-axi" ]; then
    cat >> "$work/repo/CLAUDE.md" <<'EOF'

Use `jev-axi` for snap judgments before reading files yourself:
`jev-axi files "<task>"` ranks files by relevance, `jev-axi find "<question>" <file>` locates lines,
and `<cmd> 2>&1 | jev-axi triage` finds the root cause of a failing log. Run `jev-axi --help` for more.
EOF
  fi
  local started; started="$(date +%s%3N)"
  local json
  json="$(cd "$work/repo" && claude -p "$prompt" --model "$MODEL" --output-format json --permission-mode acceptEdits 2>/dev/null || echo '{}')"
  local ended; ended="$(date +%s%3N)"
  local success=0
  if (cd "$work/repo" && bash -c "$check" >/dev/null 2>&1); then success=1; fi
  node --input-type=module -e '
const [condition, name, rep, success, wall, raw] = process.argv.slice(1);
let j = {}; try { j = JSON.parse(raw); } catch {}
console.log(JSON.stringify({ condition, task: name, rep: Number(rep), success: success === "1",
  cost_usd: j.total_cost_usd ?? null, turns: j.num_turns ?? null, duration_ms: j.duration_ms ?? Number(wall) }));
' "$condition" "$name" "$rep" "$success" "$((ended - started))" "$json" | tee -a "$OUT"
  rm -rf "$work"
}

while IFS=$'\t' read -r name prompt check; do
  for rep in $(seq 1 "$REPEATS"); do
    for condition in baseline jev-axi; do
      echo "== $condition / $name / rep $rep" >&2
      run_one "$condition" "$name" "$prompt" "$check" "$rep"
    done
  done
done <<< "$TSV"

echo
echo "summary (medians) from $OUT"
node --input-type=module -e '
import { readFileSync } from "node:fs";
const rows = readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => JSON.parse(l));
const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
for (const c of ["baseline", "jev-axi"]) {
  const r = rows.filter((x) => x.condition === c);
  const succ = r.filter((x) => x.success).length;
  console.log(`${c.padEnd(9)} success ${succ}/${r.length}  cost $${med(r.map((x) => x.cost_usd))?.toFixed(3)}  turns ${med(r.map((x) => x.turns))}  duration ${Math.round((med(r.map((x) => x.duration_ms)) ?? 0) / 1000)}s`);
}
' "$OUT"
