import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sessionStateDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	updateJsonAtomic,
	withWorkflowStateLock,
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
