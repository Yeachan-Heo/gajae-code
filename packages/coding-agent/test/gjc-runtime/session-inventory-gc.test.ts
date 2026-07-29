import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getSessionsDir } from "@gajae-code/utils";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { SETTINGS_SCHEMA } from "../../src/config/settings-schema";
import { buildGcReportText } from "../../src/gjc-runtime/gc-render";
import {
	collectGcReport,
	computeExitCode,
	defaultGcAdapters,
	GC_STORES,
	type GcContext,
} from "../../src/gjc-runtime/gc-runtime";
import { sessionInventoryGcAdapter } from "../../src/session/session-inventory-gc";

const roots: string[] = [];

async function tempDir(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-inventory-"));
	roots.push(root);
	return root;
}

function context(agentDir: string, force = false, cwd = process.cwd()): GcContext {
	return {
		probe: () => ({ status: "keep", reason: "alive" }),
		force,
		env: { GJC_CODING_AGENT_DIR: agentDir },
		cwd,
	};
}

async function seed(
	agentDir: string,
	scope: string,
	name: string,
	ageDays = 120,
): Promise<{ transcript: string; artifact: string }> {
	const transcript = path.join(getSessionsDir(agentDir), scope, `${name}.jsonl`);
	const artifact = transcript.slice(0, -".jsonl".length);
	await fs.mkdir(path.join(artifact, "subagent"), { recursive: true });
	await fs.writeFile(
		transcript,
		`${JSON.stringify({ type: "session", timestamp: new Date(Date.now() - ageDays * 86_400_000).toISOString() })}\nmessage\n`,
	);
	await fs.writeFile(path.join(artifact, "subagent", "inner.jsonl"), "artifact payload");
	const old = new Date(Date.now() - ageDays * 86_400_000);
	await fs.utimes(transcript, old, old);
	await fs.utimes(path.join(artifact, "subagent", "inner.jsonl"), old, old);
	await fs.utimes(path.join(artifact, "subagent"), old, old);
	await fs.utimes(artifact, old, old);
	return { transcript, artifact };
}

async function writeGlobalSettings(agentDir: string, enabled: boolean): Promise<void> {
	await fs.writeFile(
		path.join(agentDir, "config.yml"),
		`sessions:\n  inventory:\n    enabled: ${enabled}\n    maxAgeDays: 90\n    maxTotalSizeMb: 2048\n`,
	);
}

async function identity(root: string): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	const walk = async (file: string) => {
		const stat = await fs.lstat(file, { bigint: true });
		result.set(file, `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`);
		if (stat.isDirectory()) for (const entry of await fs.readdir(file)) await walk(path.join(file, entry));
	};
	await walk(root);
	return result;
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(async () => {
	resetSettingsForTest();
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("session inventory GC", () => {
	it("is default-OFF, including when prune is requested", async () => {
		const agentDir = await tempDir();
		await seed(agentDir, "scope-a", "one");
		await seed(agentDir, "scope-b", "two");
		const before = await identity(getSessionsDir(agentDir));
		const report = await collectGcReport([sessionInventoryGcAdapter], context(agentDir, true), true);
		expect(SETTINGS_SCHEMA["sessions.inventory.enabled"].default).toBe(false);
		// Default-OFF is enforced at the SCAN boundary: a disabled inventory does no
		// directory enumeration and no artifact-tree sizing, so it reports nothing at
		// all rather than emitting a `retention_disabled` row per transcript.
		expect(report.stores.sessions).toHaveLength(0);
		expect(report.counts.by_store.sessions).toMatchObject({ discovered: 0, would_remove: 0, removed: 0 });
		expect(report.counts.by_store.sessions).toMatchObject({ removed: 0, would_remove: 0 });
		expect(await identity(getSessionsDir(agentDir))).toEqual(before);
	});

	it("reports enabled transcript thresholds, artifact bytes, correct discovery depth, and a report-only heading", async () => {
		const agentDir = await tempDir();
		const first = await seed(agentDir, "scope-a", "s1");
		await seed(agentDir, "scope-b", "s2");
		await fs.writeFile(path.join(getSessionsDir(agentDir), "loose.jsonl"), "not a managed session");
		Settings.instance.set("sessions.inventory.enabled", true);
		Settings.instance.set("sessions.inventory.maxTotalSizeMb", 0.000001);
		const report = await collectGcReport([sessionInventoryGcAdapter], context(agentDir), false);
		expect(report.errors).toEqual([]);
		expect(report.stores.sessions.map(record => record.id).sort()).toEqual(["s1", "s2"]);
		for (const record of report.stores.sessions)
			expect(record).toMatchObject({ status: "over_threshold", removable: false, action: "none" });
		const s1 = report.stores.sessions.find(record => record.id === "s1")!;
		const transcript = await fs.lstat(first.transcript);
		const artifact = await fs.lstat(path.join(first.artifact, "subagent", "inner.jsonl"));
		expect(s1.detail).toContain(`size_bytes=${transcript.size + artifact.size}`);
		expect(buildGcReportText(report)).toContain("Session transcripts (report only) (2)");
	});

	it("never changes bytes for every command-equivalent prune context", async () => {
		const agentDir = await tempDir();
		await seed(agentDir, "scope", "s1");
		Settings.instance.set("sessions.inventory.enabled", true);
		const before = await identity(getSessionsDir(agentDir));
		for (const force of [false, true]) {
			const report = await collectGcReport([sessionInventoryGcAdapter], context(agentDir, force), true);
			expect(report.counts.by_store.sessions.removed).toBe(0);
			expect(computeExitCode(report)).toBe(0);
			expect(await identity(getSessionsDir(agentDir))).toEqual(before);
		}
	});

	it("loads global inventory settings without initializing the singleton and ignores project settings", async () => {
		const agentDir = await tempDir();
		const projectDir = await tempDir();
		await seed(agentDir, "scope", "one", 1);
		resetSettingsForTest();
		let report = await collectGcReport([sessionInventoryGcAdapter], context(agentDir, false, projectDir), false);
		expect(report.errors).toEqual([]);
		expect(report.stores.sessions).toHaveLength(0);

		await writeGlobalSettings(agentDir, true);
		resetSettingsForTest();
		report = await collectGcReport([sessionInventoryGcAdapter], context(agentDir, false, projectDir), false);
		expect(report.errors).toEqual([]);
		expect(report.stores.sessions[0]).toMatchObject({ status: "within_thresholds" });

		await writeGlobalSettings(agentDir, false);
		await fs.mkdir(path.join(projectDir, ".claude"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".claude", "settings.json"),
			JSON.stringify({ sessions: { inventory: { enabled: true } } }),
		);
		resetSettingsForTest();
		report = await collectGcReport([sessionInventoryGcAdapter], context(agentDir, false, projectDir), false);
		// A project-layer opt-in must not enable a machine-wide surface, so the scan
		// stays off entirely.
		expect(report.stores.sessions).toHaveLength(0);
	});

	it("applies the total size threshold oldest-first", async () => {
		const agentDir = await tempDir();
		await seed(agentDir, "scope", "oldest", 3);
		await seed(agentDir, "scope", "middle", 2);
		await seed(agentDir, "scope", "newest", 1);
		Settings.instance.set("sessions.inventory.enabled", true);
		Settings.instance.set("sessions.inventory.maxAgeDays", 10);
		Settings.instance.set("sessions.inventory.maxTotalSizeMb", 0.00015);
		let report = await collectGcReport([sessionInventoryGcAdapter], context(agentDir), false);
		const limit = 0.00015 * 1024 * 1024;
		expect(report.stores.sessions.every(record => Number(record.detail!.match(/size_bytes=(\d+)/)![1]) < limit)).toBe(
			true,
		);
		expect(
			report.stores.sessions
				.filter(record => record.status === "over_threshold")
				.map(record => record.id)
				.sort(),
		).toEqual(["middle", "oldest"]);

		Settings.instance.set("sessions.inventory.maxTotalSizeMb", 1);
		report = await collectGcReport([sessionInventoryGcAdapter], context(agentDir), false);
		expect(report.stores.sessions.some(record => record.status === "over_threshold")).toBe(false);
	});

	it("reads only a bounded transcript header and rejects missing or overlong headers", async () => {
		const agentDir = await tempDir();
		const large = await seed(agentDir, "scope", "large", 1);
		await fs.truncate(large.transcript, 256 * 1024 * 1024);
		const overlong = path.join(getSessionsDir(agentDir), "scope", "overlong.jsonl");
		await fs.writeFile(overlong, "x".repeat(64 * 1024));
		Settings.instance.set("sessions.inventory.enabled", true);
		const report = await collectGcReport([sessionInventoryGcAdapter], context(agentDir), false);
		expect(report.stores.sessions.find(record => record.id === "large")).toMatchObject({
			status: "within_thresholds",
		});
		expect(report.stores.sessions.find(record => record.id === "overlong")).toMatchObject({ status: "unreadable" });
	});
	it("exports the store, validates thresholds, and registers the adapter last", async () => {
		expect(GC_STORES).toEqual([
			"harness_leases",
			"team_workers",
			"file_locks",
			"tmux_sessions",
			"registry_entries",
			"local_roots",
			"sessions",
		]);
		for (const value of [0, -1, Number.NaN, Infinity, "no"])
			expect(SETTINGS_SCHEMA["sessions.inventory.maxAgeDays"].validate?.(value as never)).toBe(false);
		for (const value of [0, -1, Number.NaN, Infinity])
			expect(SETTINGS_SCHEMA["sessions.inventory.maxTotalSizeMb"].validate?.(value)).toBe(false);
		expect((await defaultGcAdapters()).map(adapter => adapter.store)).toEqual([...GC_STORES]);
	});
});
