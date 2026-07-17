import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { FinalizeChecks } from "../../src/harness-control-plane/finalize";
import { operate } from "../../src/harness-control-plane/operate";
import type { VanishEvidence } from "../../src/harness-control-plane/receipts";
import type { HarnessSessionTransport, SessionStateSnapshot } from "../../src/harness-control-plane/session-transport";
import { nextAllowedActions } from "../../src/harness-control-plane/state-machine";
import { appendEvent, readEvents, readReceiptIndex } from "../../src/harness-control-plane/storage";
import type { EventEnvelope, HarnessLifecycle, Observation, Severity } from "../../src/harness-control-plane/types";

class FakeTransport implements HarnessSessionTransport {
	cursor = 0;
	state: SessionStateSnapshot = { isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 };
	async getState(): Promise<SessionStateSnapshot> {
		return this.state;
	}
	eventCursor(): number {
		return this.cursor;
	}
	async sendPrompt(): Promise<{ commandId: string; ack: boolean }> {
		this.cursor += 1;
		return { commandId: "c", ack: true };
	}
	async waitForAgentStart(afterCursor: number): Promise<{ cursor: number } | null> {
		return this.cursor > afterCursor ? { cursor: this.cursor } : null;
	}
	async close(): Promise<void> {}
}

function obs(p: Partial<Observation>): Observation {
	return {
		lifecycle: "observing",
		ownerLive: true,
		cwd: "/ws",
		branch: "feat/x",
		gitDelta: "clean",
		lastActivityAt: null,
		observedSignals: [],
		risk: "normal",
		...p,
	};
}

function scriptedObserver(queue: Observation[]): () => Promise<Observation> {
	let i = 0;
	return async () => queue[Math.min(i++, queue.length - 1)];
}

const passingChecks: FinalizeChecks = {
	async runValidation(spec) {
		return { exactCommand: spec.command, cwd: "/ws", exitStatus: 0, pass: true };
	},
	async resolveCommit() {
		return "abc123";
	},
	async commitOnBranch() {
		return true;
	},
	async prOrIssue() {
		return { prUrl: "https://x/pr/1", issueArtifact: null };
	},
};

let root: string;
const SID = "op";

function baseOpts(observer: () => Promise<Observation>) {
	let cursor = 0;
	let lifecycle: HarnessLifecycle = "started";
	const blockers: string[] = [];
	return {
		root,
		sessionId: SID,
		workspace: "/ws",
		branch: "feat/x",
		transport: new FakeTransport(),
		transportFactory: () => new FakeTransport(),
		observe: observer,
		preserve: (_ws: string) => ({
			gitDelta: "dirty" as const,
			trackedDiff: "diff --git a/a.ts b/a.ts",
			trackedDiffSha256: "abc123",
			untrackedManifest: [{ path: "b.ts", size: 3, sha256: "hh" }],
			stashRef: "deadbeefoid",
			snapshotComplete: true,
		}),
		finalizeChecks: passingChecks,
		validationCommands: [{ name: "test", command: "bun test" }],
		acceptanceTimeoutMs: 100,
		maxIterations: 6,
		emit: async (severity: Severity, kind: string, evidence: Record<string, unknown>) => {
			if (kind === "operate_blocked") lifecycle = "blocked";
			if (kind === "operate_finalized") {
				lifecycle = evidence.completed === true ? "completed" : "blocked";
				if (Array.isArray(evidence.blockers))
					blockers.push(...evidence.blockers.filter((b): b is string => typeof b === "string"));
			}
			const event: EventEnvelope = {
				eventId: randomUUID(),
				cursor: ++cursor,
				createdAt: new Date().toISOString(),
				severity,
				kind,
				state: { sessionId: SID, lifecycle, harness: "gajae-code", ownerLive: true, blockers },
				evidence,
				nextAllowedActions: nextAllowedActions(lifecycle, true),
				writer: { ownerId: "test-owner", leaseEpoch: 1 },
			};
			await appendEvent(root, SID, event);
		},
	};
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "h"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("operate() autonomous lifecycle (AC-9 e2e + data-loss + red-team)", () => {
	it("AC-9: recovers an injected zero-delta vanish and finalizes with receipt+commit+PR", async () => {
		const observer = scriptedObserver([
			obs({ ownerLive: false, gitDelta: "zero-delta", risk: "vanished-dirty", observedSignals: ["SessionStart"] }),
			obs({ ownerLive: true, gitDelta: "clean", observedSignals: ["commit-created", "completed"] }),
		]);
		const res = await operate("ship issue #482", baseOpts(observer));
		expect(res.completed).toBe(true);
		expect(res.lifecycle).toBe("completed");
		expect(res.classifications).toContain("restart-clean");
		expect(res.vanishReceiptIds.length).toBeGreaterThanOrEqual(1);
		expect(res.finalize?.completed).toBe(true);

		expect(await readReceiptIndex(root, SID, "completion")).toHaveLength(1);
		const kinds = (await readEvents(root, SID, 0)).map(e => e.kind);
		expect(kinds).toContain("operate_started");
		expect(kinds).toContain("vanish_receipt");
		expect(kinds).toContain("operate_finalized");
	});

	it("data-loss safety: a dirty vanish uses restart-preserve-delta (NEVER restart-clean) with a valid vanish receipt", async () => {
		const observer = scriptedObserver([
			obs({ ownerLive: false, gitDelta: "dirty", risk: "vanished-dirty", observedSignals: ["partial-delta"] }),
			obs({ ownerLive: true, observedSignals: ["completed"] }),
		]);
		const res = await operate("ship #482 with dirty tree", baseOpts(observer));
		expect(res.classifications).toContain("restart-preserve-delta");
		expect(res.classifications).not.toContain("restart-clean");

		const vanish = await readReceiptIndex(root, SID, "vanish");
		expect(vanish).toHaveLength(1);
		expect(vanish[0].valid).toBe(true);
		const evidence = JSON.parse(await readFile(vanish[0].path, "utf8")).evidence as VanishEvidence;
		expect(evidence.preservation).toBe("stash");
		expect(evidence.stashRef).toBe("deadbeefoid");
		expect(evidence.untrackedManifest.length).toBeGreaterThanOrEqual(1);
		expect(evidence.snapshotComplete).toBe(true);
		expect(evidence.forbiddenActions).toContain("restart-clean");
		expect(res.completed).toBe(true);
	});

	it("red-team: a deleted worktree halts at human-check and never finalizes", async () => {
		const observer = scriptedObserver([obs({ ownerLive: false, gitDelta: "dirty", risk: "deleted-worktree" })]);
		const res = await operate("dangerous", baseOpts(observer));
		expect(res.completed).toBe(false);
		expect(res.lifecycle).toBe("blocked");
		expect(res.classifications).toContain("human-check");
		expect(res.blockers).toContain("human-check-required");
		expect(await readReceiptIndex(root, SID, "completion")).toHaveLength(0);
	});

	it("red-team: finalize gate blocks completion when the required validation fails", async () => {
		const observer = scriptedObserver([obs({ ownerLive: true, observedSignals: ["completed"] })]);
		const failingChecks: FinalizeChecks = {
			...passingChecks,
			async runValidation(spec) {
				return { exactCommand: spec.command, cwd: "/ws", exitStatus: 1, pass: false };
			},
		};
		const res = await operate("ship but tests fail", { ...baseOpts(observer), finalizeChecks: failingChecks });
		expect(res.completed).toBe(false);
		expect(res.lifecycle).toBe("blocked");
		expect(res.blockers.some(b => b.startsWith("validation-failed:"))).toBe(true);
		expect(await readReceiptIndex(root, SID, "completion")).toHaveLength(0);
	});

	it("B3: never finalizes on loop-exhaustion without an observed completion", async () => {
		const observer = scriptedObserver([obs({ ownerLive: true, observedSignals: ["working"] })]);
		const res = await operate("spin without completing", { ...baseOpts(observer), maxIterations: 3 });
		expect(res.completed).toBe(false);
		expect(res.lifecycle).toBe("blocked");
		expect(res.blockers).toContain("no-observed-completion");
		expect(await readReceiptIndex(root, SID, "completion")).toHaveLength(0);
	});
});
