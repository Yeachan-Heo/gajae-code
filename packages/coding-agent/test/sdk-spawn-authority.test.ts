import { describe, expect, it } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Broker, type SpawnPromptLayer } from "../src/sdk/broker/broker";
import { getBrokerIdentityKey } from "../src/sdk/broker/identity";
import { setLifecycleCommandResolverForTest } from "../src/sdk/broker/lifecycle";
import {
	isSpawnClaimV2,
	type SeedDeliveryV2,
	SpawnAuthorityStore,
	type SpawnClaimV2,
	type SpawnLifecycleOwnerResolution,
	type SpawnSubstrateProof,
} from "../src/sdk/broker/spawn-authority";
import { createSpawnSubstrateProvider } from "../src/sdk/broker/spawn-substrate";

const identityKey = "a".repeat(64);
const bindingMac = "b".repeat(64);
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), "gjc-spawn-authority-"));
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter(key => record[key] !== undefined)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}
async function writeSpawnModelFixtures(agentDir: string): Promise<void> {
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		"providers:\n" +
			"  fixture-a:\n" +
			"    baseUrl: http://127.0.0.1:1/v1\n" +
			"    apiKey: fixture-key\n" +
			"    api: openai-completions\n" +
			"    models:\n" +
			"      - id: shared\n" +
			"        name: shared\n" +
			"        contextWindow: 32768\n" +
			"        maxTokens: 4096\n" +
			"  fixture-b:\n" +
			"    baseUrl: http://127.0.0.1:1/v1\n" +
			"    apiKey: fixture-key\n" +
			"    api: openai-completions\n" +
			"    models:\n" +
			"      - id: shared\n" +
			"        name: shared\n" +
			"        contextWindow: 32768\n" +
			"        maxTokens: 4096\n",
	);
	await fs.writeFile(path.join(agentDir, "config.yml"), "modelProviderOrder:\n  - fixture-b\n");
}

async function resolveFakeLifecycleOwner(proof: SpawnSubstrateProof): Promise<SpawnLifecycleOwnerResolution> {
	if (!Number.isSafeInteger(proof.pid) || !proof.pid || proof.pid <= 0 || !proof.processIncarnation)
		return { ok: false, code: "owner_proof_failed" };
	return { ok: true, owner: { pid: proof.pid, incarnation: proof.processIncarnation } };
}

const spawnSubstrateFake = {
	launch: async () => ({
		ok: true as const,
		proof: {
			substrateKind: "headless" as const,
			providerIdentity: "test-provider",
			pid: 4242,
			processIncarnation: "inc-4242",
		},
	}),
	verify: async () => "verified" as const,
	resolveLifecycleOwner: resolveFakeLifecycleOwner,
	close: async () => ({ ok: true }),
};
const spawnPromptLayerFake = {
	awaitRegistration: async (input: Parameters<SpawnPromptLayer["awaitRegistration"]>[0]) => ({
		ok: true as const,
		registration: {
			sessionId: input.childId,
			lifecycleRequestId: input.effectMarker,
			endpointGeneration: 1,
			pid: 4242,
			processIncarnation: "inc-4242",
			cwd: input.cwd,
			stateRoot: input.stateRoot,
		},
	}),
	dispatch: async () => ({ kind: "accepted" as const, commandId: "cmd-1", turnId: "turn-1", acceptedAt: Date.now() }),
	reconcile: async () => ({ status: "terminal_ok" as const, commandId: "cmd-1", turnId: "turn-1" }),
};

describe("SpawnAuthorityStore", () => {
	it("reopens a canonical-only legacy claim and preserves canonical replay", async () => {
		const agentDir = await temp();
		const store = new SpawnAuthorityStore(agentDir, identityKey);
		await store.open();
		const owner = await store.claimOrJoin("legacy-canonical-replay", bindingMac, bindingMac);
		if (owner.kind !== "owner") throw new Error("expected owner");
		const file = path.join(agentDir, "sdk", "spawn-authority.jsonl");
		const row = JSON.parse((await fs.readFile(file, "utf8")).trim()) as {
			version: number;
			claim: SpawnClaimV2 & { requestBindingMac?: string };
			integrity: string;
		};
		delete row.claim.requestBindingMac;
		row.claim.state = "closed";
		row.claim.updatedAt += 1;
		row.integrity = createHmac("sha256", Buffer.from(identityKey, "hex"))
			.update(canonicalJson({ claim: row.claim }))
			.digest("hex");
		await fs.writeFile(file, `${canonicalJson(row)}\n`);
		const reopened = new SpawnAuthorityStore(agentDir, identityKey);
		await reopened.open();
		const replay = await reopened.claimOrJoin("legacy-canonical-replay", bindingMac, bindingMac);
		expect(replay.kind).toBe("terminal");
	});
	it("creates one durable prepared claim for concurrent same-identity callers", async () => {
		const agentDir = await temp();
		const gate = Promise.withResolvers<void>();
		let blocked = false;
		const store = new SpawnAuthorityStore(agentDir, identityKey, {
			beforeSyncForTest: async () => {
				if (blocked) return;
				blocked = true;
				await gate.promise;
			},
		});
		await store.open();
		const first = store.claimOrJoin("identity", bindingMac);
		while (!blocked) await Bun.sleep(1);
		const second = store.claimOrJoin("identity", bindingMac);
		gate.resolve();
		const [owner, joiner] = await Promise.all([first, second]);
		expect(owner.kind).toBe("owner");
		expect(joiner.kind).toBe("in_progress");
		expect(owner.claim.claimId).toBe(joiner.claim.claimId);
		expect(owner.claim).toMatchObject({ state: "prepared", preSendLease: { status: "owned" } });
		expect((await Bun.file(store.file).text()).split("\n").filter(Boolean)).toHaveLength(1);
	});

	it("rejects a structural-binding mismatch without changing the claim", async () => {
		const agentDir = await temp();
		const store = new SpawnAuthorityStore(agentDir, identityKey);
		await store.open();
		const initial = await store.claimOrJoin("identity", bindingMac);
		await store.releaseOwner("identity");
		const conflict = await store.claimOrJoin("identity", "c".repeat(64));
		expect(initial.kind).toBe("owner");
		expect(conflict.kind).toBe("idempotency_conflict");
		expect(conflict.claim).toEqual(initial.claim);
		expect((await Bun.file(store.file).text()).split("\n").filter(Boolean)).toHaveLength(1);
	});

	it("rotates exactly one recovery lease for a prepared claim and refuses later states", async () => {
		const agentDir = await temp();
		const firstStore = new SpawnAuthorityStore(agentDir, identityKey);
		await firstStore.open();
		const first = await firstStore.claimOrJoin("identity", bindingMac);
		expect(first.kind).toBe("owner");
		const recovered = new SpawnAuthorityStore(agentDir, identityKey);
		await recovered.open();
		const [owner, joiner] = await Promise.all([
			recovered.claimOrJoin("identity", bindingMac),
			recovered.claimOrJoin("identity", bindingMac),
		]);
		expect(owner.kind).toBe("owner");
		expect(joiner.kind).toBe("in_progress");
		if (owner.kind !== "owner" || first.kind !== "owner") throw new Error("claim ownership was not granted");
		expect(owner.recovery).toBe(true);
		expect(owner.claim.preSendLease?.epoch).not.toBe(first.claim.preSendLease?.epoch);

		await recovered.persistTransition("identity", {
			claimId: owner.claim.claimId,
			from: "prepared",
			to: "substrate_starting",
			childId: "child-1",
		});
		await recovered.releaseOwner("identity");
		const restarted = new SpawnAuthorityStore(agentDir, identityKey);
		await restarted.open();
		expect((await restarted.claimOrJoin("identity", bindingMac)).kind).toBe("replay");
	});

	it("does not publish authority when fsync preparation fails", async () => {
		const agentDir = await temp();
		const store = new SpawnAuthorityStore(agentDir, identityKey, {
			beforeSyncForTest: () => {
				throw new Error("injected sync failure");
			},
		});
		await store.open();
		await expect(store.claimOrJoin("identity", bindingMac)).rejects.toThrow("injected sync failure");
		expect(store.claims()).toHaveLength(0);
	});

	it("leaves no journal trace when the durability barrier fails, so a retry still reopens", async () => {
		const agentDir = await temp();
		let failNextSync = true;
		const store = new SpawnAuthorityStore(agentDir, identityKey, {
			beforeSyncForTest: () => {
				if (!failNextSync) return;
				failNextSync = false;
				throw new Error("injected sync failure");
			},
		});
		await store.open();
		await expect(store.claimOrJoin("identity", bindingMac)).rejects.toThrow("injected sync failure");
		// The failed append must not survive physically: otherwise the retry below
		// appends a second row for the same claim and reopen rejects the history.
		const retried = await store.claimOrJoin("identity", bindingMac);
		expect(retried.kind).toBe("owner");
		const reopened = new SpawnAuthorityStore(agentDir, identityKey);
		await reopened.open();
		expect(reopened.claims()).toHaveLength(1);
		expect(reopened.claim("identity")?.state).toBe("prepared");
	});

	it("rolls back when the parent-directory barrier fails, not just the file barrier", async () => {
		const agentDir = await temp();
		let failNextDirectorySync = true;
		const store = new SpawnAuthorityStore(agentDir, identityKey, {
			beforeDirectorySyncForTest: () => {
				if (!failNextDirectorySync) return;
				failNextDirectorySync = false;
				throw new Error("injected directory barrier failure");
			},
		});
		await store.open();
		await expect(store.claimOrJoin("identity", bindingMac)).rejects.toThrow("injected directory barrier failure");
		// The row was file-synced before the directory barrier threw; without a
		// rollback spanning that barrier it would survive and the retry below would
		// append a duplicate that makes reopen reject the whole journal.
		const retried = await store.claimOrJoin("identity", bindingMac);
		expect(retried.kind).toBe("owner");
		const reopened = new SpawnAuthorityStore(agentDir, identityKey);
		await reopened.open();
		expect(reopened.claims()).toHaveLength(1);
	});

	it("strictly rejects sensitive or generic-hash claim fields", () => {
		const base = {
			version: 2,
			claimId: "claim",
			lifecycleIdentity: "identity",
			requestBindingMac: "c".repeat(64),
			bindingMac,
			state: "prepared",
			createdAt: 1,
			updatedAt: 1,
		};
		expect(isSpawnClaimV2(base)).toBe(true);
		for (const field of [
			"task",
			"prompt",
			"rawCapability",
			"taskDigest",
			"idempotencyKey",
			"fingerprint",
			"requestHash",
			"endpointCredential",
			"childStderr",
		])
			expect(isSpawnClaimV2({ ...base, [field]: "forbidden" })).toBe(false);
	});

	describe("Broker spawn admission", () => {
		it("keeps low-entropy task and capability material out of claim, ledger, and response", async () => {
			const agentDir = await temp();
			const task = "task-0000";
			const capability = "capability-0000";
			const broker = new Broker({
				agentDir,
				spawnSubstrateProvider: spawnSubstrateFake,
				spawnPromptLayer: spawnPromptLayerFake,
				masterCapabilityVerifier: {
					verifyMasterCapability: async (_ownerSessionId, rawCapability, _attestationEpoch) => ({
						allowed: rawCapability === capability,
					}),
				},
			});
			await broker.start();
			try {
				const response = await broker.handleRequest(
					"session.spawn",
					{
						task,
						masterCapability: capability,
						ownerSessionId: "master-1",
						attestationEpoch: "epoch-1",
						cwd: agentDir,
					},
					"raw-idempotency-key",
				);
				expect(response).toMatchObject({
					ok: true,
					result: { code: "spawn_accepted", seed: { phase: "accepted", status: "accepted" } },
				});
				const lookup = await broker.handleRequest(
					"broker.lookup_lifecycle",
					{ operation: "session.spawn", fingerprint: "not-a-spawn-fingerprint" },
					"raw-idempotency-key",
				);
				expect(lookup).toMatchObject({ ok: false, error: { code: "invalid_input" } });
				const artifacts = await Promise.all([
					Bun.file(path.join(agentDir, "sdk", "spawn-authority.jsonl")).text(),
					Bun.file(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl")).text(),
				]);
				for (const candidate of [
					task,
					capability,
					createHash("sha256").update(task).digest("hex"),
					createHash("sha256").update(capability).digest("hex"),
					createHmac("sha256", "test-key").update(task).digest("hex"),
					createHmac("sha256", "test-key").update(capability).digest("hex"),
					"raw-idempotency-key",
				]) {
					expect(artifacts.join("\n")).not.toContain(candidate);
					expect(JSON.stringify(response)).not.toContain(candidate);
				}
			} finally {
				await broker.stop();
			}
		});
	});
});

describe("Broker spawn flow driver", () => {
	const verifier = {
		verifyMasterCapability: async () => ({ allowed: true }),
	};
	const spawnInput = (task = "flow-task") => ({
		task,
		masterCapability: "flow-capability",
		ownerSessionId: "master-flow",
		attestationEpoch: "epoch-flow",
		cwd: process.cwd(),
	});
	async function latestClaim(agentDir: string): Promise<SpawnClaimV2 | undefined> {
		const source = await Bun.file(path.join(agentDir, "sdk", "spawn-authority.jsonl")).text();
		const lines = source.split("\n").filter(Boolean);
		const last = lines.at(-1);
		if (!last) return undefined;
		return (JSON.parse(last) as { claim: SpawnClaimV2 }).claim;
	}

	for (const mismatch of ["pid", "incarnation", "effectMarker"] as const) {
		it(`rejects a registration with the wrong host ${mismatch} and cleans up the original substrate`, async () => {
			const agentDir = await temp();
			const proof: SpawnSubstrateProof = {
				substrateKind: "tmux",
				providerIdentity: "readiness-provider",
				nativeSessionId: "$23",
				pid: 980,
				processIncarnation: "shell-980",
				ownerGeneration: 4,
				stateFileProof: { socket: "fixture-socket" },
			};
			const owner = { pid: 981, incarnation: "host-981" };
			const closed: SpawnSubstrateProof[] = [];
			let registrationInput: Parameters<SpawnPromptLayer["awaitRegistration"]>[0] | undefined;
			let writtenMarker: unknown;
			let registrations = 0;
			let dispatches = 0;
			const broker = new Broker({
				agentDir,
				masterCapabilityVerifier: verifier,
				spawnSubstrateProvider: {
					launch: async () => ({ ok: true, proof }),
					resolveLifecycleOwner: async (observed, deadlineAt) => {
						expect(observed).toEqual(proof);
						expect(deadlineAt).toBeGreaterThan(Date.now());
						return { ok: true, owner };
					},
					verify: async observed => {
						expect(observed).toEqual(proof);
						return "verified";
					},
					close: async observed => {
						closed.push(observed);
						return { ok: true };
					},
				},
				spawnPromptLayer: {
					...spawnPromptLayerFake,
					awaitRegistration: async input => {
						registrations += 1;
						registrationInput = input;
						writtenMarker = await Bun.file(
							path.join(input.stateRoot, "sdk", `${input.childId}.lifecycle.json`),
						).json();
						return {
							ok: true,
							registration: {
								sessionId: input.childId,
								endpointGeneration: 1,
								pid: mismatch === "pid" ? 980 : owner.pid,
								processIncarnation: mismatch === "incarnation" ? "shell-980" : owner.incarnation,
								lifecycleRequestId: mismatch === "effectMarker" ? "wrong-effect-marker" : input.effectMarker,
								cwd: input.cwd,
								stateRoot: input.stateRoot,
							},
						};
					},
					dispatch: async () => {
						dispatches += 1;
						return { kind: "pre_send_rejected" };
					},
				},
			});
			await broker.start();
			try {
				const response = await broker.handleRequest(
					"session.spawn",
					{ ...spawnInput(), cwd: agentDir },
					`wrong-${mismatch}`,
				);
				expect(response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
				expect(registrations).toBe(1);
				expect(registrationInput?.owner).toEqual(owner);
				expect(writtenMarker).toMatchObject({ ...owner, effectMarker: registrationInput?.effectMarker });
				expect(dispatches).toBe(0);
				expect(closed).toEqual([proof]);
				const claim = await latestClaim(agentDir);
				expect(claim?.state).toBe("uncertain");
				expect(claim?.seed).toBeUndefined();
			} finally {
				await broker.stop();
				await fs.rm(agentDir, { recursive: true, force: true });
			}
		});
	}

	for (const failure of [
		"owner_deadline",
		"owner_unsupported",
		"owner_proof_failed",
		"owner_ambiguous",
		"throw",
		"missing_pid",
		"missing_incarnation",
	] as const) {
		it(`writes no marker or seed when owner proof or resolution fails: ${failure}`, async () => {
			const agentDir = await temp();
			const missingProof = failure === "missing_pid" || failure === "missing_incarnation";
			const proof: SpawnSubstrateProof = {
				substrateKind: "headless",
				providerIdentity: "owner-failure-provider",
				...(failure === "missing_pid" ? {} : { pid: 982 }),
				...(failure === "missing_incarnation" ? {} : { processIncarnation: "inc-982" }),
			};
			let markerPath: string | undefined;
			let resolutions = 0;
			let registrations = 0;
			let dispatches = 0;
			const closed: SpawnSubstrateProof[] = [];
			const broker = new Broker({
				agentDir,
				masterCapabilityVerifier: verifier,
				spawnSubstrateProvider: {
					launch: async spec => {
						const request = JSON.parse(spec.env?.GJC_SDK_LIFECYCLE_REQUEST ?? "{}") as { stateRoot: string };
						markerPath = path.join(request.stateRoot, "sdk", `${spec.childSessionId}.lifecycle.json`);
						return { ok: true, proof };
					},
					resolveLifecycleOwner: async observed => {
						resolutions += 1;
						expect(observed).toEqual(proof);
						if (failure === "throw") throw new Error("owner observation failed");
						if (failure === "missing_pid" || failure === "missing_incarnation")
							return resolveFakeLifecycleOwner(observed);
						return { ok: false, code: failure };
					},
					verify: async () => "verified",
					close: async observed => {
						closed.push(observed);
						return { ok: true };
					},
				},
				spawnPromptLayer: {
					...spawnPromptLayerFake,
					awaitRegistration: async input => {
						registrations += 1;
						return spawnPromptLayerFake.awaitRegistration(input);
					},
					dispatch: async () => {
						dispatches += 1;
						return { kind: "pre_send_rejected" };
					},
				},
			});
			await broker.start();
			try {
				const response = await broker.handleRequest(
					"session.spawn",
					{ ...spawnInput(), cwd: agentDir },
					`owner-${failure}`,
				);
				expect(response).toMatchObject({
					ok: false,
					error: { code: missingProof ? "spawn_failed" : "terminal_uncertain" },
				});
				expect(resolutions).toBe(missingProof ? 0 : 1);
				expect(registrations).toBe(0);
				expect(dispatches).toBe(0);
				expect(closed).toEqual([proof]);
				if (!markerPath) throw new Error("launch did not capture marker path");
				expect(await Bun.file(markerPath).exists()).toBe(false);
				const claim = await latestClaim(agentDir);
				if (failure === "throw") {
					expect(claim).toBeDefined();
					expect(claim?.state).not.toBe("accepted");
					expect(claim?.state).not.toBe("pre_send_rejected");
				} else {
					expect(claim?.state).toBe(missingProof ? "pre_send_rejected" : "uncertain");
				}
				if (missingProof) expect(claim?.failure?.code).toBe("substrate_proof_failed");
				expect(claim?.seed).toBeUndefined();
			} finally {
				await broker.stop();
				await fs.rm(agentDir, { recursive: true, force: true });
			}
		});
	}

	it("fences every effect behind a durable transition and dispatches exactly once", async () => {
		const agentDir = await temp();
		const observed: {
			atLaunch?: string;
			atDispatch?: string;
			leaseAtDispatch?: string;
			launches: number;
			dispatches: number;
		} = {
			launches: 0,
			dispatches: 0,
		};
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				launch: async () => {
					observed.launches += 1;
					observed.atLaunch = (await latestClaim(agentDir))?.state;
					return {
						ok: true as const,
						proof: {
							substrateKind: "headless" as const,
							providerIdentity: "flow-provider",
							pid: 999,
							processIncarnation: "inc-999",
						},
					};
				},
				verify: async () => "verified" as const,
				resolveLifecycleOwner: resolveFakeLifecycleOwner,
				close: async () => ({ ok: true }),
			},
			spawnPromptLayer: {
				awaitRegistration: async (input: Parameters<SpawnPromptLayer["awaitRegistration"]>[0]) => ({
					ok: true as const,
					registration: {
						sessionId: input.childId,
						lifecycleRequestId: input.effectMarker,
						endpointGeneration: 1,
						pid: 999,
						processIncarnation: "inc-999",
						cwd: input.cwd,
						stateRoot: input.stateRoot,
					},
				}),
				dispatch: async () => {
					observed.dispatches += 1;
					const claim = await latestClaim(agentDir);
					observed.atDispatch = claim?.state;
					observed.leaseAtDispatch = claim?.preSendLease?.status;
					return { kind: "accepted" as const, commandId: "cmd-flow", turnId: "turn-flow", acceptedAt: 1234 };
				},
				reconcile: async () => ({ status: "unknown" as const }),
			},
		});
		await broker.start();
		try {
			const [first, second] = await Promise.all([
				broker.handleRequest("session.spawn", spawnInput(), "flow-key"),
				broker.handleRequest("session.spawn", spawnInput(), "flow-key"),
			]);
			const responses = [first, second] as { ok: boolean }[];
			const success = responses.filter(response => response.ok);
			expect(success).toHaveLength(1);
			expect(success[0]).toMatchObject({
				ok: true,
				result: {
					code: "spawn_accepted",
					substrateKind: "headless",
					seed: { phase: "accepted", commandId: "cmd-flow", turnId: "turn-flow" },
				},
			});
			expect(responses.find(response => !response.ok)).toMatchObject({
				ok: false,
				error: { code: expect.stringMatching(/^(spawn_in_progress|idempotency_conflict)$/) },
			});
			expect(observed.launches).toBe(1);
			expect(observed.dispatches).toBe(1);
			expect(observed.atLaunch).toBe("substrate_starting");
			expect(observed.atDispatch).toBe("dispatching");
			expect(observed.leaseAtDispatch).toBe("consumed");
			const replay = await broker.handleRequest("session.spawn", spawnInput(), "flow-key");
			expect(replay).toMatchObject({ ok: true, result: { code: "spawn_replayed" } });
			expect(observed.launches).toBe(1);
			expect(observed.dispatches).toBe(1);
		} finally {
			await broker.stop();
		}
	});

	it("retains dispatch uncertainty and replays only through Q26", async () => {
		const agentDir = await temp();
		let dispatches = 0;
		let reconciles = 0;
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				launch: async () => ({
					ok: true as const,
					proof: {
						substrateKind: "headless" as const,
						providerIdentity: "flow-provider",
						pid: 998,
						processIncarnation: "inc-998",
					},
				}),
				verify: async () => "verified" as const,
				resolveLifecycleOwner: resolveFakeLifecycleOwner,
				close: async () => ({ ok: true }),
			},
			spawnPromptLayer: {
				awaitRegistration: async (input: Parameters<SpawnPromptLayer["awaitRegistration"]>[0]) => ({
					ok: true as const,
					registration: {
						sessionId: input.childId,
						lifecycleRequestId: input.effectMarker,
						endpointGeneration: 1,
						pid: 998,
						processIncarnation: "inc-998",
						cwd: input.cwd,
						stateRoot: input.stateRoot,
					},
				}),
				dispatch: async () => {
					dispatches += 1;
					return { kind: "uncertain" as const };
				},
				reconcile: async () => {
					reconciles += 1;
					return { status: "terminal_ok" as const, commandId: "cmd-q26", turnId: "turn-q26", acceptedAt: 77 };
				},
			},
		});
		await broker.start();
		try {
			const first = await broker.handleRequest("session.spawn", spawnInput(), "uncertain-key");
			expect(first).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
			expect(dispatches).toBe(1);
			// The uncertain claim is terminal for new task input; Q26 replay path is
			// exercised for dispatching claims via broker restart recovery below.
			const again = await broker.handleRequest("session.spawn", spawnInput("different-task"), "uncertain-key");
			expect(again).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
			expect(dispatches).toBe(1);
			expect(reconciles).toBe(0);
		} finally {
			await broker.stop();
		}
	});

	it("rejects before handoff, closes the substrate exactly, and stays terminal", async () => {
		const agentDir = await temp();
		let closes = 0;
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				launch: async () => ({
					ok: true as const,
					proof: {
						substrateKind: "headless" as const,
						providerIdentity: "flow-provider",
						pid: 997,
						processIncarnation: "inc-997",
					},
				}),
				verify: async () => "verified" as const,
				resolveLifecycleOwner: resolveFakeLifecycleOwner,
				close: async () => {
					closes += 1;
					return { ok: true };
				},
			},
			spawnPromptLayer: {
				awaitRegistration: async (input: Parameters<SpawnPromptLayer["awaitRegistration"]>[0]) => ({
					ok: true as const,
					registration: {
						sessionId: input.childId,
						lifecycleRequestId: input.effectMarker,
						endpointGeneration: 1,
						pid: 997,
						processIncarnation: "inc-997",
						cwd: input.cwd,
						stateRoot: input.stateRoot,
					},
				}),
				dispatch: async () => ({ kind: "pre_send_rejected" as const }),
				reconcile: async () => ({ status: "unknown" as const }),
			},
		});
		await broker.start();
		try {
			const first = await broker.handleRequest("session.spawn", spawnInput(), "rejected-key");
			expect(first).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
			expect(closes).toBe(1);
			expect((await latestClaim(agentDir))?.state).toBe("pre_send_rejected");
			const replay = await broker.handleRequest("session.spawn", spawnInput(), "rejected-key");
			expect(replay).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
			expect(closes).toBe(1);
		} finally {
			await broker.stop();
		}
	});

	it("closes the launched substrate when child registration never arrives", async () => {
		const agentDir = await temp();
		let closes = 0;
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				launch: async () => ({
					ok: true as const,
					proof: {
						substrateKind: "headless" as const,
						providerIdentity: "leak-provider",
						pid: 993,
						processIncarnation: "inc-993",
					},
				}),
				verify: async () => "verified" as const,
				resolveLifecycleOwner: resolveFakeLifecycleOwner,
				close: async () => {
					closes += 1;
					return { ok: true };
				},
			},
			spawnPromptLayer: {
				// Registration never arrives: no authority row is written, so nothing
				// else would ever reap this substrate.
				awaitRegistration: async () => ({ ok: false as const }),
				dispatch: async () => ({ kind: "accepted" as const, commandId: "c", turnId: "t", acceptedAt: 1 }),
				reconcile: async () => ({ status: "unknown" as const }),
			},
		});
		await broker.start();
		try {
			const response = await broker.handleRequest("session.spawn", spawnInput(), "leak-key");
			expect(response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
			expect(closes).toBe(1);
			expect((await latestClaim(agentDir))?.state).toBe("uncertain");
		} finally {
			await broker.stop();
		}
	});

	it("treats a partially populated endpoint pin as missing authority", async () => {
		const agentDir = await temp();
		const brokerKey = await getBrokerIdentityKey(agentDir);
		const store = new SpawnAuthorityStore(agentDir, brokerKey);
		await store.open();
		const mac = `${"c".repeat(63)}d`;
		const owner = await store.claimOrJoin("partial", mac);
		if (owner.kind !== "owner") throw new Error("expected owner");
		await store.persistTransition("partial", {
			claimId: owner.claim.claimId,
			from: "prepared",
			to: "substrate_starting",
			childId: "child-partial",
		});
		const at = Date.now();
		// Identity fields present, locator legs absent: exactly the shape an earlier
		// generation wrote. Generation plus pid is collidable across workspaces, so
		// this must NOT be usable as a pin.
		await store.persistTransition("partial", {
			claimId: owner.claim.claimId,
			from: "substrate_starting",
			to: "authority_active",
			childId: "child-partial",
			authority: {
				version: 1,
				authorityId: "authority-partial",
				claimId: owner.claim.claimId,
				childId: "child-partial",
				ownerSessionId: "master-flow",
				lifecycleIdentity: "partial",
				substrateKind: "headless",
				providerIdentity: "p",
				pid: 976,
				processIncarnation: "inc-976",
				endpointGeneration: 5,
				endpointPid: 976,
				endpointIncarnation: "inc-976",
				closeState: "active",
				createdAt: at,
				updatedAt: at,
			},
		});
		await store.releaseOwner("partial");
		let dispatches = 0;
		let reconciles = 0;
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				resolveLifecycleOwner: resolveFakeLifecycleOwner,
				launch: async () => ({
					ok: false as const,
					code: "substrate_unavailable" as const,
					message: "no relaunch",
				}),
				verify: async () => "verified" as const,
				close: async () => ({ ok: true }),
			},
			spawnPromptLayer: {
				awaitRegistration: async () => ({ ok: false as const }),
				dispatch: async () => {
					dispatches += 1;
					return { kind: "accepted" as const, commandId: "c", turnId: "t", acceptedAt: 1 };
				},
				reconcile: async () => {
					reconciles += 1;
					return { status: "terminal_ok" as const, commandId: "c", turnId: "t" };
				},
			},
		});
		await broker.start();
		try {
			const after = new SpawnAuthorityStore(agentDir, brokerKey);
			await after.open();
			// The row still reopens; it just never recovers into a seed handoff.
			expect(after.claim("partial")?.state).toBe("uncertain");
			expect(dispatches).toBe(0);
			expect(reconciles).toBe(0);
		} finally {
			await broker.stop();
		}
	});

	it("refuses a foreign workspace endpoint whose generation and pid collide", async () => {
		const agentDir = await temp();
		const brokerKey = await getBrokerIdentityKey(agentDir);
		const store = new SpawnAuthorityStore(agentDir, brokerKey);
		await store.open();
		const mac = `${"b".repeat(63)}c`;
		const owner = await store.claimOrJoin("collide", mac);
		if (owner.kind !== "owner") throw new Error("expected owner");
		await store.persistTransition("collide", {
			claimId: owner.claim.claimId,
			from: "prepared",
			to: "substrate_starting",
			childId: "child-collide",
		});
		const at = Date.now();
		await store.persistTransition("collide", {
			claimId: owner.claim.claimId,
			from: "substrate_starting",
			to: "authority_active",
			childId: "child-collide",
			authority: {
				version: 1,
				authorityId: "authority-collide",
				claimId: owner.claim.claimId,
				childId: "child-collide",
				ownerSessionId: "master-flow",
				lifecycleIdentity: "collide",
				substrateKind: "headless",
				providerIdentity: "p",
				pid: 977,
				processIncarnation: "inc-977",
				endpointGeneration: 3,
				endpointPid: 977,
				endpointIncarnation: "inc-977",
				// The workspace is part of the pin; a colliding pid elsewhere must fail.
				endpointCwd: "/expected/workspace",
				endpointStateRoot: "/expected/workspace/.gjc/state",
				closeState: "active",
				createdAt: at,
				updatedAt: at,
			},
		});
		const reopened = new SpawnAuthorityStore(agentDir, brokerKey);
		await reopened.open();
		const pin = reopened.authority("collide");
		expect(pin?.endpointCwd).toBe("/expected/workspace");
		expect(pin?.endpointGeneration).toBe(3);
		// The strict validator accepts the locator fields and still rejects unknown keys.
		expect(isSpawnClaimV2(reopened.claim("collide"))).toBe(true);
	});

	it("pins Q26 replay and refuses a mismatched clientRef", async () => {
		const agentDir = await temp();
		const brokerKey = await getBrokerIdentityKey(agentDir);
		const store = new SpawnAuthorityStore(agentDir, brokerKey);
		await store.open();
		const mac = `${"a".repeat(63)}b`;
		const owner = await store.claimOrJoin("q26-pin", mac);
		if (owner.kind !== "owner") throw new Error("expected owner");
		await store.persistTransition("q26-pin", {
			claimId: owner.claim.claimId,
			from: "prepared",
			to: "substrate_starting",
			childId: "child-q26",
		});
		const at = Date.now();
		await store.persistTransition("q26-pin", {
			claimId: owner.claim.claimId,
			from: "substrate_starting",
			to: "authority_active",
			childId: "child-q26",
			authority: {
				version: 1,
				authorityId: "authority-q26",
				claimId: owner.claim.claimId,
				childId: "child-q26",
				ownerSessionId: "master-flow",
				lifecycleIdentity: "q26-pin",
				substrateKind: "headless",
				providerIdentity: "p",
				pid: 978,
				processIncarnation: "inc-978",
				endpointGeneration: 4,
				endpointPid: 978,
				endpointIncarnation: "inc-978",
				endpointCwd: "/pinned/workspace-978",
				endpointStateRoot: "/pinned/workspace-978/.gjc/state",
				closeState: "active",
				createdAt: at,
				updatedAt: at,
			},
		});
		const seed: SeedDeliveryV2 = { version: 2, phase: "prepared", clientRef: "stored-client-ref" };
		await store.persistTransition("q26-pin", {
			claimId: owner.claim.claimId,
			from: "authority_active",
			to: "seed_prepared",
			seed,
		});
		const lease = (await store.claimOrJoin("q26-pin", mac)) as { claim: SpawnClaimV2 };
		await store.persistTransition("q26-pin", {
			claimId: owner.claim.claimId,
			from: "seed_prepared",
			to: "dispatching",
			leaseEpoch: lease.claim.preSendLease?.epoch ?? "",
			seed: { ...seed, phase: "dispatching" },
		});
		await store.releaseOwner("q26-pin");
		const seenPins: (undefined | { endpointGeneration: number; pid: number })[] = [];
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				resolveLifecycleOwner: resolveFakeLifecycleOwner,
				launch: async () => ({
					ok: false as const,
					code: "substrate_unavailable" as const,
					message: "no relaunch",
				}),
				verify: async () => "verified" as const,
				close: async () => ({ ok: true }),
			},
			spawnPromptLayer: {
				awaitRegistration: async () => ({ ok: false as const }),
				dispatch: async () => ({ kind: "accepted" as const, commandId: "c", turnId: "t", acceptedAt: 1 }),
				reconcile: async input => {
					seenPins.push(input.pinned);
					// Answer for a DIFFERENT correlation than the stored ref.
					return {
						status: "terminal_ok" as const,
						clientRef: "wrong-client-ref",
						commandId: "foreign-command",
						turnId: "foreign-turn",
					};
				},
			},
		});
		await broker.start();
		try {
			// The replay must carry the durable endpoint pin.
			expect(seenPins.length).toBeGreaterThan(0);
			expect(seenPins[0]).toMatchObject({ endpointGeneration: 4, pid: 978 });
			// A mismatched echoed clientRef must not bind foreign facts.
			const after = new SpawnAuthorityStore(agentDir, brokerKey);
			await after.open();
			const claim = after.claim("q26-pin");
			expect(claim?.state).not.toBe("accepted");
			expect(JSON.stringify(claim)).not.toContain("foreign-command");
			expect(JSON.stringify(claim)).not.toContain("foreign-turn");
		} finally {
			await broker.stop();
		}
	});

	it("fails a pre-pin legacy authority row closed instead of matching by session id", async () => {
		const agentDir = await temp();
		const brokerKey = await getBrokerIdentityKey(agentDir);
		const store = new SpawnAuthorityStore(agentDir, brokerKey);
		await store.open();
		const mac = "f".repeat(64);
		const owner = await store.claimOrJoin("legacy-pin", mac);
		if (owner.kind !== "owner") throw new Error("expected owner");
		await store.persistTransition("legacy-pin", {
			claimId: owner.claim.claimId,
			from: "prepared",
			to: "substrate_starting",
			childId: "child-legacy",
		});
		const at = Date.now();
		// A row written before the endpoint pin existed: it must still REOPEN
		// (no whole-journal rejection) but must never recover by id alone.
		await store.persistTransition("legacy-pin", {
			claimId: owner.claim.claimId,
			from: "substrate_starting",
			to: "authority_active",
			childId: "child-legacy",
			authority: {
				version: 1,
				authorityId: "authority-legacy",
				claimId: owner.claim.claimId,
				childId: "child-legacy",
				ownerSessionId: "master-flow",
				lifecycleIdentity: "legacy-pin",
				substrateKind: "headless",
				providerIdentity: "p",
				pid: 979,
				processIncarnation: "inc-979",
				closeState: "active",
				createdAt: at,
				updatedAt: at,
			},
		});
		const reopened = new SpawnAuthorityStore(agentDir, brokerKey);
		await reopened.open();
		expect(reopened.claim("legacy-pin")?.state).toBe("authority_active");
		expect(reopened.authority("legacy-pin")?.endpointGeneration).toBeUndefined();
		await store.releaseOwner("legacy-pin");
		let dispatches = 0;
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				launch: async () => ({
					ok: false as const,
					code: "substrate_unavailable" as const,
					message: "no relaunch",
				}),
				verify: async () => "verified" as const,
				resolveLifecycleOwner: resolveFakeLifecycleOwner,
				close: async () => ({ ok: true }),
			},
			spawnPromptLayer: {
				awaitRegistration: async () => ({ ok: false as const }),
				dispatch: async () => {
					dispatches += 1;
					return { kind: "accepted" as const, commandId: "c", turnId: "t", acceptedAt: 1 };
				},
				reconcile: async () => ({ status: "terminal_ok" as const, commandId: "c", turnId: "t" }),
			},
		});
		await broker.start();
		try {
			const after = new SpawnAuthorityStore(agentDir, brokerKey);
			await after.open();
			expect(after.claim("legacy-pin")?.state).toBe("uncertain");
			expect(dispatches).toBe(0);
		} finally {
			await broker.stop();
		}
	});

	it("refuses to seed a substrate that cannot be re-proven after restart", async () => {
		const agentDir = await temp();
		const brokerKey = await getBrokerIdentityKey(agentDir);
		const store = new SpawnAuthorityStore(agentDir, brokerKey);
		await store.open();
		const mac = "d".repeat(64);
		const owner = await store.claimOrJoin("recover-mismatch", mac);
		if (owner.kind !== "owner") throw new Error("expected owner");
		await store.persistTransition("recover-mismatch", {
			claimId: owner.claim.claimId,
			from: "prepared",
			to: "substrate_starting",
			childId: "child-mismatch",
		});
		const at = Date.now();
		await store.persistTransition("recover-mismatch", {
			claimId: owner.claim.claimId,
			from: "substrate_starting",
			to: "authority_active",
			childId: "child-mismatch",
			authority: {
				version: 1,
				authorityId: "authority-mismatch",
				claimId: owner.claim.claimId,
				childId: "child-mismatch",
				ownerSessionId: "master-flow",
				lifecycleIdentity: "recover-mismatch",
				substrateKind: "headless",
				providerIdentity: "flow-provider",
				pid: 994,
				processIncarnation: "inc-994",
				endpointGeneration: 1,
				endpointPid: 994,
				endpointIncarnation: "inc-994",
				endpointCwd: "/pinned/workspace-994",
				endpointStateRoot: "/pinned/workspace-994/.gjc/state",
				closeState: "active",
				createdAt: at,
				updatedAt: at,
			},
		});
		await store.releaseOwner("recover-mismatch");
		let verifyCalls = 0;
		let dispatches = 0;
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				launch: async () => ({
					ok: false as const,
					code: "substrate_unavailable" as const,
					message: "no relaunch",
				}),
				verify: async () => {
					verifyCalls += 1;
					return "mismatch" as const;
				},
				resolveLifecycleOwner: resolveFakeLifecycleOwner,
				close: async () => ({ ok: true }),
			},
			spawnPromptLayer: {
				awaitRegistration: async () => ({ ok: false as const }),
				dispatch: async () => {
					dispatches += 1;
					return { kind: "accepted" as const, commandId: "c", turnId: "t", acceptedAt: 1 };
				},
				reconcile: async () => ({ status: "unknown" as const }),
			},
		});
		await broker.start();
		try {
			// Startup recovery must re-prove the durable substrate; a mismatch retains
			// uncertainty instead of letting a recovery owner prompt a foreign child.
			expect(verifyCalls).toBeGreaterThan(0);
			const recovered = new SpawnAuthorityStore(agentDir, brokerKey);
			await recovered.open();
			expect(recovered.claim("recover-mismatch")?.state).toBe("uncertain");
			expect(dispatches).toBe(0);
		} finally {
			await broker.stop();
		}
	});

	it("recovers restart windows without a replacement child or second prompt", async () => {
		const agentDir = await temp();
		const brokerKey = await getBrokerIdentityKey(agentDir);
		const store = new SpawnAuthorityStore(agentDir, brokerKey);
		await store.open();
		const mac = "c".repeat(64);
		// substrate_starting without exact proof: retained uncertainty.
		const starting = await store.claimOrJoin("recover-starting", mac);
		if (starting.kind !== "owner") throw new Error("expected owner");
		await store.persistTransition("recover-starting", {
			claimId: starting.claim.claimId,
			from: "prepared",
			to: "substrate_starting",
			childId: "child-starting",
		});
		// dispatching: Q26-only reconciliation to accepted.
		const dispatching = await store.claimOrJoin("recover-dispatching", mac);
		if (dispatching.kind !== "owner") throw new Error("expected owner");
		await store.persistTransition("recover-dispatching", {
			claimId: dispatching.claim.claimId,
			from: "prepared",
			to: "substrate_starting",
			childId: "child-dispatching",
		});
		const authorityNow = Date.now();
		await store.persistTransition("recover-dispatching", {
			claimId: dispatching.claim.claimId,
			from: "substrate_starting",
			to: "authority_active",
			childId: "child-dispatching",
			authority: {
				version: 1,
				authorityId: "authority-dispatching",
				claimId: dispatching.claim.claimId,
				childId: "child-dispatching",
				ownerSessionId: "master-flow",
				lifecycleIdentity: "recover-dispatching",
				substrateKind: "headless",
				providerIdentity: "flow-provider",
				pid: 996,
				processIncarnation: "inc-996",
				// Endpoint identity proven at registration; recovery re-pins from it.
				endpointGeneration: 1,
				endpointPid: 996,
				endpointIncarnation: "inc-996",
				endpointCwd: "/pinned/workspace-996",
				endpointStateRoot: "/pinned/workspace-996/.gjc/state",
				closeState: "active",
				createdAt: authorityNow,
				updatedAt: authorityNow,
			},
		});
		const seed: SeedDeliveryV2 = { version: 2, phase: "prepared", clientRef: "client-ref-q26" };
		await store.persistTransition("recover-dispatching", {
			claimId: dispatching.claim.claimId,
			from: "authority_active",
			to: "seed_prepared",
			seed,
		});
		const prepared = (await store.claimOrJoin("recover-dispatching", mac)) as { kind: string; claim: SpawnClaimV2 };
		await store.persistTransition("recover-dispatching", {
			claimId: dispatching.claim.claimId,
			from: "seed_prepared",
			to: "dispatching",
			leaseEpoch: prepared.claim.preSendLease?.epoch ?? "",
			seed: { ...seed, phase: "dispatching" },
		});
		let launches = 0;
		let dispatchesAfterRestart = 0;
		const reconciled: string[] = [];
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				launch: async () => {
					launches += 1;
					return {
						ok: false as const,
						code: "substrate_unavailable" as const,
						message: "no launches during recovery",
					};
				},
				verify: async () => "verified" as const,
				resolveLifecycleOwner: resolveFakeLifecycleOwner,
				close: async () => ({ ok: true }),
			},
			spawnPromptLayer: {
				awaitRegistration: async () => ({ ok: false as const }),
				dispatch: async () => {
					dispatchesAfterRestart += 1;
					return { kind: "uncertain" as const };
				},
				reconcile: async (input: { clientRef: string }) => {
					reconciled.push(input.clientRef);
					return {
						status: "terminal_ok" as const,
						commandId: "cmd-recovered",
						turnId: "turn-recovered",
						acceptedAt: 42,
					};
				},
			},
		});
		await broker.start();
		try {
			const recovered = new SpawnAuthorityStore(agentDir, brokerKey);
			await recovered.open();
			expect(recovered.claim("recover-starting")?.state).toBe("uncertain");
			const advanced = recovered.claim("recover-dispatching");
			expect(advanced?.state).toBe("accepted");
			expect(advanced?.seed).toMatchObject({
				phase: "accepted",
				clientRef: "client-ref-q26",
				commandId: "cmd-recovered",
				turnId: "turn-recovered",
			});
			expect(reconciled).toEqual(["client-ref-q26"]);
			expect(launches).toBe(0);
			expect(dispatchesAfterRestart).toBe(0);
		} finally {
			await broker.stop();
		}
	});
});

describe("Broker spawn close and orphan reaper", () => {
	const verifier = { verifyMasterCapability: async () => ({ allowed: true }) };
	const spawnInput = () => ({
		task: "close-task",
		masterCapability: "close-capability",
		ownerSessionId: "master-close",
		attestationEpoch: "epoch-close",
		cwd: process.cwd(),
	});
	type ProviderProbe = { verdict: "verified" | "mismatch" | "gone"; closes: number; closePending?: boolean };
	function provider(probe: ProviderProbe) {
		return {
			launch: async () => ({
				ok: true as const,
				proof: {
					substrateKind: "headless" as const,
					providerIdentity: "close-provider",
					pid: 995,
					processIncarnation: "inc-995",
				},
			}),
			verify: async () => probe.verdict,
			resolveLifecycleOwner: resolveFakeLifecycleOwner,
			close: async () => {
				probe.closes += 1;
				if (probe.closePending) return { ok: false, code: "substrate_close_pending" };
				probe.verdict = "gone";
				return { ok: true };
			},
		};
	}
	const promptLayer = {
		awaitRegistration: async (input: Parameters<SpawnPromptLayer["awaitRegistration"]>[0]) => ({
			ok: true as const,
			registration: {
				sessionId: input.childId,
				lifecycleRequestId: input.effectMarker,
				endpointGeneration: 1,
				pid: input.owner.pid,
				processIncarnation: input.owner.incarnation,
				cwd: input.cwd,
				stateRoot: input.stateRoot,
			},
		}),
		dispatch: async () => ({
			kind: "accepted" as const,
			commandId: "cmd-close",
			turnId: "turn-close",
			acceptedAt: 5,
		}),
		reconcile: async () => ({ status: "unknown" as const }),
	};

	async function acceptedChild(broker: Broker, key: string): Promise<string> {
		const response = (await broker.handleRequest("session.spawn", spawnInput(), key)) as {
			ok: boolean;
			result?: { sessionId?: string };
		};
		expect(response.ok).toBe(true);
		const childId = response.result?.sessionId;
		if (!childId) throw new Error("spawn success did not return a child id");
		return childId;
	}

	it("launches after dropping unsupported broker-inherited environment entries", async () => {
		const agentDir = await temp();
		let launchEnvironment: NodeJS.ProcessEnv | undefined;
		const drops: string[][] = [];
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: createSpawnSubstrateProvider({
				platform: "darwin",
				selectMultiplexer: () => "none",
				startHeadless: (_spec, environment) => {
					launchEnvironment = environment;
					return { pid: 996, terminate() {} };
				},
				processIncarnation: pid => (pid === 996 ? "inc-996" : undefined),
				openLifecycleProcess: pid =>
					pid === 996
						? {
								pid,
								incarnation: "inc-996",
								ppid: process.pid,
								status: () => "running",
								children: () => [],
							}
						: null,
				isProcessGone: () => false,
				onInheritedEnvironmentDrop: names => drops.push([...names]),
			}),
			spawnPromptLayer: promptLayer,
		});
		setLifecycleCommandResolverForTest(broker, () => ({
			kind: "compiled",
			file: "child-command",
			args: [],
			env: { "FOO-BAR": "retained-by-os", TOO_LARGE: "x".repeat(4097), SAFE_PARENT: "kept" },
		}));
		await broker.start();
		try {
			const response = await broker.handleRequest(
				"session.spawn",
				{ ...spawnInput(), cwd: agentDir },
				"inherited-environment-key",
			);
			expect(response).toMatchObject({ ok: true, result: { code: "spawn_accepted" } });
			expect(launchEnvironment).toMatchObject({ SAFE_PARENT: "kept" });
			expect(launchEnvironment?.["FOO-BAR"]).toBeUndefined();
			expect(launchEnvironment?.TOO_LARGE).toBeUndefined();
			expect(drops).toEqual([["FOO-BAR", "TOO_LARGE"]]);
		} finally {
			setLifecycleCommandResolverForTest(broker, undefined);
			await broker.stop();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("closes only a re-proven substrate and replays repeated close safely", async () => {
		const agentDir = await temp();
		const probe: ProviderProbe = { verdict: "verified", closes: 0 };
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: provider(probe),
			spawnPromptLayer: promptLayer,
		});
		await broker.start();
		try {
			const childId = await acceptedChild(broker, "close-key");
			const closed = await broker.handleRequest("session.close", { sessionId: childId }, undefined);
			expect(closed).toMatchObject({ ok: true, result: { code: "spawn_child_closed", sessionId: childId } });
			expect(probe.closes).toBe(1);
			const again = await broker.handleRequest("session.close", { sessionId: childId }, undefined);
			expect(again).toMatchObject({ ok: true, result: { code: "spawn_child_closed" } });
			expect(probe.closes).toBe(1);
			const store = new SpawnAuthorityStore(agentDir, await getBrokerIdentityKey(agentDir));
			await store.open();
			const claim = store.claims().find(candidate => candidate.childId === childId);
			expect(claim?.state).toBe("closed");
			expect(store.authority(claim?.lifecycleIdentity ?? "")?.closeState).toBe("closed");
		} finally {
			await broker.stop();
		}
	});

	it("retains close_requested until the exact headless incarnation is observed gone", async () => {
		const agentDir = await temp();
		const probe: ProviderProbe = { verdict: "verified", closes: 0, closePending: true };
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: provider(probe),
			spawnPromptLayer: promptLayer,
		});
		await broker.start();
		try {
			const childId = await acceptedChild(broker, "close-pending-key");
			const retained = await broker.handleRequest("session.close", { sessionId: childId }, undefined);
			expect(retained).toMatchObject({ ok: false, error: { code: "close_refused" } });
			expect(probe.closes).toBe(1);
			const store = new SpawnAuthorityStore(agentDir, await getBrokerIdentityKey(agentDir));
			await store.open();
			const claim = store.claims().find(candidate => candidate.childId === childId);
			const identity = claim?.lifecycleIdentity ?? "";
			expect(claim?.state).toBe("accepted");
			expect(store.authority(identity)).toMatchObject({ closeState: "close_requested" });

			// A later maintenance pass retries the close request. The provider reports
			// success only after it observes the exact incarnation gone.
			probe.closePending = false;
			await broker.reapSpawnOrphansOnce();
			expect(probe.closes).toBe(2);
			const reopened = new SpawnAuthorityStore(agentDir, await getBrokerIdentityKey(agentDir));
			await reopened.open();
			expect(reopened.claim(identity)?.state).toBe("closed");
			expect(reopened.authority(identity)?.closeState).toBe("closed");
		} finally {
			await broker.stop();
		}
	});

	it("closes the launched substrate on every post-launch failure exit", async () => {
		// The registration-failure BRANCH is not the only post-launch exit: a throw
		// from awaitRegistration, verify, or a durable transition all leak the same
		// substrate, and none of them persists an authority row for the reaper.
		const exits = [
			{ name: "awaitRegistration throws", registration: "throw" as const },
			{ name: "awaitRegistration returns false", registration: "false" as const },
		];
		for (const exit of exits) {
			const agentDir = await temp();
			let closes = 0;
			const broker = new Broker({
				agentDir,
				masterCapabilityVerifier: verifier,
				spawnSubstrateProvider: {
					launch: async () => ({
						ok: true as const,
						proof: {
							substrateKind: "headless" as const,
							providerIdentity: "leak-p",
							pid: 981,
							processIncarnation: "inc-981",
						},
					}),
					verify: async () => "verified" as const,
					resolveLifecycleOwner: resolveFakeLifecycleOwner,
					close: async () => {
						closes += 1;
						return { ok: true };
					},
				},
				spawnPromptLayer: {
					awaitRegistration: async () => {
						if (exit.registration === "throw") throw new Error("registration transport failed");
						return { ok: false as const };
					},
					dispatch: async () => ({ kind: "accepted" as const, commandId: "c", turnId: "t", acceptedAt: 1 }),
					reconcile: async () => ({ status: "unknown" as const }),
				},
			});
			await broker.start();
			try {
				const response = await broker.handleRequest("session.spawn", spawnInput(), `exit-${exit.registration}`);
				expect(response, exit.name).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
				expect(closes, exit.name).toBe(1);
			} finally {
				await broker.stop();
			}
		}
	});

	it("retains uncertainty when a recovery verify throws instead of answering", async () => {
		const agentDir = await temp();
		const brokerKey = await getBrokerIdentityKey(agentDir);
		const store = new SpawnAuthorityStore(agentDir, brokerKey);
		await store.open();
		const mac = "e".repeat(64);
		const owner = await store.claimOrJoin("recover-throw", mac);
		if (owner.kind !== "owner") throw new Error("expected owner");
		await store.persistTransition("recover-throw", {
			claimId: owner.claim.claimId,
			from: "prepared",
			to: "substrate_starting",
			childId: "child-throw",
		});
		const at = Date.now();
		await store.persistTransition("recover-throw", {
			claimId: owner.claim.claimId,
			from: "substrate_starting",
			to: "authority_active",
			childId: "child-throw",
			authority: {
				version: 1,
				authorityId: "authority-throw",
				claimId: owner.claim.claimId,
				childId: "child-throw",
				ownerSessionId: "master-flow",
				lifecycleIdentity: "recover-throw",
				substrateKind: "headless",
				providerIdentity: "p",
				pid: 982,
				processIncarnation: "inc-982",
				endpointGeneration: 1,
				endpointPid: 982,
				endpointIncarnation: "inc-982",
				endpointCwd: "/pinned/workspace-982",
				endpointStateRoot: "/pinned/workspace-982/.gjc/state",
				closeState: "active",
				createdAt: at,
				updatedAt: at,
			},
		});
		await store.releaseOwner("recover-throw");
		let verifyCalls = 0;
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				launch: async () => ({
					ok: false as const,
					code: "substrate_unavailable" as const,
					message: "no relaunch",
				}),
				verify: async () => {
					verifyCalls += 1;
					throw new Error("verify transport failed");
				},
				resolveLifecycleOwner: resolveFakeLifecycleOwner,
				close: async () => ({ ok: true }),
			},
			spawnPromptLayer: {
				awaitRegistration: async () => ({ ok: false as const }),
				dispatch: async () => ({ kind: "accepted" as const, commandId: "c", turnId: "t", acceptedAt: 1 }),
				reconcile: async () => ({ status: "unknown" as const }),
			},
		});
		await broker.start();
		try {
			// A thrown verify is not evidence of a healthy substrate.
			const reopened = new SpawnAuthorityStore(agentDir, brokerKey);
			await reopened.open();
			expect(reopened.claim("recover-throw")?.state).toBe("uncertain");
			expect(verifyCalls).toBeGreaterThanOrEqual(1);
		} finally {
			await broker.stop();
		}
	});

	it("rejects an unknown model profile before any substrate effect", async () => {
		const agentDir = await temp();
		let launches = 0;
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				launch: async () => {
					launches += 1;
					return {
						ok: true as const,
						proof: {
							substrateKind: "headless" as const,
							providerIdentity: "p",
							pid: 991,
							processIncarnation: "inc-991",
						},
					};
				},
				verify: async () => "verified" as const,
				resolveLifecycleOwner: resolveFakeLifecycleOwner,
				close: async () => ({ ok: true }),
			},
			spawnPromptLayer: promptLayer,
		});
		await broker.start();
		try {
			const response = await broker.handleRequest(
				"session.spawn",
				{ ...spawnInput(), modelPreset: "definitely-not-a-profile" },
				"bad-profile-key",
			);
			expect(response).toMatchObject({ ok: false });
			// The failure must be typed and pre-effect, not uncertainty after launch.
			expect((response as { error: { code: string } }).error.code).not.toBe("terminal_uncertain");
			expect(launches).toBe(0);
			// No durable claim is committed either: the rejection precedes claimOrJoin.
			const journal = new SpawnAuthorityStore(agentDir, await getBrokerIdentityKey(agentDir));
			await journal.open();
			expect(journal.claims()).toHaveLength(0);
		} finally {
			await broker.stop();
		}
	});

	it("rejects an unknown model id before any claim, ledger, substrate, or seed effect", async () => {
		const agentDir = await temp();
		await writeSpawnModelFixtures(agentDir);
		let launches = 0;
		let dispatches = 0;
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				launch: async () => {
					launches += 1;
					return {
						ok: true as const,
						proof: {
							substrateKind: "headless" as const,
							providerIdentity: "unknown-model-provider",
							pid: 990,
							processIncarnation: "inc-990",
						},
					};
				},
				verify: async () => "verified" as const,
				resolveLifecycleOwner: resolveFakeLifecycleOwner,
				close: async () => ({ ok: true }),
			},
			spawnPromptLayer: {
				awaitRegistration: async () => ({ ok: false as const }),
				dispatch: async () => {
					dispatches += 1;
					return { kind: "accepted" as const, commandId: "unused", turnId: "unused", acceptedAt: 1 };
				},
				reconcile: async () => ({ status: "unknown" as const }),
			},
		});
		await broker.start();
		try {
			const invalid = await broker.handleRequest(
				"session.spawn",
				{ ...spawnInput(), modelId: "   " },
				"invalid-model-key",
			);
			expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_input" } });
			const response = await broker.handleRequest(
				"session.spawn",
				{ ...spawnInput(), modelId: "fixture/missing-model" },
				"bad-model-key",
			);
			expect(response).toMatchObject({ ok: false, error: { code: "unknown_model" } });
			expect(launches).toBe(0);
			expect(dispatches).toBe(0);
			const authorityJournal = Bun.file(path.join(agentDir, "sdk", "spawn-authority.jsonl"));
			expect((await authorityJournal.exists()) ? (await authorityJournal.text()).trim() : "").toBe("");
			const lifecycleLedger = Bun.file(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"));
			expect((await lifecycleLedger.exists()) ? (await lifecycleLedger.text()).trim() : "").toBe("");
		} finally {
			await broker.stop();
		}
	});

	it("canonicalizes an accepted model id before launch and preserves canonical replay identity", async () => {
		const agentDir = await temp();
		await writeSpawnModelFixtures(agentDir);
		let launches = 0;
		let launchModelId: string | undefined;
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				launch: async spec => {
					launches += 1;
					const request = JSON.parse(spec.env?.GJC_SDK_LIFECYCLE_REQUEST ?? "{}") as { modelId?: string };
					launchModelId = request.modelId;
					return {
						ok: true as const,
						proof: {
							substrateKind: "headless" as const,
							providerIdentity: "canonical-model-provider",
							pid: 989,
							processIncarnation: "inc-989",
						},
					};
				},
				verify: async () => "verified" as const,
				resolveLifecycleOwner: resolveFakeLifecycleOwner,
				close: async () => ({ ok: true }),
			},
			spawnPromptLayer: {
				awaitRegistration: async (input: Parameters<SpawnPromptLayer["awaitRegistration"]>[0]) => ({
					ok: true as const,
					registration: {
						sessionId: input.childId,
						lifecycleRequestId: input.effectMarker,
						endpointGeneration: 1,
						pid: 989,
						processIncarnation: "inc-989",
						cwd: input.cwd,
						stateRoot: input.stateRoot,
					},
				}),
				dispatch: async () => ({
					kind: "accepted" as const,
					commandId: "cmd-canonical",
					turnId: "turn-canonical",
					acceptedAt: 1,
				}),
				reconcile: async () => ({ status: "unknown" as const }),
			},
		});
		await broker.start();
		try {
			const first = await broker.handleRequest(
				"session.spawn",
				{ ...spawnInput(), modelId: "shared" },
				"canonical-model-key",
			);
			expect(first).toMatchObject({ ok: true, result: { code: "spawn_accepted" } });
			expect(launches).toBe(1);
			expect(launchModelId).toBe("fixture-b/shared");
			await fs.rm(path.join(agentDir, "models.yml"));
			const replay = await broker.handleRequest(
				"session.spawn",
				{ ...spawnInput(), modelId: "shared" },
				"canonical-model-key",
			);
			expect(replay).toMatchObject({ ok: true, result: { code: "spawn_replayed" } });
			expect(launches).toBe(1);
			const conflict = await broker.handleRequest(
				"session.spawn",
				{ ...spawnInput(), modelId: "fixture-b/shared" },
				"canonical-model-key",
			);
			expect(conflict).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
		} finally {
			await broker.stop();
		}
	});

	it("pins child registration to the launch locator and the dispatch endpoint", async () => {
		const agentDir = await temp();
		const seen: { pinned?: { endpointGeneration: number; pid: number } } = {};
		const registrations: { childId: string; cwd: string; stateRoot: string }[] = [];
		const closedProofs: SpawnSubstrateProof[] = [];
		const substrate = provider({ verdict: "verified", closes: 0 });
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				...substrate,
				resolveLifecycleOwner: async () => ({ ok: true, owner: { pid: 4242, incarnation: "inc-4242" } }),
				close: async proof => {
					closedProofs.push(proof);
					return substrate.close();
				},
			},
			spawnPromptLayer: {
				awaitRegistration: async (input: Parameters<SpawnPromptLayer["awaitRegistration"]>[0]) => {
					// The launch locator must reach the matcher; a same-id row from an
					// unrelated workspace must not satisfy this spawn.
					registrations.push(input);
					return {
						ok: true as const,
						registration: {
							sessionId: input.childId,
							lifecycleRequestId: input.effectMarker,
							endpointGeneration: 7,
							pid: 4242,
							processIncarnation: "inc-4242",
							cwd: input.cwd,
							stateRoot: input.stateRoot,
						},
					};
				},
				dispatch: async input => {
					seen.pinned = input.pinned;
					return { kind: "accepted" as const, commandId: "cmd-pin", turnId: "turn-pin", acceptedAt: 3 };
				},
				reconcile: async () => ({ status: "unknown" as const }),
			},
		});
		await broker.start();
		try {
			const response = (await broker.handleRequest("session.spawn", spawnInput(), "pin-key")) as { ok: boolean };
			expect(response.ok).toBe(true);
			expect(registrations).toHaveLength(1);
			expect(path.isAbsolute(registrations[0]!.cwd)).toBe(true);
			expect(registrations[0]!.stateRoot.length).toBeGreaterThan(0);
			// The proven endpoint identity is carried into the seed dispatch.
			expect(seen.pinned).toMatchObject({ endpointGeneration: 7, pid: 4242 });
			const store = new SpawnAuthorityStore(agentDir, await getBrokerIdentityKey(agentDir));
			await store.open();
			const claim = store.claims()[0];
			expect(store.authority(claim?.lifecycleIdentity ?? "")).toMatchObject({
				pid: 995,
				processIncarnation: "inc-995",
				endpointPid: 4242,
				endpointIncarnation: "inc-4242",
			});
			const closed = await broker.handleRequest("session.close", { sessionId: claim?.childId }, undefined);
			expect(closed).toMatchObject({ ok: true, result: { code: "spawn_child_closed" } });
			expect(closedProofs).toEqual([
				{
					substrateKind: "headless",
					providerIdentity: "close-provider",
					pid: 995,
					processIncarnation: "inc-995",
				},
			]);
		} finally {
			await broker.stop();
		}
	});

	it("routes the session id alias through exact spawn close", async () => {
		const agentDir = await temp();
		const probe: ProviderProbe = { verdict: "verified", closes: 0 };
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: provider(probe),
			spawnPromptLayer: promptLayer,
		});
		await broker.start();
		try {
			const childId = await acceptedChild(broker, "alias-key");
			// `id` is a supported alias normalized later by the generic path; if the
			// spawn fast path misses it, generic close can signal the child PID
			// without the provider's exact substrate proof.
			const closed = await broker.handleRequest("session.close", { id: childId }, undefined);
			expect(closed).toMatchObject({ ok: true, result: { code: "spawn_child_closed", sessionId: childId } });
			expect(probe.closes).toBe(1);
			const store = new SpawnAuthorityStore(agentDir, await getBrokerIdentityKey(agentDir));
			await store.open();
			expect(store.claims().find(row => row.childId === childId)?.state).toBe("closed");
		} finally {
			await broker.stop();
		}
	});

	it("retains uncertainty for a mismatched substrate identity and never closes it", async () => {
		const agentDir = await temp();
		const probe: ProviderProbe = { verdict: "verified", closes: 0 };
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: provider(probe),
			spawnPromptLayer: promptLayer,
		});
		await broker.start();
		try {
			const childId = await acceptedChild(broker, "mismatch-key");
			probe.verdict = "mismatch";
			const closed = await broker.handleRequest("session.close", { sessionId: childId }, undefined);
			expect(closed).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
			expect(probe.closes).toBe(0);
			const store = new SpawnAuthorityStore(agentDir, await getBrokerIdentityKey(agentDir));
			await store.open();
			const claim = store.claims().find(candidate => candidate.childId === childId);
			expect(store.authority(claim?.lifecycleIdentity ?? "")?.closeState).toBe("uncertain");
		} finally {
			await broker.stop();
		}
	});

	it("stores the orphan clock on master loss, clears it on recovery, and closes on expiry", async () => {
		const agentDir = await temp();
		const probe: ProviderProbe = { verdict: "verified", closes: 0 };
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: provider(probe),
			spawnPromptLayer: promptLayer,
			masterOrphanGraceMs: 3_600_000,
		});
		await broker.start();
		try {
			const childId = await acceptedChild(broker, "orphan-key");
			// The fixture master has no live effective host row, so the first pass orphans it.
			await broker.reapSpawnOrphansOnce();
			const identityKeyHex = await getBrokerIdentityKey(agentDir);
			let store = new SpawnAuthorityStore(agentDir, identityKeyHex);
			await store.open();
			let claim = store.claims().find(candidate => candidate.childId === childId);
			const identity = claim?.lifecycleIdentity ?? "";
			const orphanedAt = store.authority(identity)?.orphanedAt;
			expect(orphanedAt).toBeDefined();
			// Within grace nothing closes.
			await broker.reapSpawnOrphansOnce();
			expect(probe.closes).toBe(0);
			// Restart with a tiny grace honors the ORIGINAL orphanedAt and closes.
			await broker.stop();
			const restarted = new Broker({
				agentDir,
				masterCapabilityVerifier: verifier,
				spawnSubstrateProvider: provider(probe),
				spawnPromptLayer: promptLayer,
				masterOrphanGraceMs: 1,
			});
			await restarted.start();
			try {
				await restarted.reapSpawnOrphansOnce();
				expect(probe.closes).toBe(1);
				store = new SpawnAuthorityStore(agentDir, identityKeyHex);
				await store.open();
				claim = store.claims().find(candidate => candidate.childId === childId);
				expect(claim?.state).toBe("closed");
				const authority = store.authority(identity);
				expect(authority?.closeState).toBe("closed");
				expect(authority?.orphanedAt).toBe(orphanedAt);
			} finally {
				await restarted.stop();
			}
		} finally {
			await broker.stop();
		}
	});
});
