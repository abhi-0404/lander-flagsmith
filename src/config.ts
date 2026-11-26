import { z } from "zod";
import { loadEnvFiles } from "./envFiles.js";

/** Environment variables Lander reads. See .env.example for the documented list. */
export const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().default(""),
  LANDER_MODEL: z.string().default("claude-sonnet-5-5"),
  LANDER_EXPLAIN_MODEL: z.string().default("claude-haiku-5-5"),

  FLAGSMITH_API_KEY: z.string().default(""),
  FLAGSMITH_API_URL: z.url().default("https://api.flagsmith.com"),
  FLAGSMITH_PROJECT_ID: z.string().default(""),
  LANDER_ENV_STAGING: z.string().default(""),
  LANDER_ENV_PRODUCTION: z.string().default(""),
  LANDER_PROTECTED_ENVS: z
    .string()
    .default("production")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),

  FLAGSMITH_MCP_URL: z.url().default("https://mcp.flagsmith.com"),
  FLAGSMITH_MCP_TRANSPORT: z.enum(["http", "stdio"]).default("http"),

  LANDER_REPO_PATH: z.string().default("../lander-demo-shop"),
  LANDER_BASE_BRANCH: z.string().default("main"),

  FLAGSMITH_SERVER_KEY_STAGING: z.string().default(""),
  FLAGSMITH_SERVER_KEY_PRODUCTION: z.string().default(""),
});

export type LanderConfig = z.infer<typeof envSchema>;

/** Parse and validate a plain env record. Throws a readable error on bad values. */
export function parseConfig(env: Record<string, string | undefined>): LanderConfig {
  // An empty value in .env (KEY=) means "use the default", so drop empty strings first.
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== "") cleaned[k] = v;
  }
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid Lander configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}

/** Load .env (plus any file named by LANDER_ENV_FILE, see envFiles.ts), then validate process.env. */
export function loadConfig(envFile = ".env"): LanderConfig {
  loadEnvFiles([envFile]);
  return parseConfig(process.env);
}

/** Settings that must be present before a command that talks to Flagsmith can run. */
export function requireFlagsmith(cfg: LanderConfig): void {
  const missing: string[] = [];
  if (!cfg.FLAGSMITH_API_KEY) missing.push("FLAGSMITH_API_KEY");
  if (!cfg.FLAGSMITH_PROJECT_ID) missing.push("FLAGSMITH_PROJECT_ID");
  if (missing.length > 0) {
    throw new Error(`Missing required settings: ${missing.join(", ")} (copy .env.example to .env)`);
  }
}

/**
 * Environment name (staging, production) to its API key. Anything else is taken to be a raw environment key,
 * so `--env <key>` works for a project that is not wired into .env.
 */
export function resolveEnvironmentKey(cfg: LanderConfig, name: string): string {
  const n = name.trim().toLowerCase();
  const named: Record<string, string> = { staging: cfg.LANDER_ENV_STAGING, production: cfg.LANDER_ENV_PRODUCTION };
  if (n in named) {
    const key = named[n] as string;
    if (!key) {
      throw new Error(`No key for environment "${name}": set LANDER_ENV_${n.toUpperCase()} in .env (copy .env.example)`);
    }
    return key;
  }
  return name.trim();
}
