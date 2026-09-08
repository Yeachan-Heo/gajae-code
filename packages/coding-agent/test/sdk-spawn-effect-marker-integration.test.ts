import { expect, test, vi } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Process } from "@gajae-code/natives";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { executeTmuxOwnerIsolationPlanSync, lifecyclePaths } from "../src/gjc-runtime/tmux-owner-isolation";
import {
	__setCreateOwnerIsolationForTests,
	createManagedGjcTmuxSession,
	type ManagedTmuxLaunchProof,
} from "../src/gjc-runtime/tmux-sessions";
import { Broker, type SpawnPromptLayer } from "../src/sdk/broker/broker";
import { getBrokerIdentityKey } from "../src/sdk/broker/identity";
import { setLifecycleCommandResolverForTest, writeSessionLifecycleFailure } from "../src/sdk/broker/lifecycle";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import { SpawnAuthorityStore, type SpawnSubstrateProof } from "../src/sdk/broker/spawn-authority";
import { createSpawnSubstrateProvider } from "../src/sdk/broker/spawn-substrate";

const ownerId = "marker-test-owner";
const epoch = "marker-test-epoch";
const task = "private marker test task";

async function attest(broker: Broker, cwd: string): Promise<void> {
	const incarnation = processIncarnation(process.pid);
	if (!incarnation) throw new Error("Test owner has no process incarnation");
	for (const endpointGeneration of [0, 1]) {
		await broker.index.append({
			type: "host_registered",
			sessionId: ownerId,
			locator: { cwd, worktreeRoot: null, stateRoot: path.join(cwd, ".gjc", "state") },
			endpointGeneration,
			pid: process.pid,
			hostIncarnation: incarnation,
			masterRole: {
				version: 2,
				ownerSessionId: ownerId,
				launchPid: process.pid,
				launchProcessIncarnation: incarnation,
				role: "master",
				attestationEpoch: epoch,
			},
		});
	}
}

async function spawn(broker: Broker, cwd: string) {
	return broker.handleRequest(
		"session.spawn",
		{
			cwd,
			task,
			ownerSessionId: ownerId,
			masterCapability: "fixture-grant",
			attestationEpoch: epoch,
		},
		"marker-test-key",
	);
}

const verifier = { verifyMasterCapability: async () => ({ allowed: true }) };
const proof: SpawnSubstrateProof = {
	substrateKind: "headless",
	providerIdentity: "marker-fixture",
	pid: 4321,
	processIncarnation: "inc-4321",
};

for (const scenario of [
	"missing_pid",
	"missing_incarnation",
	"write_failure",
	"startup_failure",
	"stale_failure",
] as const) {
	test(`spawn effect marker: ${scenario}`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-spawn-marker-"));
		let childId = "";
		let effectMarker = "";
		let closes = 0;
		let registrations = 0;
		const stateRoot = path.join(root, ".gjc", "state");
		const markerPath = () => path.join(stateRoot, "sdk", `${childId}.lifecycle.json`);
		const launchedProof = { ...proof };
		if (scenario === "missing_pid") delete launchedProof.pid;
		if (scenario === "missing_incarnation") delete launchedProof.processIncarnation;
		const layer: SpawnPromptLayer = {
			awaitRegistration: async () => {
				registrations += 1;
				expect(await Bun.file(markerPath()).json()).toEqual({ pid: 4321, incarnation: "inc-4321", effectMarker });
				await writeSessionLifecycleFailure(
					stateRoot,
					childId,
					effectMarker,
					{ phase: "startup", reason: "failed", message: task },
					{
						endpointGeneration: null,
						fenced: true,
						runtimeRemoved: true,
						hostStopped: true,
						brokerRegistrationReleased: true,
					},
					undefined,
					scenario === "stale_failure" ? "stale-incarnation" : "inc-4321",
					4321,
				);
				return { ok: false };
			},
			dispatch: async () => {
				throw new Error("Seed must not be sent");
			},
			reconcile: async () => ({ status: "unknown" }),
		};
		const broker = new Broker({
			agentDir: path.join(root, "agent"),
			masterCapabilityVerifier: verifier,
			spawnPromptLayer: layer,
			spawnSubstrateProvider: {
				launch: async spec => {
					childId = spec.childSessionId;
					effectMarker = spec.env?.GJC_LIFECYCLE_REQUEST_ID ?? "";
					if (scenario === "write_failure") await fs.mkdir(markerPath(), { recursive: true });
					return { ok: true, proof: launchedProof };
				},
				verify: async () => "verified",
				resolveLifecycleOwner: async () => ({ ok: true, owner: { pid: 4321, incarnation: "inc-4321" } }),
				close: async () => {
					closes += 1;
					return { ok: true };
				},
			},
		});
		await broker.start();
		try {
			await attest(broker, root);
			const response = await spawn(broker, root);
			expect(response.ok).toBe(false);
			expect(closes).toBe(1);
			const store = new SpawnAuthorityStore(
				broker.settings.agentDir,
				await getBrokerIdentityKey(broker.settings.agentDir),
			);
			await store.open();
			if (scenario === "missing_pid" || scenario === "missing_incarnation") {
				expect(response).toMatchObject({
					ok: false,
					error: { code: "spawn_failed", details: { code: "substrate_proof_failed" } },
				});
				expect(store.claims()[0]?.state).toBe("pre_send_rejected");
				expect(await Bun.file(markerPath()).exists()).toBe(false);
				expect(registrations).toBe(0);
			} else {
				expect(response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
				expect(JSON.stringify(response)).not.toContain(task);
				if (scenario === "write_failure") expect(registrations).toBe(0);
				else {
					expect(store.claims()[0]?.state).toBe("uncertain");
					expect(JSON.stringify(response).includes("startup/failed")).toBe(scenario === "startup_failure");
				}
			}
		} finally {
			await broker.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
}

const sourceCli = path.resolve(import.meta.dir, "../src/cli.ts");
const compiledCli = path.resolve(import.meta.dir, "../dist/gjc");
const compiledAvailable = await Bun.file(compiledCli).exists();

async function readPublishedLifecycleReady(
	read: () => Promise<unknown>,
	deadlineAt: number,
	now: () => number = Date.now,
	sleep: (milliseconds: number) => Promise<void> = Bun.sleep,
): Promise<unknown> {
	if (!Number.isSafeInteger(deadlineAt)) throw new Error("Missing semantic ready deadline");
	while (now() < deadlineAt) {
		try {
			const ready = await read();
			if (now() >= deadlineAt) break;
			return ready;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
		}
		await sleep(Math.min(25, Math.max(0, deadlineAt - now())));
	}
	throw new Error("Lifecycle ready publication exceeded original semantic ready deadline");
}

test("ready publication waits past registration without extending its original deadline", async () => {
	let now = 100;
	let reads = 0;
	const ready = { pid: 42, incarnation: "synthetic", effectMarker: "synthetic" };
	expect(
		await readPublishedLifecycleReady(
			async () => {
				if (++reads === 1) throw Object.assign(new Error("not published"), { code: "ENOENT" });
				return ready;
			},
			150,
			() => now,
			async ms => {
				now += ms;
			},
		),
	).toEqual(ready);
	expect(reads).toBe(2);
	await expect(
		readPublishedLifecycleReady(
			async () => {
				throw Object.assign(new Error("not published"), { code: "ENOENT" });
			},
			150,
			() => now,
			async ms => {
				now += ms;
			},
		),
	).rejects.toThrow("original semantic ready deadline");
	expect(now).toBe(150);
});

test("ready publication does not retry unreadable or malformed evidence", async () => {
	for (const error of [Object.assign(new Error("denied"), { code: "EACCES" }), new SyntaxError("invalid JSON")]) {
		let reads = 0;
		await expect(
			readPublishedLifecycleReady(
				async () => {
					reads += 1;
					throw error;
				},
				150,
				() => 100,
			),
		).rejects.toBe(error);
		expect(reads).toBe(1);
	}
});

// A real Linux service cgroup needs the existing user bus to establish its
// isolated owner scope. Do not inherit unrelated host configuration or state.
const linuxUserBusEnvironment: NodeJS.ProcessEnv = {};
if (process.platform === "linux") {
	for (const name of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const) {
		const value = process.env[name];
		if (value !== undefined) linuxUserBusEnvironment[name] = value;
	}
}

function captureScopedBootstrap(
	launch: () => ManagedTmuxLaunchProof,
	environment: NodeJS.ProcessEnv,
	diagnostics: string[],
): ManagedTmuxLaunchProof {
	__setCreateOwnerIsolationForTests({
		execute: (plan, dependencies) =>
			executeTmuxOwnerIsolationPlanSync(plan, {
				...dependencies,
				spawn: (argv, stdinLine) => {
					const result = dependencies.spawn(argv, stdinLine);
					if (plan.ok && plan.execution.mode === "scoped" && diagnostics.length < 2) {
						const secrets = [plan.execution.attempt.token, ...Object.values(environment)].filter(
							(value): value is string => typeof value === "string" && value.length > 0,
						);
						const redact = (text: string) => {
							for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
							return text.slice(0, 4096);
						};
						diagnostics.push(
							JSON.stringify({
								exitCode: result.exitCode,
								stdout: redact(result.stdout ?? ""),
								stderr: redact(result.stderr ?? ""),
							}),
						);
					}
					return result;
				},
			}),
	});
	try {
		return launch();
	} finally {
		__setCreateOwnerIsolationForTests(null);
	}
}

test("managed wrong outer cannot register a valid inner CLI or substitute headless", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-wrong-outer-"));
	const env = {
		...linuxUserBusEnvironment,
		PATH: process.env.PATH ?? "",
		LANG: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
		HOME: root,
		TMPDIR: root,
		TMUX_TMPDIR: root,
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
	};
	let launched: SpawnSubstrateProof | undefined;
	const retained: { process: Process | null } = { process: null };
	let allocations = 0;
	let validInnerObserved = false;
	let headlessAttempts = 0;
	let passed = false;
	let cleanupProven = false;
	const bootstrapDiagnostics: string[] = [];
	const provider = createSpawnSubstrateProvider({
		env,
		selectMultiplexer: () => "tmux",
		startHeadless: () => {
			headlessAttempts += 1;
			throw new Error("Forbidden headless fallback");
		},
		launchManaged: (spec, environment, platform) => {
			allocations += 1;
			expect(spec.argv).toEqual([process.execPath, "run", sourceCli, "sdk", "session-host-internal"]);
			validInnerObserved = true;
			// A genuine allocated tmux pane, but deliberately not a GJC supervisor.
			// Its bounded natural exit is containment, never readiness success.
			return captureScopedBootstrap(
				() =>
					createManagedGjcTmuxSession(spec, environment, {
						platform,
						supervisorArgvForTest: ["/bin/sleep", "5"],
					}),
				environment,
				bootstrapDiagnostics,
			);
		},
	});
	const broker = new Broker({
		agentDir: path.join(root, "agent"),
		masterCapabilityVerifier: verifier,
		spawnSubstrateProvider: {
			...provider,
			launch: async spec => {
				const result = await provider.launch({ ...spec, inheritedEnv: env });
				if (result.ok) {
					launched = result.proof;
					retained.process = nativeProcessBindings().Process.fromPid(result.proof.pid!);
				}
				return result;
			},
			resolveLifecycleOwner: (proof, deadline) =>
				provider.resolveLifecycleOwner(proof, Math.min(deadline, Date.now() + 1_000)),
		},
	});
	setLifecycleCommandResolverForTest(broker, () => ({
		file: process.execPath,
		args: ["run", sourceCli, "sdk", "session-host-internal"],
	}));
	try {
		await broker.start();
		await attest(broker, root);
		const response = await spawn(broker, root);
		expect(response.ok).toBe(false);
		expect(allocations).toBe(1);
		expect(validInnerObserved).toBe(true);
		expect(headlessAttempts).toBe(0);
		expect(broker.index.listSessionIdentities().filter(row => row.sessionId !== ownerId)).toHaveLength(0);
		const ledger = await Bun.file(path.join(broker.settings.agentDir, "sdk", "spawn-authority.jsonl")).text();
		for (const state of ["authority_active", "seed_prepared", "dispatching", "accepted"])
			expect(ledger).not.toContain(`"${state}"`);
		if (!launched) throw new Error(`Wrong-outer allocation proof was not captured; retained ${root}`);
		if (launched) {
			expect(launched.substrateKind).toBe("tmux");
			expect(response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
			if (!retained.process) throw new Error(`Missing exact wrong-outer reference; retained ${root}`);
			expect(await retained.process.waitForExit({ timeoutMs: 5_000 })).toBe(true);
			expect(await provider.verify(launched)).toBe("gone");
		}
		// This fixture owns an isolated socket namespace. Observe absence only;
		// never kill a whole server or guess which allocated pane to remove.
		const listing = Bun.spawn(["tmux", "list-sessions", "-F", "#{session_id}"], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(listing.stdout).text(),
			new Response(listing.stderr).text(),
		]);
		const exit = await listing.exited;
		expect(stdout.trim()).toBe("");
		expect(exit).not.toBe(0);
		expect(stderr).toMatch(/no server running|failed to connect|error connecting/);
		cleanupProven = true;
		passed = true;
	} catch (error) {
		process.stderr.write(`${JSON.stringify({ fixture: "wrong-outer", scopedBootstrap: bootstrapDiagnostics })}\n`);
		throw new AggregateError(
			[error],
			`Wrong-outer fixture failed; scoped bootstrap: ${bootstrapDiagnostics.join("; ")}`,
		);
	} finally {
		await broker.stop();
		setLifecycleCommandResolverForTest(broker, undefined);
		if (passed && cleanupProven) await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

async function assertOpaqueSinks(
	root: string,
	alias: string,
	probes: readonly string[],
	observations: readonly string[],
) {
	let files = 0;
	async function scan(directory: string): Promise<void> {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			if (file === alias) continue;
			if (entry.isSymbolicLink()) throw new Error(`Unscanned product sink symlink: ${file}`);
			if (entry.isDirectory()) await scan(file);
			else if (entry.isFile()) {
				files += 1;
				const content = await Bun.file(file).text();
				for (const probe of probes) expect(content, `opaque sink ${file}`).not.toContain(probe);
			}
		}
	}
	await scan(root);
	expect(files).toBeGreaterThan(0);
	for (const observation of observations) {
		for (const probe of probes) expect(observation).not.toContain(probe);
	}
}

async function captureManagedDiagnostics(proof: SpawnSubstrateProof, env: NodeJS.ProcessEnv): Promise<string> {
	if (!proof.nativeSessionId) throw new Error("Cannot capture diagnostics without exact session");
	const capture = Bun.spawn(["tmux", "capture-pane", "-p", "-S", "-", "-t", proof.nativeSessionId], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(capture.stdout).text(),
		new Response(capture.stderr).text(),
	]);
	expect(await capture.exited).toBe(0);
	return stdout + stderr;
}

for (const lane of ["headless", "managed-source", "managed-compiled", "managed-early-failure"] as const) {
	test.skipIf(lane === "managed-compiled" && !compiledAvailable)(
		`real session.spawn ${lane}: ${lane === "managed-early-failure" ? "injected refusal after observed owner resolution" : "registers before seed delivery"} (compiled lane requires build)`,
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-spawn-real-marker-"));
			const managed = lane !== "headless";
			const compiled = lane === "managed-compiled";
			const earlyFailure = lane === "managed-early-failure";
			const canary = `OPAQUE-COMMAND-CANARY-${randomUUID()}`;
			const alias = path.join(root, canary);
			const executable = compiled ? compiledCli : process.execPath;
			await fs.symlink(executable, alias);
			expect(await fs.realpath(alias)).toBe(await fs.realpath(executable));
			expect(
				createHash("sha256")
					.update(Buffer.from(await Bun.file(alias).arrayBuffer()))
					.digest("hex"),
			).toBe(
				createHash("sha256")
					.update(Buffer.from(await Bun.file(executable).arrayBuffer()))
					.digest("hex"),
			);
			let commandProbes: string[] = [];
			const observations: string[] = [];
			let launchedChildId = "";
			let injectedAfterResolution = false;
			const ownerResolutionFailure: { error?: unknown } = {};
			const fixtureFailure: { error?: unknown } = {};
			const cleanupFailure: { error?: unknown } = {};
			const bootstrapDiagnostics: string[] = [];
			const launchEnvironment = {
				...linuxUserBusEnvironment,
				PATH: process.env.PATH ?? "",
				LANG: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
				HOME: root,
				TMPDIR: root,
				TMUX_TMPDIR: root,
				// Source-mode transpiler cache is a Bun harness artifact, not a product
				// sink. Its transient staging files race the complete product-sink scan.
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
			};
			const supervisorArgv = compiled
				? [compiledCli, "--internal-managed-owner-supervisor"]
				: [process.execPath, "run", sourceCli, "--internal-managed-owner-supervisor"];
			const provider = createSpawnSubstrateProvider({
				env: launchEnvironment,
				...(managed
					? {
							startHeadless: () => {
								throw new Error("Managed fixture forbids headless substitution");
							},
						}
					: {}),
				selectMultiplexer: () => (managed ? "tmux" : "none"),
				launchManaged: (spec, env, platform) =>
					captureScopedBootstrap(
						() =>
							createManagedGjcTmuxSession(spec, env, {
								platform,
								supervisorArgvForTest: supervisorArgv,
							}),
						env,
						bootstrapDiagnostics,
					),
			});
			let launchedProof: SpawnSubstrateProof | undefined;
			let semanticReadyDeadlineAt = Number.NaN;
			const retainedProcesses: Process[] = [];
			// Stop at the durable registration boundary, before Q26 turn admission. The
			// master-mode test covers seed acceptance with its injected prompt layer.
			const registered = Promise.withResolvers<string>();
			const release = Promise.withResolvers<void>();
			const persistTransition = SpawnAuthorityStore.prototype.persistTransition;
			const transition = vi
				.spyOn(SpawnAuthorityStore.prototype, "persistTransition")
				.mockImplementation(async function (this: SpawnAuthorityStore, identity, input) {
					const result = await persistTransition.call(this, identity, input);
					if (input.to === "authority_active") {
						registered.resolve(result.claim.childId!);
						await release.promise;
						throw new Error("Fixture stopped after proving real child registration");
					}
					return result;
				});
			const broker = new Broker({
				agentDir: path.join(root, "agent"),
				masterCapabilityVerifier: verifier,
				spawnSubstrateProvider: {
					...provider,
					launch: async spec => {
						launchedChildId = spec.childSessionId;
						semanticReadyDeadlineAt = JSON.parse(spec.env!.GJC_SDK_LIFECYCLE_REQUEST!).semanticReadyDeadlineAt;
						const serialized = JSON.stringify(spec.argv);
						commandProbes = [canary, serialized, createHash("sha256").update(serialized).digest("hex")];
						const result = await provider.launch({
							...spec,
							inheritedEnv: launchEnvironment,
						});
						if (result.ok) launchedProof = result.proof;
						return result;
					},
					resolveLifecycleOwner: async (proof, deadlineAt) => {
						const result = await provider.resolveLifecycleOwner(proof, deadlineAt);
						if (earlyFailure && result.ok) {
							try {
								for (const pid of [proof.pid!, result.owner.pid]) {
									const reference = nativeProcessBindings().Process.fromPid(pid);
									if (!reference) throw new Error("Early failure lacks retained process evidence");
									retainedProcesses.push(reference);
									const observedArgv = reference.args();
									expect(observedArgv).toContain(sourceCli);
									expect(observedArgv).toContain(
										pid === proof.pid ? "--internal-managed-owner-supervisor" : "session-host-internal",
									);
								}
								observations.push(await captureManagedDiagnostics(proof, launchEnvironment));
								await assertOpaqueSinks(root, alias, commandProbes, observations);
								injectedAfterResolution = true;
								return { ok: false, code: "owner_proof_failed" };
							} catch (error) {
								// Broker deliberately redacts provider errors. Retain this synthetic
								// fixture failure locally so the test reports it after its finally cleanup.
								ownerResolutionFailure.error = error;
								throw error;
							}
						}
						return result;
					},
				},
			});
			setLifecycleCommandResolverForTest(broker, () => ({
				file: alias,
				args: compiled ? ["sdk", "session-host-internal"] : ["run", sourceCli, "sdk", "session-host-internal"],
			}));
			let spawning: Promise<unknown> | undefined;
			let passed = false;
			try {
				await broker.start();
				await attest(broker, root);
				if (earlyFailure) {
					const response = await spawn(broker, root);
					observations.push(JSON.stringify(response));
					if ("error" in ownerResolutionFailure) throw ownerResolutionFailure.error;
					expect(response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
					expect(launchedProof?.substrateKind).toBe("tmux");
					expect(retainedProcesses).toHaveLength(2);
					expect(injectedAfterResolution).toBe(true);
					expect(
						await Bun.file(path.join(root, ".gjc", "state", "sdk", `${launchedChildId}.lifecycle.json`)).exists(),
					).toBe(false);
					expect(
						await Bun.file(
							path.join(root, ".gjc", "state", "sdk", `${launchedChildId}.lifecycle.ready.json`),
						).exists(),
					).toBe(false);
					const ledger = await Bun.file(
						path.join(broker.settings.agentDir, "sdk", "spawn-authority.jsonl"),
					).text();
					for (const state of ["authority_active", "seed_prepared", "dispatching", "accepted"])
						expect(ledger).not.toContain(`"${state}"`);
					expect(broker.index.listSessionIdentities().filter(row => row.sessionId !== ownerId)).toHaveLength(0);
				} else {
					spawning = spawn(broker, root).then(response => {
						observations.push(JSON.stringify(response));
						registered.reject(
							new Error(`Spawn ended before registration; fixture ${root}: ${JSON.stringify(response)}`),
						);
					});
					const childId = await registered.promise;
					expect(launchedProof?.substrateKind).toBe(managed ? "tmux" : "headless");
					const rows = await broker.handleRequest("session.list", { resolveSessionId: childId });
					observations.push(JSON.stringify(rows));
					expect(rows).toMatchObject({ ok: true, result: { sessions: [{ sessionId: childId, live: true }] } });
					if (!rows.ok) throw new Error(rows.error.message);
					expect(
						(rows.result as { sessions: Array<{ endpointGeneration: number }> }).sessions[0]!.endpointGeneration,
					).toBeGreaterThan(0);
					const endpoint = broker.index
						.listSessionIdentities()
						.find(row => row.sessionId === childId && row.endpointGeneration > 0);
					if (!endpoint) throw new Error("Registered host identity is absent");
					for (const pid of new Set([endpoint.pid, launchedProof?.pid])) {
						if (pid === undefined) throw new Error("Registered child lacks substrate PID");
						const reference = nativeProcessBindings().Process.fromPid(pid);
						if (!reference) throw new Error("Registered child lacks a retained process reference");
						retainedProcesses.push(reference);
					}
					const marker = await Bun.file(
						path.join(root, ".gjc", "state", "sdk", `${childId}.lifecycle.json`),
					).json();
					expect(marker).toMatchObject({
						pid: endpoint.pid,
						incarnation: endpoint.hostIncarnation ?? endpoint.processIncarnation,
						effectMarker: endpoint.lifecycleRequestId,
					});
					const ready = await readPublishedLifecycleReady(
						() => Bun.file(path.join(root, ".gjc", "state", "sdk", `${childId}.lifecycle.ready.json`)).json(),
						semanticReadyDeadlineAt,
					);
					expect(ready).toMatchObject(marker);
					if (!managed) expect(marker.pid).toBe(launchedProof?.pid);
					const ledger = await Bun.file(
						path.join(broker.settings.agentDir, "sdk", "spawn-authority.jsonl"),
					).text();
					expect(ledger).toContain('"authority_active"');
					expect(ledger).not.toContain('"dispatching"');
					const store = new SpawnAuthorityStore(
						broker.settings.agentDir,
						await getBrokerIdentityKey(broker.settings.agentDir),
					);
					await store.open();
					expect(store.claims().find(claim => claim.childId === childId)?.state).toBe("authority_active");
					expect(ledger).not.toContain(task);
					if (managed) {
						const stateFile = launchedProof?.stateFileProof?.sessionStateFile;
						const generation = launchedProof?.stateFileProof?.ownerGeneration;
						if (typeof stateFile !== "string" || typeof generation !== "string" || !launchedProof?.pid)
							throw new Error("Managed child lacks exact substrate authority");
						const ownerRoot = lifecyclePaths(path.dirname(stateFile), childId, generation).root;
						const names = await fs.readdir(ownerRoot);
						const bindingNames = names.filter(
							name => name.startsWith("child-") && name.endsWith(".binding.json"),
						);
						expect(bindingNames).toHaveLength(1);
						const binding = await Bun.file(path.join(ownerRoot, bindingNames[0]!)).json();
						expect(binding).toMatchObject({
							binding_kind: "opaque",
							supervisor_pid: launchedProof.pid,
							session_id: childId,
						});
						expect(binding).not.toHaveProperty("command");
						expect(binding).not.toHaveProperty("command_sha256");
						expect(endpoint.pid).not.toBe(launchedProof.pid);
						for (const [pid, entry] of [
							[launchedProof.pid, "--internal-managed-owner-supervisor"],
							[endpoint.pid, "session-host-internal"],
						] as const) {
							const inspection = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], {
								stdout: "pipe",
								stderr: "pipe",
							});
							const command = await new Response(inspection.stdout).text();
							expect(await inspection.exited).toBe(0);
							if (compiled && pid === endpoint.pid)
								expect(command.includes(alias) || command.includes(compiledCli)).toBe(true);
							else expect(command).toContain(compiled ? compiledCli : sourceCli);
							expect(command).toContain(entry);
						}
						const parentInspection = Bun.spawn(["ps", "-p", String(endpoint.pid), "-o", "ppid="], {
							stdout: "pipe",
							stderr: "pipe",
						});
						const parentPid = Number((await new Response(parentInspection.stdout).text()).trim());
						expect(await parentInspection.exited).toBe(0);
						expect(parentPid).toBe(launchedProof.pid);
						for (const name of names.filter(name => name.endsWith(".json"))) {
							const content = await Bun.file(path.join(ownerRoot, name)).text();
							expect(content).not.toContain(task);
							expect(content).not.toContain("session-host-internal");
						}
						observations.push(await captureManagedDiagnostics(launchedProof!, launchEnvironment));
					}
				}
				await assertOpaqueSinks(root, alias, commandProbes, observations);
				passed = true;
			} catch (error) {
				process.stderr.write(`${JSON.stringify({ fixture: lane, scopedBootstrap: bootstrapDiagnostics })}\n`);
				fixtureFailure.error = new AggregateError(
					[error],
					`Fixture ${root} failed; scoped bootstrap: ${bootstrapDiagnostics.join("; ")}`,
				);
			} finally {
				try {
					release.resolve();
					await spawning;
					transition.mockRestore();
					let cleanupSucceeded = !launchedProof;
					try {
						if (launchedProof) {
							if ((await provider.verify(launchedProof)) === "gone") cleanupSucceeded = true;
							else {
								const closed = await provider.close(launchedProof);
								cleanupSucceeded = closed.ok;
								if (!closed.ok && launchedProof.substrateKind === "headless") {
									try {
										const stateFile = launchedProof.stateFileProof?.stateFile;
										let state: Record<string, unknown> | undefined;
										let stateReadCode: string | undefined;
										try {
											if (typeof stateFile === "string") state = await Bun.file(stateFile).json();
										} catch (error) {
											stateReadCode =
												(error as NodeJS.ErrnoException)?.code === "ENOENT" ? "ENOENT" : "read_failed";
										}
										const reference = nativeProcessBindings().Process.fromPid(launchedProof.pid!);
										const observedIncarnation = processIncarnation(launchedProof.pid!);
										const pid = launchedProof.pid;
										const retained = retainedProcesses.find(reference => reference.pid === pid);
										let osPresence: "present" | "gone" | "unverifiable" = "unverifiable";
										try {
											// Observation only: never authorize cleanup from a numeric PID probe.
											process.kill(launchedProof.pid!, 0);
											osPresence = "present";
										} catch (error) {
											if ((error as NodeJS.ErrnoException)?.code === "ESRCH") osPresence = "gone";
										}
										process.stderr.write(
											`${JSON.stringify({
												fixture: lane,
												headlessClose: {
													code: closed.code,
													stateReadCode,
													statePresent: state !== undefined,
													statePidMatches: state?.pid === launchedProof.pid,
													stateIncarnationMatches:
														state?.processIncarnation === launchedProof.processIncarnation,
													stateProviderMatches: state?.providerIdentity === launchedProof.providerIdentity,
													stateChildMatches: state?.childSessionId === launchedChildId,
													incarnationPresent: observedIncarnation !== undefined,
													incarnationMatches: observedIncarnation === launchedProof.processIncarnation,
													osPresence,
													retainedReferencePresent: retained !== undefined,
													retainedIncarnationMatches:
														retained?.incarnation === launchedProof.processIncarnation,
													retainedStatus: retained?.status(),
													nativeReferencePresent: reference !== null,
													nativeStatus: reference?.status(),
												},
											})}\n`,
										);
									} catch {
										process.stderr.write(
											`${JSON.stringify({ fixture: lane, headlessClose: { code: closed.code, diagnosticUnavailable: true } })}\n`,
										);
									}
								}
								expect(closed).toMatchObject({ ok: true });
							}
							for (const reference of retainedProcesses) {
								const exited = await reference.waitForExit({ timeoutMs: 5000 });
								cleanupSucceeded &&= exited;
								expect(exited).toBe(true);
							}
						}
					} finally {
						await broker.stop();
						setLifecycleCommandResolverForTest(broker, undefined);
						if (passed) await assertOpaqueSinks(root, alias, commandProbes, observations);
						if (passed && process.platform === "darwin" && (lane === "managed-source" || earlyFailure)) {
							await expect(fs.stat(path.join(root, "Library", "Caches", "bun"))).rejects.toMatchObject({
								code: "ENOENT",
							});
						}
						if (passed && cleanupSucceeded) await fs.rm(root, { recursive: true, force: true });
					}
				} catch (cleanupError) {
					if (!("error" in fixtureFailure))
						process.stderr.write(`${JSON.stringify({ fixture: lane, scopedBootstrap: bootstrapDiagnostics })}\n`);
					cleanupFailure.error = cleanupError;
				}
			}
			if ("error" in fixtureFailure || "error" in cleanupFailure) {
				throw new AggregateError(
					[
						...("error" in fixtureFailure ? [fixtureFailure.error] : []),
						...("error" in cleanupFailure ? [cleanupFailure.error] : []),
					],
					`Fixture ${root} failed; scoped bootstrap: ${bootstrapDiagnostics.join("; ")}`,
				);
			}
		},
		30_000,
	);
}
