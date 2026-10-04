import { describe, expect, test } from "bun:test";
import { BACKMERGE_CONFLICT_PATH, resolveDiagnosticArtifactBackmerge } from "./release";

const DEV = `{
  "schema": "gjc.diagnostic-artifact",
  "version": "0.18.6",
  "artifacts": {
    "pi_natives.darwin-arm64.node": "dev-digest"
  }
}
`;

const MAIN = `{
  "schema": "gjc.diagnostic-artifact",
  "version": "0.18.7",
  "artifacts": {
    "pi_natives.darwin-arm64.node": "main-digest"
  }
}
`;

describe("backmerge conflict resolution", () => {
	test("keeps the released version and dev's artifact digests", () => {
		const resolved = JSON.parse(resolveDiagnosticArtifactBackmerge(DEV, MAIN)) as Record<string, unknown>;
		expect(resolved).toEqual({
			schema: "gjc.diagnostic-artifact",
			version: "0.18.7",
			artifacts: { "pi_natives.darwin-arm64.node": "dev-digest" },
		});
		expect(resolveDiagnosticArtifactBackmerge(DEV, MAIN).endsWith("\n")).toBe(true);
	});

	test("fails closed when main carries no released version", () => {
		expect(() => resolveDiagnosticArtifactBackmerge(DEV, `{"artifacts":{}}`)).toThrow(/no string version/);
	});

	test("fails closed when dev carries no artifacts map", () => {
		expect(() => resolveDiagnosticArtifactBackmerge(`{"version":"0.18.6"}`, MAIN)).toThrow(/no artifacts map/);
	});

	test("names the one path a backmerge may conflict on", () => {
		expect(BACKMERGE_CONFLICT_PATH).toBe("packages/natives/native/diagnostic-artifact.json");
	});
});
