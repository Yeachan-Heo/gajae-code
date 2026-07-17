import { describe, expect, it } from "bun:test";
import { ingestReceipts, RECEIPT_DIGEST_MAX_CHARS } from "../../src/harness-control-plane/receipt-ingest";
import {
	buildReceipt,
	type CompletionEvidence,
	type ReceiptEnvelope,
	type ReceiptSubject,
	type ValidationEvidence,
} from "../../src/harness-control-plane/receipts";
import type { HarnessLifecycle, SessionState } from "../../src/harness-control-plane/types";

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

function tampered(receiptId = "bad"): ReceiptEnvelope<unknown> {
	return { ...validation(receiptId), sha256: "0".repeat(64) };
}

describe("receipt ingest", () => {
	it("transitions an eligible lifecycle to completed for a valid completion receipt", () => {
		const r = completion();
		const result = ingestReceipts(state("finalizing"), [r]);

		expect(result.accepted).toEqual([r]);
		expect(result.rejected).toEqual([]);
		expect(result.transitions).toEqual([{ from: "finalizing", to: "completed", receiptId: "c-1" }]);
		expect(result.finalLifecycle).toBe("completed");
		expect(result.digest).toContain("ingested 1 receipts: 1 accepted, 0 rejected");
		expect(result.digest).toContain("lifecycle finalizing->completed");
	});

	it("rejects a tampered receipt with no state transition", () => {
		const r = tampered();
		const result = ingestReceipts(state("finalizing"), [r]);

		expect(result.accepted).toEqual([]);
		expect(result.rejected).toEqual([{ receipt: r, reasons: ["hash-mismatch"] }]);
		expect(result.transitions).toEqual([]);
		expect(result.finalLifecycle).toBe("finalizing");
	});

	it("processes a mixed batch in order", () => {
		const acceptedNoTransition = validation("v-first");
		const acceptedTransition = completion("c-second");
		const rejectedAfterTransition = tampered("bad-third");
		const result = ingestReceipts(state("finalizing"), [
			acceptedNoTransition,
			acceptedTransition,
			rejectedAfterTransition,
		]);

		expect(result.accepted).toEqual([acceptedNoTransition, acceptedTransition]);
		expect(result.rejected).toEqual([{ receipt: rejectedAfterTransition, reasons: ["hash-mismatch"] }]);
		expect(result.transitions).toEqual([{ from: "finalizing", to: "completed", receiptId: "c-second" }]);
		expect(result.finalLifecycle).toBe("completed");
	});

	it("rejects an illegal completion transition fail-closed", () => {
		const r = completion("already-complete");
		const result = ingestReceipts(state("completed"), [r]);

		expect(result.accepted).toEqual([]);
		expect(result.rejected).toEqual([{ receipt: r, reasons: ["illegal-transition:completed->completed"] }]);
		expect(result.transitions).toEqual([]);
		expect(result.finalLifecycle).toBe("completed");
	});

	it("hard-caps the digest at 280 characters", () => {
		const rejected = Array.from({ length: 50 }, (_, index) => tampered(`bad-${index}-${"x".repeat(80)}`));
		const result = ingestReceipts(state("finalizing"), rejected);

		expect(result.rejected).toHaveLength(50);
		expect(result.digest.length).toBeLessThanOrEqual(RECEIPT_DIGEST_MAX_CHARS);
	});

	it("is deterministic for the same input", () => {
		const receipts = [validation("v"), completion("c"), tampered("bad")];
		const first = ingestReceipts(state("finalizing"), receipts);
		const second = ingestReceipts(state("finalizing"), receipts);

		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});

	it("does not mutate the input state", () => {
		const input = state("finalizing");
		const before = JSON.stringify(input);
		ingestReceipts(input, [validation("v"), completion("c")]);
		expect(JSON.stringify(input)).toBe(before);
		expect(input.lifecycle).toBe("finalizing");
	});
});
