import { expect, test } from "bun:test";
import {
	createTurnContinuationSeam,
	type DeliveryOrigin,
	newTerminalScopeId,
	nextPromptAttemptEpoch,
	type TurnRegistrationKey,
} from "../../src/session/terminal-abort";

const registration: TurnRegistrationKey = {
	endpointGeneration: 1,
	lineageIdHash: "lineage-a",
	promptAttemptEpoch: 7,
	jobId: "job-1",
	jobGeneration: "gen-1",
};

const continuation = (id: string): DeliveryOrigin => ({
	kind: "turn-continuation",
	lineageIdHash: "lineage-a",
	attemptEpoch: 7,
	continuationId: id,
});

const owned = (
	originOverrides: Partial<
		Pick<Extract<DeliveryOrigin, { kind: "owned-completion" }>, "lineageIdHash" | "attemptEpoch">
	> = {},
	registrationOverrides: Partial<TurnRegistrationKey> = {},
): DeliveryOrigin => ({
	kind: "owned-completion",
	lineageIdHash: "lineage-a",
	attemptEpoch: 7,
	...originOverrides,
	registration: { ...registration, ...registrationOverrides },
});

test("fence starts open and closes synchronously", () => {
	const { fence, gate } = createTurnContinuationSeam({
		lineageIdHash: "lineage-a",
		abortedAttemptEpoch: 7,
		terminalScopeId: "scope-1",
	});
	expect(fence.state).toBe("open");
	gate.close("terminal-turn");
	expect(fence.state).toBe("closed");
});

test("post-close same-turn continuations are denied; pre-close predecessors allowed", () => {
	const { gate } = createTurnContinuationSeam({
		lineageIdHash: "lineage-a",
		abortedAttemptEpoch: 7,
		terminalScopeId: "scope-1",
	});
	// Linearize a predecessor before close.
	expect(gate.authorizeContinuation(continuation("pre-1"))).toBe("allow-predecessor");
	gate.close("terminal-turn");
	// A different continuation after close is denied.
	expect(gate.authorizeContinuation(continuation("retry-1"))).toBe("deny");
	// The pre-close predecessor remains allowed to finish its linearized work.
	expect(gate.authorizeContinuation(continuation("pre-1"))).toBe("allow-predecessor");
});

test("owned completions stay allowed after close (corrected semantics)", () => {
	const { gate } = createTurnContinuationSeam({
		lineageIdHash: "lineage-a",
		abortedAttemptEpoch: 7,
		terminalScopeId: "scope-1",
	});
	gate.close("terminal-turn");
	// Left-running owned completion is intentionally delivered as a fresh turn.
	expect(gate.authorizeOwnedCompletion(owned())).toBe("allow-new-turn");
	// Before close it is allowed too.
	const open = createTurnContinuationSeam({
		lineageIdHash: "lineage-a",
		abortedAttemptEpoch: 7,
		terminalScopeId: "scope-2",
	});
	expect(open.gate.authorizeOwnedCompletion(owned())).toBe("allow-new-turn");
});

test("owned completion fails closed on mismatched or missing metadata", () => {
	const { gate } = createTurnContinuationSeam({
		lineageIdHash: "lineage-a",
		abortedAttemptEpoch: 7,
		terminalScopeId: "scope-1",
	});
	gate.close("terminal-turn");
	expect(gate.authorizeOwnedCompletion(owned({ lineageIdHash: "other" }))).toBe("deny");
	expect(gate.authorizeOwnedCompletion(owned({}, { promptAttemptEpoch: 8 }))).toBe("deny");
	expect(gate.authorizeOwnedCompletion(owned({}, { jobId: "" }))).toBe("deny");
	expect(gate.authorizeOwnedCompletion(owned({}, { jobGeneration: "" }))).toBe("deny");
	expect(gate.authorizeOwnedCompletion(owned({}, { endpointGeneration: Number.NaN }))).toBe("deny");
	// A non-owned origin is never admitted as a new turn.
	expect(gate.authorizeOwnedCompletion({ kind: "ordinary", source: "monitor" })).toBe("deny");
	expect(gate.authorizeOwnedCompletion(continuation("x"))).toBe("deny");
});

test("disabled owned completion policy blocks new turns", () => {
	const { gate } = createTurnContinuationSeam({
		lineageIdHash: "lineage-a",
		abortedAttemptEpoch: 7,
		terminalScopeId: "scope-1",
		ownedCompletionPolicy: "disabled",
	});
	gate.close("terminal-turn");
	expect(gate.authorizeOwnedCompletion(owned())).toBe("deny");
});

test("fresh attempt epochs are monotonic and scope ids are unique", () => {
	const a = nextPromptAttemptEpoch();
	const b = nextPromptAttemptEpoch();
	expect(b).toBeGreaterThan(a);
	expect(newTerminalScopeId()).not.toBe(newTerminalScopeId());
});
