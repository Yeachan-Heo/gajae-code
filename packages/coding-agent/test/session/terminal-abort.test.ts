import { beforeEach, expect, test } from "bun:test";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ownedCompletionResumeAction } from "../../src/session/agent-session";
import {
	bindToolLineage,
	boundCompletedTerminalScopeRows,
	boundEvictedTerminalKeys,
	boundTerminalRetentionState,
	classifyOwnedCompletion,
	classifyOwnedEnvelope,
	collectEvictedTerminalKeys,
	createTurnContinuationSeam,
	type DeliveryOrigin,
	findOwnedRegistrationsForTurn,
	isOwnedAttemptRegistrationIncomplete,
	isOwnedCompletionEnvelopeAllowed,
	lookupOwnedRegistration,
	lookupTerminalScope,
	mintTurnLineageIdHash,
	newTerminalScopeId,
	nextPromptAttemptEpoch,
	registerOwnedIfLineaged,
	registerOwnedRegistration,
	registerTerminalScope,
	registerTerminalTurnScope,
	resetTerminalAbortRegistriesForTests,
	resolveToolLineage,
	retireOwnedRegistrationForDeadLetter,
	retireOwnedRegistrationsForEndpoint,
	settleOwnedWork,
	settleToolLineageRegistrationWindow,
	type TurnRegistrationKey,
	unbindToolLineage,
	unregisterOwnedRegistration,
	unregisterTerminalScope,
} from "../../src/session/terminal-abort";

test("retireOwnedRegistrationsForEndpoint removes the disposing endpoint's live and retained tuples only", () => {
	// A disposing session's owned registrations can never reach a delivery
	// settlement boundary, and other managers deliberately never classify
	// foreign-endpoint tuples as terminal — retiring them at dispose prevents
	// repeated session churn from saturating the 8192-entry registry and making
	// all later owned aborts fail closed (review thread P2).
	const jobOf = (n: number) => ({ ...registration, jobId: `retire-a-${n}`, jobGeneration: `gen-${n}` });
	// Saturate the live map and force evictions: with isJobTerminal always true,
	// each registration beyond the cap moves an older terminal tuple into the
	// retained evidence (compact pending-authorization tuples).
	for (let n = 1; n <= 8200; n++) {
		registerOwnedRegistration({ ...jobOf(n), endpointId: "ep-a" }, { isJobTerminal: () => true });
	}
	// An early evicted tuple lives in the RETAINED evidence (still findable).
	expect(lookupOwnedRegistration("retire-a-1", "gen-1", "ep-a")).toBeDefined();
	// A recent tuple is still LIVE.
	expect(lookupOwnedRegistration("retire-a-8200", "gen-8200", "ep-a")).toBeDefined();
	// A foreign endpoint registers fine (its candidate eviction is terminal).
	// A foreign endpoint registers fine (its candidate eviction is terminal).
	registerOwnedRegistration(
		{ ...registration, endpointId: "ep-b", jobId: "retire-b", jobGeneration: "gen-b" },
		{ isJobTerminal: () => true },
	);
	expect(lookupOwnedRegistration("retire-b", "gen-b", "ep-b")).toBeDefined();
	// Retire ONLY ep-a: live, retained, and backlogged ep-a tuples all go.
	retireOwnedRegistrationsForEndpoint("ep-a");
	for (const n of [1, 1024, 4096, 8192, 8200]) {
		expect(lookupOwnedRegistration(`retire-a-${n}`, `gen-${n}`, "ep-a")).toBeUndefined();
	}
	// The foreign endpoint's registration is untouched.
	expect(lookupOwnedRegistration("retire-b", "gen-b", "ep-b")).toBeDefined();
	// And the registry is back under its live cap with only ep-b's tuple.
	expect(
		[1, 2, 3].map(n =>
			lookupOwnedRegistration(`retire-a-${n}`, `gen-${n}`, "ep-a") === undefined ? "gone" : "present",
		),
	).toEqual(["gone", "gone", "gone"]);
	unregisterOwnedRegistration({ ...registration, endpointId: "ep-b", jobId: "retire-b", jobGeneration: "gen-b" });
});

test("findOwnedRegistrationsForTurn includes retained-evidence tuples", () => {
	// A terminal job evicted into the retained evidence (its execution promise
	// may still be unwinding) is still exact causal work of the attempt: a
	// scope:"owned" abort must include it in the settlement set, or it could
	// claim stopped_owned before the job is quiescent (review thread P2).
	for (let n = 0; n < 8200; n++) {
		registerOwnedRegistration(
			{
				...registration,
				endpointId: "ep-turn",
				lineageIdHash: "retained-turn-lineage",
				promptAttemptEpoch: 99,
				jobId: `turn-${n}`,
				jobGeneration: "gen-1",
			},
			{ isJobTerminal: () => true },
		);
	}
	const set = findOwnedRegistrationsForTurn("retained-turn-lineage", 99);
	// Every registration of the attempt is captured — including the oldest
	// tuples evicted into the retained evidence (turn-0 is no longer live).
	expect(set.length).toBe(8200);
	expect(set.some(r => r.jobId === "turn-0")).toBe(true);
	expect(set.some(r => r.jobId === "turn-8199")).toBe(true);
	// The retained tuple is settled by unregisterOwnedRegistration too.
	const oldest = set.find(r => r.jobId === "turn-0")!;
	unregisterOwnedRegistration(oldest);
	expect(lookupOwnedRegistration("turn-0", "gen-1", "ep-turn")).toBeUndefined();
});

beforeEach(() => {
	// Isolate the process-lifetime registries per test (job ids/generations
	// collide across tests; bindings/scopes persist otherwise).
	resetTerminalAbortRegistriesForTests();
});

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
	registerOwnedRegistration(registration);
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
	unregisterOwnedRegistration(registration);
});

test("owned completion fails closed on mismatched or missing metadata", () => {
	registerOwnedRegistration(registration);
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
	unregisterOwnedRegistration(registration);
});

test("owned completion gate denies forged or unregistered registration tuples", () => {
	const { gate } = createTurnContinuationSeam({
		lineageIdHash: "lineage-a",
		abortedAttemptEpoch: 7,
		terminalScopeId: "scope-1",
	});
	gate.close("terminal-turn");
	// The tuple is NOT registered: even with a matching lineage/epoch the gate
	// must fail closed (AC 25 — missing/copied/mismatched origin never
	// authorizes an automatic call).
	expect(gate.authorizeOwnedCompletion(owned())).toBe("deny");
	// A registered tuple with a FORGED job generation is denied.
	registerOwnedRegistration(registration);
	expect(gate.authorizeOwnedCompletion(owned({}, { jobGeneration: "forged-gen" }))).toBe("deny");
	// A registered tuple with a FORGED endpoint generation is denied.
	expect(gate.authorizeOwnedCompletion(owned({}, { endpointGeneration: 99 }))).toBe("deny");
	// The exact registered tuple is allowed.
	expect(gate.authorizeOwnedCompletion(owned())).toBe("allow-new-turn");
	unregisterOwnedRegistration(registration);
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
	const registered = registerTerminalTurnScope({
		lineageIdHash: "lineage-turn-1",
		promptAttemptEpoch: 9,
	});
	expect(registered).toBeDefined();
	const { scopeId, lineageIdHash, promptAttemptEpoch, seam } = registered!;
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
	})!;
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
test("findOwnedRegistrationsForTurn returns only exact lineage+epoch registrations", () => {
	registerOwnedRegistration({ ...registration, lineageIdHash: "lineage-a", promptAttemptEpoch: 7 });
	registerOwnedRegistration({
		...registration,
		jobId: "job-2",
		lineageIdHash: "lineage-a",
		promptAttemptEpoch: 7,
	});
	registerOwnedRegistration({
		...registration,
		jobId: "job-foreign",
		lineageIdHash: "lineage-other",
		promptAttemptEpoch: 7,
	});
	registerOwnedRegistration({
		...registration,
		jobId: "job-later",
		lineageIdHash: "lineage-a",
		promptAttemptEpoch: 8,
	});
	const exact = findOwnedRegistrationsForTurn("lineage-a", 7);
	expect(exact.map(key => key.jobId).sort()).toEqual(["job-1", "job-2"]);
	// Foreign lineage and a different epoch are never captured.
	expect(findOwnedRegistrationsForTurn("lineage-other", 7).map(key => key.jobId)).toEqual(["job-foreign"]);
	expect(findOwnedRegistrationsForTurn("lineage-a", 8).map(key => key.jobId)).toEqual(["job-later"]);
	expect(findOwnedRegistrationsForTurn("lineage-none", 7)).toEqual([]);
	unregisterOwnedRegistration({ ...registration, lineageIdHash: "lineage-a", promptAttemptEpoch: 7 });
	unregisterOwnedRegistration({
		...registration,
		jobId: "job-2",
		lineageIdHash: "lineage-a",
		promptAttemptEpoch: 7,
	});
	unregisterOwnedRegistration({
		...registration,
		jobId: "job-foreign",
		lineageIdHash: "lineage-other",
		promptAttemptEpoch: 7,
	});
	unregisterOwnedRegistration({
		...registration,
		jobId: "job-later",
		lineageIdHash: "lineage-a",
		promptAttemptEpoch: 8,
	});
});

test("settling an evicted tuple removes it despite a live replacement", () => {
	for (let index = 0; index <= 8192; index++) {
		registerOwnedRegistration(
			{ ...registration, jobId: `evicted-${index}`, jobGeneration: `generation-${index}` },
			{ isJobTerminal: () => true },
		);
	}
	const evicted = { ...registration, jobId: "evicted-0", jobGeneration: "generation-0" };
	expect(lookupOwnedRegistration(evicted.jobId, evicted.jobGeneration, evicted.endpointId)).toEqual(evicted);
	const replacement = { ...evicted, lineageIdHash: "replacement-lineage", promptAttemptEpoch: 8 };
	registerOwnedRegistration(replacement, { isJobTerminal: () => true });
	unregisterOwnedRegistration(evicted);
	unregisterOwnedRegistration(replacement);
	expect(lookupOwnedRegistration(evicted.jobId, evicted.jobGeneration, evicted.endpointId)).toBeUndefined();
});

test("settleOwnedWork stops exact jobs, purges deliveries, and returns stopped", async () => {
	const cancelled: string[] = [];
	const purged: string[][] = [];
	const jobs = new Map([
		["job-1", { generation: "gen-1", status: "running" }],
		["job-2", { generation: "gen-1", status: "running" }],
	]);
	const manager = {
		cancel: (jobId: string) => {
			cancelled.push(jobId);
			const job = jobs.get(jobId);
			if (job && job.status !== "paused") job.status = "cancelled";
			return true;
		},
		getJob: (jobId: string) => jobs.get(jobId),
		acknowledgeDeliveries: (jobIds: string[]) => {
			purged.push(jobIds);
			return jobIds.length;
		},
	};
	const outcome = await settleOwnedWork(
		manager,
		[
			{ ...registration, jobId: "job-1", jobGeneration: "gen-1" },
			{ ...registration, jobId: "job-2", jobGeneration: "gen-1" },
		],
		5,
	);
	expect(outcome).toBe("stopped");
	expect(cancelled.sort()).toEqual(["job-1", "job-2"]);
	expect(purged).toEqual([["job-1", "job-2"]]);
});

test("settleOwnedWork fails closed on a reused id with a new generation (no foreign sweep)", async () => {
	const cancelled: string[] = [];
	const purged: string[][] = [];
	const manager = {
		cancel: (jobId: string) => {
			cancelled.push(jobId);
			return true;
		},
		getJob: (jobId: string) => (jobId === "job-1" ? { generation: "gen-2", status: "running" } : undefined),
		acknowledgeDeliveries: (jobIds: string[]) => {
			purged.push(jobIds);
			return jobIds.length;
		},
	};
	const outcome = await settleOwnedWork(manager, [{ ...registration, jobId: "job-1", jobGeneration: "gen-1" }], 5);
	expect(outcome).toBe("unsettled");
	// The foreign (reused) job must NOT be cancelled or purged.
	expect(cancelled).toEqual([]);
	expect(purged).toEqual([]);
});

test("settleOwnedWork cancels every generation-matching job despite another reused id", async () => {
	const cancelled: string[] = [];
	const jobs = new Map([
		["mismatched", { generation: "new-generation", status: "running" }],
		["matching-after", { generation: "gen-2", status: "running" }],
	]);
	const manager = {
		cancel: (jobId: string) => {
			cancelled.push(jobId);
			const job = jobs.get(jobId);
			if (job) job.status = "cancelled";
			return true;
		},
		getJob: (jobId: string) => jobs.get(jobId),
		acknowledgeDeliveries: () => 0,
	};
	const outcome = await settleOwnedWork(
		manager,
		[
			{ ...registration, jobId: "mismatched", jobGeneration: "old-generation" },
			{ ...registration, jobId: "matching-after", jobGeneration: "gen-2" },
		],
		5,
	);
	expect(outcome).toBe("unsettled");
	expect(cancelled).toEqual(["matching-after"]);
});

test("settleOwnedWork fails closed when a captured job is still running or missing after grace", async () => {
	const running = {
		cancel: () => true,
		getJob: () => ({ generation: "gen-1", status: "running" }),
		acknowledgeDeliveries: () => 0,
	};
	expect(await settleOwnedWork(running, [registration], 2)).toBe("unsettled");

	const missing = {
		cancel: () => true,
		getJob: () => undefined,
		acknowledgeDeliveries: () => 0,
	};
	expect(await settleOwnedWork(missing, [registration], 2)).toBe("unsettled");

	const paused = {
		cancel: (_jobId: string) => true,
		getJob: () => ({ generation: "gen-1", status: "paused" }),
		acknowledgeDeliveries: () => 0,
	};
	expect(await settleOwnedWork(paused, [registration], 2)).toBe("unsettled");
});

test("settleOwnedWork fails closed when the job id is reused with a new generation during grace", async () => {
	const cancelled: string[] = [];
	const purged: string[][] = [];
	let generation = "gen-1";
	const manager = {
		cancel: (jobId: string) => {
			cancelled.push(jobId);
			return true;
		},
		getJob: () => ({ generation, status: "cancelled" }),
		acknowledgeDeliveries: (jobIds: string[]) => {
			purged.push(jobIds);
			return jobIds.length;
		},
	};
	// The job id is reused with a NEW generation between the cancel and the
	// second proof: the foreign job must not be claimed or purged.
	const settling = settleOwnedWork(manager, [registration], 20);
	generation = "gen-2";
	const outcome = await settling;
	expect(outcome).toBe("unsettled");
	expect(purged).toEqual([]);
	// Only the exact captured generation was cancelled; the foreign job record
	// was left untouched (no post-grace claim of it).
	expect(cancelled).toEqual(["job-1"]);
});

test("ownedCompletionResumeAction drops denied owned deliveries at the injector boundary", async () => {
	// An ordinary async-result message (no envelope) delivers as before.
	expect(ownedCompletionResumeAction({ role: "custom", customType: "async-result" } as never)).toBe("ordinary");
	// A scope:"turn" envelope with the exact registered tuple resumes fresh.
	const turnScope = registerTerminalTurnScope({ lineageIdHash: "lineage-drop", promptAttemptEpoch: 21 })!;
	registerOwnedRegistration({
		...registration,
		jobId: "job-drop",
		jobGeneration: "gen-drop",
		lineageIdHash: "lineage-drop",
		promptAttemptEpoch: 21,
	});
	const freshMessage = {
		details: {
			ownedCompletions: [
				{
					lineageIdHash: "lineage-drop",
					promptAttemptEpoch: 21,
					registration: {
						...registration,
						jobId: "job-drop",
						jobGeneration: "gen-drop",
						lineageIdHash: "lineage-drop",
						promptAttemptEpoch: 21,
					},
				},
			],
		},
	} as never;
	expect(ownedCompletionResumeAction(freshMessage)).toBe("fresh");
	// A scope:"owned" envelope (policy disabled) is DROPPED — stopped work must
	// never call followUp/prompt even if a delivery races the purge.
	const ownedScope = registerTerminalTurnScope({
		lineageIdHash: "lineage-owned",
		promptAttemptEpoch: 22,
		ownedCompletionPolicy: "disabled",
	})!;
	registerOwnedRegistration({
		...registration,
		jobId: "job-owned",
		jobGeneration: "gen-owned",
		lineageIdHash: "lineage-owned",
		promptAttemptEpoch: 22,
	});
	const ownedMessage = {
		details: {
			ownedCompletions: [
				{
					lineageIdHash: "lineage-owned",
					promptAttemptEpoch: 22,
					registration: {
						...registration,
						jobId: "job-owned",
						jobGeneration: "gen-owned",
						lineageIdHash: "lineage-owned",
						promptAttemptEpoch: 22,
					},
				},
			],
		},
	} as never;
	expect(ownedCompletionResumeAction(ownedMessage)).toBe("drop");
	// A forged/unregistered tuple is dropped.
	expect(ownedCompletionResumeAction(freshMessage)).toBe("fresh");
	expect(
		ownedCompletionResumeAction({
			details: {
				ownedCompletions: [
					{
						lineageIdHash: "lineage-drop",
						promptAttemptEpoch: 21,
						registration: {
							...registration,
							jobId: "job-drop",
							lineageIdHash: "lineage-drop",
							promptAttemptEpoch: 21,
							jobGeneration: "forged",
						},
					},
				],
			},
		} as never),
	).toBe("drop");
	// An envelope whose scope no longer exists is ORDINARY: ownership is kept
	// on the entry regardless of scope (P1), and no active scope means normal
	// delivery — the owned-drop applies only to an existing disabled scope.
	unregisterTerminalScope(turnScope.scopeId);
	expect(ownedCompletionResumeAction(freshMessage)).toBe("ordinary");
	unregisterTerminalScope(ownedScope.scopeId);
	unregisterOwnedRegistration({
		...registration,
		jobId: "job-drop",
		jobGeneration: "gen-drop",
		lineageIdHash: "lineage-drop",
		promptAttemptEpoch: 21,
	});
	unregisterOwnedRegistration({
		...registration,
		jobId: "job-owned",
		jobGeneration: "gen-owned",
		lineageIdHash: "lineage-owned",
		promptAttemptEpoch: 22,
	});
});

test("mixed owned-completion batches drop when ANY envelope is denied", async () => {
	// Allowed turn-scope envelope (distinct job key from the denied fixture:
	// the registry overwrites reused (jobId, generation) tuples).
	const turnScope = registerTerminalTurnScope({ lineageIdHash: "lineage-mix-a", promptAttemptEpoch: 31 })!;
	registerOwnedRegistration({
		...registration,
		jobId: "job-mix-a",
		jobGeneration: "gen-mix-a",
		lineageIdHash: "lineage-mix-a",
		promptAttemptEpoch: 31,
	});
	const allowed = {
		lineageIdHash: "lineage-mix-a",
		promptAttemptEpoch: 31,
		registration: {
			...registration,
			jobId: "job-mix-a",
			jobGeneration: "gen-mix-a",
			lineageIdHash: "lineage-mix-a",
			promptAttemptEpoch: 31,
		},
	};
	// Denied owned-scope envelope (policy disabled).
	const ownedScope = registerTerminalTurnScope({
		lineageIdHash: "lineage-mix-b",
		promptAttemptEpoch: 32,
		ownedCompletionPolicy: "disabled",
	})!;
	registerOwnedRegistration({
		...registration,
		jobId: "job-mix-b",
		jobGeneration: "gen-mix-b",
		lineageIdHash: "lineage-mix-b",
		promptAttemptEpoch: 32,
	});
	const denied = {
		lineageIdHash: "lineage-mix-b",
		promptAttemptEpoch: 32,
		registration: {
			...registration,
			jobId: "job-mix-b",
			jobGeneration: "gen-mix-b",
			lineageIdHash: "lineage-mix-b",
			promptAttemptEpoch: 32,
		},
	};
	const message = (ownedCompletions: unknown[]) => ({ details: { ownedCompletions } }) as never;
	// Allowed-then-denied and denied-then-allowed orderings both drop.
	expect(ownedCompletionResumeAction(message([allowed, denied]))).toBe("drop");
	expect(ownedCompletionResumeAction(message([denied, allowed]))).toBe("drop");
	// All-allowed stays fresh; no envelope is ordinary.
	expect(ownedCompletionResumeAction(message([allowed, allowed]))).toBe("fresh");
	expect(ownedCompletionResumeAction(message([]))).toBe("ordinary");
	// Build-time partitioning predicate: a denied envelope is never allowed.
	expect(isOwnedCompletionEnvelopeAllowed(denied)).toBe(false);
	expect(isOwnedCompletionEnvelopeAllowed(allowed)).toBe(true);
	unregisterTerminalScope(turnScope.scopeId);
	unregisterTerminalScope(ownedScope.scopeId);
	unregisterOwnedRegistration({
		...registration,
		jobId: "job-mix-a",
		jobGeneration: "gen-mix-a",
		lineageIdHash: "lineage-mix-a",
		promptAttemptEpoch: 31,
	});
	unregisterOwnedRegistration({
		...registration,
		jobId: "job-mix-b",
		jobGeneration: "gen-mix-b",
		lineageIdHash: "lineage-mix-b",
		promptAttemptEpoch: 32,
	});
});

test("pre-abort completion keeps ownership and is dropped once an owned scope lands", async () => {
	// A job completes BEFORE any terminal abort: registered but no scope yet.
	registerOwnedRegistration({ ...registration, lineageIdHash: "lineage-p1", promptAttemptEpoch: 51 });
	const envelope = {
		lineageIdHash: "lineage-p1",
		promptAttemptEpoch: 51,
		registration: { ...registration, lineageIdHash: "lineage-p1", promptAttemptEpoch: 51 },
	};
	const message = { details: { ownedCompletions: [envelope] } } as never;
	// No scope -> ordinary (normal delivery; ownership preserved on the entry).
	expect(ownedCompletionResumeAction(message)).toBe("ordinary");
	expect(isOwnedCompletionEnvelopeAllowed(envelope)).toBe(true);
	// The owned scope lands AFTER the completion was queued: the same entry is
	// now classified as owned-stopped work and must be dropped, so the queued
	// async result can never resume the agent (review thread P1).
	registerTerminalTurnScope({
		lineageIdHash: "lineage-p1",
		promptAttemptEpoch: 51,
		ownedCompletionPolicy: "disabled",
	});
	expect(ownedCompletionResumeAction(message)).toBe("drop");
	expect(isOwnedCompletionEnvelopeAllowed(envelope)).toBe(false);
});

test("registerOwnedRegistration overwrites a reused tuple from a different turn", () => {
	registerOwnedRegistration(registration);
	// Same tuple, same lineage -> idempotent no-op.
	registerOwnedRegistration(registration);
	expect(lookupOwnedRegistration("job-1", "gen-1")).toEqual(registration);
	// Reused (jobId, generation) with a DIFFERENT lineage (fresh manager after
	// session replacement restarts ids at bg_1/job:1) must OVERWRITE so the new
	// job binds to its own turn (review thread P1).
	const fresh = { ...registration, lineageIdHash: "lineage-new-session", promptAttemptEpoch: 99 };
	registerOwnedRegistration(fresh);
	expect(lookupOwnedRegistration("job-1", "gen-1")).toEqual(fresh);
	unregisterOwnedRegistration(fresh);
});

test("boundCompletedTerminalScopeRows evicts the oldest completed rows but never pending markers", () => {
	const rows: Array<{
		idempotencyKeyHash: string;
		idempotencyInputHash: string;
		turnDisposition: string;
		acceptedAt: number;
	}> = [];
	for (let i = 0; i < 300; i++) {
		rows.push({
			idempotencyKeyHash: `k${i}`,
			idempotencyInputHash: `i${i}`,
			turnDisposition: "no_effect",
			acceptedAt: i,
		});
	}
	rows.push({
		idempotencyKeyHash: "stopped-key",
		idempotencyInputHash: "i",
		turnDisposition: "stopped",
		acceptedAt: 0,
	});
	rows.push({
		idempotencyKeyHash: "pending-key",
		idempotencyInputHash: "i",
		turnDisposition: "pending",
		acceptedAt: 0,
	});
	const bounded = boundCompletedTerminalScopeRows(rows, 256);
	// 300 completed + 1 stopped -> 256 completed kept (45 oldest evicted); the
	// pending marker is NEVER evicted.
	expect(bounded.filter((r: { turnDisposition: string }) => r.turnDisposition !== "pending")).toHaveLength(256);
	expect(bounded.some((r: { idempotencyKeyHash: string }) => r.idempotencyKeyHash === "k0")).toBe(false);
	expect(bounded.some((r: { idempotencyKeyHash: string }) => r.idempotencyKeyHash === "k43")).toBe(false);
	expect(bounded.some((r: { idempotencyKeyHash: string }) => r.idempotencyKeyHash === "k44")).toBe(true);
	expect(bounded.some((r: { idempotencyKeyHash: string }) => r.idempotencyKeyHash === "k299")).toBe(true);
	expect(bounded.some((r: { idempotencyKeyHash: string }) => r.idempotencyKeyHash === "stopped-key")).toBe(false);
	expect(bounded.some((r: { idempotencyKeyHash: string }) => r.idempotencyKeyHash === "pending-key")).toBe(true);
});

test("a transitional no_effect_reserved row survives eviction of a completed row sharing its key pair", () => {
	// The evict set is keyed by key+input hash, so applying it to anything other
	// than a COMPLETED row deletes a live reservation: the abort that owns it
	// would then finalize into nothing and a same-key retry would replay
	// uncertainty over an unfinalized reservation (review thread P2).
	const rows = [
		...Array.from({ length: 257 }, (_, i) => ({
			idempotencyKeyHash: `k${i}`,
			idempotencyInputHash: `i${i}`,
			turnDisposition: "no_effect",
			acceptedAt: i,
		})),
		{
			// Shares the key pair of the OLDEST completed row (k0), which is the one
			// row the cap evicts.
			idempotencyKeyHash: "k0",
			idempotencyInputHash: "i0",
			turnDisposition: "no_effect_reserved",
			acceptedAt: 0,
		},
	];
	const bounded = boundCompletedTerminalScopeRows(rows, 256);
	expect(bounded.filter(row => row.turnDisposition === "no_effect")).toHaveLength(256);
	expect(bounded.some(row => row.turnDisposition === "no_effect" && row.idempotencyKeyHash === "k0")).toBe(false);
	expect(bounded.filter(row => row.turnDisposition === "no_effect_reserved")).toHaveLength(1);
	// The surviving reservation keeps the key alive, so no tombstone claims
	// replay authority over it.
	expect(collectEvictedTerminalKeys(rows, bounded)).toHaveLength(0);
});

test("collectEvictedTerminalKeys never mints a tombstone for a transitional reservation", () => {
	// A reservation is not evictable, so it must not be tombstoned either — a
	// tombstone would replay uncertainty over a reservation the owning abort can
	// still finalize (review thread P2).
	const reserved = {
		idempotencyKeyHash: "reserved-key",
		idempotencyInputHash: "reserved-input",
		turnDisposition: "no_effect_reserved",
		ownedWorkDisposition: "not_requested" as const,
		acceptedAt: 1,
	};
	const completed = {
		idempotencyKeyHash: "completed-key",
		idempotencyInputHash: "completed-input",
		turnDisposition: "stopped",
		ownedWorkDisposition: "stopped" as const,
		acceptedAt: 2,
	};
	const evicted = collectEvictedTerminalKeys([reserved, completed], []);
	expect(evicted.map(key => key.keyHash)).toEqual(["completed-key"]);
});

test("evicted terminal scopes retain their attempt policy via a compact tombstone", () => {
	// Register a turn-scope attempt, then overflow the scope cap so it is evicted.
	registerTerminalTurnScope({ lineageIdHash: "lineage-tomb", promptAttemptEpoch: 5001 });
	registerOwnedRegistration({
		...registration,
		jobId: "job-tomb",
		jobGeneration: "gen-tomb",
		lineageIdHash: "lineage-tomb",
		promptAttemptEpoch: 5001,
	});
	// The runnable cap check: register MAX_ACTIVE_TERMINAL_SCOPES more scopes to
	// force eviction of the first (FIFO). The oldest scope is the tomb one.
	for (let i = 0; i < 1024; i++) {
		registerTerminalTurnScope({ lineageIdHash: `lineage-fill-${i}`, promptAttemptEpoch: 10000 + i });
	}
	expect(lookupTerminalScope("lineage-tomb", 5001)).toBeUndefined();
	// A still-running turn-scope owned completion from the evicted attempt must
	// STILL classify as fresh (resume), not degrade to ordinary.
	const turnEnvelope = {
		lineageIdHash: "lineage-tomb",
		promptAttemptEpoch: 5001,
		registration: {
			...registration,
			jobId: "job-tomb",
			jobGeneration: "gen-tomb",
			lineageIdHash: "lineage-tomb",
			promptAttemptEpoch: 5001,
		},
	};
	expect(classifyOwnedEnvelope(turnEnvelope)).toBe("fresh");
	// An owned-scope evicted policy drops.
	registerOwnedRegistration({
		...registration,
		jobId: "job-tomb-owned",
		jobGeneration: "gen-tomb-owned",
		lineageIdHash: "lineage-tomb-owned",
		promptAttemptEpoch: 6001,
	});
	registerTerminalTurnScope({
		lineageIdHash: "lineage-tomb-owned",
		promptAttemptEpoch: 6001,
		ownedCompletionPolicy: "disabled",
	});
	for (let i = 0; i < 1024; i++) {
		registerTerminalTurnScope({ lineageIdHash: `lineage-fill2-${i}`, promptAttemptEpoch: 20000 + i });
	}
	expect(lookupTerminalScope("lineage-tomb-owned", 6001)).toBeUndefined();
	expect(
		classifyOwnedEnvelope({
			lineageIdHash: "lineage-tomb-owned",
			promptAttemptEpoch: 6001,
			registration: {
				...registration,
				jobId: "job-tomb-owned",
				jobGeneration: "gen-tomb-owned",
				lineageIdHash: "lineage-tomb-owned",
				promptAttemptEpoch: 6001,
			},
		}),
	).toBe("drop");
});

test("registerOwnedRegistration evicts terminal registrations before a live one", () => {
	// A long-lived live job is registered first; then the cap is overflowed with
	// shorter FINISHED jobs. The live tuple must survive the FIFO eviction.
	registerOwnedRegistration(
		{ ...registration, jobId: "job-live", jobGeneration: "gen-live" },
		{ isJobTerminal: candidate => (candidate.jobId === "job-live" ? undefined : true) },
	);
	for (let i = 0; i < 8192; i++) {
		registerOwnedRegistration(
			{ ...registration, jobId: `job-${i}`, jobGeneration: `gen-${i}`, lineageIdHash: `lineage-${i}` },
			{ isJobTerminal: candidate => (candidate.jobId === "job-live" ? undefined : true) },
		);
	}
	expect(lookupOwnedRegistration("job-live", "gen-live")).toBeDefined();
	unregisterOwnedRegistration({ ...registration, jobId: "job-live", jobGeneration: "gen-live" });
});

test("retained-policy fallback validates the full tuple; a rebound registration classifies ordinary", () => {
	registerTerminalTurnScope({ lineageIdHash: "lineage-rebind", promptAttemptEpoch: 7001 });
	registerOwnedRegistration({
		...registration,
		jobId: "job-rebind",
		jobGeneration: "gen-rebind",
		lineageIdHash: "lineage-rebind",
		promptAttemptEpoch: 7001,
	});
	for (let i = 0; i < 1024; i++) {
		registerTerminalTurnScope({ lineageIdHash: `lineage-fill-${i}`, promptAttemptEpoch: 30000 + i });
	}
	expect(lookupTerminalScope("lineage-rebind", 7001)).toBeUndefined();
	// The (jobId, jobGeneration) is REBOUND to another lineage/epoch.
	registerOwnedRegistration({
		...registration,
		jobId: "job-rebind",
		jobGeneration: "gen-rebind",
		lineageIdHash: "lineage-new",
		promptAttemptEpoch: 8001,
	});
	// A stale envelope for the OLD lineage must NOT classify fresh (the tuple no
	// longer matches the authoritative registration).
	expect(
		classifyOwnedEnvelope({
			lineageIdHash: "lineage-rebind",
			promptAttemptEpoch: 7001,
			registration: {
				...registration,
				jobId: "job-rebind",
				jobGeneration: "gen-rebind",
				lineageIdHash: "lineage-rebind",
				promptAttemptEpoch: 7001,
			},
		}),
	).toBe("ordinary");
});

test("rekeying the endpoint registration keeps owned registration resolvable after a session-identity transition", () => {
	// Reproduction of the review-thread P1 scenario: the manager is registered
	// under the construction-time endpoint, then newSession/switchSession
	// commits a successor session id. Post-transition lineage bindings use the
	// successor id, so AsyncJobManager.endpointIdOf() must follow — otherwise
	// a queued subagent resume cannot resolve its lineage or register its
	// owned tuple and a scope:"owned" abort misreports stopped_owned.
	const manager = new AsyncJobManager({ onJobComplete: async () => {} });
	try {
		AsyncJobManager.registerForEndpoint("session-a", manager);
		expect(AsyncJobManager.endpointIdOf(manager)).toBe("session-a");

		// Pre-transition binding resolves under the predecessor endpoint.
		bindToolLineage("call-pre", {
			lineageIdHash: "lineage-pre",
			promptAttemptEpoch: 7,
			endpointGeneration: 4,
			endpointId: "session-a",
		});
		registerOwnedIfLineaged({ getJob: () => ({ generation: "gen-1" }) }, "call-pre", "job-pre", "session-a");
		expect(lookupOwnedRegistration("job-pre", "gen-1", "session-a")).toMatchObject({
			lineageIdHash: "lineage-pre",
			promptAttemptEpoch: 7,
			jobId: "job-pre",
		});
		unregisterOwnedRegistration({
			lineageIdHash: "lineage-pre",
			promptAttemptEpoch: 7,
			endpointGeneration: 4,
			endpointId: "session-a",
			jobId: "job-pre",
			jobGeneration: "gen-1",
		});
		unbindToolLineage("call-pre", "session-a");

		// Committed identity transition: the registry key follows the manager.
		AsyncJobManager.rekeyForEndpoint("session-a", "session-b", AsyncJobManager.forEndpoint("session-a"));
		expect(AsyncJobManager.endpointIdOf(manager)).toBe("session-b");

		// A queued subagent resume bound AFTER the transition registers its
		// owned tuple through endpointIdOf(manager) — the exact seam the review
		// thread identified as broken.
		bindToolLineage("call-resume", {
			lineageIdHash: "lineage-resume",
			promptAttemptEpoch: 8,
			endpointGeneration: 5,
			endpointId: "session-b",
		});
		registerOwnedIfLineaged(
			{ getJob: () => ({ generation: "gen-1" }) },
			"call-resume",
			"job-resume",
			AsyncJobManager.endpointIdOf(manager),
		);
		expect(lookupOwnedRegistration("job-resume", "gen-1", "session-b")).toMatchObject({
			lineageIdHash: "lineage-resume",
			promptAttemptEpoch: 8,
			jobId: "job-resume",
		});
		unregisterOwnedRegistration({
			lineageIdHash: "lineage-resume",
			promptAttemptEpoch: 8,
			endpointGeneration: 5,
			endpointId: "session-b",
			jobId: "job-resume",
			jobGeneration: "gen-1",
		});
		unbindToolLineage("call-resume", "session-b");

		// Disposal drops the rekeyed registration regardless of the session id.
		AsyncJobManager.unregisterManager(manager);
		expect(AsyncJobManager.endpointIdOf(manager)).toBeUndefined();
	} finally {
		AsyncJobManager.unregisterManager(manager);
	}
});

test("refuses the new registration when the eviction candidate must stay in the live backlog", () => {
	// Reproduction of the review-thread P2 scenario: with retained evidence at
	// cap, the eviction candidate (terminal but still awaiting delivery) must
	// be restored to the LIVE map (backlogged). The new registration must
	// FAIL CLOSED instead of inserting anyway and letting both the live map
	// and the backlog grow without bound while deliveries stay stalled.
	const terminal = { isJobTerminal: () => true };
	// Registrations 1..8192 fill the live map; registrations 8193..10240 evict
	// the oldest terminal tuples into retained evidence (2048 = cap).
	for (let i = 0; i < 8192 + 2048; i++) {
		registerOwnedRegistration(
			{ ...registration, jobId: `job-${i}`, jobGeneration: `gen-${i}`, lineageIdHash: `lineage-${i}` },
			terminal,
		);
	}
	// The next candidate (job-2048) is restored to the live backlog; the new
	// tuple is refused fail-closed and marked registration-incomplete.
	registerOwnedRegistration(
		{ ...registration, jobId: "job-refused", jobGeneration: "gen-refused", lineageIdHash: "lineage-refused" },
		terminal,
	);
	expect(lookupOwnedRegistration("job-refused", "gen-refused")).toBeUndefined();
	expect(isOwnedAttemptRegistrationIncomplete("lineage-refused", registration.promptAttemptEpoch)).toBe(true);
	// The pending candidate is preserved (backlogged) and still findable, so
	// authorizeOwnedCompletion keeps its authorization while queued.
	expect(lookupOwnedRegistration("job-2048", "gen-2048")).toBeDefined();
});

test("rekeying retires the predecessor endpoint's owned registrations", () => {
	// Reproduction of the review-thread P2 scenario: an identity transition
	// rekeys the manager mapping but tuples registered before the transition
	// stay keyed by the PREDECESSOR endpoint, where no delivery-settlement
	// boundary ever fires; disposal retires only the successor. The rekey
	// helper retires the predecessor's tuples as part of the transition.
	const managerForRekey = new AsyncJobManager({ onJobComplete: async () => {} });
	AsyncJobManager.registerForEndpoint("ep-old", managerForRekey);
	AsyncJobManager.registerForEndpoint("ep-new", managerForRekey);
	try {
		// Pre-transition tuples under the predecessor endpoint.
		registerOwnedRegistration(
			{ ...registration, endpointId: "ep-old", jobId: "pre-1", jobGeneration: "gen-1" },
			{ isJobTerminal: () => true },
		);
		// A successor-owned tuple is untouched by the retire.
		registerOwnedRegistration(
			{ ...registration, endpointId: "ep-new", jobId: "post-1", jobGeneration: "gen-1" },
			{ isJobTerminal: () => true },
		);
		expect(lookupOwnedRegistration("pre-1", "gen-1", "ep-old")).toBeDefined();

		// The rekey transition (helper semantics): move the manager mapping,
		// then retire the predecessor endpoint's tuples.
		AsyncJobManager.rekeyForEndpoint("ep-old", "ep-new", AsyncJobManager.forEndpoint("ep-old"));
		retireOwnedRegistrationsForEndpoint("ep-old");

		expect(AsyncJobManager.endpointIdOf(managerForRekey)).toBe("ep-new");
		expect(lookupOwnedRegistration("pre-1", "gen-1", "ep-old")).toBeUndefined();
		expect(lookupOwnedRegistration("post-1", "gen-1", "ep-new")).toBeDefined();
	} finally {
		AsyncJobManager.unregisterManager(managerForRekey);
	}
});
test("lineage-binding eviction marks only the evicted attempt, never the whole process", () => {
	// Reproduction of the review-thread P2 scenario: every tool call binds a
	// lineage entry and production never unbinds it, so a healthy long-running
	// daemon inevitably reaches the 8,192 cap and the first eviction is
	// ordinary historical churn. The evicted ATTEMPT must fail closed (its
	// per-attempt marker may be displaced before an in-flight job registers),
	// but the process must NOT be permanently disabled — otherwise every
	// subsequent scope:"owned" abort returns uncertainty even when all
	// evicted calls and their jobs settled long ago.
	for (let i = 0; i < 8192 + 10; i++) {
		bindToolLineage(`call-evict-${i}`, {
			lineageIdHash: `lineage-evict-${i}`,
			promptAttemptEpoch: 1000 + i,
			endpointGeneration: 0,
		});
	}
	// The EVICTED attempt is provably-incomplete (per-attempt marker).
	expect(isOwnedAttemptRegistrationIncomplete("lineage-evict-0", 1000)).toBe(true);
	// An unrelated attempt stays provable: ordinary historical churn does not
	// disable owned aborts process-wide (review thread P2).
	expect(isOwnedAttemptRegistrationIncomplete("unrelated-attempt", 999_999)).toBe(false);
});

test("registry saturation marks only the affected attempt and retires at endpoint teardown", () => {
	// Reproduction of the review-thread P2 scenario: when the process-global
	// registry reaches 8,192 registrations with no evictable terminal tuple,
	// the skipped registration's attempt must fail closed, but the authority
	// must be scoped to that attempt and retired when its endpoint is torn
	// down — a transient backlog must not permanently disable owned aborts for
	// unrelated sessions or endpoints.
	// Fill the registry with LIVE tuples from a foreign endpoint: none are
	// evictable, so the next registration hits the saturation path.
	for (let index = 0; index < 8192; index++) {
		registerOwnedRegistration(
			{ ...registration, endpointId: "ep-foreign", jobId: `live-${index}`, jobGeneration: "gen-live" },
			{ isJobTerminal: () => false },
		);
	}
	const saturatedKey = (jobId: string): TurnRegistrationKey => ({
		...registration,
		endpointId: "ep-saturated",
		lineageIdHash: "saturated-lineage",
		promptAttemptEpoch: 55,
		jobId,
		jobGeneration: "gen-1",
	});
	// The saturation skip marks ONLY the affected attempt: the skipped job may
	// still launch unregistered, so its exact causal set is unknowable.
	registerOwnedRegistration(saturatedKey("sat-1"), { isJobTerminal: () => false });
	expect(isOwnedAttemptRegistrationIncomplete("saturated-lineage", 55)).toBe(true);
	// Already-registered attempts (the fill) and unrelated attempts stay
	// provable — saturation is not a process-lifetime daemon flag.
	expect(isOwnedAttemptRegistrationIncomplete("lineage-a", 7)).toBe(false);
	expect(isOwnedAttemptRegistrationIncomplete("unrelated-attempt", 999_999)).toBe(false);
	// Retiring the saturated endpoint (session dispose/rekey) retires its
	// saturation authority; the foreign endpoint's tuples stay intact.
	retireOwnedRegistrationsForEndpoint("ep-saturated");
	expect(isOwnedAttemptRegistrationIncomplete("saturated-lineage", 55)).toBe(false);
	expect(lookupOwnedRegistration("live-0", "gen-live", "ep-foreign")).toBeDefined();
	// Once the saturated backlog drains (the foreign endpoint is disposed too),
	// a fresh registration is admitted and its attempt is provable — the
	// transient saturation never poisoned later owned aborts.
	retireOwnedRegistrationsForEndpoint("ep-foreign");
	registerOwnedRegistration(
		{ ...registration, endpointId: "ep-fresh", jobId: "fresh-1", jobGeneration: "gen-fresh" },
		{ isJobTerminal: () => true },
	);
	expect(lookupOwnedRegistration("fresh-1", "gen-fresh", "ep-fresh")).toBeDefined();
	expect(isOwnedAttemptRegistrationIncomplete("lineage-a", 7)).toBe(false);
});

test("boundEvictedTerminalKeys FIFO-expires the oldest tombstones past the cap", () => {
	// Review thread P2: a long-lived session's unique terminal-abort keys
	// eventually fill the tombstone collection. The next finalization must
	// FIFO-expire the OLDEST tombstones instead of throwing after the
	// destructive stop already happened — the client would otherwise receive
	// an error while its durable row stays pending, and subsequent aborts
	// repeat the failure and accumulate non-evictable pending rows.
	const keys = Array.from({ length: 4100 }, (_, i) => ({
		keyHash: `k-${i}`,
		inputHash: `i-${i}`,
		turnDisposition: "stopped" as const,
		ownedWorkDisposition: "left_running" as const,
		responseState: "pending" as const,
		responsePayloadHash: `p-${i}`,
	}));
	const bounded = boundEvictedTerminalKeys(keys, 4096);
	expect(bounded).toHaveLength(4096);
	// The OLDEST tombstones expire first; the newest keys keep replay authority.
	expect(bounded[0]?.keyHash).toBe("k-4");
	expect(bounded.at(-1)?.keyHash).toBe("k-4099");
	// Under the cap nothing is dropped.
	expect(boundEvictedTerminalKeys(keys.slice(0, 100), 4096)).toHaveLength(100);
});

test("boundTerminalRetentionState bounds scopes and accumulates evicted-key tombstones in one pass", () => {
	// Both session runtimes (the notifications-hosted bus runtime and the
	// SDK-only host runtime) write durable terminal state through this single
	// bound; a hand-rolled copy in either path is how the retention invariants
	// drift apart (review thread P2).
	const scopes = [
		...Array.from({ length: 300 }, (_, i) => ({
			idempotencyKeyHash: `k-${i}`,
			idempotencyInputHash: `i-${i}`,
			turnDisposition: "no_effect" as const,
			ownedWorkDisposition: "not_requested" as const,
			acceptedAt: i,
		})),
		{
			idempotencyKeyHash: "pending-key",
			idempotencyInputHash: "pending-input",
			turnDisposition: "pending" as const,
			ownedWorkDisposition: "not_requested" as const,
			acceptedAt: 0,
		},
		{
			idempotencyKeyHash: "reserved-key",
			idempotencyInputHash: "reserved-input",
			turnDisposition: "no_effect_reserved",
			ownedWorkDisposition: "not_requested" as const,
			acceptedAt: 0,
		},
	];
	const priorKeys = [{ keyHash: "prior-key", inputHash: "prior-input", turnDisposition: "stopped" as const }];
	const next = boundTerminalRetentionState(priorKeys, scopes);
	// 300 completed rows -> the 256 newest are kept and the 44 oldest evicted.
	expect(next.scopes.filter(row => row.turnDisposition === "no_effect")).toHaveLength(256);
	expect(next.scopes.some(row => row.idempotencyKeyHash === "k-0")).toBe(false);
	expect(next.scopes.some(row => row.idempotencyKeyHash === "k-43")).toBe(false);
	expect(next.scopes.some(row => row.idempotencyKeyHash === "k-44")).toBe(true);
	// The pending marker and the TRANSITIONAL reservation are never evicted:
	// evicting a reserved row would replay uncertainty over an unfinalized
	// reservation.
	expect(next.scopes.some(row => row.idempotencyKeyHash === "pending-key")).toBe(true);
	expect(next.scopes.some(row => row.idempotencyKeyHash === "reserved-key")).toBe(true);
	// Pre-existing tombstones are retained ahead of this transaction's evictions,
	// so replay authority survives successive bounded writes.
	expect(next.keys[0]).toEqual(priorKeys[0]);
	expect(next.keys).toHaveLength(1 + 44);
	expect(next.keys.slice(1).map(key => key.keyHash)).toEqual(Array.from({ length: 44 }, (_, i) => `k-${i}`));
});

test("boundTerminalRetentionState FIFO-expires the oldest tombstones at the retained cap", () => {
	// At tombstone capacity the bound must expire the OLDEST keys instead of
	// throwing after the destructive stop already happened (review thread P2).
	const priorKeys = Array.from({ length: 4096 }, (_, i) => ({
		keyHash: `old-${i}`,
		inputHash: `old-input-${i}`,
		turnDisposition: "stopped" as const,
	}));
	const next = boundTerminalRetentionState(priorKeys, [
		{
			idempotencyKeyHash: "fresh-key",
			idempotencyInputHash: "fresh-input",
			turnDisposition: "no_effect" as const,
			ownedWorkDisposition: "not_requested" as const,
			acceptedAt: 1,
		},
	]);
	expect(next.keys).toHaveLength(4096);
	// No scope row was evicted, so the collection is already at the cap with
	// every prior tombstone still intact.
	expect(next.keys.some(key => key.keyHash === "old-0")).toBe(true);
	expect(next.scopes).toHaveLength(1);

	// Now force an eviction on top of a full tombstone collection: the evicted
	// key is retained and the oldest prior tombstone expires.
	const full = Array.from({ length: 257 }, (_, i) => ({
		idempotencyKeyHash: `k-${i}`,
		idempotencyInputHash: `i-${i}`,
		turnDisposition: "no_effect" as const,
		ownedWorkDisposition: "not_requested" as const,
		acceptedAt: i,
	}));
	const expired = boundTerminalRetentionState(priorKeys, full);
	expect(expired.keys).toHaveLength(4096);
	expect(expired.keys.some(key => key.keyHash === "old-0")).toBe(false);
	expect(expired.keys.at(-1)?.keyHash).toBe("k-0");
});

test("saturation evidence keeps an attempt incomplete after every evicted tool window settles", () => {
	// Review thread P2: an attempt can simultaneously carry an evicted
	// in-flight tool window AND a registration skipped because the owned
	// registry is saturated. Settling the last tool window must not clear the
	// incomplete marker while the saturation evidence still records an
	// unregistered live job — a subsequent scope:"owned" abort could otherwise
	// omit that job and claim stopped_owned.
	for (let index = 0; index < 8194; index++) {
		bindToolLineage(`sat-window-${index}`, {
			lineageIdHash: "sat-attempt-lineage",
			promptAttemptEpoch: 99,
			endpointGeneration: 0,
			endpointId: "ep-sat",
		});
	}
	expect(isOwnedAttemptRegistrationIncomplete("sat-attempt-lineage", 99)).toBe(true);
	// Fill the owned registry to capacity so this attempt's own registration
	// is skipped as saturated.
	for (let index = 0; index < 8192; index++) {
		registerOwnedRegistration({
			endpointId: "ep-fill",
			lineageIdHash: `fill-lineage-${index}`,
			promptAttemptEpoch: 1,
			endpointGeneration: 0,
			jobId: `fill-job-${index}`,
			jobGeneration: `fill-gen-${index}`,
		});
	}
	// The attempt's registration is skipped: its window marker AND the
	// saturation evidence now both record the attempt as incomplete.
	registerOwnedIfLineaged(
		{ getJob: () => ({ generation: "gen-sat", status: "running" }) },
		"sat-window-0",
		"job-saturated",
		"ep-sat",
	);
	settleToolLineageRegistrationWindow("sat-window-0", "ep-sat");
	// The window marker is gone, but the saturation evidence keeps the attempt
	// incomplete: the skipped job may still be running unregistered.
	expect(isOwnedAttemptRegistrationIncomplete("sat-attempt-lineage", 99)).toBe(true);
	// Retiring the saturated endpoint's registrations retires the authority.
	retireOwnedRegistrationsForEndpoint("ep-sat");
	expect(isOwnedAttemptRegistrationIncomplete("sat-attempt-lineage", 99)).toBe(false);
});

test("incomplete attempt evidence remains until every evicted tool window settles", () => {
	for (let index = 0; index < 8194; index++) {
		bindToolLineage(`shared-attempt-${index}`, {
			lineageIdHash: "shared-attempt-lineage",
			promptAttemptEpoch: 77,
			endpointGeneration: 0,
		});
	}
	expect(isOwnedAttemptRegistrationIncomplete("shared-attempt-lineage", 77)).toBe(true);
	settleToolLineageRegistrationWindow("shared-attempt-0");
	expect(isOwnedAttemptRegistrationIncomplete("shared-attempt-lineage", 77)).toBe(true);
	settleToolLineageRegistrationWindow("shared-attempt-1");
	expect(isOwnedAttemptRegistrationIncomplete("shared-attempt-lineage", 77)).toBe(false);
});

test("registerOwnedIfLineaged registers an evicted tool call's job with the retained lineage", () => {
	// Evict a binding (8192 cap) while its tool call is still in flight, then
	// have that tool launch a background job: the job must register under the
	// evicted binding's retained lineage so the attempt's causal set is not
	// empty, and the attempt stays provably incomplete until the tool call
	// settles (review thread P2).
	for (let index = 0; index < 8193; index++) {
		bindToolLineage(`retained-call-${index}`, {
			lineageIdHash: "retained-lineage",
			promptAttemptEpoch: 88,
			endpointGeneration: 3,
		});
	}
	expect(isOwnedAttemptRegistrationIncomplete("retained-lineage", 88)).toBe(true);
	registerOwnedIfLineaged(
		{ getJob: () => ({ generation: "gen-new", status: "running" }) },
		"retained-call-0",
		"job-new",
	);
	const registered = lookupOwnedRegistration("job-new", "gen-new");
	expect(registered).toBeDefined();
	expect(registered?.lineageIdHash).toBe("retained-lineage");
	expect(registered?.promptAttemptEpoch).toBe(88);
	expect(registered?.endpointGeneration).toBe(3);
	// The window stays open until the tool call settles, so the attempt remains
	// provably incomplete while the job may still be running.
	expect(isOwnedAttemptRegistrationIncomplete("retained-lineage", 88)).toBe(true);
	settleToolLineageRegistrationWindow("retained-call-0");
	expect(isOwnedAttemptRegistrationIncomplete("retained-lineage", 88)).toBe(false);
});

test("retireOwnedRegistrationForDeadLetter removes the exact tuple a dead-lettered delivery leaves behind", () => {
	// Reproduction of the review-thread P2 scenario: a dead-lettered delivery
	// (queue overflow or retry exhaustion) never injects a message and has no
	// later consumption boundary, so the manager retires the exact tuple.
	registerOwnedRegistration(
		{ ...registration, endpointId: "ep-dl", jobId: "dl-1", jobGeneration: "gen-1" },
		{ isJobTerminal: () => true },
	);
	expect(lookupOwnedRegistration("dl-1", "gen-1", "ep-dl")).toBeDefined();
	retireOwnedRegistrationForDeadLetter("ep-dl", "dl-1", "gen-1");
	expect(lookupOwnedRegistration("dl-1", "gen-1", "ep-dl")).toBeUndefined();
	// A foreign tuple is untouched.
	registerOwnedRegistration(
		{ ...registration, endpointId: "ep-keep", jobId: "keep-1", jobGeneration: "gen-1" },
		{ isJobTerminal: () => true },
	);
	retireOwnedRegistrationForDeadLetter("ep-dl", "keep-1", "gen-1");
	expect(lookupOwnedRegistration("keep-1", "gen-1", "ep-keep")).toBeDefined();
	unregisterOwnedRegistration({ ...registration, endpointId: "ep-keep", jobId: "keep-1", jobGeneration: "gen-1" });
});
