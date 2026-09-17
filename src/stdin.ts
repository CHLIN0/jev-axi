import { fstatSync, readFileSync } from "node:fs";
import { isatty } from "node:tty";

export function isStdinTTY(): boolean {
  return isatty(0);
}

export function readStdinSync(): string {
  return readFileSync(0, "utf8");
}

/**
 * Piped input the user did not explicitly ask for with `-`: returns the text only
 * when stdin is a pipe or redirected file that actually carries content.
 *
 * Agent harnesses run commands non-interactively, usually with stdin attached to
 * /dev/null or an empty pipe. Treating that as "the input is empty" made commands
 * like `diff` review nothing, so an empty or device stdin means "no piped input".
 */
export function readImplicitStdin(): string | undefined {
  if (isStdinTTY()) return undefined;
  try {
    const st = fstatSync(0);
    if (!st.isFIFO() && !st.isFile() && !st.isSocket()) return undefined; // e.g. /dev/null
  } catch {
    return undefined;
  }
  const text = readStdinSync();
  return text.trim() === "" ? undefined : text;
}
