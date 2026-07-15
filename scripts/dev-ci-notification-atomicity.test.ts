import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const workflowPath = path.join(import.meta.dir, "..", ".github", "workflows", "dev-ci.yml");

async function workflow(): Promise<string> {
	return Bun.file(workflowPath).text();
}

function jobSection(workflowText: string, jobName: string): string {
	const jobs = [...workflowText.matchAll(/^ {2}[a-z][a-z0-9-]*:$/gmu)];
	const current = jobs.find(job => job[0] === `  ${jobName}:`);
	expect(current).toBeDefined();
	const start = current!.index!;
	const next = jobs.find(job => job.index! > start);
	return workflowText.slice(start, next?.index);
}

describe("Windows notification atomicity CI topology", () => {
	test("stages and loads the baseline addon before exact, separately counted atomicity suites", async () => {
		const devCi = await workflow();
		const windows = jobSection(devCi, "notification-atomic-windows");
		const aggregate = jobSection(devCi, "affected");

		expect(windows).toContain("name: Notification atomicity / Windows");
		expect(windows).toContain("runs-on: windows-latest");
		expect(windows).toContain("toolchain: nightly-2026-04-29");
		expect(windows).toContain("TARGET_PLATFORM: win32");
		expect(windows).toContain("TARGET_ARCH: x64");
		expect(windows).toContain("TARGET_VARIANTS: baseline");
		expect(windows).toContain("packages/natives/native/pi_natives.win32-x64-baseline.node");
		expect(windows).toContain("Get-FileHash -LiteralPath $addonPath -Algorithm SHA256");
		expect(windows).toContain('$env:PI_NATIVE_VARIANT = "baseline"');
		expect(windows).toContain('import { h06FormatHashLines } from "./packages/natives/native/index.js"');
		expect(windows).toContain("run: bun test scripts/dev-ci-notification-atomicity.test.ts");

		const build = windows.indexOf("- name: Build native addon (win32-x64 baseline)");
		const proof = windows.indexOf("- name: Stage and prove win32-x64 baseline native addon");
		const renameExhaustion = windows.indexOf("- name: Verify Windows rename-exhaustion atomic replacement (1 test)");
		const causalPersistence = windows.indexOf("- name: Verify Windows causal atomic persistence (6 tests)");
		expect(build).toBeGreaterThanOrEqual(0);
		expect(proof).toBeGreaterThan(build);
		expect(renameExhaustion).toBeGreaterThan(proof);
		expect(causalPersistence).toBeGreaterThan(renameExhaustion);

		expect(windows).toContain(
			'bun test packages/coding-agent/test/config/atomic-yaml-patch.test.ts --test-name-pattern "keeps the old complete file and removes the temp file when rename exhausts"',
		);
		expect(windows).toContain('if ($summary -notmatch [regex]::Escape("Ran 1 test across 1 file."))');
		expect(windows).toContain(
			'bun test packages/coding-agent/test/settings-manager.test.ts --test-name-pattern "causally ordered atomic persistence"',
		);
		expect(windows).toContain('if ($summary -notmatch [regex]::Escape("Ran 6 tests across 1 file."))');

		expect(aggregate).toContain(
			"needs: [affected-plan, affected-native, affected-shards, windows-dev-doctor, notification-atomic-windows]",
		);
		expect(aggregate).toContain("windows_atomic='${{ needs.notification-atomic-windows.result }}'");
		expect(aggregate).toContain('test "$windows_atomic" = success');
	});
});
