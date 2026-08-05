import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	collectGcDiskReport,
	collectNativesVersionCandidates,
	compareSemver,
	formatBytes,
	isOrderableSemver,
	pruneNativesVersionCandidate,
} from "@gajae-code/coding-agent/gjc-runtime/gc-disk";
import { runGjcGcCommand } from "@gajae-code/coding-agent/gjc-runtime/gc-runtime";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { SessionIndex } from "../src/sdk/broker/session-index";

const originalAgentDir = getAgentDir();
const tempDirs: string[] = [];

afterEach(async () => {
	setAgentDir(originalAgentDir);
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTemp(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function seedVersionDir(nativesDir: string, version: string, payload = "x"): Promise<string> {
	const dir = path.join(nativesDir, version);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "addon.node"), payload.repeat(100));
	return dir;
}

async function seedHealthySessionIndex(): Promise<string> {
	const agentDir = await makeTemp("gc-disk-session-index-");
	setAgentDir(agentDir);
	const index = await new SessionIndex(agentDir).open();
	await index.append({
		type: "host_registered",
		sessionId: "gc-disk-session",
		locator: { repo: "/tmp/repo", stateRoot: "/tmp/state" },
		endpointGeneration: 1,
		pid: process.pid,
		endpointMtimeMs: Date.now(),
	});
	return agentDir;
}

describe("semver helpers", () => {
	test("isOrderableSemver accepts release versions", () => {
		expect(isOrderableSemver("0.12.12")).toBe(true);
		expect(isOrderableSemver("1.0.0")).toBe(true);
		expect(isOrderableSemver("not-a-version")).toBe(false);
		expect(isOrderableSemver("")).toBe(false);
	});

	test("compareSemver orders ascending", () => {
		expect(compareSemver("0.11.7", "0.11.8")).toBeLessThan(0);
		expect(compareSemver("0.12.12", "0.11.8")).toBeGreaterThan(0);
		expect(compareSemver("0.12.12", "0.12.12")).toBe(0);
	});

	test("formatBytes uses binary units", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2 KiB");
	});
});

describe("collectNativesVersionCandidates", () => {
	test("keeps current and N older predecessors; excess is reclaimable", async () => {
		const nativesDir = await makeTemp("gc-disk-natives-");
		await seedVersionDir(nativesDir, "0.12.12", "current");
		await seedVersionDir(nativesDir, "0.11.8", "keep1");
		await seedVersionDir(nativesDir, "0.11.7", "keep2");
		await seedVersionDir(nativesDir, "0.5.1", "drop");
		await seedVersionDir(nativesDir, "0.4.0", "drop2");

		const { candidates, errors } = await collectNativesVersionCandidates({
			nativesDir,
			currentNativesVersion: "0.12.12",
			keepVersions: 2,
		});
		expect(errors).toEqual([]);

		const byId = Object.fromEntries(candidates.map(c => [c.id, c]));
		expect(byId["0.12.12"]?.removable).toBe(false);
		expect(byId["0.12.12"]?.status).toBe("current");
		expect(byId["0.11.8"]?.removable).toBe(false);
		expect(byId["0.11.8"]?.status).toBe("retained_predecessor");
		expect(byId["0.11.7"]?.removable).toBe(false);
		expect(byId["0.5.1"]?.removable).toBe(true);
		expect(byId["0.5.1"]?.action).toBe("would_remove");
		expect(byId["0.4.0"]?.removable).toBe(true);
		expect(byId["0.5.1"]?.bytes).toBeGreaterThan(0);
	});

	test("keepVersions=0 retains only the current version", async () => {
		const nativesDir = await makeTemp("gc-disk-natives-keep0-");
		await seedVersionDir(nativesDir, "0.12.12");
		await seedVersionDir(nativesDir, "0.11.8");

		const { candidates } = await collectNativesVersionCandidates({
			nativesDir,
			currentNativesVersion: "0.12.12",
			keepVersions: 0,
		});
		const byId = Object.fromEntries(candidates.map(c => [c.id, c]));
		expect(byId["0.12.12"]?.removable).toBe(false);
		expect(byId["0.11.8"]?.removable).toBe(true);
	});

	test("keeps versions newer than current (fail-closed)", async () => {
		const nativesDir = await makeTemp("gc-disk-natives-newer-");
		await seedVersionDir(nativesDir, "0.12.12");
		await seedVersionDir(nativesDir, "0.13.0");

		const { candidates } = await collectNativesVersionCandidates({
			nativesDir,
			currentNativesVersion: "0.12.12",
			keepVersions: 2,
		});
		const newer = candidates.find(c => c.id === "0.13.0");
		expect(newer?.removable).toBe(false);
		expect(newer?.status).toBe("newer_than_current");
	});

	test("keeps non-semver and non-directory entries", async () => {
		const nativesDir = await makeTemp("gc-disk-natives-junk-");
		await seedVersionDir(nativesDir, "0.12.12");
		await fs.writeFile(path.join(nativesDir, "README"), "nope");
		await fs.mkdir(path.join(nativesDir, "staging-tmp"), { recursive: true });

		const { candidates } = await collectNativesVersionCandidates({
			nativesDir,
			currentNativesVersion: "0.12.12",
			keepVersions: 2,
		});
		const readme = candidates.find(c => c.id === "README");
		const staging = candidates.find(c => c.id === "staging-tmp");
		expect(readme?.removable).toBe(false);
		expect(staging?.removable).toBe(false);
		expect(staging?.status).toBe("non_semver");
	});

	test("missing natives dir is empty, not an error", async () => {
		const nativesDir = path.join(await makeTemp("gc-disk-missing-parent-"), "nope");
		const { candidates, errors } = await collectNativesVersionCandidates({
			nativesDir,
			currentNativesVersion: "0.12.12",
			keepVersions: 2,
		});
		expect(candidates).toEqual([]);
		expect(errors).toEqual([]);
	});
});

describe("pruneNativesVersionCandidate", () => {
	test("removes excess predecessor and leaves current intact", async () => {
		const nativesDir = await makeTemp("gc-disk-prune-");
		const current = await seedVersionDir(nativesDir, "0.12.12");
		// With keepVersions=2 these two newest predecessors are retained…
		await seedVersionDir(nativesDir, "0.11.8");
		await seedVersionDir(nativesDir, "0.11.7");
		// …and anything older is excess.
		const excess = await seedVersionDir(nativesDir, "0.5.1");

		const { candidates } = await collectNativesVersionCandidates({
			nativesDir,
			currentNativesVersion: "0.12.12",
			keepVersions: 2,
		});
		const target = candidates.find(c => c.id === "0.5.1");
		expect(target?.removable).toBe(true);

		const outcome = await pruneNativesVersionCandidate(target!, {
			nativesDir,
			currentNativesVersion: "0.12.12",
		});
		expect(outcome.removed).toBe(true);
		expect(await fs.exists(excess)).toBe(false);
		expect(await fs.exists(current)).toBe(true);
	});

	test("refuses path escape / current version", async () => {
		const nativesDir = await makeTemp("gc-disk-prune-guard-");
		await seedVersionDir(nativesDir, "0.12.12");
		const outcome = await pruneNativesVersionCandidate(
			{
				surface: "natives_versions",
				id: "0.12.12",
				path: path.join(nativesDir, "0.12.12"),
				bytes: 1,
				status: "current",
				removable: true,
				action: "would_remove",
				reason: "forced",
			},
			{ nativesDir, currentNativesVersion: "0.12.12" },
		);
		expect(outcome.removed).toBe(false);
		expect(outcome.skipped).toBe("natives_current_version");
	});
});

describe("collectGcDiskReport", () => {
	test("dry-run marks would_remove without deleting", async () => {
		const nativesDir = await makeTemp("gc-disk-report-");
		const excess = await seedVersionDir(nativesDir, "0.1.0");
		await seedVersionDir(nativesDir, "0.12.12");

		const report = await collectGcDiskReport(
			{ nativesDir, currentNativesVersion: "0.12.12", keepVersions: 0 },
			false,
		);
		expect(report.dry_run).toBe(true);
		expect(report.counts.would_remove).toBe(1);
		expect(report.counts.reclaimable_bytes).toBeGreaterThan(0);
		expect(await fs.exists(excess)).toBe(true);
	});

	test("prune removes excess and reports reclaimed bytes", async () => {
		const nativesDir = await makeTemp("gc-disk-report-prune-");
		const excess = await seedVersionDir(nativesDir, "0.1.0");
		await seedVersionDir(nativesDir, "0.12.12");

		const report = await collectGcDiskReport({ nativesDir, currentNativesVersion: "0.12.12", keepVersions: 0 }, true);
		expect(report.dry_run).toBe(false);
		expect(report.counts.removed).toBe(1);
		expect(report.counts.reclaimed_bytes).toBeGreaterThan(0);
		expect(await fs.exists(excess)).toBe(false);
	});
});

describe("runGjcGcCommand --disk", () => {
	test("without --disk, disk section is absent and natives stay untouched", async () => {
		await seedHealthySessionIndex();
		const nativesDir = await makeTemp("gc-disk-cli-absent-");
		const excess = await seedVersionDir(nativesDir, "0.1.0");
		await seedVersionDir(nativesDir, "0.12.12");

		const result = await runGjcGcCommand(["--json", "--prune"], "/tmp", process.env, [], {
			nativesDir,
			currentNativesVersion: "0.12.12",
			keepVersions: 0,
		});
		const report = JSON.parse(result.stdout);
		expect(report.disk).toBeUndefined();
		expect(await fs.exists(excess)).toBe(true);
		expect(result.status).toBe(0);
	});

	test("--disk dry-run reports reclaimable natives without deleting", async () => {
		await seedHealthySessionIndex();
		const nativesDir = await makeTemp("gc-disk-cli-dry-");
		const excess = await seedVersionDir(nativesDir, "0.1.0");
		await seedVersionDir(nativesDir, "0.12.12");

		const result = await runGjcGcCommand(["--disk", "--json"], "/tmp", process.env, [], {
			nativesDir,
			currentNativesVersion: "0.12.12",
			keepVersions: 0,
		});
		expect(result.status).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.disk?.dry_run).toBe(true);
		expect(report.disk?.counts.would_remove).toBe(1);
		expect(report.disk?.policy.natives_current_version).toBe("0.12.12");
		expect(await fs.exists(excess)).toBe(true);
	});

	test("--disk --prune removes excess natives versions", async () => {
		await seedHealthySessionIndex();
		const nativesDir = await makeTemp("gc-disk-cli-prune-");
		const excess = await seedVersionDir(nativesDir, "0.1.0");
		const current = await seedVersionDir(nativesDir, "0.12.12");

		const result = await runGjcGcCommand(["--disk", "--prune", "--json"], "/tmp", process.env, [], {
			nativesDir,
			currentNativesVersion: "0.12.12",
			keepVersions: 0,
		});
		expect(result.status).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.disk?.dry_run).toBe(false);
		expect(report.disk?.counts.removed).toBe(1);
		expect(await fs.exists(excess)).toBe(false);
		expect(await fs.exists(current)).toBe(true);
	});

	test("--natives-keep-versions requires --disk", async () => {
		const result = await runGjcGcCommand(["--natives-keep-versions", "1", "--json"], "/tmp", {}, []);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("natives_keep_versions_requires_disk");
	});

	test("text mode mentions disk retention when --disk is set", async () => {
		await seedHealthySessionIndex();
		const nativesDir = await makeTemp("gc-disk-cli-text-");
		await seedVersionDir(nativesDir, "0.12.12");

		const result = await runGjcGcCommand(["--disk"], "/tmp", process.env, [], {
			nativesDir,
			currentNativesVersion: "0.12.12",
			keepVersions: 2,
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Disk retention");
		expect(result.stdout).toContain("Natives version caches");
	});
});
