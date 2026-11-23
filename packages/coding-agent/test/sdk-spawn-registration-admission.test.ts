import { describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withFileLock } from "../src/config/file-lock";
import { awaitSpawnHostRegistration, Broker, type SpawnRegistrationRequest } from "../src/sdk/broker/broker";
import {
	hasSessionLifecycleStartupCommit,
	reapDeadLifecycleMarkers,
	removeSessionLifecycleStartupCommit,
	retireExitedLifecycleMarkerPair,
	writeSessionLifecycleFailure,
	writeSessionLifecycleReady,
	writeSessionLifecycleStartupCommit,
} from "../src/sdk/broker/lifecycle";
import * as incarnationModule from "../src/sdk/broker/process-incarnation";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import {
	resolveSessionLocator,
	SESSION_HEARTBEAT_INTERVAL_MS,
	SessionIndex,
	type SessionIndexEvent,
} from "../src/sdk/broker/session-index";
import type { SpawnClaimV2 } from "../src/sdk/broker/spawn-authority";
import { trackTempDirs } from "./helpers/tracked-temp-dirs";

const trackedTemp = trackTempDirs();

type RegistrationInput = Omit<SessionIndexEvent, "version" | "indexSeq" | "checksum" | "ts"> &
	Partial<Pick<SessionIndexEvent, "ts">>;

/**
 * An isolated agent root with the broker's index reader and a separate index
 * writer standing in for the child host. The host row names this test process
 * (live pid, real OS incarnation) so the projection's liveness and incarnation
 * checks run for real.
 */
async function fixture(childId: string) {
	const agentDir = await trackedTemp.mkdtemp(path.join(os.tmpdir(), "gjc-spawn-registration-"));
	const cwd = path.join(agentDir, "workspace");
	const stateRoot = path.join(cwd, ".gjc", "state");
	await fs.mkdir(stateRoot, { recursive: true });
	const incarnation = processIncarnation(process.pid);
	if (!incarnation) throw new Error("this platform cannot observe the test process incarnation");
	const owner = { pid: process.pid, incarnation };
	const effectMarker = `marker-${childId}`;
	const locator = await resolveSessionLocator(cwd, stateRoot);
	const observer = await new SessionIndex(agentDir).open();
	const host = await new SessionIndex(agentDir).open();
	const registration = (overrides: Partial<RegistrationInput> = {}): RegistrationInput => ({
		type: "host_registered",
		sessionId: childId,
		locator,
		endpointGeneration: 1,
		pid: owner.pid,
		processIncarnation: owner.incarnation,
		hostIncarnation: owner.incarnation,
		lifecycleRequestId: effectMarker,
		...overrides,
	});
	const request = (deadlineAt: number): SpawnRegistrationRequest => ({
		childId,
		cwd,
		stateRoot,
		owner,
		effectMarker,
		deadlineAt,
	});
	return { agentDir, cwd, stateRoot, owner, effectMarker, locator, observer, host, registration, request };
}

describe("awaitSpawnHostRegistration", () => {
	it("admits a timely registration whose in-budget read is evaluated after the deadline", async () => {
		const f = await fixture("child-late-evaluation");
		await f.host.append(f.registration());
		const deadlineAt = Date.now() + 1_000;
		// The read itself starts well inside the budget. A synchronous stall right
		// after it (the shape of the broker's synchronous tmux probing on macOS)
		// pushes its evaluation past the deadline.
		const refresh = f.observer.refresh.bind(f.observer);
		const spy = vi.spyOn(f.observer, "refresh").mockImplementation(async options => {
			await refresh(options);
			Bun.sleepSync(Math.max(0, deadlineAt - Date.now()) + 50);
		});
		try {
			const result = await awaitSpawnHostRegistration(f.observer, f.request(deadlineAt));
			expect(Date.now()).toBeGreaterThan(deadlineAt);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(result).toEqual({
				ok: true,
				registration: {
					sessionId: "child-late-evaluation",
					endpointGeneration: 1,
					pid: f.owner.pid,
					processIncarnation: f.owner.incarnation,
					lifecycleRequestId: f.effectMarker,
					cwd: f.locator.cwd,
					stateRoot: f.locator.stateRoot,
				},
			});
		} finally {
			spy.mockRestore();
		}
	});

	it("admits a registration the host publishes while the broker is already polling", async () => {
		const f = await fixture("child-concurrent");
		const deadlineAt = Date.now() + 5_000;
		const waiting = awaitSpawnHostRegistration(f.observer, f.request(deadlineAt));
		await Bun.sleep(150);
		await f.host.append(f.registration());
		const result = await waiting;
		expect(result).toMatchObject({ ok: true, registration: { sessionId: "child-concurrent" } });
		expect(Date.now()).toBeLessThan(deadlineAt);
	});

	it("stops waiting on a held index lock at the deadline and reports the miss as inconclusive", async () => {
		const f = await fixture("child-lock-held");
		await f.host.append(f.registration());
		const acquired = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const holder = withFileLock(path.join(f.agentDir, "sdk", "sessions", "index.jsonl"), async () => {
			acquired.resolve();
			await release.promise;
		});
		await acquired.promise;
		const releaseTimer = setTimeout(() => release.resolve(), 3_000);
		try {
			const started = Date.now();
			const deadlineAt = started + 400;
			const result = await awaitSpawnHostRegistration(f.observer, f.request(deadlineAt));
			// Without the bound, the read waits for the holder (3 s) and only then
			// reports a bare miss.
			expect(Date.now() - deadlineAt).toBeLessThan(1_000);
			expect(result).toEqual({ ok: false, reason: "inconclusive" });
		} finally {
			clearTimeout(releaseTimer);
			release.resolve();
			await holder;
		}
		// The registration was there all along: once the index is readable again
		// the same exact predicate admits it.
		const recovered = await awaitSpawnHostRegistration(f.observer, f.request(Date.now() + 2_000));
		expect(recovered).toMatchObject({ ok: true, registration: { sessionId: "child-lock-held" } });
	});

	it("keeps an earlier mismatch when the final polls cannot read the index", async () => {
		const f = await fixture("child-mismatch-then-locked");
		await f.host.append(f.registration({ lifecycleRequestId: "marker-other" }));
		const deadlineAt = Date.now() + 1_200;
		const waiting = awaitSpawnHostRegistration(f.observer, f.request(deadlineAt));
		await Bun.sleep(300);
		const acquired = Promise.withResolvers<void>();
		const holder = withFileLock(path.join(f.agentDir, "sdk", "sessions", "index.jsonl"), async () => {
			acquired.resolve();
			await Bun.sleep(Math.max(0, deadlineAt - Date.now()) + 300);
		});
		await acquired.promise;
		const result = await waiting;
		await holder;
		expect(result).toEqual({ ok: false, reason: "mismatch" });
	});

	it("reports inconclusive when an absent read is followed by polls blocked past the deadline", async () => {
		const f = await fixture("child-absent-then-locked");
		const deadlineAt = Date.now() + 1_200;
		const waiting = awaitSpawnHostRegistration(f.observer, f.request(deadlineAt));
		await Bun.sleep(300);
		const acquired = Promise.withResolvers<void>();
		const holder = withFileLock(path.join(f.agentDir, "sdk", "sessions", "index.jsonl"), async () => {
			acquired.resolve();
			await Bun.sleep(Math.max(0, deadlineAt - Date.now()) + 300);
		});
		await acquired.promise;
		const result = await waiting;
		await holder;
		// Early reads saw no row, but nothing was readable near the deadline, so
		// absence is unproven.
		expect(result).toEqual({ ok: false, reason: "inconclusive" });
	});

	it("reports absent when no row for the child was ever published", async () => {
		const f = await fixture("child-absent");
		await f.host.append({ ...f.registration(), sessionId: "unrelated-session" });
		const result = await awaitSpawnHostRegistration(f.observer, f.request(Date.now() + 300));
		expect(result).toEqual({ ok: false, reason: "absent" });
	});

	it("reports inconclusive when the deadline has already passed before any read", async () => {
		const f = await fixture("child-expired");
		await f.host.append(f.registration());
		const result = await awaitSpawnHostRegistration(f.observer, f.request(Date.now() - 1));
		expect(result).toEqual({ ok: false, reason: "inconclusive" });
	});

	for (const control of [
		{ name: "wrong lifecycle marker", overrides: { lifecycleRequestId: "marker-other" } },
		{ name: "wrong host incarnation", overrides: { hostIncarnation: "other-incarnation" } },
		{ name: "supervisor pid", overrides: { pid: process.ppid } },
		{ name: "generation 0 transcript row", overrides: { endpointGeneration: 0 } },
		{
			name: "stale registration with an early timestamp",
			overrides: { ts: Date.now() - 10 * SESSION_HEARTBEAT_INTERVAL_MS },
		},
	] as const) {
		it(`refuses a ${control.name} even though it was published before the deadline`, async () => {
			const f = await fixture(`child-${control.name.replaceAll(" ", "-")}`);
			await f.host.append(f.registration(control.overrides));
			const result = await awaitSpawnHostRegistration(f.observer, f.request(Date.now() + 300));
			expect(result).toEqual({
				ok: false,
				reason: control.overrides.endpointGeneration === 0 ? "absent" : "mismatch",
			});
		});
	}

	it("refuses a row from another workspace's state root", async () => {
		const f = await fixture("child-foreign-root");
		const foreign = path.join(f.agentDir, "foreign", ".gjc", "state");
		await fs.mkdir(foreign, { recursive: true });
		await f.host.append(f.registration({ locator: { ...f.locator, stateRoot: foreign } }));
		const result = await awaitSpawnHostRegistration(f.observer, f.request(Date.now() + 300));
		expect(result).toEqual({ ok: false, reason: "mismatch" });
	});

	for (const control of [
		{ name: "lifecycle_terminal row", overrides: { type: "lifecycle_terminal" } },
		{ name: "terminal-uncertain row", overrides: { terminalUncertain: true } },
	] as const) {
		it(`refuses a ${control.name} for the child`, async () => {
			const f = await fixture(`child-${control.name.replaceAll(" ", "-")}`);
			await f.host.append(f.registration(control.overrides));
			const result = await awaitSpawnHostRegistration(f.observer, f.request(Date.now() + 300));
			expect(result).toEqual({ ok: false, reason: "mismatch" });
		});
	}

	it("refuses an ambiguous child claimed from two state roots", async () => {
		const f = await fixture("child-two-roots");
		const other = path.join(f.agentDir, "other", ".gjc", "state");
		await fs.mkdir(other, { recursive: true });
		await f.host.append(f.registration());
		await f.host.append(f.registration({ locator: { ...f.locator, stateRoot: other } }));
		const result = await awaitSpawnHostRegistration(f.observer, f.request(Date.now() + 300));
		expect(result).toEqual({ ok: false, reason: "mismatch" });
	});

	it("refuses a dead host whose recorded incarnation still matches the owner", async () => {
		const f = await fixture("child-dead-host");
		const child = Bun.spawn(["sleep", "0.2"]);
		const incarnation = processIncarnation(child.pid);
		if (!incarnation) throw new Error("child process incarnation is unavailable");
		await child.exited;
		await f.host.append(
			f.registration({ pid: child.pid, processIncarnation: incarnation, hostIncarnation: incarnation }),
		);
		const result = await awaitSpawnHostRegistration(f.observer, {
			...f.request(Date.now() + 300),
			owner: { pid: child.pid, incarnation },
		});
		expect(result).toEqual({ ok: false, reason: "mismatch" });
	});

	it("refuses a registration the host already unregistered", async () => {
		const f = await fixture("child-unregistered");
		await f.host.append(f.registration());
		await f.host.append(f.registration({ type: "host_unregistered" }));
		const result = await awaitSpawnHostRegistration(f.observer, f.request(Date.now() + 300));
		expect(result).toEqual({ ok: false, reason: "mismatch" });
	});

	it("stops reading on an unregistered row but holds the recheck refusal until the probe decides", async () => {
		const f = await fixture("child-recheck-unregistered");
		await f.host.append(f.registration());
		await f.host.append(f.registration({ type: "host_unregistered" }));
		const observer = f.observer;
		const refresh = vi.spyOn(observer, "refresh");
		// A rolling-back host unregisters first and writes its failure receipt later.
		const startedAt = Date.now();
		const receiptAt = startedAt + 600;
		try {
			const result = await awaitSpawnHostRegistration(observer, {
				...f.request(startedAt + 5_000),
				recheck: { decided: async () => Date.now() >= receiptAt },
			});
			const elapsed = Date.now() - startedAt;
			expect(result).toEqual({ ok: false, reason: "mismatch" });
			expect(elapsed).toBeGreaterThanOrEqual(600);
			expect(elapsed).toBeLessThan(2_000);
			expect(refresh).toHaveBeenCalledTimes(1);
		} finally {
			refresh.mockRestore();
		}
	});

	it("ends a recheck on an unregistered row at the bound when the probe never decides", async () => {
		const f = await fixture("child-recheck-unregistered-undecided");
		await f.host.append(f.registration());
		await f.host.append(f.registration({ type: "host_unregistered" }));
		const startedAt = Date.now();
		const result = await awaitSpawnHostRegistration(f.observer, {
			...f.request(startedAt + 800),
			recheck: { decided: async () => false },
		});
		const elapsed = Date.now() - startedAt;
		expect(result).toEqual({ ok: false, reason: "mismatch" });
		expect(elapsed).toBeGreaterThanOrEqual(750);
		expect(elapsed).toBeLessThan(2_000);
	});

	it("keeps a recheck open when a row fails only on a transiently unreadable liveness probe", async () => {
		const f = await fixture("child-recheck-liveness-flake");
		await f.host.append(f.registration());
		// The projection reads the owner incarnation at read time; the first reads
		// cannot observe it, so the row projects as not live (a liveness-only mismatch).
		const real = incarnationModule.processIncarnation;
		let unreadable = 3;
		const spy = vi.spyOn(incarnationModule, "processIncarnation").mockImplementation((pid, options) => {
			if (pid === process.pid && unreadable > 0) {
				unreadable -= 1;
				return undefined;
			}
			return real(pid, options);
		});
		try {
			const result = await awaitSpawnHostRegistration(f.observer, {
				...f.request(Date.now() + 3_000),
				recheck: { decided: async () => false },
			});
			expect(unreadable).toBe(0);
			expect(result).toMatchObject({ ok: true, registration: { sessionId: "child-recheck-liveness-flake" } });
		} finally {
			spy.mockRestore();
		}
	});
});

describe("late spawn admission requires the host's startup commit", () => {
	const verifier = { verifyMasterCapability: async () => ({ allowed: true }) };
	/** Host behaviour before the late observation; `background` keeps running after it. */
	type HostScript = (
		input: SpawnRegistrationRequest,
		incarnation: string,
	) => Promise<{ background?: Promise<void> } | undefined>;

	/**
	 * Drives one real Broker spawn whose registration layer returns an exact match
	 * 50 ms past the semantic deadline, after `host` has acted on the child's
	 * lifecycle files. Returns the response, when the broker first dispatched or
	 * released the child, and the dispatch, close, and persisted-claim evidence
	 * after any host work `host` left running settles.
	 */
	async function lateSpawn(name: string, host: HostScript) {
		const agentDir = await trackedTemp.mkdtemp(path.join(os.tmpdir(), "gjc-spawn-commit-"));
		const incarnation = processIncarnation(process.pid);
		if (!incarnation) throw new Error("test process incarnation is unavailable");
		let closes = 0;
		let dispatches = 0;
		let deadlineAt = 0;
		let decidedAt = 0;
		let pendingHostWork: Promise<void> | undefined;
		const broker = new Broker({
			agentDir,
			masterCapabilityVerifier: verifier,
			spawnSubstrateProvider: {
				launch: async () => ({
					ok: true as const,
					proof: {
						substrateKind: "headless" as const,
						providerIdentity: `commit-${name}`,
						pid: process.pid,
						processIncarnation: incarnation,
					},
				}),
				verify: async () => "verified" as const,
				resolveLifecycleOwner: async proof => ({
					ok: true as const,
					owner: { pid: proof.pid as number, incarnation: proof.processIncarnation as string },
				}),
				close: async () => {
					closes += 1;
					decidedAt ||= Date.now();
					return { ok: true };
				},
			},
			spawnPromptLayer: {
				awaitRegistration: async (input: SpawnRegistrationRequest) => {
					deadlineAt = input.deadlineAt;
					pendingHostWork = (await host(input, incarnation))?.background;
					await Bun.sleep(Math.max(0, input.deadlineAt - Date.now()) + 50);
					return {
						ok: true as const,
						registration: {
							sessionId: input.childId,
							lifecycleRequestId: input.effectMarker,
							endpointGeneration: 1,
							pid: process.pid,
							processIncarnation: incarnation,
							cwd: input.cwd,
							stateRoot: input.stateRoot,
						},
					};
				},
				dispatch: async () => {
					dispatches += 1;
					decidedAt ||= Date.now();
					return {
						kind: "accepted" as const,
						commandId: "cmd-commit",
						turnId: "turn-commit",
						acceptedAt: Date.now(),
					};
				},
				reconcile: async () => ({ status: "unknown" as const }),
			},
		});
		await broker.start();
		try {
			const response = await broker.handleRequest(
				"session.spawn",
				{
					task: "commit-task",
					masterCapability: "commit-capability",
					ownerSessionId: "master-commit",
					attestationEpoch: "epoch-commit",
					cwd: agentDir,
				},
				`late-commit-${name}`,
			);
			await pendingHostWork;
			const lines = (await Bun.file(path.join(agentDir, "sdk", "spawn-authority.jsonl")).text())
				.split("\n")
				.filter(Boolean)
				.map(line => (JSON.parse(line) as { claim: SpawnClaimV2 }).claim);
			return { response, decidedAt, deadlineAt, dispatches, closes, claims: lines };
		} finally {
			await broker.stop();
		}
	}

	const hostFailure = (input: SpawnRegistrationRequest, incarnation: string) =>
		writeSessionLifecycleFailure(
			input.stateRoot,
			input.childId,
			input.effectMarker,
			{ phase: "startup", reason: "pending", message: "readiness cutoff" },
			{
				endpointGeneration: null,
				fenced: true,
				runtimeRemoved: true,
				hostStopped: true,
				brokerRegistrationReleased: true,
			},
			undefined,
			incarnation,
			process.pid,
		);

	it("never admits a host whose readiness stays visible through confirmation and which then loses its cutoff race", async () => {
		// The host published readiness in time, then stalled before its final
		// cutoff check. Its readiness marker is visible on every broker read until
		// well past termination start; only then does it observe the lost cutoff,
		// revoke readiness and write its failure receipt.
		let revokedAt = 0;
		const result = await lateSpawn("cutoff-lost", async (input, incarnation) => {
			let revoke: (() => Promise<boolean>) | undefined;
			await writeSessionLifecycleReady(
				input.stateRoot,
				input.childId,
				input.effectMarker,
				() => true,
				captured => {
					revoke = captured;
				},
			);
			return {
				background: (async () => {
					await Bun.sleep(Math.max(0, input.deadlineAt - Date.now()) + 2_500);
					revokedAt = Date.now();
					expect(await revoke?.()).toBe(true);
					await hostFailure(input, incarnation);
				})(),
			};
		});
		expect(result.decidedAt).toBeGreaterThan(result.deadlineAt);
		// The broker decided (dispatch or release) while readiness was still visible.
		expect(result.decidedAt).toBeLessThan(revokedAt);
		expect(result.response).toMatchObject({
			ok: false,
			error: { code: "spawn_failed", details: { code: "child_registration_timeout" } },
		});
		expect(result.dispatches).toBe(0);
		expect(result.closes).toBe(1);
		expect(result.claims.some(claim => claim.authorityRef !== undefined || claim.state === "authority_active")).toBe(
			false,
		);
		expect(result.claims.some(claim => claim.seed !== undefined)).toBe(false);
		expect(result.claims.at(-1)?.state).toBe("pre_send_rejected");
		expect(result.claims.at(-1)?.failure?.message).toContain("did not confirm readiness");
	}, 30_000);

	const publishReadiness = (input: SpawnRegistrationRequest) =>
		writeSessionLifecycleReady(input.stateRoot, input.childId, input.effectMarker);
	const writeForeignCommit = (input: SpawnRegistrationRequest, record: Record<string, unknown>) =>
		Bun.write(path.join(input.stateRoot, "sdk", `${input.childId}.lifecycle.committed`), JSON.stringify(record));
	const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

	const admitted = [
		{
			name: "a host that committed startup before the deadline",
			host: async (input: SpawnRegistrationRequest) => {
				await publishReadiness(input);
				await writeSessionLifecycleStartupCommit(input.stateRoot, input.childId, input.effectMarker);
				return undefined;
			},
		},
		{
			name: "a host whose commit record lands after the deadline, before termination start",
			host: async (input: SpawnRegistrationRequest) => {
				await publishReadiness(input);
				return {
					background: (async () => {
						await Bun.sleep(Math.max(0, input.deadlineAt - Date.now()) + 300);
						await writeSessionLifecycleStartupCommit(input.stateRoot, input.childId, input.effectMarker);
					})(),
				};
			},
		},
	] as const;
	for (const scenario of admitted) {
		it(`admits ${scenario.name}`, async () => {
			const result = await lateSpawn(scenario.name.replaceAll(" ", "-"), scenario.host);
			expect(result.decidedAt).toBeGreaterThan(result.deadlineAt);
			expect(result.response).toMatchObject({ ok: true });
			expect(result.dispatches).toBe(1);
			expect(result.closes).toBe(0);
			expect(result.claims.at(-1)?.state).toBe("accepted");
			expect(result.claims.some(claim => claim.authorityRef !== undefined)).toBe(true);
		}, 30_000);
	}

	const refused = [
		{
			name: "readiness without a commit (a host that stopped before committing, or predates the commit)",
			code: "child_registration_timeout",
			host: async (input: SpawnRegistrationRequest) => {
				await publishReadiness(input);
				return undefined;
			},
		},
		{
			name: "a commit without readiness (readiness already revoked)",
			code: "child_registration_timeout",
			host: async (input: SpawnRegistrationRequest) => {
				await writeSessionLifecycleStartupCommit(input.stateRoot, input.childId, input.effectMarker);
				return undefined;
			},
		},
		{
			name: "a commit followed by a failure receipt",
			code: "child_registration_failed",
			host: async (input: SpawnRegistrationRequest, incarnation: string) => {
				await publishReadiness(input);
				await writeSessionLifecycleStartupCommit(input.stateRoot, input.childId, input.effectMarker);
				await hostFailure(input, incarnation);
				return undefined;
			},
		},
		{
			name: "a commit while a failure receipt is present but unreadable",
			code: "child_registration_timeout",
			host: async (input: SpawnRegistrationRequest) => {
				await publishReadiness(input);
				await writeSessionLifecycleStartupCommit(input.stateRoot, input.childId, input.effectMarker);
				await Bun.write(
					path.join(input.stateRoot, "sdk", `${input.childId}.lifecycle.failure.${input.effectMarker}.json`),
					"{not json",
				);
				return undefined;
			},
		},
		{
			name: "a commit while a failure receipt is still being promoted",
			code: "child_registration_timeout",
			host: async (input: SpawnRegistrationRequest) => {
				await publishReadiness(input);
				await writeSessionLifecycleStartupCommit(input.stateRoot, input.childId, input.effectMarker);
				await Bun.write(
					path.join(
						input.stateRoot,
						"sdk",
						`${input.childId}.lifecycle.failure.${input.effectMarker}.json.promoting`,
					),
					"",
				);
				return undefined;
			},
		},
		{
			name: "a commit from another incarnation of the owner pid",
			code: "child_registration_timeout",
			host: async (input: SpawnRegistrationRequest) => {
				await publishReadiness(input);
				await writeForeignCommit(input, {
					pid: process.pid,
					incarnation: "earlier-incarnation",
					effectMarkerSha256: sha256(input.effectMarker),
				});
				return undefined;
			},
		},
		{
			name: "a commit for another launch of the same child id",
			code: "child_registration_timeout",
			host: async (input: SpawnRegistrationRequest) => {
				await publishReadiness(input);
				await writeSessionLifecycleStartupCommit(input.stateRoot, input.childId, "earlier-launch-marker");
				return undefined;
			},
		},
	] as const;
	for (const scenario of refused) {
		it(`refuses ${scenario.name}`, async () => {
			const result = await lateSpawn(scenario.name.replaceAll(/[^A-Za-z0-9]+/g, "-"), scenario.host);
			expect(result.response).toMatchObject({
				ok: false,
				error: { code: "spawn_failed", details: { code: scenario.code } },
			});
			expect(result.dispatches).toBe(0);
			expect(result.closes).toBe(1);
			expect(
				result.claims.some(claim => claim.authorityRef !== undefined || claim.state === "authority_active"),
			).toBe(false);
			expect(result.claims.at(-1)?.state).toBe("pre_send_rejected");
		}, 30_000);
	}
});

describe("lifecycle startup commit record", () => {
	async function root() {
		const dir = await trackedTemp.mkdtemp(path.join(os.tmpdir(), "gjc-startup-commit-"));
		await fs.mkdir(path.join(dir, "sdk"), { recursive: true, mode: 0o700 });
		return dir;
	}
	const ownIncarnation = () => {
		const incarnation = processIncarnation(process.pid);
		if (!incarnation) throw new Error("test process incarnation is unavailable");
		return incarnation;
	};
	const commitPath = (dir: string, id: string) => path.join(dir, "sdk", `${id}.lifecycle.committed`);

	it("names exactly the committing owner and never stores the lifecycle marker", async () => {
		const dir = await root();
		const id = "11111111-1111-4111-8111-111111111111";
		const effectMarker = "commit-marker-a";
		const owner = { pid: process.pid, incarnation: ownIncarnation(), effectMarker };
		await writeSessionLifecycleStartupCommit(dir, id, effectMarker);
		const bytes = await Bun.file(commitPath(dir, id)).text();
		expect(bytes).not.toContain(effectMarker);
		expect((await fs.stat(commitPath(dir, id))).mode & 0o777).toBe(0o600);
		// Endpoint scanners read every `*.json` in this directory.
		expect((await fs.readdir(path.join(dir, "sdk"))).filter(name => name.endsWith(".json"))).toEqual([]);
		expect(hasSessionLifecycleStartupCommit(dir, id, owner)).toBe(true);
		for (const other of [
			{ ...owner, pid: process.pid + 1 },
			{ ...owner, incarnation: "other-incarnation" },
			{ ...owner, effectMarker: "commit-marker-b" },
		])
			expect(hasSessionLifecycleStartupCommit(dir, id, other)).toBe(false);
		expect(hasSessionLifecycleStartupCommit(dir, "22222222-2222-4222-8222-222222222222", owner)).toBe(false);
	});

	it("does not follow a symlink or accept a hard-linked record", async () => {
		const dir = await root();
		const id = "33333333-3333-4333-8333-333333333333";
		const effectMarker = "commit-marker-link";
		const owner = { pid: process.pid, incarnation: ownIncarnation(), effectMarker };
		const elsewhere = await root();
		await writeSessionLifecycleStartupCommit(elsewhere, id, effectMarker);
		await fs.symlink(commitPath(elsewhere, id), commitPath(dir, id));
		expect(hasSessionLifecycleStartupCommit(dir, id, owner)).toBe(false);
		await fs.rm(commitPath(dir, id));
		await fs.link(commitPath(elsewhere, id), commitPath(dir, id));
		expect(hasSessionLifecycleStartupCommit(dir, id, owner)).toBe(false);
	});

	it("is withdrawn only by its own host", async () => {
		const dir = await root();
		const id = "44444444-4444-4444-8444-444444444444";
		await writeSessionLifecycleStartupCommit(dir, id, "commit-marker-own");
		// Another launch's host leaves this record alone.
		expect(removeSessionLifecycleStartupCommit(dir, id, "commit-marker-other")).toBe(true);
		expect(await Bun.file(commitPath(dir, id)).exists()).toBe(true);
		expect(removeSessionLifecycleStartupCommit(dir, id, "commit-marker-own")).toBe(true);
		expect(await Bun.file(commitPath(dir, id)).exists()).toBe(false);
		expect(removeSessionLifecycleStartupCommit(dir, id, "commit-marker-own")).toBe(true);
	});

	it("is retired with the marker pair of an exited owner, and a foreign record is left alone", async () => {
		const child = Bun.spawn(["sleep", "0.1"]);
		const incarnation = processIncarnation(child.pid);
		if (!incarnation) throw new Error("child process incarnation is unavailable");
		await child.exited;
		for (const foreign of [false, true]) {
			const dir = await root();
			const id = foreign ? "55555555-5555-4555-8555-555555555555" : "66666666-6666-4666-8666-666666666666";
			const effectMarker = `exited-owner-${foreign}`;
			await Bun.write(
				path.join(dir, "sdk", `${id}.lifecycle.json`),
				JSON.stringify({ pid: child.pid, effectMarker, incarnation }),
			);
			await Bun.write(
				commitPath(dir, id),
				JSON.stringify({
					pid: child.pid,
					incarnation: foreign ? "another-owner" : incarnation,
					effectMarkerSha256: createHash("sha256").update(effectMarker).digest("hex"),
				}),
			);
			expect(await retireExitedLifecycleMarkerPair(dir, id)).toBe(true);
			expect(await Bun.file(path.join(dir, "sdk", `${id}.lifecycle.json`)).exists()).toBe(false);
			expect(await Bun.file(commitPath(dir, id)).exists()).toBe(foreign);
		}
	});

	it("is reaped by the dead-marker sweep together with an expired exited owner's marker", async () => {
		const child = Bun.spawn(["sleep", "0.1"]);
		const incarnation = processIncarnation(child.pid);
		if (!incarnation) throw new Error("child process incarnation is unavailable");
		await child.exited;
		const dir = await root();
		const id = "77777777-7777-4777-8777-777777777777";
		const effectMarker = "swept-owner";
		const markerPath = path.join(dir, "sdk", `${id}.lifecycle.json`);
		await Bun.write(markerPath, JSON.stringify({ pid: child.pid, effectMarker, incarnation }));
		await Bun.write(
			commitPath(dir, id),
			JSON.stringify({
				pid: child.pid,
				incarnation,
				effectMarkerSha256: createHash("sha256").update(effectMarker).digest("hex"),
			}),
		);
		const expired = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await fs.utimes(markerPath, expired, expired);
		expect(await reapDeadLifecycleMarkers(dir)).toBe(1);
		expect(await Bun.file(markerPath).exists()).toBe(false);
		expect(await Bun.file(commitPath(dir, id)).exists()).toBe(false);
	});
});
