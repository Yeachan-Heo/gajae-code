import { describe, expect, it } from "bun:test";
import {
	buildReceipt,
	type CompletionEvidence,
	type PromptAcceptanceEvidence,
	type ReceiptSubject,
	requiresVanishBeforeAction,
	type ValidationEvidence,
	type VanishEvidence,
	validateReceipt,
} from "../../src/harness-control-plane/receipts";

const subject: ReceiptSubject = { workspace: "/ws", branch: "feat/x", head: "abc", commit: "abc" };

function vanish(over: Partial<VanishEvidence> = {}): VanishEvidence {
	return {
		classification: "restart-preserve-delta",
		gitDelta: "dirty",
		gitStatusPorcelain: " M a.ts\n?? b.ts",
		untrackedManifest: [{ path: "b.ts", size: 3, sha256: "h" }],
		preservation: "snapshot",
		stashRef: null,
		snapshotComplete: true,
		forbiddenActions: ["restart-clean", "delete", "reset"],
		...over,
	};
}

describe("receipts: hashing + tamper detection", () => {
	it("builds a self-consistent hash that validates", () => {
		const r = buildReceipt<VanishEvidence>({
			receiptId: "v-1",
			sessionId: "s",
			family: "vanish",
			source: "test",
			subject,
			evidence: vanish(),
		});
		expect(validateReceipt(r).valid).toBe(true);
	});

	it("fails closed when evidence is tampered after hashing", () => {
		const r = buildReceipt<VanishEvidence>({
			receiptId: "v-2",
			sessionId: "s",
			family: "vanish",
			source: "test",
			subject,
			evidence: vanish(),
		});
		(r.evidence as VanishEvidence).gitDelta = "clean"; // tamper
		const out = validateReceipt(r);
		expect(out.valid).toBe(false);
		expect(out.reasons).toContain("hash-mismatch");
	});
});

describe("receipts: vanish data-loss invariants", () => {
	it("valid when dirty delta is preserved and restart-clean is forbidden", () => {
		const r = buildReceipt({
			receiptId: "v",
			sessionId: "s",
			family: "vanish",
			source: "t",
			subject,
			evidence: vanish(),
		});
		expect(validateReceipt(r).valid).toBe(true);
	});

	it("invalid when a dirty delta is blocked instead of preserved", () => {
		const r = buildReceipt({
			receiptId: "v",
			sessionId: "s",
			family: "vanish",
			source: "t",
			subject,
			evidence: vanish({ preservation: "block" }),
		});
		expect(validateReceipt(r).reasons).toContain("vanish-dirty-must-preserve-not-block");
	});

	it("invalid when restart-clean is not in forbiddenActions", () => {
		const r = buildReceipt({
			receiptId: "v",
			sessionId: "s",
			family: "vanish",
			source: "t",
			subject,
			evidence: vanish({ forbiddenActions: [] }),
		});
		expect(validateReceipt(r).reasons).toContain("vanish-must-forbid-restart-clean");
	});

	it("invalid when a stash preservation lacks a stash ref", () => {
		const r = buildReceipt({
			receiptId: "v",
			sessionId: "s",
			family: "vanish",
			source: "t",
			subject,
			evidence: vanish({ preservation: "stash", stashRef: null, snapshotComplete: false }),
		});
		expect(validateReceipt(r).reasons).toContain("vanish-stash-missing-ref");
	});
});

describe("receipts: prompt-acceptance / validation / completion validators", () => {
	function accept(over: Partial<PromptAcceptanceEvidence> = {}): PromptAcceptanceEvidence {
		return {
			promptSha256: "p",
			rpcCommandId: "c",
			preSubmitState: { isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 },
			preSubmitCursor: 5,
			agentStartCursor: 6,
			acceptedAt: new Date().toISOString(),
			singleFlight: true,
			...over,
		};
	}

	it("accepts an idle single-flight acceptance with agent_start after the cursor", () => {
		const r = buildReceipt({
			receiptId: "a",
			sessionId: "s",
			family: "prompt-acceptance",
			source: "t",
			subject,
			evidence: accept(),
		});
		expect(validateReceipt(r).valid).toBe(true);
	});

	it("rejects acceptance when pre-state was streaming or agent_start did not advance", () => {
		const streaming = buildReceipt({
			receiptId: "a",
			sessionId: "s",
			family: "prompt-acceptance",
			source: "t",
			subject,
			evidence: accept({ preSubmitState: { isStreaming: true, steeringQueueDepth: 0, followupQueueDepth: 0 } }),
		});
		expect(validateReceipt(streaming).reasons).toContain("acceptance-pre-state-streaming");
		const stale = buildReceipt({
			receiptId: "a2",
			sessionId: "s",
			family: "prompt-acceptance",
			source: "t",
			subject,
			evidence: accept({ preSubmitCursor: 6, agentStartCursor: 6 }),
		});
		expect(validateReceipt(stale).reasons).toContain("acceptance-agent-start-not-after-cursor");
	});

	it("validation receipt: pass -> valid, fail -> validation-failed", () => {
		const ok: ValidationEvidence = {
			command: "build",
			exactCommand: "bun run build",
			cwd: "/ws",
			exitStatus: 0,
			pass: true,
			commitUnderTest: "abc",
		};
		const bad: ValidationEvidence = { ...ok, exitStatus: 1, pass: false };
		expect(
			validateReceipt(
				buildReceipt({ receiptId: "x", sessionId: "s", family: "validation", source: "t", subject, evidence: ok }),
			).valid,
		).toBe(true);
		expect(
			validateReceipt(
				buildReceipt({ receiptId: "y", sessionId: "s", family: "validation", source: "t", subject, evidence: bad }),
			).reasons,
		).toContain("validation-failed");
	});

	it("completion receipt requires commit + pr/issue + validations + no blockers", () => {
		const good: CompletionEvidence = {
			finalCommit: "abc",
			branch: "feat/x",
			prUrl: "https://x/pr/1",
			issueArtifact: null,
			requiredValidationReceiptIds: ["val-1"],
			finalLifecycle: "completed",
			finalizedAt: new Date().toISOString(),
			blockers: [],
		};
		expect(
			validateReceipt(
				buildReceipt({
					receiptId: "d",
					sessionId: "s",
					family: "completion",
					source: "t",
					subject,
					evidence: good,
				}),
			).valid,
		).toBe(true);
		const noPr = buildReceipt({
			receiptId: "d2",
			sessionId: "s",
			family: "completion",
			source: "t",
			subject,
			evidence: { ...good, prUrl: null },
		});
		expect(validateReceipt(noPr).reasons).toContain("completion-missing-pr-or-issue");
		const blocked = buildReceipt({
			receiptId: "d3",
			sessionId: "s",
			family: "completion",
			source: "t",
			subject,
			evidence: { ...good, blockers: ["x"] },
		});
		expect(validateReceipt(blocked).reasons).toContain("completion-has-blockers");
	});

	it("requiresVanishBeforeAction gates the destructive classifications", () => {
		expect(requiresVanishBeforeAction("restart-clean")).toBe(true);
		expect(requiresVanishBeforeAction("restart-preserve-delta")).toBe(true);
		expect(requiresVanishBeforeAction("fallback-codex-exec")).toBe(true);
		expect(requiresVanishBeforeAction("continue")).toBe(false);
		expect(requiresVanishBeforeAction("human-check")).toBe(false);
	});
});
