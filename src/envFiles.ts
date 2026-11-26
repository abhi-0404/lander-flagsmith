import { existsSync, readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { parseEnv } from "node:util";

/**
 * Load dotenv files into process.env, later files overriding earlier ones, and real shell variables beating all of
 * them. (Node's `process.loadEnvFile` never overrides, and an empty `KEY=` in a copied .env.example would otherwise
 * block a second file.) `LANDER_ENV_FILE` (set in the shell, never in a file) names extra files, separated by the
 * platform path delimiter, for example `LANDER_ENV_FILE=.env.local-stack` for a self-hosted Flagsmith.
 */
export function loadEnvFiles(base: string[] = [".env"], env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env["LANDER_ENV_FILE"] ?? "").split(delimiter).map((s) => s.trim()).filter(Boolean);
  const shell = new Set(Object.keys(env));
  const loaded: string[] = [];
  for (const file of [...base, ...extra]) {
    if (!existsSync(file)) {
      if (extra.includes(file)) throw new Error(`LANDER_ENV_FILE: file not found: ${file}`);
      continue;
    }
    for (const [k, v] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
      if (!shell.has(k) && v !== undefined) env[k] = v;
    }
    loaded.push(file);
  }
  return loaded;
}
