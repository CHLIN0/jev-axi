import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/git.js";

describe("parseDiff", () => {
  it("splits files and counts lines with standard prefixes", () => {
    const text = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\ndiff --git a/b.md b/b.md\nnew file mode 100644\n--- /dev/null\n+++ b/b.md\n@@ -0,0 +1 @@\n+hi\n";
    const files = parseDiff(text);
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([["src/a.ts", 2, 1], ["b.md", 1, 0]]);
  });
  it("handles mnemonic prefixes and deleted files", () => {
    const text = "diff --git c/x.ts i/x.ts\n--- c/x.ts\n+++ i/x.ts\n@@ @@\n+a\ndiff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ @@\n-z\n";
    expect(parseDiff(text).map((f) => f.path)).toEqual(["x.ts", "gone.ts"]);
  });
  it("returns nothing for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });
});
