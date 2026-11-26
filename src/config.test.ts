import { describe, expect, it } from "vitest";
import { parseConfig, requireFlagsmith } from "./config.js";

describe("parseConfig", () => {
  it("applies the documented defaults for an empty environment", () => {
    const cfg = parseConfig({});
    expect(cfg.LANDER_MODEL).toBe("claude-sonnet-5-5");
    expect(cfg.LANDER_EXPLAIN_MODEL).toBe("claude-haiku-5-5");
    expect(cfg.FLAGSMITH_API_URL).toBe("https://api.flagsmith.com");
    expect(cfg.FLAGSMITH_MCP_TRANSPORT).toBe("http");
    expect(cfg.LANDER_PROTECTED_ENVS).toEqual(["production"]);
    expect(cfg.LANDER_BASE_BRANCH).toBe("main");
  });

  it("treats empty values from a copied .env.example as defaults", () => {
    const cfg = parseConfig({ FLAGSMITH_API_URL: "", LANDER_MODEL: "" });
    expect(cfg.FLAGSMITH_API_URL).toBe("https://api.flagsmith.com");
    expect(cfg.LANDER_MODEL).toBe("claude-sonnet-5-5");
  });

  it("splits protected environments on commas and trims", () => {
    const cfg = parseConfig({ LANDER_PROTECTED_ENVS: " production , staging ," });
    expect(cfg.LANDER_PROTECTED_ENVS).toEqual(["production", "staging"]);
  });

  it("rejects a bad URL and a bad MCP transport with a readable error", () => {
    expect(() => parseConfig({ FLAGSMITH_API_URL: "not a url" })).toThrow(/FLAGSMITH_API_URL/);
    expect(() => parseConfig({ FLAGSMITH_MCP_TRANSPORT: "carrier-pigeon" })).toThrow(
      /FLAGSMITH_MCP_TRANSPORT/,
    );
  });
});

describe("requireFlagsmith", () => {
  it("names every missing setting", () => {
    expect(() => requireFlagsmith(parseConfig({}))).toThrow(
      /FLAGSMITH_API_KEY, FLAGSMITH_PROJECT_ID/,
    );
  });

  it("passes when both are set", () => {
    const cfg = parseConfig({ FLAGSMITH_API_KEY: "k", FLAGSMITH_PROJECT_ID: "1" });
    expect(() => requireFlagsmith(cfg)).not.toThrow();
  });
});
