import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Broker, type SpawnPromptLayer } from "../src/sdk/broker/broker";
import { getBrokerIdentityKey } from "../src/sdk/broker/identity";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import { type SessionIndexEvent, sessionIndexChecksum } from "../src/sdk/broker/session-index";
import { SpawnAuthorityStore } from "../src/sdk/broker/spawn-authority";
import { SESSION_INDEX_EVENT_VERSION } from "../src/sdk/broker/state-version";
import { runSdkSpawn } from "../src/sdk/cli/master-cli";

const grant = "master-e2e-grant-value";
const seedText = "master-e2e-seed-text";
const ownerId = "master-e2e-owner";
const epoch = "master-e2e-epoch";
const incarnation = processIncarnation(process.pid);

function indexEvent(
	input: Omit<SessionIndexEvent, "version" | "indexSeq" | "checksum" | "ts">,
	indexSeq: number,
): SessionIndexEvent {
	const unsigned: Omit<SessionIndexEvent, "checksum"> = {
		...input,
		version: SESSION_INDEX_EVENT_VERSION,
		indexSeq,
		ts: Date.now(),
	};
	return { ...unsigned, checksum: sessionIndexChecksum(unsigned) };
}

async function writeIndex(agentDir: string, events: readonly SessionIndexEvent[]): Promise<void> {
	const directory = path.join(agentDir, "sdk", "sessions");
	await fs.mkdir(directory, { recursive: true });
	await Bun.write(path.join(directory, "index.jsonl"), `${events.map(row => JSON.stringify(row)).join("\n")}\n`);
}

function substrateFake(counters: { launches: number; closes: number }) {
	let gone = false;
	return {
		launch: async () => {
			counters.launches += 1;
			return {
				ok: true as const,
				proof: {
					substrateKind: "headless" as const,
					providerIdentity: "e2e-provider",
					pid: 4321,
					processIncarnation: "inc-4321",
				},
			};
		},
		verify: async () => (gone ? ("gone" as const) : ("verified" as const)),
		resolveLifecycleOwner: async () => ({ ok: true as const, owner: { pid: 4321, incarnation: "inc-4321" } }),
		close: async () => {
			counters.closes += 1;
			gone = true;
			return { ok: true };
		},
	};
}

function promptLayerFake(counters: { dispatches: number }) {
	return {
		awaitRegistration: async (input: Parameters<SpawnPromptLayer["awaitRegistration"]>[0]) => {
			const marker = await Bun.file(path.join(input.stateRoot, "sdk", `${input.childId}.lifecycle.json`)).json();
			expect(marker).toMatchObject({ pid: 4321, incarnation: "inc-4321", effectMarker: expect.any(String) });
			return {
				ok: true as const,
				registration: {
					sessionId: input.childId,
					lifecycleRequestId: input.effectMarker,
					endpointGeneration: 1,
					pid: 4321,
					processIncarnation: "inc-4321",
					cwd: input.cwd,
					stateRoot: input.stateRoot,
				},
			};
		},
		dispatch: async () => {
			counters.dispatches += 1;
			return { kind: "accepted" as const, commandId: "cmd-e2e", turnId: "turn-e2e", acceptedAt: 11 };
		},
		reconcile: async () => ({ status: "terminal_ok" as const, commandId: "cmd-e2e", turnId: "turn-e2e" }),
	};
}

/**
 * End-to-end master flow over one real Broker: role attestation adoption,
 * grant validation through the injected verifier seam, the full spawn state
 * machine to `accepted`, same-identity replay, exact close, and a durable-store
 * scan proving no request material was retained. Substrate and prompt layers
 * are injected fakes; real multiplexer behavior is separate platform evidence.
 */
describe("master mode end to end", () => {
	it("attests, spawns once, replays, and closes through one broker", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-master-e2e-"));
		const stateRoot = path.join(agentDir, "host-state");
		const locator = { cwd: agentDir, worktreeRoot: null, stateRoot };
		const attestation = {
			version: 2 as const,
			ownerSessionId: ownerId,
			launchPid: process.pid,
			launchProcessIncarnation: incarnation ?? "missing-incarnation",
			role: "master" as const,
			attestationEpoch: epoch,
		};
		const direct = indexEvent(
			{
				type: "host_registered",
				sessionId: ownerId,
				locator,
				endpointGeneration: 0,
				pid: process.pid,
				hostIncarnation: incarnation,
				masterRole: attestation,
			},
			1,
		);
		const effective = indexEvent(
			{
				type: "host_registered",
				sessionId: ownerId,
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				hostIncarnation: incarnation,
				masterRole: attestation,
			},
			2,
		);
		const counters = { launches: 0, closes: 0 };
		const dispatchCounters = { dispatches: 0 };
		const broker = new Broker({
			agentDir,
			spawnSubstrateProvider: substrateFake(counters),
			spawnPromptLayer: promptLayerFake(dispatchCounters),
			masterCapabilityVerifier: {
				verifyMasterCapability: async (owner, supplied, suppliedEpoch) => ({
					allowed: owner === ownerId && supplied === grant && suppliedEpoch === epoch,
				}),
			},
		});
		await broker.start();
		try {
			await writeIndex(agentDir, [direct, effective]);

			// The CLI resolves the epoch from the adopted attestation row and can
			// replay a durable Broker claim when the caller supplies its identity.

			const dispatched: Record<string, unknown>[] = [];
			const dispatchedKeys: string[] = [];
			const idempotencyKey = "shared-cli-spawn-key";

			const cliDeps = {
				env: { GJC_MASTER_CAPABILITY: grant, GJC_MASTER_OWNER_SESSION_ID: ownerId },
				dispatch: async (_dir: string, payload: Record<string, unknown>, idempotencyKey: string) => {
					dispatched.push(payload);
					dispatchedKeys.push(idempotencyKey);
					return await broker.handleRequest("session.spawn", payload, idempotencyKey);
				},
			};
			const accepted = await runSdkSpawn({ cwd: agentDir, prompt: seedText, agentDir, idempotencyKey }, cliDeps);
			expect(accepted.exitCode).toBe(0);
			expect(accepted.rendered.code).toBe("spawn_accepted");
			expect(accepted.rendered.substrateKind).toBe("headless");
			expect(accepted.rendered.seed?.phase).toBe("accepted");
			expect(dispatched[0]?.attestationEpoch).toBe(epoch);
			expect(counters.launches).toBe(1);
			expect(dispatchCounters.dispatches).toBe(1);

			// Re-running the CLI with the same identity joins the original claim:
			// it creates neither another child nor another seed prompt.
			const childId = accepted.rendered.sessionId;
			expect(childId).toBeDefined();
			const identityKey = await getBrokerIdentityKey(agentDir);
			const store = new SpawnAuthorityStore(agentDir, identityKey);
			await store.open();
			const claim = store.claims().find(row => row.childId === childId);
			expect(claim?.state).toBe("accepted");
			const replay = await runSdkSpawn({ cwd: agentDir, prompt: seedText, agentDir, idempotencyKey }, cliDeps);
			expect(replay).toMatchObject({
				exitCode: 0,
				rendered: { code: "spawn_replayed", sessionId: childId },
			});
			expect(dispatchedKeys).toEqual([idempotencyKey, idempotencyKey]);
			expect(counters.launches).toBe(1);
			expect(dispatchCounters.dispatches).toBe(1);

			// A rejected grant never reaches a substrate effect.
			const denied = await broker.handleRequest(
				"session.spawn",
				{ ...dispatched[0]!, masterCapability: "wrong-grant" },
				"e2e-denied-key",
			);
			expect(denied).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
			expect(counters.launches).toBe(1);

			// Close routes through the claim/authority record and re-proves the substrate.
			const closed = await broker.handleRequest("session.close", { sessionId: childId }, undefined);
			expect(closed).toMatchObject({ ok: true, result: { code: "spawn_child_closed" } });
			expect(counters.closes).toBe(1);
			const afterClose = new SpawnAuthorityStore(agentDir, identityKey);
			await afterClose.open();
			const closedClaim = afterClose.claims().find(row => row.childId === childId);
			expect(closedClaim?.state).toBe("closed");
			expect(afterClose.authority(closedClaim?.lifecycleIdentity ?? "")?.closeState).toBe("closed");
		} finally {
			await broker.stop();
		}

		// No request material is retained anywhere under the agent directory.
		const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: agentDir, onlyFiles: true }));
		const contents = (await Promise.all(files.map(file => Bun.file(path.join(agentDir, file)).text()))).join("\n");
		for (const value of [
			grant,
			seedText,
			new Bun.CryptoHasher("sha256").update(grant).digest("hex"),
			new Bun.CryptoHasher("sha256").update(seedText).digest("hex"),
		]) {
			expect(contents).not.toContain(value);
		}
		await fs.rm(agentDir, { recursive: true, force: true });
	});
});
