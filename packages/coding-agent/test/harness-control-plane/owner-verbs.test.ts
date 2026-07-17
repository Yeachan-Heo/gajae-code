import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { callEndpoint } from "../../src/harness-control-plane/control-endpoint";
import type { FinalizeChecks } from "../../src/harness-control-plane/finalize";
import { RuntimeOwner } from "../../src/harness-control-plane/owner";
import type { HarnessSessionTransport, SessionStateSnapshot } from "../../src/harness-control-plane/session-transport";
import { readEvents, readReceiptIndex, writeSessionState } from "../../src/harness-control-plane/storage";
import { SESSION_SCHEMA_VERSION, type SessionHandle, type SessionState } from "../../src/harness-control-plane/types";

class FakeTransport implements HarnessSessionTransport {
	cursor = 0;
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
const SID = "v";
let owner: RuntimeOwner | null = null;

function seed(workspace: string): SessionState {
	const now = new Date().toISOString();
	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId: SID,
		lifecycle: "started",
		harness: "gajae-code",
		handle: { sessionId: SID, harness: "gajae-code", workspace } as SessionHandle,
		retries: {},
		blockers: [],
		createdAt: now,
		updatedAt: now,
	};
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "h"));
	await writeSessionState(root, seed(root));
	owner = null;
});

afterEach(async () => {
	await owner?.stop();
	await rm(root, { recursive: true, force: true });
});

describe("owner-dispatched recover / validate / operate", () => {
	it("validate runs configured commands and persists validation receipts", async () => {
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport: new FakeTransport(),
			finalizeChecks: passingChecks,
			validationCommands: [{ name: "typecheck", command: "true" }],
		});
		const info = await owner.start();
		const res = (await callEndpoint(info.socketPath, { verb: "validate", input: {} })) as Record<string, unknown>;
		const validation = (res.evidence as Record<string, unknown>).validation as { name: string; valid: boolean }[];
		expect(validation).toHaveLength(1);
		expect(validation[0].valid).toBe(true);
		expect(await readReceiptIndex(root, SID, "validation")).toHaveLength(1);
	});

	it("recover observes + classifies and returns a deterministic decision", async () => {
		owner = new RuntimeOwner({ root, sessionId: SID, transport: new FakeTransport() });
		const info = await owner.start();
		const res = (await callEndpoint(info.socketPath, { verb: "recover", input: {} })) as Record<string, unknown>;
		const decision = (res.evidence as Record<string, unknown>).decision as Record<string, unknown>;
		expect(typeof decision.classification).toBe("string");
		expect(decision.classification).toBe("continue"); // owner live, normal
	});

	it("operate is owner-dispatched and runs the bounded lifecycle loop", async () => {
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport: new FakeTransport(),
			finalizeChecks: passingChecks,
			validationCommands: [{ name: "t", command: "true" }],
		});
		const info = await owner.start();
		const res = (await callEndpoint(info.socketPath, {
			verb: "operate",
			input: { goal: "do the thing", maxIterations: 2 },
		})) as Record<string, unknown>;
		const operate = (res.evidence as Record<string, unknown>).operate as Record<string, unknown>;
		expect(operate).toBeTruthy();
		expect(Array.isArray(operate.classifications)).toBe(true);
		// git observer never reports completion here, so the bounded loop blocks rather than finalizing.
		expect(operate.lifecycle).toBe("blocked");
		// The owner persists the loop's terminal lifecycle (not stale).
		expect((res.state as Record<string, unknown>).lifecycle).toBe("blocked");
		// Every emitted event carries the owner's lease identity (no hardcoded "operate" writer).
		const events = await readEvents(root, SID, 0);
		expect(events.length).toBeGreaterThan(0);
		expect(events.every(e => e.writer.ownerId === info.ownerId)).toBe(true);
	});
});
