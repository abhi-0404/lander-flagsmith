import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiCall } from "./adapter.js";

/**
 * Offline transport for `lander scan --fixtures <dir>`: answers the same paths the adapter calls, from JSON files.
 *
 * Files (per experiment id N, a generic name is the fallback so a single-experiment capture works as is):
 *   experiments-list.json
 *   experiments-detail-<N>.json            or experiments-detail-running-with-data.json (when its id matches)
 *   experiments-results-<N>.json           or experiments-results.json
 *   experiments-exposures-<N>.json         or experiments-exposures.json
 *   features-list.json                     or features-list-with-env.json (optional, for "not mine" rows)
 * A missing results/exposures file answers `null` (not computed yet). POST refresh answers null (202, empty body).
 */
export function fixtureTransport(dir: string): ApiCall {
  const read = (name: string): unknown | undefined => {
    const p = join(dir, name);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as unknown) : undefined;
  };
  const first = (...names: string[]): unknown | undefined => {
    for (const n of names) {
      const v = read(n);
      if (v !== undefined) return v;
    }
    return undefined;
  };

  return async (method, path) => {
    const p = path.split("?")[0] ?? path;
    if (method === "POST" && /\/(results|exposures)\/refresh\/$/.test(p)) return null;
    if (method !== "GET") throw new Error(`fixture transport is read only: ${method} ${path}`);

    if (/^api\/v1\/environments\/[^/]+\/experiments\/$/.test(p)) {
      const v = read("experiments-list.json");
      if (v === undefined) throw new Error(`fixtures: ${join(dir, "experiments-list.json")} not found`);
      return v;
    }
    const m = /^api\/v1\/environments\/[^/]+\/experiments\/(\d+)\/(results\/|exposures\/)?$/.exec(p);
    if (m) {
      const id = m[1] as string;
      if (m[2] === "results/") return first(`experiments-results-${id}.json`, "experiments-results.json") ?? { results: null };
      if (m[2] === "exposures/") {
        return first(`experiments-exposures-${id}.json`, "experiments-exposures.json") ?? { exposures: null };
      }
      const detail = first(`experiments-detail-${id}.json`, "experiments-detail-running-with-data.json");
      if (detail && (detail as { id?: number }).id === Number(id)) return detail;
      throw new Error(`fixtures: no detail for experiment ${id}`);
    }
    if (/^api\/v1\/projects\/[^/]+\/features\/$/.test(p)) {
      const v = first("features-list.json", "features-list-with-env.json");
      if (v === undefined) throw new Error("fixtures: no features list");
      return v;
    }
    throw new Error(`fixtures: no answer for ${method} ${path}`);
  };
}
