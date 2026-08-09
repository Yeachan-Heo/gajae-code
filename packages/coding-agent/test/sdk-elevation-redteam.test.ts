import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { signElevationCapability, verifyElevationCapability } from "../src/sdk/elevation/capability";
import { elevationRequestDigest } from "../src/sdk/elevation/digest";
import type { ElevationClaimIdentity } from "../src/sdk/elevation/dispatch-receipt";
import {
	ElevationLedger,
	type ElevationRequester,
	type ElevationSessionIdentity,
} from "../src/sdk/elevation/grant-ledger";
import type { BrokerOwnerPrincipal } from "../src/sdk/elevation/owner";
import { classifyProcessIncarnationLiveness } from "../src/sdk/elevation/owner";

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

async function freshLedger(
	options: { classifyLiveness?: (pid: unknown, incarnation: unknown) => "alive" | "dead" | "unknown" } = {},
): Promise<{ ledger: ElevationLedger; dir: string; now: () => number }> {
	const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-elev-redteam-"));
	const current = 1_000_000;
	const now = () => current;
	const ledger = new ElevationLedger(dir, {
		enabled: true,
		ttlMs: 60_000,
		now,
		...(options.classifyLiveness ? { classifyLiveness: options.classifyLiveness } : {}),
	});
	await ledger.open();
	return { ledger, dir, now };
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

describe("SDK elevation redteam", () => {
	it("binds broker control capabilities to the exact operation and input", () => {
		const requestId = "11111111-1111-4111-8111-111111111111";
		const input = { command: "echo safe" };
		const capability = signElevationCapability("host-authority", requestId, "bash.execute", input);
		expect(verifyElevationCapability("host-authority", capability, "bash.execute", input)).toBe(true);
		expect(verifyElevationCapability("host-authority", requestId, "bash.execute", input)).toBe(false);
		expect(verifyElevationCapability("wrong-authority", capability, "bash.execute", input)).toBe(false);
		expect(verifyElevationCapability("host-authority", capability, "bash.abort", input)).toBe(false);
		expect(verifyElevationCapability("host-authority", capability, "bash.execute", { command: "echo pwned" })).toBe(
			false,
		);
	});
	it("computes a fully qualified digest that excludes the top-level elevationRequestId", () => {
		const input = { cwd: "/tmp/fixture", elevationRequestId: "11111111-1111-4111-8111-111111111111" };
		const withId = elevationRequestDigest({ kind: "global", sdkId: "session.close", input });
		const withoutId = elevationRequestDigest({
			kind: "global",
			sdkId: "session.close",
			input: { cwd: "/tmp/fixture" },
		});
		expect(withId.ok).toBe(true);
		expect(withoutId.ok).toBe(true);
		if (!withId.ok || !withoutId.ok) throw new Error("digest failed");
		expect(withId.digest).toBe(withoutId.digest);
	});

	it("digests the full {kind, sdkId, input} triple so substitution is detectable", () => {
		const base = elevationRequestDigest({ kind: "global", sdkId: "session.close", input: { cwd: "/tmp/fixture" } });
		const otherInput = elevationRequestDigest({
			kind: "global",
			sdkId: "session.close",
			input: { cwd: "/tmp/other" },
		});
		const otherOp = elevationRequestDigest({
			kind: "global",
			sdkId: "session.delete",
			input: { cwd: "/tmp/fixture" },
		});
		const otherKind = elevationRequestDigest({ kind: "control", sdkId: "workflow.gate_answer", input: {} });
		expect(base.ok).toBe(true);
		expect(otherInput.ok).toBe(true);
		expect(otherOp.ok).toBe(true);
		expect(otherKind.ok).toBe(true);
		if (!base.ok || !otherInput.ok || !otherOp.ok || !otherKind.ok) throw new Error("digest failed");
		expect(otherInput.digest).not.toBe(base.digest);
		expect(otherOp.digest).not.toBe(base.digest);
		expect(otherKind.digest).not.toBe(base.digest);
	});

	it("refuses operations outside the elevation allowlist", () => {
		const refused = elevationRequestDigest({ kind: "query", sdkId: "session.list", input: {} });
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("refused should fail");
		expect(refused.error.code).toBe("elevation_not_required");
		const badKind = elevationRequestDigest({ kind: "invalid", sdkId: "session.close", input: {} });
		expect(badKind.ok).toBe(false);
		if (badKind.ok) throw new Error("bad kind should fail");
		expect(badKind.error.code).toBe("invalid_input");
	});

	it("classifies process-incarnation liveness in three states (malformed -> unknown)", () => {
		expect(classifyProcessIncarnationLiveness("not-a-pid", "linux:1")).toBe("unknown");
		expect(classifyProcessIncarnationLiveness(0, "linux:1")).toBe("unknown");
		expect(classifyProcessIncarnationLiveness(process.pid, "malformed-incarnation")).toBe("unknown");
		expect(classifyProcessIncarnationLiveness(2_147_483_647, "linux:1")).toBe("dead");
	});

	it("terminalizes a claim left by a provably dead broker tenure and requires a new grant", async () => {
		const { ledger } = await freshLedger();
		const issued = await issueAndGrant(ledger, "22222222-2222-4222-8222-222222222222");
		// Claim with a pid that can never be live: the tenure is provably dead.
		const deadTenure = claimIdentity("dead-owner", 1, 2_147_483_647, "linux:1");
		const claimed = await ledger.claim({
			elevationRequestId: issued.elevationRequestId,
			claimIdentity: deadTenure,
			currentSessionIdentity: sessionIdentity(),
		});
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) throw new Error("claim failed");

		const successor = claimIdentity("live-owner", 1);
		const replayed = await ledger.claim({
			elevationRequestId: issued.elevationRequestId,
			claimIdentity: successor,
			currentSessionIdentity: sessionIdentity(),
		});
		expect(replayed.ok).toBe(false);
		if (replayed.ok) throw new Error("replayed claim should fail");
		expect(replayed.error.code).toBe("terminal_uncertain");

		const resolved = await ledger.resolve(issued.elevationRequestId, successor);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) throw new Error("resolve failed");
		expect(resolved.value.grant.state).toBe("consumed");
		expect(resolved.value.receipt?.state).toBe("uncertain");
		expect(resolved.value.receipt?.outcome?.status).toBe("unknown");

		// A new grant is required: the same request id replays the consumed grant.
		const retry = await ledger.issue({
			elevationRequestId: issued.elevationRequestId,
			operation,
			input: { cwd: "/tmp/fixture" },
			sessionIdentity: sessionIdentity(),
			principal: principal(),
			requester: requester(),
		});
		expect(retry.ok).toBe(true);
		if (!retry.ok) throw new Error("retry issue failed");
		expect(retry.value.replay).toBe(true);
		expect(retry.value.state).toBe("consumed");
	});

	it("reports elevation_claim_in_progress when claim liveness is unknown", async () => {
		const { ledger } = await freshLedger({
			classifyLiveness: () => "unknown",
		});
		const issued = await issueAndGrant(ledger, "33333333-3333-4333-8333-333333333333");
		const first = await ledger.claim({
			elevationRequestId: issued.elevationRequestId,
			claimIdentity: claimIdentity("tenure-a", 1),
			currentSessionIdentity: sessionIdentity(),
		});
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error("first claim failed");
		const second = await ledger.claim({
			elevationRequestId: issued.elevationRequestId,
			claimIdentity: claimIdentity("tenure-b", 1),
			currentSessionIdentity: sessionIdentity(),
		});
		expect(second.ok).toBe(false);
		if (second.ok) throw new Error("second claim should fail");
		expect(second.error.code).toBe("elevation_claim_in_progress");
	});

	it("refuses dispatch before claim and refuses unknown outcomes as caller input", async () => {
		const { ledger } = await freshLedger();
		const issued = await issueAndGrant(ledger, "44444444-4444-4444-8444-444444444444");
		const early = await ledger.dispatch({
			elevationRequestId: issued.elevationRequestId,
			dispatchIdentity: claimIdentity(),
			outcome: { status: "ok", dispatchedAt: 1_000_000 },
		});
		expect(early.ok).toBe(false);
		if (early.ok) throw new Error("early dispatch should fail");
		expect(early.error.code).toBe("elevation_claim_in_progress");

		const claimed = await ledger.claim({
			elevationRequestId: issued.elevationRequestId,
			claimIdentity: claimIdentity(),
			currentSessionIdentity: sessionIdentity(),
		});
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) throw new Error("claim failed");
		const unknownOutcome = await ledger.dispatch({
			elevationRequestId: issued.elevationRequestId,
			dispatchIdentity: claimIdentity(),
			outcome: { status: "unknown", message: "caller cannot claim crash truth", dispatchedAt: 1_000_000 },
		});
		expect(unknownOutcome.ok).toBe(false);
		if (unknownOutcome.ok) throw new Error("unknown outcome should fail");
		expect(unknownOutcome.error.code).toBe("invalid_input");
	});

	it("refuses dispatch by a different tenure while the claim is live", async () => {
		// The claiming tenure is classified alive (injected), so the second
		// tenure's dispatch fails closed as in progress rather than fabricating
		// a terminal outcome for a live claim.
		const { ledger } = await freshLedger({ classifyLiveness: () => "alive" });
		const issued = await issueAndGrant(ledger, "55555555-5555-4555-8555-555555555555");
		await ledger.claim({
			elevationRequestId: issued.elevationRequestId,
			claimIdentity: claimIdentity("tenure-a", 1),
			currentSessionIdentity: sessionIdentity(),
		});
		const other = await ledger.dispatch({
			elevationRequestId: issued.elevationRequestId,
			dispatchIdentity: claimIdentity("tenure-b", 1),
			outcome: { status: "ok", dispatchedAt: 1_000_000 },
		});
		expect(other.ok).toBe(false);
		if (other.ok) throw new Error("other tenure dispatch should fail");
		expect(other.error.code).toBe("elevation_claim_in_progress");
	});

	it("quarantines corrupt ledger rows and heals the issue index on reopen", async () => {
		const { ledger, dir } = await freshLedger();
		const issued = await issueAndGrant(ledger, "66666666-6666-4666-8666-666666666666");
		const grantsFile = path.join(dir, "sdk", "elevation", "grants.jsonl");
		await fs.appendFile(grantsFile, "{not-json}\n");
		// Reopen: the corrupt row is quarantined and the index heals from grants.
		const reopened = new ElevationLedger(dir, { enabled: true, ttlMs: 60_000 });
		await reopened.open();
		expect(reopened.warnings.length).toBeGreaterThan(0);
		const next = await reopened.issue({
			elevationRequestId: "77777777-7777-4777-8777-777777777777",
			operation,
			input: { cwd: "/tmp/fixture" },
			sessionIdentity: sessionIdentity(),
			principal: principal(),
			requester: requester(),
		});
		expect(next.ok).toBe(true);
		if (!next.ok) throw new Error("next issue failed");
		expect(next.value.issueIndex).toBe(issued.issueIndex + 1);
		expect(await fs.exists(`${grantsFile}.corrupt`)).toBe(true);
	});
});
