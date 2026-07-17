import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { callEndpoint } from "../../src/harness-control-plane/control-endpoint";
import type { FinalizeChecks } from "../../src/harness-control-plane/finalize";
import { RuntimeOwner } from "../../src/harness-control-plane/owner";
import type { ReviewFailureEvidence, ReviewVerdictEvidence } from "../../src/harness-control-plane/receipts";
import type { HarnessSessionTransport, SessionStateSnapshot } from "../../src/harness-control-plane/session-transport";
import { readReceiptIndex, writeSessionState } from "../../src/harness-control-plane/storage";
import { SESSION_SCHEMA_VERSION, type SessionHandle, type SessionState } from "../../src/harness-control-plane/types";

class FakeTransport implements HarnessSessionTransport {
	cursor = 0;
	#assistantText: string | null;
	constructor(assistantText: string | null) {
		this.#assistantText = assistantText;
	}
	async getState(): Promise<SessionStateSnapshot> {
		return { isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 };
	}
	eventCursor(): number {
		return this.cursor;
	}
	async sendPrompt(): Promise<{ commandId: string; ack: boolean }> {
		this.cursor += 1;
		return { commandId: "c", ack: true };
	}
	async waitForAgentStart(after: number): Promise<{ cursor: number } | null> {
		return this.cursor > after ? { cursor: this.cursor } : null;
	}
	async getLastAssistantText(): Promise<string | null> {
		return this.#assistantText;
	}
	async close(): Promise<void> {}
}

const passingChecks: FinalizeChecks = {
	async runValidation(spec) {
		return { exactCommand: spec.command, cwd: ".", exitStatus: 0, pass: true };
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
const SID = "rv";
let owner: RuntimeOwner | null = null;

function seedReview(workspace: string): SessionState {
	const now = new Date().toISOString();
	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId: SID,
		lifecycle: "finalizing",
		harness: "gajae-code",
		handle: {
			sessionId: SID,
			harness: "gajae-code",
			workspace,
			mode: "review",
			issueOrPr: "PR-414",
		} as SessionHandle,
		retries: {},
		blockers: [],
		createdAt: now,
		updatedAt: now,
	};
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "h"));
	owner = null;
});

afterEach(async () => {
	await owner?.stop();
	await rm(root, { recursive: true, force: true });
});

async function readEvidence<E>(family: "review-verdict" | "review-failure"): Promise<E> {
	const idx = await readReceiptIndex(root, SID, family);
	expect(idx).toHaveLength(1);
	const env = JSON.parse(await readFile(idx[0].path, "utf8")) as { evidence: E };
	return env.evidence;
}

describe("owner review-only finalize via live RPC assistant text", () => {
	it("extracts the verdict from the final assistant text when no verdict input is given", async () => {
		await writeSessionState(root, seedReview(root));
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport: new FakeTransport("Detailed review.\nVerdict: REQUEST_CHANGES"),
			finalizeChecks: passingChecks,
		});
		const info = await owner.start();
		const res = (await callEndpoint(info.socketPath, { verb: "finalize", input: {} })) as Record<string, unknown>;
		const fin = (res.evidence as Record<string, unknown>).finalize as Record<string, unknown>;
		expect(fin.completed).toBe(true); // REQUEST_CHANGES is a valid terminal verdict
		expect(fin.verdict).toBe("REQUEST_CHANGES");
		const evidence = await readEvidence<ReviewVerdictEvidence>("review-verdict");
		expect(evidence.verdict).toBe("REQUEST_CHANGES");
		expect(evidence.verdictSource).toBe("assistant");
	});

	it("completes when the assistant text approves merge readiness", async () => {
		await writeSessionState(root, seedReview(root));
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport: new FakeTransport("All checks pass. APPROVE_MERGE_READY"),
			finalizeChecks: passingChecks,
		});
		const info = await owner.start();
		const res = (await callEndpoint(info.socketPath, { verb: "finalize", input: {} })) as Record<string, unknown>;
		const fin = (res.evidence as Record<string, unknown>).finalize as Record<string, unknown>;
		expect(fin.completed).toBe(true);
		expect(fin.verdict).toBe("APPROVE_MERGE_READY");
		expect((res.state as Record<string, unknown>).lifecycle).toBe("completed");
	});

	it("fails deterministically with bounded/digest evidence when assistant text lacks a verdict", async () => {
		await writeSessionState(root, seedReview(root));
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport: new FakeTransport("I am still thinking about this and have no recommendation."),
			finalizeChecks: passingChecks,
		});
		const info = await owner.start();
		const res = (await callEndpoint(info.socketPath, { verb: "finalize", input: {} })) as Record<string, unknown>;
		const fin = (res.evidence as Record<string, unknown>).finalize as Record<string, unknown>;
		expect(fin.completed).toBe(false);
		expect(fin.verdict).toBeNull();
		expect(fin.blockers).toEqual(["review-verdict-missing"]);
		const evidence = await readEvidence<ReviewFailureEvidence>("review-failure");
		expect(typeof evidence.assistantDigest).toBe("string");
		expect(evidence.assistantSummary).toContain("no recommendation");
		expect((res.state as Record<string, unknown>).lifecycle).toBe("blocked");
	});

	it("explicit input.verdict still wins over assistant extraction", async () => {
		await writeSessionState(root, seedReview(root));
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport: new FakeTransport("Verdict: REQUEST_CHANGES"),
			finalizeChecks: passingChecks,
		});
		const info = await owner.start();
		const res = (await callEndpoint(info.socketPath, {
			verb: "finalize",
			input: { verdict: "APPROVE_MERGE_READY" },
		})) as Record<string, unknown>;
		const fin = (res.evidence as Record<string, unknown>).finalize as Record<string, unknown>;
		expect(fin.completed).toBe(true);
		expect(fin.verdict).toBe("APPROVE_MERGE_READY");
		const evidence = await readEvidence<ReviewVerdictEvidence>("review-verdict");
		expect(evidence.verdictSource).toBe("input");
	});
});
