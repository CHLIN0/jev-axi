import { describe, expect, it } from "vitest";
import { numberFlag, parseArgs } from "../src/args.js";
import { AxiError } from "../src/errors.js";

describe("parseArgs", () => {
  it("parses positionals, values, bools, and repeatable flags", () => {
    const p = parseArgs(["q", "--option", "a", "--option=b", "--full", "--state", "-", "file"], { "--option": "multi", "--state": "value" }, "pick");
    expect(p.positional).toEqual(["q", "file"]);
    expect(p.multi["--option"]).toEqual(["a", "b"]);
    expect(p.bools["--full"]).toBe(true);
    expect(p.values["--state"]).toBe("-");
  });

  it("rejects unknown flags with exit code 2 and the valid list", () => {
    try {
      parseArgs(["--optoin", "a"], { "--option": "multi" }, "pick");
      throw new Error("expected throw");
    } catch (e) {
      const err = e as AxiError;
      expect(err).toBeInstanceOf(AxiError);
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err.message).toContain("unknown flag --optoin");
      expect(err.suggestions[0]).toContain("--option");
    }
  });

  it("gives a targeted hint for renamed flags", () => {
    try {
      parseArgs(["--file", "x"], {}, "check");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as AxiError).suggestions[0]).toMatch(/renamed; use --state/);
    }
  });

  it("requires values and rejects duplicates", () => {
    expect(() => parseArgs(["--state"], { "--state": "value" }, "check")).toThrow(/requires a value/);
    expect(() => parseArgs(["--state", "a", "--state", "b"], { "--state": "value" }, "check")).toThrow(/only be given once/);
  });

  it("treats negative numbers and '-' as values, not flags", () => {
    const p = parseArgs(["--min", "-1", "-"], { "--min": "value" }, "rank");
    expect(p.values["--min"]).toBe("-1");
    expect(p.positional).toEqual(["-"]);
  });

  it("validates numeric flags with bounds", () => {
    const p = parseArgs(["--top", "5"], { "--top": "value" }, "rank");
    expect(numberFlag(p, "--top", 10, 1)).toBe(5);
    expect(() => numberFlag(parseArgs(["--top", "x"], { "--top": "value" }, "rank"), "--top", 1)).toThrow(/must be a number/);
    expect(() => numberFlag(parseArgs(["--top", "0"], { "--top": "value" }, "rank"), "--top", 1, 1)).toThrow(/>= 1/);
  });
});
