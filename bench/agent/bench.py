#!/usr/bin/env python3
"""Agent benchmark: does Claude Code finish real tasks cheaper with the jev-axi skill?

Each task runs as a headless `claude -p` session in its own copy of a pinned repository,
under two conditions:

  baseline  no jev-axi skill and no jev-axi on PATH (plain Claude Code)
  jev-axi   the skill installed in the project's .claude/skills and jev-axi on PATH

The prompt never mentions jev-axi, so this measures whether the skill triggers on its own
and whether it pays off. Per run it records Claude's cost, turns, duration and token usage
(from --output-format json), Jev's token spend (from an isolated jev-axi ledger), how many
jev-axi commands ran (from the session transcript), and whether the answer matched.

This spends real Claude and TypeSafe credits. Start small:

    python3 bench/agent/bench.py --repo ~/Work/t3code --repeats 1 --only theme-size-limits
    python3 bench/agent/bench.py --repo ~/Work/t3code --repeats 2 --model sonnet --parallel 4

Results: bench/agent/results/<timestamp>/runs.jsonl and summary.md (gitignored).
"""
import argparse
import concurrent.futures as cf
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

try:
    import yaml  # PyYAML
except ImportError:  # pragma: no cover
    yaml = None

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SKILL_DIR = ROOT / "skills" / "jev-axi"
JEV_BIN = ROOT / "dist" / "bin" / "jev-axi.js"
JEV_PRICE_PER_M = 0.042


def load_tasks(path: Path) -> dict:
    text = path.read_text()
    if yaml:
        return yaml.safe_load(text)
    out = subprocess.run(["node", "-e", "const y=require('yaml');process.stdout.write(JSON.stringify(y.parse(require('fs').readFileSync(0,'utf8'))))"],
                         input=text, capture_output=True, text=True, cwd=ROOT, check=True)
    return json.loads(out.stdout)


def export_repo(repo: Path, commit: str, dest: Path) -> None:
    """Tracked files at the pinned commit, without node_modules or build output."""
    dest.mkdir(parents=True, exist_ok=True)
    archive = subprocess.run(["git", "-C", str(repo), "archive", "--format=tar", commit], capture_output=True, check=True)
    subprocess.run(["tar", "-x", "-C", str(dest)], input=archive.stdout, check=True)
    subprocess.run(["git", "init", "-q"], cwd=dest, check=True)
    subprocess.run(["git", "add", "-A"], cwd=dest, check=True)
    subprocess.run(["git", "-c", "user.name=bench", "-c", "user.email=bench@local", "commit", "-qm", f"pinned {commit}"], cwd=dest, check=True)


def make_jev_shim(bin_dir: Path, xdg_config: Path, xdg_cache: Path) -> None:
    """A `jev-axi` on PATH that uses this repo's build, the dev key, and an isolated ledger."""
    bin_dir.mkdir(parents=True, exist_ok=True)
    env_file = ROOT / ".env"
    shim = bin_dir / "jev-axi"
    shim.write_text(
        "#!/usr/bin/env bash\n"
        f"[ -f '{env_file}' ] && {{ set -a; . '{env_file}'; set +a; }}\n"
        f"export XDG_CONFIG_HOME='{xdg_config}' XDG_CACHE_HOME='{xdg_cache}'\n"
        f"exec node '{JEV_BIN}' \"$@\"\n"
    )
    shim.chmod(0o755)


def jev_spend(xdg_config: Path) -> dict:
    ledger = xdg_config / "jev-axi" / "stats" / "usage.jsonl"
    if not ledger.exists():
        return {"jev_calls": 0, "jev_input_tokens": 0, "jev_cost_usd": 0.0}
    rows = [json.loads(l) for l in ledger.read_text().splitlines() if l.strip()]
    tokens = sum(r["in"] for r in rows if not r.get("cached"))
    return {"jev_calls": len(rows), "jev_input_tokens": tokens, "jev_cost_usd": tokens * JEV_PRICE_PER_M / 1e6}


def transcript_stats(session_id: str) -> dict:
    """Count jev-axi invocations, skill loads, file reads, and subagents across the session
    transcript and every subagent transcript it spawned (Claude Code often explores in subagents)."""
    projects = Path.home() / ".claude" / "projects"
    main = list(projects.glob(f"*/{session_id}.jsonl"))
    subs = list(projects.glob(f"*/{session_id}/subagents/*.jsonl"))
    stats = {"jev_commands": 0, "skill_loaded": False, "file_reads": 0, "searches": 0, "tool_calls": 0, "subagents": len(subs), "jev_in_subagents": 0}
    for path in main + subs:
        in_sub = path in subs
        for line in path.read_text(errors="ignore").splitlines():
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            m = e.get("message")
            if not isinstance(m, dict) or e.get("type") != "assistant":
                continue
            for b in m.get("content") or []:
                if not isinstance(b, dict) or b.get("type") != "tool_use":
                    continue
                stats["tool_calls"] += 1
                name, inp = b.get("name"), b.get("input") or {}
                text = json.dumps(inp)
                cmd = str(inp.get("command", ""))
                if re.search(r"(?<![\w/.-])jev-axi\s+\w", text):
                    stats["jev_commands"] += 1
                    stats["jev_in_subagents"] += int(in_sub)
                if (name == "Skill" and "jev-axi" in text) or "skills/jev-axi/SKILL.md" in text:
                    stats["skill_loaded"] = True
                if name == "Read" or (name == "Bash" and re.search(r"(^|&&\s*|;\s*)(cat|sed -n|head|tail|nl)\b", cmd)):
                    stats["file_reads"] += 1
                if name in ("Grep", "Glob") or (name == "Bash" and re.search(r"(^|&&\s*|;\s*)(grep|rg|find|ls)\b", cmd)):
                    stats["searches"] += 1
    return stats


JEV_CONDITIONS = ("jev-axi", "jev-axi-hook", "jev-axi-agent", "jev-axi-explore", "jev-axi-forced")


def grade(task: dict, answer: str) -> list[str]:
    """Patterns the answer failed. `expect` needs all; `expect_min` needs at least `min` of `patterns`."""
    missing = [p for p in task.get("expect", []) if not re.search(p, answer, re.I)]
    if "expect_min" in task:
        spec = task["expect_min"]
        found = [p for p in spec["patterns"] if re.search(p, answer, re.I)]
        if len(found) < spec["min"]:
            missing.append(f"only {len(found)}/{spec['min']} of {len(spec['patterns'])} required: found {found}")
    return missing


def run_one(task: dict, condition: str, rep: int, base: Path, work: Path, args) -> dict:
    run_dir = work / f"{task['name']}__{condition}__r{rep}"
    shutil.rmtree(run_dir, ignore_errors=True)
    run_dir.mkdir(parents=True)
    repo_dir = run_dir / "repo"
    subprocess.run(["cp", "-r", str(base), str(repo_dir)], check=True)
    env = dict(os.environ)
    env.pop("TYPESAFE_API_KEY", None)
    xdg_config, xdg_cache = run_dir / "jev-config", run_dir / "jev-cache"
    if condition in JEV_CONDITIONS:
        dest = repo_dir / ".claude" / "skills" / "jev-axi"
        shutil.copytree(SKILL_DIR, dest, dirs_exist_ok=True)
        make_jev_shim(run_dir / "bin", xdg_config, xdg_cache)
        env["PATH"] = f"{run_dir / 'bin'}:{env['PATH']}"
    if condition == "jev-axi-hook":
        # What `jev-axi setup hooks --project` installs: the home view as SessionStart context.
        settings = repo_dir / ".claude" / "settings.json"
        data = json.loads(settings.read_text()) if settings.exists() else {}
        data.setdefault("hooks", {}).setdefault("SessionStart", []).append(
            {"matcher": "", "hooks": [{"type": "command", "command": "jev-axi", "timeout": 10}]}
        )
        settings.write_text(json.dumps(data, indent=2))
    if condition in ("jev-axi-agent", "jev-axi-explore"):
        # What `jev-axi setup agent --project [--replace-explore]` installs.
        extra = ["--replace-explore"] if condition == "jev-axi-explore" else []
        subprocess.run([str(run_dir / "bin" / "jev-axi"), "setup", "agent", "--project", *extra],
                       cwd=repo_dir, env=env, check=True, capture_output=True)
    if condition == "baseline":
        # Make sure no jev-axi is reachable in the baseline.
        env["PATH"] = ":".join(p for p in env["PATH"].split(":") if "askjev" not in p and "jev-axi" not in p)
    prompt = task["prompt"].strip()
    if condition == "jev-axi-forced":
        # Upper bound: tell the agent to use jev-axi, to measure what it saves when it is used.
        prompt += ("\n\nUse the jev-axi CLI (see .claude/skills/jev-axi/SKILL.md) to locate relevant code before "
                   "reading files: start with `jev-axi files` on the relevant directories and use `jev-axi find` "
                   "for long files. If you delegate exploration to a subagent, tell it to do the same.")
    cmd = ["claude", "-p", prompt, "--output-format", "json", "--model", args.model,
           "--allowedTools", "Bash", "Read", "Grep", "Glob", "Skill"]
    started = time.time()
    proc = subprocess.run(cmd, cwd=repo_dir, env=env, capture_output=True, text=True, timeout=args.timeout)
    wall = time.time() - started
    try:
        out = json.loads(proc.stdout)
    except json.JSONDecodeError:
        out = {"result": proc.stdout[-2000:], "is_error": True}
    answer = str(out.get("result") or "")
    missing = grade(task, answer)
    usage = out.get("usage") or {}
    row = {
        "task": task["name"], "condition": condition, "rep": rep, "model": args.model,
        "correct": not missing and not out.get("is_error"), "missing": missing,
        "claude_cost_usd": out.get("total_cost_usd"), "turns": out.get("num_turns"),
        # The CLI's duration_ms excludes subagent time, so wall-clock is the honest number.
        "duration_s": round(wall, 1),
        "cli_duration_s": round((out.get("duration_ms") or 0) / 1000, 1),
        "input_tokens": usage.get("input_tokens"), "cache_read_tokens": usage.get("cache_read_input_tokens"),
        "cache_write_tokens": usage.get("cache_creation_input_tokens"), "output_tokens": usage.get("output_tokens"),
        "session_id": out.get("session_id"),
        **jev_spend(xdg_config),
        **(transcript_stats(out["session_id"]) if out.get("session_id") else {}),
        "answer": answer[:4000],
    }
    row["total_cost_usd"] = round((row["claude_cost_usd"] or 0) + row["jev_cost_usd"], 4)
    if not args.keep:
        shutil.rmtree(repo_dir, ignore_errors=True)
    return row


def summarize(rows: list[dict]) -> str:
    def med(xs):
        xs = [x for x in xs if isinstance(x, (int, float))]
        return statistics.median(xs) if xs else float("nan")

    lines = ["# Agent benchmark", "", f"Runs: {len(rows)}", "",
             "| task | condition | correct | cost $ (median) | turns | duration s | file reads | subagents | jev cmds | skill loaded |",
             "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    tasks = sorted({r["task"] for r in rows})
    for t in tasks + ["ALL"]:
        for c in ("baseline", *JEV_CONDITIONS):
            rs = [r for r in rows if (t == "ALL" or r["task"] == t) and r["condition"] == c]
            if not rs:
                continue
            lines.append(
                f"| {t} | {c} | {sum(r['correct'] for r in rs)}/{len(rs)} | {med([r['total_cost_usd'] for r in rs]):.3f} | "
                f"{med([r['turns'] for r in rs]):.0f} | {med([r['duration_s'] for r in rs]):.0f} | {med([r.get('file_reads', 0) for r in rs]):.0f} | {med([r.get('subagents', 0) for r in rs]):.0f} | "
                f"{med([r.get('jev_commands', 0) for r in rs]):.0f} | {sum(bool(r.get('skill_loaded')) for r in rs)}/{len(rs)} |")
    b = [r for r in rows if r["condition"] == "baseline"]
    cb = sum(r["total_cost_usd"] for r in b) / len(b) if b else 0
    for c in JEV_CONDITIONS:
        j = [r for r in rows if r["condition"] == c]
        if b and j and cb:
            cj = sum(r["total_cost_usd"] for r in j) / len(j)
            lines += ["", f"Mean cost per run: baseline ${cb:.3f}, {c} ${cj:.3f} ({(cj - cb) / cb:+.0%})"]
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="local clone of the repo named in tasks.yaml")
    ap.add_argument("--tasks", default=str(HERE / "tasks.yaml"))
    ap.add_argument("--only", help="comma-separated task names")
    ap.add_argument("--conditions", default="baseline,jev-axi")
    ap.add_argument("--repeats", type=int, default=1)
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--parallel", type=int, default=2)
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--keep", action="store_true", help="keep per-run repo copies")
    ap.add_argument("--rescore", help="regrade an existing results dir with the current tasks.yaml")
    args = ap.parse_args()

    if args.rescore:
        spec = load_tasks(Path(args.tasks))
        by_name = {t["name"]: t for t in spec["tasks"]}
        path = Path(args.rescore) / "runs.jsonl"
        rows = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
        for r in rows:
            if r.get("task") in by_name and "answer" in r:
                r["missing"] = grade(by_name[r["task"]], r["answer"])
                r["correct"] = not r["missing"]
            if r.get("session_id"):
                r.update(transcript_stats(r["session_id"]))
        path.write_text("".join(json.dumps(r) + "\n" for r in rows))
        (Path(args.rescore) / "summary.md").write_text(summarize(rows))
        print(summarize(rows))
        return

    if not JEV_BIN.exists():
        sys.exit("build jev-axi first: pnpm build")
    spec = load_tasks(Path(args.tasks))
    tasks = [t for t in spec["tasks"] if not args.only or t["name"] in args.only.split(",")]
    stamp = time.strftime("%Y%m%dT%H%M%S")
    results = HERE / "results" / stamp
    results.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="jev-bench-"))
    base = work / "base"
    print(f"exporting {spec['repo']} @ {spec['commit']} ...", file=sys.stderr)
    export_repo(Path(args.repo).expanduser(), spec["commit"], base)

    jobs = [(t, c, r) for r in range(1, args.repeats + 1) for t in tasks for c in args.conditions.split(",")]
    rows = []
    with cf.ThreadPoolExecutor(max_workers=args.parallel) as pool:
        futures = {pool.submit(run_one, t, c, r, base, work, args): (t["name"], c, r) for t, c, r in jobs}
        for fut in cf.as_completed(futures):
            name, c, r = futures[fut]
            try:
                row = fut.result()
            except Exception as e:  # keep going; record the failure
                row = {"task": name, "condition": c, "rep": r, "error": str(e), "correct": False, "total_cost_usd": 0}
            rows.append(row)
            with (results / "runs.jsonl").open("a") as f:
                f.write(json.dumps(row) + "\n")
            print(f"{name:24} {c:9} r{r}  correct={row.get('correct')}  ${row.get('total_cost_usd')}  turns={row.get('turns')}  jev={row.get('jev_commands')}", file=sys.stderr)
    (results / "summary.md").write_text(summarize(rows))
    print(summarize(rows))
    print(f"results: {results}", file=sys.stderr)
    shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
