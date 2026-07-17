import { describe, expect, it } from "bun:test";
import { ingestReceipts, RECEIPT_DIGEST_MAX_CHARS } from "../../src/harness-control-plane/receipt-ingest";
import {
	buildReceipt,
	type CompletionEvidence,
	type ReceiptEnvelope,
	type ReceiptSubject,
	type ValidationEvidence,
} from "../../src/harness-control-plane/receipts";
import type { HarnessLifecycle, ReceiptFamily, SessionState } from "../../src/harness-control-plane/types";

const subject: ReceiptSubject = { workspace: "/ws", branch: "feat/x", head: "abc", commit: "abc" };

function state(lifecycle: HarnessLifecycle = "finalizing"): SessionState {
	return {
		schemaVersion: 1,
		sessionId: "s",
		lifecycle,
		harness: "gajae-code",
		handle: {
			sessionId: "s",
			harness: "gajae-code",
			mode: "implement",
			repo: "/repo",
			workspace: "/ws",
			branch: "feat/x",
			base: "main",
			issueOrPr: null,
			processHandle: { kind: "runtime-owner", ownerId: null, pid: null },
			sdkHandle: { kind: "sdk-session-endpoint", sessionId: "s" },
			ownerHandle: { leasePath: "/tmp/s/lease", endpoint: null, heartbeatAt: null },
			routerHandle: { kind: "default-in-owner", policy: "default", eventsPath: "/tmp/s/events.jsonl" },
			viewportHandle: { kind: "event-monitor", tmuxSessionName: null, viewOnly: true },
			startedAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		retries: {},
		blockers: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function completion(receiptId = "c-1"): ReceiptEnvelope<CompletionEvidence> {
	return buildReceipt<CompletionEvidence>({
		receiptId,
		sessionId: "s",
		family: "completion",
		source: "test",
		subject,
		createdAt: "2026-01-01T00:00:00.000Z",
		evidence: {
			finalCommit: "abc",
			branch: "feat/x",
			prUrl: "https://example.test/pr/1",
			issueArtifact: null,
			requiredValidationReceiptIds: ["v-1"],
			finalLifecycle: "completed",
			finalizedAt: "2026-01-01T00:00:00.000Z",
			blockers: [],
		},
	});
}

function validation(receiptId = "v-1"): ReceiptEnvelope<ValidationEvidence> {
	return buildReceipt<ValidationEvidence>({
		receiptId,
		sessionId: "s",
		family: "validation",
		source: "test",
		subject,
		createdAt: "2026-01-01T00:00:00.000Z",
		evidence: {
			command: "test",
			exactCommand: "bun test x",
			cwd: "/ws",
			exitStatus: 0,
			pass: true,
			commitUnderTest: "abc",
		},
	});
}

function tampered(receiptId: string): ReceiptEnvelope<ValidationEvidence> {
	return { ...validation(receiptId), sha256: "0".repeat(64) };
}

describe("receipt ingest red-team", () => {
	it("returns a sane digest and no transitions for an empty batch", () => {
		const result = ingestReceipts(state("finalizing"), []);

		expect(result.accepted).toEqual([]);
		expect(result.rejected).toEqual([]);
		expect(result.transitions).toEqual([]);
		expect(result.finalLifecycle).toBe("finalizing");
		expect(result.digest).toBe("ingested 0 receipts: 0 accepted, 0 rejected; lifecycle finalizing->finalizing");
		expect(result.digest.length).toBeLessThanOrEqual(RECEIPT_DIGEST_MAX_CHARS);
	});

	it("rejects unknown families fail-closed without lifecycle transitions", () => {
		const unknownFamily = buildReceipt({
			receiptId: "unknown-family",
			sessionId: "s",
			family: "unknown" as ReceiptFamily,
			source: "test",
			subject,
			createdAt: "2026-01-01T00:00:00.000Z",
			evidence: {},
		});

		const result = ingestReceipts(state("finalizing"), [unknownFamily]);

		expect(result.accepted).toEqual([]);
		expect(result.rejected).toEqual([{ receipt: unknownFamily, reasons: ["unknown-family:unknown"] }]);
		expect(result.transitions).toEqual([]);
		expect(result.finalLifecycle).toBe("finalizing");
	});

	it("rejects the second completion receipt in a batch after the first completes lifecycle", () => {
		const first = completion("c-first");
		const second = completion("c-second");
		const result = ingestReceipts(state("finalizing"), [first, second]);

		expect(result.accepted).toEqual([first]);
		expect(result.rejected).toEqual([{ receipt: second, reasons: ["illegal-transition:completed->completed"] }]);
		expect(result.transitions).toEqual([{ from: "finalizing", to: "completed", receiptId: "c-first" }]);
		expect(result.finalLifecycle).toBe("completed");
	});

	it("caps digest for a batch of 100 tampered receipts", () => {
		const receipts = Array.from({ length: 100 }, (_, index) => tampered(`tampered-${index}-${"x".repeat(50)}`));
		const result = ingestReceipts(state("finalizing"), receipts);

		expect(result.accepted).toEqual([]);
		expect(result.rejected).toHaveLength(100);
		expect(result.digest.length).toBeLessThanOrEqual(RECEIPT_DIGEST_MAX_CHARS);
		expect(result.digest).toContain("ingested 100 receipts: 0 accepted, 100 rejected");
	});

	it("rejects schema-version mismatches", () => {
		const mismatched = { ...validation("schema-mismatch"), schemaVersion: 2 };
		const result = ingestReceipts(state("finalizing"), [mismatched]);

		expect(result.accepted).toEqual([]);
		expect(result.rejected).toEqual([{ receipt: mismatched, reasons: ["hash-mismatch", "schema-version-mismatch"] }]);
		expect(result.transitions).toEqual([]);
		expect(result.finalLifecycle).toBe("finalizing");
	});

	it("rejects self-consistent receipts from a different session without transitioning", () => {
		const foreign = buildReceipt<CompletionEvidence>({
			receiptId: "c-foreign",
			sessionId: "other-session",
			family: "completion",
			source: "test",
			subject,
			createdAt: "2026-01-01T00:00:00.000Z",
			evidence: {
				finalCommit: "abc",
				branch: "feat/x",
				prUrl: "https://example.test/pr/1",
				issueArtifact: null,
				requiredValidationReceiptIds: ["v-1"],
				finalLifecycle: "completed",
				finalizedAt: "2026-01-01T00:00:00.000Z",
				blockers: [],
			},
		});

		const result = ingestReceipts(state("finalizing"), [foreign]);

		expect(result.accepted).toEqual([]);
		expect(result.rejected).toEqual([{ receipt: foreign, reasons: ["session-mismatch:other-session"] }]);
		expect(result.transitions).toEqual([]);
		expect(result.finalLifecycle).toBe("finalizing");
	});

	it("rejects hash-consistent receipts whose envelope marks them invalid", () => {
		const markedInvalid = buildReceipt<CompletionEvidence>({
			receiptId: "c-invalid",
			sessionId: "s",
			family: "completion",
			source: "test",
			subject,
			createdAt: "2026-01-01T00:00:00.000Z",
			valid: false,
			evidence: {
				finalCommit: "abc",
				branch: "feat/x",
				prUrl: "https://example.test/pr/1",
				issueArtifact: null,
				requiredValidationReceiptIds: ["v-1"],
				finalLifecycle: "completed",
				finalizedAt: "2026-01-01T00:00:00.000Z",
				blockers: [],
			},
		});

		const result = ingestReceipts(state("finalizing"), [markedInvalid]);

		expect(result.accepted).toEqual([]);
		expect(result.rejected).toEqual([{ receipt: markedInvalid, reasons: ["receipt-marked-invalid"] }]);
		expect(result.transitions).toEqual([]);
		expect(result.finalLifecycle).toBe("finalizing");
	});

	it("a terminal review verdict completes a finalizing review session", () => {
		const verdict = buildReceipt({
			receiptId: "rv-approve",
			sessionId: "s",
			family: "review-verdict",
			source: "test",
			subject,
			createdAt: "2026-01-01T00:00:00.000Z",
			evidence: {
				verdict: "APPROVE_MERGE_READY",
				prTarget: "https://example.test/pr/1",
				finalizedAt: "2026-01-01T00:00:00.000Z",
				summaryRef: null,
			},
		});

		const result = ingestReceipts(state("finalizing"), [verdict]);

		expect(result.accepted).toEqual([verdict]);
		expect(result.transitions).toEqual([{ from: "finalizing", to: "completed", receiptId: "rv-approve" }]);
		expect(result.finalLifecycle).toBe("completed");
	});

	it("OWNER_CONFIRMATION_REQUIRED verdicts are accepted but do not complete", () => {
		const verdict = buildReceipt({
			receiptId: "rv-owner",
			sessionId: "s",
			family: "review-verdict",
			source: "test",
			subject,
			createdAt: "2026-01-01T00:00:00.000Z",
			evidence: {
				verdict: "OWNER_CONFIRMATION_REQUIRED",
				prTarget: null,
				finalizedAt: "2026-01-01T00:00:00.000Z",
				summaryRef: null,
			},
		});

		const result = ingestReceipts(state("finalizing"), [verdict]);

		expect(result.accepted).toEqual([verdict]);
		expect(result.transitions).toEqual([]);
		expect(result.finalLifecycle).toBe("finalizing");
	});

	it("rejects completion receipts whose evidence finalLifecycle disagrees", () => {
		const contradictory = buildReceipt<CompletionEvidence>({
			receiptId: "c-contradiction",
			sessionId: "s",
			family: "completion",
			source: "test",
			subject,
			createdAt: "2026-01-01T00:00:00.000Z",
			evidence: {
				finalCommit: "abc",
				branch: "feat/x",
				prUrl: "https://example.test/pr/1",
				issueArtifact: null,
				requiredValidationReceiptIds: ["v-1"],
				finalLifecycle: "finalizing",
				finalizedAt: "2026-01-01T00:00:00.000Z",
				blockers: [],
			},
		});

		const result = ingestReceipts(state("finalizing"), [contradictory]);

		expect(result.accepted).toEqual([]);
		expect(result.rejected).toEqual([
			{ receipt: contradictory, reasons: ["evidence-lifecycle-mismatch:finalizing"] },
		]);
		expect(result.transitions).toEqual([]);
		expect(result.finalLifecycle).toBe("finalizing");
	});
});
