import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { updateJsonAtomic, withWorkflowStateLock } from "@gajae-code/coding-agent/gjc-runtime/state-writer";

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
	it("updateJsonAtomic does not lose concurrent read-modify-write updates", async () => {
		const root = await tempDir();
		const target = ".gjc/state/cas-probe.json";
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
		const target = ".gjc/state/counter.json";
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
		const target = ".gjc/state/lock-probe.json";

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
});
