import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { paths } from "../src/config.js";

describe("config dir migration", () => {
  it("adopts a leftover jev-cli directory when jev-axi does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "xdg-"));
    process.env["XDG_CONFIG_HOME"] = root;
    mkdirSync(join(root, "jev-cli"));
    writeFileSync(join(root, "jev-cli", "config.json"), "{}");
    expect(paths.configDir()).toBe(join(root, "jev-axi"));
    expect(existsSync(join(root, "jev-axi", "config.json"))).toBe(true);
    expect(existsSync(join(root, "jev-cli"))).toBe(false);
  });
});
