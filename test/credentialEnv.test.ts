import { describe, expect, it } from "vitest";
import { credentialEnv } from "../src/flagsmith/cli.js";

describe("credentialEnv (environment for the flagsmith CLI child process)", () => {
  it("passes FLAGSMITH_PROJECT_ID as FLAGSMITH_PROJECT so flag get/update know the project", () => {
    expect(credentialEnv({ FLAGSMITH_PROJECT_ID: "2" })).toEqual({ FLAGSMITH_PROJECT: "2" });
  });

  it("never overrides a FLAGSMITH_PROJECT set in the shell", () => {
    expect(credentialEnv({ FLAGSMITH_PROJECT_ID: "2", FLAGSMITH_PROJECT: "7" })).toEqual({});
  });

  it("scopes the API key to a self-hosted host, keeps Cloud on the plain key", () => {
    expect(credentialEnv({ FLAGSMITH_API_URL: "http://localhost:8000", FLAGSMITH_API_KEY: "k" })).toEqual({
      FLAGSMITH_API_KEY_localhost_8000: "k",
    });
    expect(credentialEnv({ FLAGSMITH_API_URL: "https://api.flagsmith.com", FLAGSMITH_API_KEY: "k" })).toEqual({});
    expect(credentialEnv({ FLAGSMITH_API_URL: "not a url", FLAGSMITH_API_KEY: "k", FLAGSMITH_PROJECT_ID: "2" })).toEqual({
      FLAGSMITH_PROJECT: "2",
    });
  });
});
