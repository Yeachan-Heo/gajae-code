import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sessionStateDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	updateJsonAtomic,
	withWorkflowStateLock,
	writeGuardedJsonAtomic,
	writeGuardedWorkflowEnvelopeAtomic,
} from "@gajae-code/coding-agent/gjc-runtime/state-writer";
import { WORKFLOW_STATE_VERSION } from "@gajae-code/coding-agent/skill-state/workflow-state-contract";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-writer-cas-"));
	tempRoots.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function readJson(filePath: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

describe("state-writer concurrency (issue #646)", () => {
	it("rejects a group/world-writable cwd before creating private durable descendants", async () => {
		if (process.platform !== "linux") return;
		const root = await tempDir();
		await fs.chmod(root, 0o777);
		const target = path.join(".gjc", "private-durable", "state.json");
		const filePath = path.join(root, target);

		const rootStat = await fs.stat(root);
		const uid = process.getuid?.();
		if (uid === undefined) throw new Error("Linux test requires a POSIX uid");
		expect(rootStat.uid).toBe(uid);
		expect(rootStat.mode & 0o022).not.toBe(0);
		await expect(
			writeGuardedJsonAtomic(
				target,
				{ marker: "must-not-publish" },
				{
					cwd: root,
					policy: "source",
					expectedRevision: 0,
					privateDurable: { directory: path.dirname(target) },
				},
			),
		).rejects.toThrow("publication parent is not exclusively owned");
		await expect(fs.lstat(path.join(root, ".gjc"))).rejects.toThrow();
		await expect(fs.lstat(filePath)).rejects.toThrow();
	});

	it("preserves exact private modes when umask removes owner permissions", async () => {
		if (process.platform !== "linux") return;
		const root = await tempDir();
		const target = path.join(".gjc", "private-durable", "state.json");
		const realMkdir = fs.mkdir.bind(fs);
		const realOpen = fs.open.bind(fs);
		const mkdirImplementation = async (...args: Parameters<typeof fs.mkdir>) => {
			const [directory, options] = args;
			const parent = await fs.realpath(path.dirname(String(directory))).catch(() => undefined);
			const relative = parent === undefined ? ".." : path.relative(root, parent);
			const withinRoot =
				relative === "" ||
				(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
			if (withinRoot && typeof options === "object" && options !== null && options.mode === 0o700)
				return realMkdir(directory, { ...options, mode: 0 });
			return realMkdir(...args);
		};
		const mkdirSpy = spyOn(fs, "mkdir").mockImplementation(mkdirImplementation as typeof fs.mkdir);
		const openImplementation = async (...args: Parameters<typeof fs.open>) => {
			const [file, flags, mode] = args;
			const parent = await fs.realpath(path.dirname(String(file))).catch(() => undefined);
			const relative = parent === undefined ? ".." : path.relative(root, parent);
			const withinRoot =
				relative === "" ||
				(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
			if (withinRoot && String(file).includes(".tmp.") && flags === "wx" && mode === 0o600)
				return realOpen(file, flags, 0);
			return realOpen(...args);
		};
		const openSpy = spyOn(fs, "open").mockImplementation(openImplementation as typeof fs.open);
		try {
			await writeGuardedJsonAtomic(
				target,
				{ marker: "exact-modes" },
				{
					cwd: root,
					policy: "source",
					expectedRevision: 0,
					lockHeld: true,
					privateDurable: { directory: path.dirname(target) },
				},
			);
		} finally {
			openSpy.mockRestore();
			mkdirSpy.mockRestore();
		}

		expect((await fs.stat(path.join(root, ".gjc"))).mode & 0o777).toBe(0o700);
		expect((await fs.stat(path.join(root, ".gjc", "private-durable"))).mode & 0o777).toBe(0o700);
		expect((await fs.stat(path.join(root, target))).mode & 0o777).toBe(0o600);
	});

	it("anchors publication to the opened parent when its pathname is swapped before rename", async () => {
		if (process.platform !== "linux") return;
		const root = await tempDir();
		const target = path.join(".gjc", "private-durable", "state.json");
		const parent = path.join(root, ".gjc", "private-durable");
		const movedParent = path.join(root, ".gjc", "moved-private-durable");
		const originalRename = fs.rename.bind(fs);
		let swapped = false;
		const renameSpy = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
			if (!swapped && String(source).includes(".tmp.") && path.basename(String(destination)) === "state.json") {
				swapped = true;
				await originalRename(parent, movedParent);
				await fs.mkdir(parent, { mode: 0o700 });
			}
			return originalRename(source, destination);
		});
		try {
			await expect(
				writeGuardedJsonAtomic(
					target,
					{ marker: "descriptor-anchored" },
					{
						cwd: root,
						policy: "source",
						expectedRevision: 0,
						lockHeld: true,
						privateDurable: { directory: path.dirname(target) },
					},
				),
			).rejects.toThrow("state publication requires authoritative reload");
		} finally {
			renameSpy.mockRestore();
		}

		expect(swapped).toBe(true);
		expect(await readJson(path.join(movedParent, "state.json"))).toMatchObject({ marker: "descriptor-anchored" });
		await expect(fs.lstat(path.join(parent, "state.json"))).rejects.toThrow();
	});

	it("serializes private durable CAS calls through one stable target lock", async () => {
		if (process.platform !== "linux") return;
		const root = await tempDir();
		const target = path.join(".gjc", "private-durable", "state.json");
		const options = {
			cwd: root,
			policy: "source" as const,
			expectedRevision: 0,
			privateDurable: { directory: path.dirname(target) },
		};
		const results = await Promise.allSettled([
			writeGuardedJsonAtomic(target, { marker: "first" }, options),
			writeGuardedJsonAtomic(target, { marker: "second" }, options),
		]);

		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
		expect((await readJson(path.join(root, target))).state_revision).toBe(1);
	});

	it("updateJsonAtomic does not lose concurrent read-modify-write updates", async () => {
		const root = await tempDir();
		const target = path.relative(root, path.join(sessionStateDir(root, "test-session"), "cas-probe.json"));
		const filePath = path.join(root, target);
		const keys = Array.from({ length: 16 }, (_, index) => `k${index}`);

		// Each mutator yields between read and write, so without serialization
		// every writer reads the same document and the last write wins, silently
		// dropping every other mutation (the TOCTOU in issue #646). The
		// cross-process lock in updateJsonAtomic must serialize these cycles.
		await Promise.all(
			keys.map(key =>
				updateJsonAtomic<Record<string, unknown>>(
					target,
					async current => {
						await sleep(5);
						return { ...(current ?? {}), [key]: true };
					},
					{ cwd: root },
				),
			),
		);

		const final = await readJson(filePath);
		for (const key of keys) {
			expect(final[key]).toBe(true);
		}
		expect(Object.keys(final)).toHaveLength(keys.length);
	});

	it("updateJsonAtomic applies sequential increments without losing any", async () => {
		const root = await tempDir();
		const target = path.relative(root, path.join(sessionStateDir(root, "test-session"), "counter.json"));
		const filePath = path.join(root, target);
		const bumps = 24;

		await Promise.all(
			Array.from({ length: bumps }, () =>
				updateJsonAtomic<{ count?: number }>(
					target,
					async current => {
						const count = typeof current?.count === "number" ? current.count : 0;
						await sleep(2);
						return { count: count + 1 };
					},
					{ cwd: root },
				),
			),
		);

		const final = await readJson(filePath);
		expect(final.count).toBe(bumps);
	});

	it("withWorkflowStateLock serializes mutations of the same resolved target", async () => {
		const root = await tempDir();
		const target = path.relative(root, path.join(sessionStateDir(root, "test-session"), "lock-probe.json"));

		let active = 0;
		let maxActive = 0;
		const runCriticalSection = async (): Promise<void> => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await sleep(5);
			active -= 1;
		};

		await Promise.all(
			Array.from({ length: 8 }, () => withWorkflowStateLock(target, runCriticalSection, { cwd: root })),
		);

		// If the lock serializes correctly, only one critical section is ever in
		// flight, so the observed peak concurrency stays at 1.
		expect(maxActive).toBe(1);
	});
	it("returns the lock-owned stamped workflow envelope without rereading the file", async () => {
		const root = await tempDir();
		const target = path.relative(root, path.join(sessionStateDir(root, "test-session"), "stamped-probe.json"));
		const filePath = path.join(root, target);
		const envelope = (marker: string, updatedAt: string): Record<string, unknown> => ({
			skill: "ralplan",
			version: WORKFLOW_STATE_VERSION,
			active: true,
			current_phase: "planner",
			updated_at: updatedAt,
			marker,
		});
		const receipt = (marker: string) => ({
			cwd: root,
			skill: "ralplan" as const,
			owner: "gjc-state-cli" as const,
			command: `test ${marker}`,
			sessionId: "test-session",
			mutationId: `state-writer-cas:${marker}`,
		});

		const first = await writeGuardedWorkflowEnvelopeAtomic(target, envelope("first", "2026-01-01T00:00:00.000Z"), {
			cwd: root,
			policy: "source",
			receipt: receipt("first"),
		});
		const second = await writeGuardedWorkflowEnvelopeAtomic(target, envelope("second", "2026-01-01T00:00:01.000Z"), {
			cwd: root,
			policy: "source",
			receipt: receipt("second"),
		});

		if (!first.written) throw new Error("first write unexpectedly stale-skipped");
		if (!second.written) throw new Error("second write unexpectedly stale-skipped");
		const firstStamped = first.stamped as Record<string, unknown>;
		expect(firstStamped.marker).toBe("first");
		expect(firstStamped.state_revision).toBe(1);
		expect((firstStamped.receipt as Record<string, unknown>).mutation_id).toBe("state-writer-cas:first");

		const final = await readJson(filePath);
		expect(final.marker).toBe("second");
		expect(final.state_revision).toBe(2);
	});
});
