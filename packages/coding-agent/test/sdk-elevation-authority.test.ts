import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { ElevationClaimIdentity } from "../src/sdk/elevation/dispatch-receipt";
import {
	ElevationLedger,
	type ElevationRequester,
	type ElevationSessionIdentity,
} from "../src/sdk/elevation/grant-ledger";
import type { BrokerOwnerPrincipal } from "../src/sdk/elevation/owner";

const sessionIdentity = (): ElevationSessionIdentity => ({
	sessionId: "sess-1",
	endpointStateRoot: path.join(process.cwd(), "fixture-state"),
	endpointGeneration: 3,
	endpointIncarnation: "a".repeat(64),
});

const principal = (): BrokerOwnerPrincipal => ({
	kind: "broker_owner",
	owner: { agentDirUid: 0, brokerPid: 4242, brokerIncarnation: "linux:100" },
});

const requester = (): ElevationRequester => ({ source: "broker_connection", connectionId: "conn-1" });

const claimIdentity = (
	ownerId = "owner-1",
	epoch = 1,
	pid = process.pid,
	incarnation = "linux:1",
): ElevationClaimIdentity => ({
	ownerId,
	epoch,
	pid,
	incarnation,
});

const operation = { kind: "global" as const, sdkId: "session.close" };

async function freshLedger(options: { ttlMs?: number } = {}): Promise<{
	ledger: ElevationLedger;
	dir: string;
	now: () => number;
	advance: (ms: number) => void;
}> {
	const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-elev-authority-"));
	let current = 1_000_000;
	const now = () => current;
	const advance = (ms: number) => {
		current += ms;
	};
	const ledger = new ElevationLedger(dir, { enabled: true, ttlMs: options.ttlMs ?? 60_000, now });
	await ledger.open();
	return { ledger, dir, now, advance };
}

async function issueAndGrant(ledger: ElevationLedger, elevationRequestId = "11111111-1111-4111-8111-111111111111") {
	const issued = await ledger.issue({
		elevationRequestId,
		operation,
		input: { cwd: "/tmp/fixture" },
		sessionIdentity: sessionIdentity(),
		principal: principal(),
		requester: requester(),
	});
	expect(issued.ok).toBe(true);
	if (!issued.ok) throw new Error("issue failed");
	const answered = await ledger.answer({
		elevationRequestId,
		answer: "approve",
		presentedDigest: issued.value.requestDigest,
		principal: principal(),
		answerer: { source: "local_operator", attestedBy: "tui-operator" },
		currentSessionIdentity: sessionIdentity(),
	});
	expect(answered.ok).toBe(true);
	if (!answered.ok) throw new Error("answer failed");
	expect(answered.value.outcome).toBe("granted");
	return issued.value;
}

describe("SDK elevation authority", () => {
	it("issues, grants, claims, and dispatches a single-use grant", async () => {
		const { ledger } = await freshLedger();
		const issued = await issueAndGrant(ledger);
		expect(issued.replay).toBe(false);
		expect(issued.state).toBe("requested");
		expect(issued.issueIndex).toBe(1);
		expect(issued.requestDigest).toMatch(/^[a-f0-9]{64}$/);

		const claimed = await ledger.claim({
			elevationRequestId: issued.elevationRequestId,
			claimIdentity: claimIdentity(),
			currentSessionIdentity: sessionIdentity(),
		});
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) throw new Error("claim failed");
		expect(claimed.value.grant.state).toBe("claimed");
		expect(claimed.value.receipt.state).toBe("claimed");

		const dispatched = await ledger.dispatch({
			elevationRequestId: issued.elevationRequestId,
			dispatchIdentity: claimIdentity(),
			outcome: { status: "ok", dispatchedAt: 1_000_000 },
		});
		expect(dispatched.ok).toBe(true);
		if (!dispatched.ok) throw new Error("dispatch failed");
		expect(dispatched.value.grant.state).toBe("dispatched");
		expect(dispatched.value.receipt.state).toBe("dispatched");
		expect(dispatched.value.receipt.outcome).toEqual({ status: "ok", dispatchedAt: 1_000_000 });

		const resolved = await ledger.resolve(issued.elevationRequestId, claimIdentity());
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) throw new Error("resolve failed");
		expect(resolved.value.grant.state).toBe("dispatched");
		expect(resolved.value.receipt?.state).toBe("dispatched");
	});

	it("replays the same request id with identical content and conflicts on substitution", async () => {
		const { ledger } = await freshLedger();
		const issued = await issueAndGrant(ledger);
		const replayed = await ledger.issue({
			elevationRequestId: issued.elevationRequestId,
			operation,
			input: { cwd: "/tmp/fixture" },
			sessionIdentity: sessionIdentity(),
			principal: principal(),
			requester: requester(),
		});
		expect(replayed.ok).toBe(true);
		if (!replayed.ok) throw new Error("replay failed");
		expect(replayed.value.replay).toBe(true);
		expect(replayed.value.issueIndex).toBe(issued.issueIndex);
		expect(replayed.value.requestDigest).toBe(issued.requestDigest);

		const conflicted = await ledger.issue({
			elevationRequestId: issued.elevationRequestId,
			operation,
			input: { cwd: "/tmp/other" },
			sessionIdentity: sessionIdentity(),
			principal: principal(),
			requester: requester(),
		});
		expect(conflicted.ok).toBe(false);
		if (conflicted.ok) throw new Error("conflict should fail");
		expect(conflicted.error.code).toBe("idempotency_conflict");
	});

	it("denies on a negative operator answer and refuses later claims", async () => {
		const { ledger } = await freshLedger();
		const issued = await ledger.issue({
			elevationRequestId: "22222222-2222-4222-8222-222222222222",
			operation,
			input: { cwd: "/tmp/fixture" },
			sessionIdentity: sessionIdentity(),
			principal: principal(),
			requester: requester(),
		});
		expect(issued.ok).toBe(true);
		if (!issued.ok) throw new Error("issue failed");
		const denied = await ledger.answer({
			elevationRequestId: issued.value.elevationRequestId,
			answer: "deny",
			presentedDigest: issued.value.requestDigest,
			principal: principal(),
			answerer: { source: "local_operator", attestedBy: "tui-operator" },
			currentSessionIdentity: sessionIdentity(),
		});
		expect(denied.ok).toBe(true);
		if (!denied.ok) throw new Error("deny failed");
		expect(denied.value.outcome).toBe("denied");

		const claimed = await ledger.claim({
			elevationRequestId: issued.value.elevationRequestId,
			claimIdentity: claimIdentity(),
			currentSessionIdentity: sessionIdentity(),
		});
		expect(claimed.ok).toBe(false);
		if (claimed.ok) throw new Error("claim should fail");
		expect(claimed.error.code).toBe("grant_spent");
	});

	it("expires a request whose deadline passed before the answer", async () => {
		const { ledger, advance } = await freshLedger({ ttlMs: 1_000 });
		const issued = await ledger.issue({
			elevationRequestId: "33333333-3333-4333-8333-333333333333",
			operation,
			input: { cwd: "/tmp/fixture" },
			sessionIdentity: sessionIdentity(),
			principal: principal(),
			requester: requester(),
		});
		expect(issued.ok).toBe(true);
		if (!issued.ok) throw new Error("issue failed");
		// Advance the injected clock beyond the deadline.
		advance(10_000);
		const answered = await ledger.answer({
			elevationRequestId: issued.value.elevationRequestId,
			answer: "approve",
			presentedDigest: issued.value.requestDigest,
			principal: principal(),
			answerer: { source: "local_operator", attestedBy: "tui-operator" },
			currentSessionIdentity: sessionIdentity(),
		});
		expect(answered.ok).toBe(true);
		if (!answered.ok) throw new Error("answer failed");
		expect(answered.value.outcome).toBe("expired");
	});

	it("fails closed on digest substitution, wrong principal, and wrong session identity", async () => {
		const { ledger } = await freshLedger();
		const issued = await ledger.issue({
			elevationRequestId: "44444444-4444-4444-8444-444444444444",
			operation,
			input: { cwd: "/tmp/fixture" },
			sessionIdentity: sessionIdentity(),
			principal: principal(),
			requester: requester(),
		});
		expect(issued.ok).toBe(true);
		if (!issued.ok) throw new Error("issue failed");

		const substituted = await ledger.answer({
			elevationRequestId: issued.value.elevationRequestId,
			answer: "approve",
			presentedDigest: "b".repeat(64),
			principal: principal(),
			answerer: { source: "local_operator", attestedBy: "tui-operator" },
			currentSessionIdentity: sessionIdentity(),
		});
		expect(substituted.ok).toBe(true);
		if (!substituted.ok) throw new Error("substitution answer failed");
		expect(substituted.value.outcome).toBe("misused");

		const issued2 = await ledger.issue({
			elevationRequestId: "55555555-5555-4555-8555-555555555555",
			operation,
			input: { cwd: "/tmp/fixture" },
			sessionIdentity: sessionIdentity(),
			principal: principal(),
			requester: requester(),
		});
		expect(issued2.ok).toBe(true);
		if (!issued2.ok) throw new Error("issue2 failed");
		const wrongPrincipal = await ledger.answer({
			elevationRequestId: issued2.value.elevationRequestId,
			answer: "approve",
			presentedDigest: issued2.value.requestDigest,
			principal: { kind: "broker_owner", owner: { agentDirUid: 0, brokerPid: 9999, brokerIncarnation: "linux:1" } },
			answerer: { source: "local_operator", attestedBy: "tui-operator" },
			currentSessionIdentity: sessionIdentity(),
		});
		expect(wrongPrincipal.ok).toBe(true);
		if (!wrongPrincipal.ok) throw new Error("wrong principal answer failed");
		expect(wrongPrincipal.value.outcome).toBe("misused");

		const issued3 = await ledger.issue({
			elevationRequestId: "66666666-6666-4666-8666-666666666666",
			operation,
			input: { cwd: "/tmp/fixture" },
			sessionIdentity: sessionIdentity(),
			principal: principal(),
			requester: requester(),
		});
		expect(issued3.ok).toBe(true);
		if (!issued3.ok) throw new Error("issue3 failed");
		const staleSession = await ledger.answer({
			elevationRequestId: issued3.value.elevationRequestId,
			answer: "approve",
			presentedDigest: issued3.value.requestDigest,
			principal: principal(),
			answerer: { source: "local_operator", attestedBy: "tui-operator" },
			currentSessionIdentity: { ...sessionIdentity(), endpointGeneration: 9 },
		});
		expect(staleSession.ok).toBe(true);
		if (!staleSession.ok) throw new Error("stale session answer failed");
		expect(staleSession.value.outcome).toBe("misused");
	});

	it("first answer wins and a second answer is audited as duplicate", async () => {
		const { ledger } = await freshLedger();
		const issued = await issueAndGrant(ledger);
		const duplicate = await ledger.answer({
			elevationRequestId: issued.elevationRequestId,
			answer: "approve",
			presentedDigest: issued.requestDigest,
			principal: principal(),
			answerer: { source: "local_operator", attestedBy: "tui-operator" },
			currentSessionIdentity: sessionIdentity(),
		});
		expect(duplicate.ok).toBe(true);
		if (!duplicate.ok) throw new Error("duplicate answer failed");
		expect(duplicate.value.outcome).toBe("duplicate_answer");
	});

	it("rejects a claim before grant and reports in-progress for a live claim", async () => {
		const { ledger } = await freshLedger();
		const issued = await ledger.issue({
			elevationRequestId: "77777777-7777-4777-8777-777777777777",
			operation,
			input: { cwd: "/tmp/fixture" },
			sessionIdentity: sessionIdentity(),
			principal: principal(),
			requester: requester(),
		});
		expect(issued.ok).toBe(true);
		if (!issued.ok) throw new Error("issue failed");
		const premature = await ledger.claim({
			elevationRequestId: issued.value.elevationRequestId,
			claimIdentity: claimIdentity(),
			currentSessionIdentity: sessionIdentity(),
		});
		expect(premature.ok).toBe(false);
		if (premature.ok) throw new Error("premature claim should fail");
		expect(premature.error.code).toBe("elevation_required");

		await issueAndGrant(ledger, "88888888-8888-4888-8888-888888888888");
		const first = await ledger.claim({
			elevationRequestId: "88888888-8888-4888-8888-888888888888",
			claimIdentity: claimIdentity(),
			currentSessionIdentity: sessionIdentity(),
		});
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error("first claim failed");
		const second = await ledger.claim({
			elevationRequestId: "88888888-8888-4888-8888-888888888888",
			claimIdentity: claimIdentity(),
			currentSessionIdentity: sessionIdentity(),
		});
		expect(second.ok).toBe(false);
		if (second.ok) throw new Error("second claim should fail");
		expect(second.error.code).toBe("elevation_claim_in_progress");
	});

	it("fails closed on an endpoint identity mismatch at claim time", async () => {
		const { ledger } = await freshLedger();
		const issued = await issueAndGrant(ledger, "99999999-9999-4999-8999-999999999999");
		const claimed = await ledger.claim({
			elevationRequestId: issued.elevationRequestId,
			claimIdentity: claimIdentity(),
			currentSessionIdentity: { ...sessionIdentity(), endpointStateRoot: path.join(process.cwd(), "other-root") },
		});
		expect(claimed.ok).toBe(false);
		if (claimed.ok) throw new Error("claim should fail");
		expect(claimed.error.code).toBe("endpoint_stale");
	});

	it("target_unavailable when the session cannot be resolved at answer or claim time", async () => {
		const { ledger } = await freshLedger();
		const issued = await ledger.issue({
			elevationRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			operation,
			input: { cwd: "/tmp/fixture" },
			sessionIdentity: sessionIdentity(),
			principal: principal(),
			requester: requester(),
		});
		expect(issued.ok).toBe(true);
		if (!issued.ok) throw new Error("issue failed");
		const unavailable = await ledger.answer({
			elevationRequestId: issued.value.elevationRequestId,
			answer: "approve",
			presentedDigest: issued.value.requestDigest,
			principal: principal(),
			answerer: { source: "local_operator", attestedBy: "tui-operator" },
		});
		expect(unavailable.ok).toBe(true);
		if (!unavailable.ok) throw new Error("unavailable answer failed");
		expect(unavailable.value.outcome).toBe("target_unavailable");
	});
	it("binds a delete grant against a retained stopped session identity like any other identity", async () => {
		const { ledger } = await freshLedger();
		const stopped = sessionIdentity();
		const issued = await ledger.issue({
			elevationRequestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			operation: { kind: "global", sdkId: "session.delete" },
			input: { sessionId: stopped.sessionId },
			sessionIdentity: stopped,
			principal: principal(),
			requester: requester(),
		});
		expect(issued.ok).toBe(true);
		if (!issued.ok) throw new Error("issue failed");
		const answered = await ledger.answer({
			elevationRequestId: issued.value.elevationRequestId,
			answer: "approve",
			presentedDigest: issued.value.requestDigest,
			principal: principal(),
			answerer: { source: "local_operator", attestedBy: "tui-operator" },
			currentSessionIdentity: stopped,
		});
		expect(answered.ok).toBe(true);
		if (!answered.ok) throw new Error("answer failed");
		expect(answered.value.outcome).toBe("granted");
		// A replaced identity is refused before a valid claim consumes the grant.
		const stale = await ledger.claim({
			elevationRequestId: issued.value.elevationRequestId,
			claimIdentity: claimIdentity(),
			currentSessionIdentity: { ...stopped, endpointIncarnation: "b".repeat(64) },
		});
		expect(stale.ok).toBe(false);
		if (stale.ok) throw new Error("stale claim should fail");
		expect(stale.error.code).toBe("endpoint_stale");
		const claimed = await ledger.claim({
			elevationRequestId: issued.value.elevationRequestId,
			claimIdentity: claimIdentity(),
			currentSessionIdentity: stopped,
		});
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) throw new Error("claim failed");
		expect(claimed.value.grant.state).toBe("claimed");
	});
});
