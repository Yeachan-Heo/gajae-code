import { describe, expect, test } from "bun:test";
import {
	BACKMERGE_CONFLICT_PATH,
	classifyBackmergePushFailure,
	resolveDiagnosticArtifactBackmerge,
} from "./release";

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

	test("fails closed on any manifest field the resolution depends on", () => {
		expect(() => resolveDiagnosticArtifactBackmerge(DEV, `{"artifacts":{}}`)).toThrow(
			new RegExp(`${BACKMERGE_CONFLICT_PATH} has no string version on main`),
		);
		expect(() => resolveDiagnosticArtifactBackmerge(`{"version":"0.18.6"}`, MAIN)).toThrow(/no string schema on dev/);
		expect(() => resolveDiagnosticArtifactBackmerge(`{"schema":"gjc.diagnostic-artifact"}`, MAIN)).toThrow(
			/no artifacts map on dev/,
		);
	});
});

describe("backmerge push rejection", () => {
	test("retries only when dev moved under the merge", () => {
		expect(classifyBackmergePushFailure(" ! [rejected]        HEAD -> dev (fetch first)")).toBe("retry");
		expect(classifyBackmergePushFailure(" ! [rejected]        HEAD -> dev (non-fast-forward)")).toBe("retry");
	});

	test("reports a terminal refusal instead of burning the remaining attempts", () => {
		// A protected-branch or permission rejection cannot succeed on a retry.
		expect(
			classifyBackmergePushFailure(
				"remote: error: GH006: Protected branch update failed for refs/heads/dev.\n ! [remote rejected] HEAD -> dev (protected branch hook declined)",
			),
		).toBe("blocked");
		expect(classifyBackmergePushFailure("fatal: Authentication failed for 'https://github.com/x/y.git/'")).toBe("blocked");
		expect(classifyBackmergePushFailure("")).toBe("blocked");
	});
});
