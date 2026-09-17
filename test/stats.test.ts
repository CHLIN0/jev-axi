import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { dailySeries, projectName, sparkline, sumBands, trendLabel, type UsageEntry } from "../src/usage.js";

describe("trend helpers", () => {
  it("renders sparklines scaled to the max", () => {
    expect(sparkline([0, 1, 2, 4])).toBe("▁▃▅█");
    expect(sparkline([0, 0])).toBe("▁▁");
  });
  it("labels period changes", () => {
    expect(trendLabel(12, 10)).toBe("+20%");
    expect(trendLabel(5, 10)).toBe("-50%");
    expect(trendLabel(3, 0)).toBe("new");
    expect(trendLabel(0, 0)).toBe("flat");
  });
  it("zero-fills daily series and sums bands", () => {
    const now = new Date("2026-09-16T12:00:00Z");
    const e = (ts: string, bands = { act: 1, confirm: 0, escalate: 0 }): UsageEntry => ({ ts, cmd: "check", model: "m", in: 100, out: 0, ms: 1, q: 1, cached: false, bands });
    const s = dailySeries([e("2026-09-16T01:00:00Z"), e("2026-09-14T01:00:00Z"), e("2026-09-14T02:00:00Z")], 3, now);
    expect(s.map((d) => [d.day, d.calls])).toEqual([["2026-09-14", 2], ["2026-09-15", 0], ["2026-09-16", 1]]);
    expect(sumBands([e("x"), e("y", { act: 0, confirm: 1, escalate: 2 })])).toEqual({ act: 1, confirm: 1, escalate: 2 });
  });
  it("names the project from the git root", () => {
    const dir = mkdtempSync(join(tmpdir(), "proj-"));
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    expect(projectName(join(dir, "a", "b"))).toBe(basename(dir));
  });
});

describe("stats command", () => {
  let out = "";
  const stdout = { write: (s: string) => { out += s; return true; } };
  let dir: string;
  beforeEach(() => {
    out = "";
    dir = mkdtempSync(join(tmpdir(), "jev-stats-"));
    process.env["XDG_CONFIG_HOME"] = join(dir, "config");
    process.env["XDG_STATE_HOME"] = join(dir, "state");
    process.env["XDG_CACHE_HOME"] = join(dir, "cache");
  });
  afterEach(() => { process.exitCode = 0; });

  it("reports an empty ledger definitively", async () => {
    await main(["stats"], stdout);
    expect(out).toContain("stats: 0 calls recorded yet");
  });

  it("migrates a legacy ledger and renders lifetime, trends, and breakdowns", async () => {
    const legacy = join(dir, "state", "jev-axi");
    mkdirSync(legacy, { recursive: true });
    const today = new Date().toISOString();
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const rows: UsageEntry[] = [
      { ts: today, cmd: "diff", model: "m", in: 20000, out: 100, ms: 900, q: 12, cached: false, project: "askjev", bands: { act: 8, confirm: 3, escalate: 1 } },
      { ts: today, cmd: "check", model: "m", in: 300, out: 10, ms: 300, q: 1, cached: true, project: "askjev", bands: { act: 1, confirm: 0, escalate: 0 } },
      { ts: old, cmd: "check", model: "m", in: 300, out: 10, ms: 300, q: 1, cached: false, project: "other" },
    ];
    writeFileSync(join(legacy, "usage.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await main(["stats"], stdout);
    expect(out.replace(/\\\\/g, "\\")).toContain(join(dir, "config", "jev-axi", "stats", "usage.jsonl"));
    expect(out).toMatch(/lifetime: "?since/);
    expect(out).toContain("3 calls, 14 questions");
    expect(out).toMatch(/calls: "?2 \(\+100%\)/);
    expect(out).toContain("13 answers: act 69%, confirm 23%, escalate 8%");
    expect(out).toMatch(/trend_calls_30d: [▁-█]{30}/u);
    expect(out).toContain("by_command[2]{command,calls,share,avg_q,avg_in,avg_ms,act,cost}:");
    expect(out).toMatch(/biggest_call: "?diff on/);
    expect(out).toMatch(/cache: "?50% hit rate/);
  });
});
