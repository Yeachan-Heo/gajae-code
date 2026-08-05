import { expect, test } from "bun:test";
import {
	bindToolLineage,
	classifyOwnedCompletion,
	createTurnContinuationSeam,
	type DeliveryOrigin,
	lookupOwnedRegistration,
	lookupTerminalScope,
	mintTurnLineageIdHash,
	newTerminalScopeId,
	nextPromptAttemptEpoch,
	registerOwnedIfLineaged,
	registerOwnedRegistration,
	registerTerminalScope,
	registerTerminalTurnScope,
	resolveToolLineage,
	type TurnRegistrationKey,
	unbindToolLineage,
	unregisterOwnedRegistration,
	unregisterTerminalScope,
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
test("lineage bindings round-trip and fail closed", () => {
	const binding = {
		lineageIdHash: mintTurnLineageIdHash("session-1", 3, "secret-1"),
		promptAttemptEpoch: 3,
		endpointGeneration: 0,
	};
	expect(resolveToolLineage("call-1")).toBeUndefined();
	bindToolLineage("call-1", binding);
	expect(resolveToolLineage("call-1")).toEqual(binding);
	expect(resolveToolLineage(undefined)).toBeUndefined();
	unbindToolLineage("call-1");
	expect(resolveToolLineage("call-1")).toBeUndefined();
	// A rebind supersedes the prior binding on the same id.
	bindToolLineage("call-1", { ...binding, promptAttemptEpoch: 4 });
	expect(resolveToolLineage("call-1")?.promptAttemptEpoch).toBe(4);
});

test("mintTurnLineageIdHash is deterministic per inputs and opaque across epochs/secrets", () => {
	const a = mintTurnLineageIdHash("session-1", 3, "secret-1");
	expect(a).toBe(mintTurnLineageIdHash("session-1", 3, "secret-1"));
	expect(a).not.toBe(mintTurnLineageIdHash("session-1", 4, "secret-1"));
	expect(a).not.toBe(mintTurnLineageIdHash("session-2", 3, "secret-1"));
	expect(a).not.toBe(mintTurnLineageIdHash("session-1", 3, "secret-2"));
	// The hash is opaque: it never embeds the raw inputs.
	expect(a).not.toContain("session-1");
	expect(a).not.toContain("secret-1");
});

test("owned registrations round-trip, dedupe, and unregister", () => {
	expect(lookupOwnedRegistration("job-1", "gen-1")).toBeUndefined();
	registerOwnedRegistration(registration);
	expect(lookupOwnedRegistration("job-1", "gen-1")).toEqual(registration);
	// Same exact key is deduplicated, not re-inserted.
	registerOwnedRegistration(registration);
	unregisterOwnedRegistration(registration);
	expect(lookupOwnedRegistration("job-1", "gen-1")).toBeUndefined();
	// A different generation is a distinct registration.
	registerOwnedRegistration(registration);
	registerOwnedRegistration({ ...registration, jobGeneration: "gen-2" });
	expect(lookupOwnedRegistration("job-1", "gen-2")).toBeDefined();
	expect(lookupOwnedRegistration("job-1", "gen-1")).toBeDefined();
	unregisterOwnedRegistration(registration);
	unregisterOwnedRegistration({ ...registration, jobGeneration: "gen-2" });
});

test("terminal scopes round-trip by exact lineage+epoch and unregister", () => {
	const { fence, gate } = createTurnContinuationSeam({
		lineageIdHash: "lineage-a",
		abortedAttemptEpoch: 7,
		terminalScopeId: "scope-1",
	});
	expect(lookupTerminalScope("lineage-a", 7)).toBeUndefined();
	registerTerminalScope({ scopeId: "scope-1", lineageIdHash: "lineage-a", abortedAttemptEpoch: 7, gate, fence });
	expect(lookupTerminalScope("lineage-a", 7)?.scopeId).toBe("scope-1");
	// Different epoch/lineage does not resolve to this scope.
	expect(lookupTerminalScope("lineage-a", 8)).toBeUndefined();
	expect(lookupTerminalScope("lineage-other", 7)).toBeUndefined();
	unregisterTerminalScope("scope-1");
	expect(lookupTerminalScope("lineage-a", 7)).toBeUndefined();
});

test("registerOwnedIfLineaged records the exact five-tuple when lineage is bound", () => {
	bindToolLineage("call-t", {
		lineageIdHash: "lineage-a",
		promptAttemptEpoch: 7,
		endpointGeneration: 4,
	});
	const manager = { getJob: () => ({ generation: "gen-9" }) };
	registerOwnedIfLineaged(manager, "call-t", "job-9");
	expect(lookupOwnedRegistration("job-9", "gen-9")).toEqual({
		endpointGeneration: 4,
		lineageIdHash: "lineage-a",
		promptAttemptEpoch: 7,
		jobId: "job-9",
		jobGeneration: "gen-9",
	});
	unregisterOwnedRegistration({ ...registration, jobId: "job-9", jobGeneration: "gen-9" });
});

test("registerOwnedIfLineaged fails closed on missing lineage, generation, or manager", () => {
	const manager = { getJob: () => ({ generation: "gen-1" }) };
	// No bound lineage for this tool call -> no ownership claim.
	registerOwnedIfLineaged(manager, "unbound-call", "job-1");
	expect(lookupOwnedRegistration("job-1", "gen-1")).toBeUndefined();
	// Bound lineage but missing job generation -> fails closed.
	bindToolLineage("call-2", {
		lineageIdHash: "lineage-a",
		promptAttemptEpoch: 7,
		endpointGeneration: 4,
	});
	registerOwnedIfLineaged({}, "call-2", "job-2");
	expect(lookupOwnedRegistration("job-2", "gen-1")).toBeUndefined();
	// A throwing manager never breaks ordinary registration.
	bindToolLineage("call-3", {
		lineageIdHash: "lineage-a",
		promptAttemptEpoch: 7,
		endpointGeneration: 4,
	});
	expect(() =>
		registerOwnedIfLineaged(
			{
				getJob: () => {
					throw new Error("boom");
				},
			},
			"call-3",
			"job-3",
		),
	).not.toThrow();
	expect(lookupOwnedRegistration("job-3", "never-registered")).toBeUndefined();
});

test("terminal scope registry evicts oldest beyond its bound", () => {
	for (let i = 0; i < 1025; i++) {
		registerTerminalScope({
			scopeId: `scope-evict-${i}`,
			lineageIdHash: `lineage-evict-${i}`,
			abortedAttemptEpoch: i,
			gate: { close() {}, authorizeContinuation: () => "deny", authorizeOwnedCompletion: () => "deny" },
			fence: {
				state: "open",
				lineageIdHash: `lineage-evict-${i}`,
				abortedAttemptEpoch: i,
				terminalScopeId: `scope-evict-${i}`,
				blockedContinuationIds: new Set(),
				predecessorTombstones: new Set(),
				ownedCompletionPolicy: "enabled",
			},
		});
	}
	// The oldest registration was evicted; the newest survives.
	expect(lookupTerminalScope("lineage-evict-0", 0)).toBeUndefined();
	expect(lookupTerminalScope("lineage-evict-1024", 1024)).toBeDefined();
	unregisterTerminalScope("scope-evict-1024");
});
test("classifyOwnedCompletion resolves only for exact registration plus terminal scope", () => {
	// No registration -> ordinary.
	expect(classifyOwnedCompletion("job-x", "gen-x")).toBeUndefined();
	// Registered but no terminal scope for its turn -> ordinary (fail closed).
	registerOwnedRegistration(registration);
	expect(classifyOwnedCompletion("job-1", "gen-1")).toBeUndefined();
	// Missing generation -> ordinary.
	expect(classifyOwnedCompletion("job-1", undefined)).toBeUndefined();
	// Terminal scope for the exact lineage+epoch -> owned-completion.
	const { fence, gate } = createTurnContinuationSeam({
		lineageIdHash: "lineage-a",
		abortedAttemptEpoch: 7,
		terminalScopeId: "scope-1",
	});
	registerTerminalScope({ scopeId: "scope-1", lineageIdHash: "lineage-a", abortedAttemptEpoch: 7, gate, fence });
	const classified = classifyOwnedCompletion("job-1", "gen-1");
	expect(classified).toEqual({
		lineageIdHash: "lineage-a",
		promptAttemptEpoch: 7,
		registration,
		terminalScopeId: "scope-1",
	});
	// A different generation of the same job id is NOT owned (exact tuple).
	expect(classifyOwnedCompletion("job-1", "gen-other")).toBeUndefined();
	unregisterTerminalScope("scope-1");
	unregisterOwnedRegistration(registration);
});

test("classifyOwnedCompletion fails closed when the scope is removed or epoch mismatches", () => {
	registerOwnedRegistration(registration);
	const { fence, gate } = createTurnContinuationSeam({
		lineageIdHash: "lineage-a",
		abortedAttemptEpoch: 7,
		terminalScopeId: "scope-1",
	});
	registerTerminalScope({ scopeId: "scope-1", lineageIdHash: "lineage-a", abortedAttemptEpoch: 7, gate, fence });
	expect(classifyOwnedCompletion("job-1", "gen-1")).toBeDefined();
	unregisterTerminalScope("scope-1");
	// After the scope is gone, the same delivery is ordinary again.
	expect(classifyOwnedCompletion("job-1", "gen-1")).toBeUndefined();
	unregisterOwnedRegistration(registration);
});
test("registerTerminalTurnScope registers a synchronously closed scope for the turn", () => {
	const { scopeId, lineageIdHash, promptAttemptEpoch, seam } = registerTerminalTurnScope({
		lineageIdHash: "lineage-turn-1",
		promptAttemptEpoch: 9,
	});
	expect(seam.fence.state).toBe("closed");
	expect(seam.fence.ownedCompletionPolicy).toBe("enabled");
	expect(seam.fence.abortedAttemptEpoch).toBe(9);
	// The scope is lookup-able by the exact lineage+epoch.
	const found = lookupTerminalScope("lineage-turn-1", 9);
	expect(found?.scopeId).toBe(scopeId);
	expect(found?.lineageIdHash).toBe(lineageIdHash);
	expect(found?.abortedAttemptEpoch).toBe(promptAttemptEpoch);
	// Post-close same-turn continuations are denied; owned completions allowed.
	expect(seam.gate.authorizeContinuation(continuation("retry-x"))).toBe("deny");
	unregisterTerminalScope(scopeId);
	expect(lookupTerminalScope("lineage-turn-1", 9)).toBeUndefined();
});

test("registerTerminalTurnScope with owned policy disables owned-completion delivery", () => {
	const { seam } = registerTerminalTurnScope({
		lineageIdHash: "lineage-turn-2",
		promptAttemptEpoch: 11,
		ownedCompletionPolicy: "disabled",
	});
	expect(seam.fence.ownedCompletionPolicy).toBe("disabled");
	expect(
		seam.gate.authorizeOwnedCompletion(
			owned(
				{ lineageIdHash: "lineage-turn-2", attemptEpoch: 11 },
				{ ...registration, lineageIdHash: "lineage-turn-2", promptAttemptEpoch: 11 },
			),
		),
	).toBe("deny");
	unregisterTerminalScope(seam.fence.terminalScopeId);
});

test("a registered terminal turn scope makes a matching owned job classify as owned-completion", () => {
	registerTerminalTurnScope({ lineageIdHash: "lineage-chain", promptAttemptEpoch: 13 });
	registerOwnedRegistration({ ...registration, lineageIdHash: "lineage-chain", promptAttemptEpoch: 13 });
	const classified = classifyOwnedCompletion("job-1", "gen-1");
	expect(classified).toEqual({
		lineageIdHash: "lineage-chain",
		promptAttemptEpoch: 13,
		registration: { ...registration, lineageIdHash: "lineage-chain", promptAttemptEpoch: 13 },
		terminalScopeId: expect.any(String),
	});
	unregisterOwnedRegistration({ ...registration, lineageIdHash: "lineage-chain", promptAttemptEpoch: 13 });
});
