import { readFileSync } from "node:fs";
import { isatty } from "node:tty";

export function isStdinTTY(): boolean {
  return isatty(0);
}

export function readStdinSync(): string {
  return readFileSync(0, "utf8");
}
