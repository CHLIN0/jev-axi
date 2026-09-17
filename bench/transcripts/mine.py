#!/usr/bin/env python3
"""Mine local Claude Code transcripts for where tokens go and where jev-axi could help.

Reads ~/.claude/projects/**/*.jsonl locally and writes aggregate numbers only (plus short,
truncated command examples) to bench/transcripts/out/. Nothing is sent anywhere.

    python3 bench/transcripts/mine.py [--days 30] [--root ~/.claude/projects]

How cost is estimated
- Each API call's usage is read from the transcript (deduplicated by message id). Input is
  expressed in "input-equivalent tokens": input + 1.25 x cache writes + 0.1 x cache reads,
  matching the relative prices of Anthropic prompt caching. Output tokens are reported separately.
- A tool result enters the context once and is then re-sent on every later call in the same
  transcript (as cache reads) until the transcript ends or is compacted. Its "carried cost" is
  tokens x (1.25 + 0.1 x later calls). This is what an oversized log or file read really costs.
- Tokens are estimated from characters at 4 chars per token.
"""
import argparse
import collections
import json
import os
import re
import sys
import time
from pathlib import Path

CHARS_PER_TOKEN = 4
EXCLUDE_CWD = re.compile(r"jev-axi-skill-workspace|^/tmp/")

# ---------------------------------------------------------------- classification

BUILD_TEST = re.compile(
    r"\b(npm|pnpm|yarn|bun|npx)\b[^|;&]*\b(test|build|lint|tsc|vitest|jest|eslint|check|typecheck|install|ci)\b"
    r"|\b(pytest|cargo (test|build|check|clippy)|go (test|build|vet)|make\b|gradle|mvn|tsc\b|vitest|jest|eslint|ruff|mypy)"
    r"|gh run (view|watch)[^|;&]*--log|docker (build|compose)|uv run (pytest|ruff|mypy)"
)
GIT_DIFF = re.compile(r"\bgit\b[^|;&]*\b(diff|show|log\b[^|;&]*-p)\b")
# Only a command at the start of a segment counts; `... | grep` or `... | tail` just filters output.
SEG = r"(?:^|(?<![|])[;&]\s*|&&\s*|\(\s*|\n\s*)"
SEARCH = re.compile(SEG + r"(grep|rg|egrep|fgrep|find|fd|ls|tree|git grep|git ls-files)\b")
FILE_READ = re.compile(SEG + r"(cat|sed -n|head|tail|less|nl|bat|awk)\b(?!\s*>)")
WEB = re.compile(SEG + r"(curl|wget)\b")


def strip_cd(cmd: str) -> str:
    """Drop leading `cd dir &&` and env exports so the real command is classified."""
    return re.sub(r"^(\s*(cd\s+\S+|export\s+[^;&]+|set\s+[^;&]+)\s*(&&|;)\s*)+", "", cmd.strip())


def classify(name: str, inp: dict) -> str:
    if name == "Read":
        return "file_read"
    if name in ("Grep", "Glob"):
        return "search"
    if name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        return "edit"
    if name in ("WebFetch", "WebSearch"):
        return "web"
    if name in ("Agent", "Task", "SendMessage"):
        return "agent"
    if name != "Bash":
        return "other"
    cmd = strip_cd(str(inp.get("command", "")))
    if BUILD_TEST.search(cmd):
        return "build_test"
    if GIT_DIFF.search(cmd):
        return "git_diff"
    if WEB.search(cmd):
        return "web"
    if re.search(r"(^|[;&|]\s*)(cat\s*>|tee\s|python3? - <<|sed -i|perl -pi)", cmd):
        return "edit"
    if FILE_READ.search(cmd):
        return "file_read"
    if SEARCH.search(cmd):
        return "search"
    return "other"


def read_paths(name: str, inp: dict) -> list[str]:
    if name == "Read":
        return [str(inp.get("file_path", ""))]
    if name == "Bash":
        cmd = strip_cd(str(inp.get("command", ""))).split("|")[0]
        if FILE_READ.search(cmd):
            return [t for t in re.findall(r"(?:^|\s)((?:/|\./|[\w.-]+/)[\w./@-]+\.\w+)", cmd)]
    return []


def result_chars(block: dict) -> int:
    c = block.get("content")
    if isinstance(c, str):
        return len(c)
    if isinstance(c, list):
        return sum(len(x.get("text", "")) for x in c if isinstance(x, dict))
    return 0


# ---------------------------------------------------------------- per-transcript analysis


def analyze(path: Path) -> dict | None:
    calls = {}  # message id -> usage
    call_order = []  # message ids in order
    tool_uses = {}  # tool_use_id -> (name, input, call index)
    results = []  # (tool_use_id, chars, call index at arrival)
    prompts = []  # call index when a real user prompt arrived
    cwd = None
    model = collections.Counter()
    compactions = []

    try:
        lines = path.read_text(errors="ignore").splitlines()
    except OSError:
        return None
    for line in lines:
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        cwd = cwd or e.get("cwd")
        if e.get("isCompactSummary") or e.get("type") == "summary":
            compactions.append(len(call_order))
        m = e.get("message")
        if not isinstance(m, dict):
            continue
        if e.get("type") == "assistant":
            mid = m.get("id") or e.get("requestId") or e.get("uuid")
            if mid not in calls and isinstance(m.get("usage"), dict):
                calls[mid] = m["usage"]
                call_order.append(mid)
                if m.get("model"):
                    model[m["model"]] += 1
            for b in m.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    tool_uses[b.get("id")] = (b.get("name", ""), b.get("input") or {}, len(call_order))
        elif e.get("type") == "user":
            content = m.get("content")
            if isinstance(content, str) and content.strip() and not content.startswith("<"):
                prompts.append(len(call_order))
            elif isinstance(content, list):
                has_text = any(isinstance(b, dict) and b.get("type") == "text" and not str(b.get("text", "")).startswith("<") for b in content)
                if has_text and not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
                    prompts.append(len(call_order))
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        results.append((b.get("tool_use_id"), result_chars(b), len(call_order)))

    if not call_order:
        return None
    if cwd and EXCLUDE_CWD.search(cwd):
        return {"excluded": True}
    # Subagent transcripts record the parent's cwd; exclude eval runs by where their tools worked.
    if path.parent.name == "subagents":
        worked = " ".join(json.dumps(inp) for _, inp, _ in tool_uses.values())
        if EXCLUDE_CWD.search(worked) or "jev-axi-skill-workspace" in worked:
            return {"excluded": True}

    n_calls = len(call_order)

    def usage_sum(key):
        return sum(int(calls[i].get(key) or 0) for i in call_order)

    input_equiv = usage_sum("input_tokens") + 1.25 * usage_sum("cache_creation_input_tokens") + 0.1 * usage_sum("cache_read_input_tokens")
    output = usage_sum("output_tokens")

    def carried(tokens: float, at_call: int) -> float:
        # calls after this result, until the next compaction
        end = next((c for c in compactions if c > at_call), n_calls)
        later = max(0, end - at_call)
        return tokens * (1.25 + 0.1 * later)

    by_cat = collections.defaultdict(lambda: {"calls": 0, "result_tokens": 0.0, "carried": 0.0})
    events = []  # (call_idx, category, tokens, carried, name, input, id)
    for tid, chars, at in results:
        if tid not in tool_uses:
            continue
        name, inp, _ = tool_uses[tid]
        cat = classify(name, inp)
        tok = chars / CHARS_PER_TOKEN
        car = carried(tok, at)
        by_cat[cat]["calls"] += 1
        by_cat[cat]["result_tokens"] += tok
        by_cat[cat]["carried"] += car
        events.append((at, cat, tok, car, name, inp, tid))
    events.sort(key=lambda x: x[0])

    # ---- opportunities
    opp = collections.defaultdict(lambda: {"count": 0, "tokens": 0.0, "carried": 0.0, "examples": []})

    def add(kind, tok, car, example):
        o = opp[kind]
        o["count"] += 1
        o["tokens"] += tok
        o["carried"] += car
        if len(o["examples"]) < 3 and example:
            o["examples"].append(example[:140])

    def short(name, inp):
        return f"{name}: {strip_cd(str(inp.get('command') or inp.get('file_path') or inp.get('pattern') or inp.get('url') or ''))}"

    # A. exploration bursts: reads/searches between a user prompt and the first edit
    boundaries = sorted(set(prompts)) + [n_calls + 1]
    for start, end in zip(boundaries, boundaries[1:]):
        seg = [ev for ev in events if start <= ev[0] < end]
        first_edit = next((i for i, ev in enumerate(seg) if ev[1] == "edit"), len(seg))
        explore = [ev for ev in seg[:first_edit] if ev[1] in ("file_read", "search")]
        if len(explore) >= 4:
            add("explore_before_edit", sum(e[2] for e in explore), sum(e[3] for e in explore), f"{len(explore)} reads/searches, first: {short(explore[0][4], explore[0][5])}")

    # G. files read during a task but never edited in that task (exploration that may not have mattered)
    for start, end in zip(boundaries, boundaries[1:]):
        seg = [ev for ev in events if start <= ev[0] < end]
        edited = set()
        for ev in seg:
            if ev[1] == "edit":
                fp = ev[5].get("file_path") or ""
                if fp:
                    edited.add(os.path.basename(fp))
                cmd = str(ev[5].get("command") or "")
                edited.update(os.path.basename(x) for x in re.findall(r"[\w./-]+\.\w+", cmd))
        if not edited:
            continue  # read-only tasks (reviews, questions) are not "wasted" reads
        for ev in seg:
            if ev[1] != "file_read":
                continue
            paths = [os.path.basename(p) for p in read_paths(ev[4], ev[5])]
            if paths and not any(p in edited for p in paths):
                add("read_not_edited", ev[2], ev[3], short(ev[4], ev[5]))

    seen_paths = collections.Counter()
    for at, cat, tok, car, name, inp, tid in events:
        # B. large build/test logs
        if cat == "build_test" and tok >= 1000:
            add("large_build_test_log", tok, car, short(name, inp))
        # C. large single file reads
        if cat == "file_read" and tok >= 2000:
            add("large_file_read", tok, car, short(name, inp))
        # D. re-reads of the same file
        for p in read_paths(name, inp):
            seen_paths[p] += 1
            if seen_paths[p] >= 2 and cat == "file_read":
                add("repeat_file_read", tok, car, p)
        # E. untrusted web content
        if cat == "web":
            add("web_content", tok, car, short(name, inp))
        # F. large diffs
        if cat == "git_diff" and tok >= 1000:
            add("large_git_diff", tok, car, short(name, inp))

    project = path.parts[-2] if path.parent.name != "subagents" else path.parts[-4]
    return {
        "file": str(path),
        "project": project,
        "subagent": path.parent.name == "subagents",
        "model": model.most_common(1)[0][0] if model else "?",
        "calls": n_calls,
        "prompts": len(prompts),
        "input_equiv": input_equiv,
        "output": output,
        "by_category": by_cat,
        "opportunities": opp,
    }


# ---------------------------------------------------------------- report


def fmt(n: float) -> str:
    n = float(n)
    if n >= 1e6:
        return f"{n / 1e6:.1f}M"
    if n >= 1e3:
        return f"{n / 1e3:.0f}k"
    return f"{n:.0f}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(Path.home() / ".claude" / "projects"))
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--out", default=str(Path(__file__).parent / "out"))
    args = ap.parse_args()

    cutoff = time.time() - args.days * 86400
    files = [p for p in Path(args.root).glob("**/*.jsonl") if p.stat().st_mtime >= cutoff]
    rows, excluded = [], 0
    for p in files:
        r = analyze(p)
        if r is None:
            continue
        if r.get("excluded"):
            excluded += 1
            continue
        rows.append(r)

    total_in = sum(r["input_equiv"] for r in rows)
    total_out = sum(r["output"] for r in rows)
    cats = collections.defaultdict(lambda: {"calls": 0, "result_tokens": 0.0, "carried": 0.0})
    opps = collections.defaultdict(lambda: {"count": 0, "tokens": 0.0, "carried": 0.0, "examples": [], "transcripts": 0})
    projects = collections.defaultdict(lambda: {"transcripts": 0, "input_equiv": 0.0, "output": 0})
    models = collections.Counter()
    for r in rows:
        models[r["model"]] += r["input_equiv"]
        pr = projects[r["project"]]
        pr["transcripts"] += 1
        pr["input_equiv"] += r["input_equiv"]
        pr["output"] += r["output"]
        for k, v in r["by_category"].items():
            for f in ("calls", "result_tokens", "carried"):
                cats[k][f] += v[f]
        for k, v in r["opportunities"].items():
            o = opps[k]
            o["count"] += v["count"]
            o["tokens"] += v["tokens"]
            o["carried"] += v["carried"]
            o["transcripts"] += 1
            for ex in v["examples"]:
                if len(o["examples"]) < 5:
                    o["examples"].append(ex)

    carried_total = sum(v["carried"] for v in cats.values())
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    summary = {
        "days": args.days,
        "transcripts": len(rows),
        "subagent_transcripts": sum(1 for r in rows if r["subagent"]),
        "excluded_transcripts": excluded,
        "api_calls": sum(r["calls"] for r in rows),
        "input_equiv_tokens": total_in,
        "output_tokens": total_out,
        "tool_result_carried_tokens": carried_total,
        "by_category": cats,
        "opportunities": opps,
        "projects": projects,
        "models_by_input_equiv": models,
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=dict))

    lines = [
        f"# Transcript mining: last {args.days} days",
        "",
        f"- Transcripts analyzed: {len(rows)} ({summary['subagent_transcripts']} subagent), excluded {excluded} sandbox/eval transcripts",
        f"- API calls: {summary['api_calls']}",
        f"- Input-equivalent tokens: {fmt(total_in)}; output tokens: {fmt(total_out)}",
        f"- Tool results carried through later calls: {fmt(carried_total)} input-equivalent ({carried_total / total_in:.0%} of all input)" if total_in else "",
        "",
        "## Where tool-result tokens go",
        "",
        "| category | calls | result tokens | carried cost | share of input |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for k, v in sorted(cats.items(), key=lambda kv: -kv[1]["carried"]):
        lines.append(f"| {k} | {v['calls']} | {fmt(v['result_tokens'])} | {fmt(v['carried'])} | {v['carried'] / total_in:.1%} |")
    lines += [
        "",
        "## jev-axi opportunities",
        "",
        "| pattern | occurrences | transcripts | tokens | carried cost | share of input | jev-axi command |",
        "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    cmd_for = {
        "explore_before_edit": "files, find",
        "large_build_test_log": "triage",
        "large_file_read": "find",
        "repeat_file_read": "find",
        "web_content": "guard (safety, not savings)",
        "large_git_diff": "diff",
        "read_not_edited": "files, find",
    }
    for k, v in sorted(opps.items(), key=lambda kv: -kv[1]["carried"]):
        lines.append(f"| {k} | {v['count']} | {v['transcripts']} | {fmt(v['tokens'])} | {fmt(v['carried'])} | {v['carried'] / total_in:.1%} | {cmd_for.get(k, '')} |")
    lines.append("")
    lines.append("Patterns overlap (a large read inside an exploration burst counts in both), so shares are not additive.")
    main_rows = [r for r in rows if not r["subagent"]]
    sub_rows = [r for r in rows if r["subagent"]]
    lines += ["", "## Main sessions vs subagents", "", "| kind | transcripts | API calls | input-equiv | output |", "| --- | ---: | ---: | ---: | ---: |"]
    for label, rs in (("main", main_rows), ("subagent", sub_rows)):
        lines.append(f"| {label} | {len(rs)} | {sum(r['calls'] for r in rs)} | {fmt(sum(r['input_equiv'] for r in rs))} | {fmt(sum(r['output'] for r in rs))} |")
    lines += ["", "### Examples (truncated)", ""]
    for k, v in opps.items():
        lines.append(f"**{k}**")
        lines += [f"- `{ex}`" for ex in v["examples"]]
        lines.append("")
    lines += ["## Projects", "", "| project | transcripts | input-equiv | output |", "| --- | ---: | ---: | ---: |"]
    for k, v in sorted(projects.items(), key=lambda kv: -kv[1]["input_equiv"]):
        lines.append(f"| {k} | {v['transcripts']} | {fmt(v['input_equiv'])} | {fmt(v['output'])} |")
    (out / "report.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
