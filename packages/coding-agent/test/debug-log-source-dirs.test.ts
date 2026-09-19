/**
 * `createDebugLogSource()` must see BOTH log directories (issue #5618).
 *
 * The effective directory holds what the current process is writing (a trusted
 * `GJC_LOG_DIR` pin — the test preload sets one for every test process); the
 * canonical `getLogsDir()` holds history from previous runs, other processes,
 * and anything seeded through the public API. Reading only the effective one
 * hid seeded canonical logs and timed the `/debug` log viewer out; reading only
 * the canonical one was the original finding. Each direction is pinned below.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getEffectiveLogsDir, getLogsDir, setAgentDir } from "@gajae-code/utils";
import { safeRm } from "../../../scripts/safe-cleanup";
import { createDebugLogSource } from "../src/debug/report-bundle";

const TODAY = new Date().toISOString().slice(0, 10);

interface Fixture {
	canonicalDir: string;
	effectiveDir: string;
}

const cleanups: (() => Promise<void>)[] = [];

/**
 * Point the canonical config root and the effective log dir at two distinct
 * temp directories, mirroring `composer-detach-overlay-paths`' exclusive-root
 * setup so nothing here can touch the operator's real `~/.gjc`.
 *
 * `pinEffective: false` leaves `GJC_LOG_DIR` pointing at the canonical
 * directory, which is the production shape: one directory, seen once.
 */
async function pinLogDirs(options: { pinEffective: boolean } = { pinEffective: true }): Promise<Fixture> {
	const originalHome = process.env.HOME;
	const originalGjcConfigDir = process.env.GJC_CONFIG_DIR;
	const originalPiConfigDir = process.env.PI_CONFIG_DIR;
	const originalCodingAgentDir = process.env.GJC_CODING_AGENT_DIR;
	const originalLogDir = process.env.GJC_LOG_DIR;
	const originalAgentDir = (await import("@gajae-code/utils")).getAgentDir();

	const homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-log-source-home-"));
	const agentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-log-source-agent-"));
	const effectiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-log-source-effective-"));
	const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homeRoot);
	process.env.HOME = homeRoot;
	const configName = `gjc-log-source-${randomUUID()}`;
	process.env.GJC_CONFIG_DIR = configName;
	process.env.PI_CONFIG_DIR = configName;
	setAgentDir(agentRoot);

	const canonicalDir = getLogsDir();
	const exclusiveRoot = path.join(homeRoot, configName);
	if (!canonicalDir.startsWith(exclusiveRoot)) {
		throw new Error(`canonical logs dir ${canonicalDir} escaped the exclusive test tree ${exclusiveRoot}`);
	}
	await fs.mkdir(canonicalDir, { recursive: true });
	process.env.GJC_LOG_DIR = options.pinEffective ? effectiveRoot : canonicalDir;
	const effectiveDir = getEffectiveLogsDir();

	const restoreVar = (name: string, value: string | undefined): void => {
		const env: Record<string, string | undefined> = process.env;
		if (value === undefined) delete env[name];
		else env[name] = value;
	};
	cleanups.push(async () => {
		restoreVar("PI_CONFIG_DIR", originalPiConfigDir);
		restoreVar("GJC_CONFIG_DIR", originalGjcConfigDir);
		// setAgentDir re-exports GJC_CODING_AGENT_DIR, so restore it after.
		setAgentDir(originalAgentDir);
		restoreVar("GJC_CODING_AGENT_DIR", originalCodingAgentDir);
		restoreVar("GJC_LOG_DIR", originalLogDir);
		restoreVar("HOME", originalHome);
		homedirSpy.mockRestore();
		await safeRm(agentRoot, { recursive: true, force: true });
		await safeRm(effectiveRoot, { recursive: true, force: true });
		await safeRm(homeRoot, { recursive: true, force: true });
	});

	return { canonicalDir, effectiveDir };
}

async function seedLog(dir: string, date: string, body: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, `gjc.${date}.log`), `${body}\n`);
}

/** Drain every older-log page the source offers. */
async function readAllOlderLogs(source: Awaited<ReturnType<typeof createDebugLogSource>>): Promise<string> {
	const chunks: string[] = [];
	while (source.hasOlderLogs()) chunks.push(await source.loadOlderLogs(1));
	return chunks.join("\n");
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("debug log source spans both log directories", () => {
	test("discovers an older log present only in the canonical directory", async () => {
		const { canonicalDir, effectiveDir } = await pinLogDirs();
		expect(effectiveDir).not.toBe(canonicalDir);
		await seedLog(canonicalDir, "2020-01-02", "canonical-only-older");

		const source = await createDebugLogSource();
		expect(source.hasOlderLogs()).toBe(true);
		expect(await readAllOlderLogs(source)).toContain("canonical-only-older");
	});

	test("discovers an older log present only in the effective directory", async () => {
		const { effectiveDir } = await pinLogDirs();
		await seedLog(effectiveDir, "2020-01-03", "effective-only-older");

		const source = await createDebugLogSource();
		expect(source.hasOlderLogs()).toBe(true);
		expect(await readAllOlderLogs(source)).toContain("effective-only-older");
	});

	test("discovers older logs from both directories, newest first", async () => {
		const { canonicalDir, effectiveDir } = await pinLogDirs();
		await seedLog(canonicalDir, "2020-01-02", "canonical-older");
		await seedLog(effectiveDir, "2020-01-05", "effective-older");

		const source = await createDebugLogSource();
		// Paged newest-first, so the 01-05 effective file comes back before the
		// 01-02 canonical one.
		const first = await source.loadOlderLogs(1);
		const second = await source.loadOlderLogs(1);
		expect(first).toContain("effective-older");
		expect(second).toContain("canonical-older");
		expect(source.hasOlderLogs()).toBe(false);
	});

	test("falls back to today's canonical log when the effective directory has none", async () => {
		// The exact shape `composer-detach-overlay-paths` seeds: today's dated log
		// written through `getLogsDir()` while `GJC_LOG_DIR` points elsewhere.
		const { canonicalDir } = await pinLogDirs();
		await seedLog(canonicalDir, TODAY, "seeded canonical today line");

		const source = await createDebugLogSource();
		expect(await source.getInitialText()).toContain("seeded canonical today line");
	});

	test("prefers today's effective log when the current process has written one", async () => {
		const { canonicalDir, effectiveDir } = await pinLogDirs();
		await seedLog(canonicalDir, TODAY, "canonical today line");
		await seedLog(effectiveDir, TODAY, "effective today line");

		const source = await createDebugLogSource();
		const initial = await source.getInitialText();
		expect(initial).toContain("effective today line");
		expect(initial).not.toContain("canonical today line");
	});

	test("lists a file once when both directories resolve to the same place", async () => {
		// The production shape: no distinct pin, so the two directories coincide
		// and nothing may be enumerated twice or reordered.
		const { canonicalDir, effectiveDir } = await pinLogDirs({ pinEffective: false });
		expect(effectiveDir).toBe(canonicalDir);
		await seedLog(canonicalDir, "2020-01-04", "single-directory-older");

		const source = await createDebugLogSource();
		expect(source.hasOlderLogs()).toBe(true);
		const first = await source.loadOlderLogs(1);
		expect(first).toContain("single-directory-older");
		expect(source.hasOlderLogs()).toBe(false);
	});
});
