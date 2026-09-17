import type { Renderable as AxiRenderable } from "./common.js";
import { readConfig, resolveApiKey, resolveModel } from "../config.js";
import { cacheCount, todayUsageLine } from "./meta.js";
import { COMMAND_TABLE } from "./table.js";

export async function homeCommand(): Promise<AxiRenderable> {
  const config = readConfig();
  const key = resolveApiKey(config);
  const out: Record<string, unknown> = {
    key: key.key ? `ok (${key.source})` : "missing",
    model: resolveModel(undefined, config),
    usage: todayUsageLine(),
    cache: `${cacheCount()} responses`,
    commands: Object.fromEntries(COMMAND_TABLE.map(([need, cmd]) => [/jev-axi (\w+)/.exec(cmd)?.[1] ?? need, `${need}: ${cmd}`])),
  };
  const help: string[] = [];
  if (!key.key) help.push("Set TYPESAFE_API_KEY (or `jev-axi config set apiKey <key>`) before running questions");
  help.push("Output columns: p = probability, confidence 0..1, band = act | confirm | escalate");
  help.push("Piped stdin is the state when no --state is given. Run `jev-axi <command> --help` for flags");
  return { ...out, help };
}
