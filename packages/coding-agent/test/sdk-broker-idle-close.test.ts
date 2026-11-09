import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { getBrokerIdentityKey } from "../src/sdk/broker/identity";
import { setLifecycleCommandResolverForTest } from "../src/sdk/broker/lifecycle";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import { SpawnAuthorityStore } from "../src/sdk/broker/spawn-authority";
import { createSpawnSubstrateProvider } from "../src/sdk/broker/spawn-substrate";
import { SdkClient } from "../src/sdk/client";

interface FixtureState {
	turnEntered: boolean;
	providerCalls: number;
	streaming: boolean;
	queued: boolean;
	pending: number;
	runningJobs: number;
	work: boolean;
}
async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
}
async function fixture(spawned = false, managed = false, mismatchAfterExit = false) {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-idle-close-"));
	const agentDir = path.join(root, "agent");
	let managedChild: Bun.Subprocess | undefined;
	const provider = createSpawnSubstrateProvider(
		managed
			? {
					selectMultiplexer: () => "tmux",
					launchManaged: (spec, env) => {
						managedChild = Bun.spawn([...spec.argv], {
							cwd: spec.cwd,
							env: { ...env, ...spec.env },
							stdin: "ignore",
							stdout: "ignore",
							stderr: "ignore",
						});
						return {
							name: "fixture-managed",
							nativeSessionId: "$fixture",
							serverPid: process.pid,
							serverStartTime: processIncarnation(process.pid)!,
							ownerGeneration: "fixture-owner",
							sessionId: spec.childSessionId,
							sessionStateFile: path.join(root, "managed-state.json"),
							pid: managedChild.pid,
							providerIdentity: "fixture-managed-provider",
						};
					},
					verifyManaged: () =>
						managedChild?.exitCode === null ? "verified" : mismatchAfterExit ? "mismatch" : "gone",
					closeManaged: async () => {
						throw new Error("Already-exited managed owner must not be signalled");
					},
				}
			: { selectMultiplexer: () => "none" },
	);
	if (managed)
		provider.resolveLifecycleOwner = async proof => ({
			ok: true,
			owner: { pid: proof.pid!, incarnation: processIncarnation(proof.pid!)! },
		});
	const originalSubstrateClose = provider.close.bind(provider);
	const substrateClose = spyOn(provider, "close");
	const broker = new Broker({
		agentDir,
		...(spawned
			? {
					spawnSubstrateProvider: provider,
					masterCapabilityVerifier: { verifyMasterCapability: async () => ({ allowed: true }) },
				}
			: {}),
	});
	setLifecycleCommandResolverForTest(broker, () => ({
		file: process.execPath,
		args: ["run", path.join(import.meta.dirname, "fixtures/sdk-idle-close-host.ts")],
	}));
	await broker.start();
	const created = await broker.handleRequest(
		spawned ? "session.spawn" : "session.create",
		{
			cwd: root,
			...(spawned
				? {
						task: "hold the seed turn",
						masterCapability: "fixture-capability",
						ownerSessionId: "fixture-master",
						attestationEpoch: "fixture-epoch",
					}
				: { env: { ANTHROPIC_API_KEY: "fixture-key" } }),
			...(spawned ? {} : { readinessTimeoutMs: 20_000 }),
		},
		"create",
	);
	if (!created.ok) {
		await broker.stop();
		substrateClose.mockRestore();
		await fs.rm(root, { recursive: true, force: true });
		throw new Error(JSON.stringify(created));
	}
	const { sessionId } = created.result as { sessionId: string };
	const endpointResult = await broker.handleRequest("session.get_endpoint", { sessionId });
	if (!endpointResult.ok) throw new Error(endpointResult.error.message);
	const endpoint = endpointResult.result as { url: string; token: string };
	await broker.index.refresh();
	expect(
		broker.index.listSessions().sessions.find(row => row.sessionId === sessionId)?.lifecycleRequestId,
	).toBeString();
	const control = await waitFor(async () => {
		const file = Bun.file(path.join(root, "fixture-control.json"));
		return (await file.exists()) ? ((await file.json()) as { url: string }) : undefined;
	}, "fixture control");
	const client = await SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 3_000, reconnectAttempts: 0 });
	const state = async (action = "state"): Promise<FixtureState> =>
		(await (await fetch(`${control.url}/${action}`)).json()) as FixtureState;
	const close = (ifIdle = true, key = "close") =>
		broker.handleRequest("session.close", { sessionId, ...(ifIdle ? { ifIdle: true } : {}) }, key);
	return {
		root,
		agentDir,
		broker,
		client,
		sessionId,
		state,
		close,
		provider,
		originalSubstrateClose,
		substrateClose,
		idle: () =>
			waitFor(async () => {
				const value = await state();
				return !value.streaming && !value.queued && value.pending === 0 && !value.work && value.runningJobs === 0
					? value
					: undefined;
			}, "idle host"),
		cleanup: async () => {
			await state("release").catch(() => {});
			await client.close().catch(() => {});
			await close(false, "cleanup").catch(() => {});
			await broker.stop();
			substrateClose.mockRestore();
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

test("ifIdle closes a real idle host and rejects prompt and autonomous ingress before disposal", async () => {
	const host = await fixture();
	try {
		await host.idle();
		await host.state("race");
		expect(await host.close()).toMatchObject({ ok: true, result: { sessionId: host.sessionId } });
		const race = await Bun.file(path.join(host.root, "race-result.json")).json();
		expect(race).toEqual({ codes: ["busy", "busy", "busy"], providerCalls: 0 });
		expect(await host.broker.handleRequest("session.get_endpoint", { sessionId: host.sessionId })).toMatchObject({
			ok: false,
			error: { code: "resource_gone" },
		});
	} finally {
		await host.cleanup();
	}
}, 30_000);

test("a running turn refuses busy, stays usable, and the same key succeeds after it becomes idle", async () => {
	const host = await fixture();
	try {
		expect(await host.client.control("turn.prompt", { text: "hold this turn" })).toMatchObject({ ok: true });
		await waitFor(async () => ((await host.state()).turnEntered ? true : undefined), "running provider");
		expect(await host.close()).toMatchObject({ ok: false, error: { code: "busy" } });
		expect((await host.state()).streaming).toBe(true);
		expect(
			await host.broker.handleRequest("session.close", { sessionId: host.sessionId, ifIdle: false }, "close"),
		).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
		expect(await host.client.query("context.get")).toMatchObject({ ok: true });
		await host.state("release");
		await host.idle();
		expect(await host.client.control("turn.prompt", { text: "still usable after busy" })).toMatchObject({ ok: true });
		expect((await host.idle()).providerCalls).toBe(2);
		// Reopen the ledger through a broker restart to prove the refusal is not a terminal replay.
		await host.broker.stop();
		await host.broker.start();
		expect(await host.close()).toMatchObject({ ok: true, result: { sessionId: host.sessionId } });
	} finally {
		await host.cleanup();
	}
}, 30_000);

test("a queued prompt refuses idle retirement without dropping queued work", async () => {
	const host = await fixture();
	try {
		await host.client.control("turn.prompt", { text: "hold" });
		await waitFor(async () => ((await host.state()).turnEntered ? true : undefined), "running provider");
		expect((await host.state("queue")).queued).toBe(true);
		expect(await host.close()).toMatchObject({ ok: false, error: { code: "busy" } });
		expect((await host.state()).queued).toBe(true);
		await host.state("release");
		const idle = await host.idle();
		expect(idle.providerCalls).toBe(2);
		expect(await host.close()).toMatchObject({ ok: true });
	} finally {
		await host.cleanup();
	}
}, 30_000);

test("concurrent same-key busy closes retain conflicts across restart and retry once idle", async () => {
	const host = await fixture();
	try {
		await host.client.control("turn.prompt", { text: "held" });
		await waitFor(async () => ((await host.state()).turnEntered ? true : undefined), "held turn");
		const results = await Promise.all(Array.from({ length: 8 }, () => host.close()));
		for (const result of results) expect(result).toMatchObject({ ok: false, error: { code: "busy" } });
		await host.broker.stop();
		await host.broker.start();
		expect(
			await host.broker.handleRequest("session.close", { sessionId: host.sessionId, ifIdle: false }, "close"),
		).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
		await host.state("release");
		await host.idle();
		expect(await host.close()).toMatchObject({ ok: true });
	} finally {
		await host.cleanup();
	}
}, 30_000);

test("a running owned async job refuses busy and its real completion can drain before retry", async () => {
	const host = await fixture();
	try {
		const running = await host.state("job");
		expect(running.runningJobs).toBe(1);
		expect(running.streaming).toBe(false);
		expect(await host.close()).toMatchObject({ ok: false, error: { code: "busy" } });
		expect((await host.state()).runningJobs).toBe(1);
		await host.state("release");
		await host.idle();
		expect(await host.close()).toMatchObject({ ok: true });
	} finally {
		await host.cleanup();
	}
}, 30_000);

test("a live broker btw.ask refuses idle close until its actual side provider settles", async () => {
	const host = await fixture();
	const pending = host.client.control("btw.ask", { question: "hold the side question" });
	try {
		await waitFor(async () => ((await host.state()).turnEntered ? true : undefined), "side provider");
		expect((await host.state()).streaming).toBe(false);
		expect(await host.close()).toMatchObject({ ok: false, error: { code: "busy" } });
		await host.state("release");
		expect(await pending).toMatchObject({ ok: true });
		expect(await host.close()).toMatchObject({ ok: true });
	} finally {
		await host.state("release").catch(() => {});
		await pending.catch(() => {});
		await host.cleanup();
	}
}, 30_000);

test("pending autonomous input refuses busy even with no streaming turn or running job", async () => {
	const host = await fixture();
	try {
		expect(await host.state("pending")).toMatchObject({
			streaming: false,
			pending: 1,
			runningJobs: 0,
			providerCalls: 0,
		});
		expect(await host.close()).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await host.state()).toMatchObject({ streaming: false, pending: 1 });
		await host.state("release");
		await host.client.control("turn.prompt", { text: "consume deferred input" });
		expect((await host.idle()).providerCalls).toBe(1);
		expect(await host.close()).toMatchObject({ ok: true });
	} finally {
		await host.cleanup();
	}
}, 30_000);

test("default close still force-closes a running host", async () => {
	const host = await fixture();
	try {
		await host.client.control("turn.prompt", { text: "hold" });
		await waitFor(async () => ((await host.state()).turnEntered ? true : undefined), "running provider");
		expect(await host.close(false)).toMatchObject({ ok: true, result: { sessionId: host.sessionId } });
	} finally {
		await host.cleanup();
	}
}, 30_000);

test("idle close rejects malformed and incompatible options without retiring anything", async () => {
	const host = await fixture();
	try {
		for (const input of [
			{ ifIdle: "yes" },
			{ ifIdle: true, forceRetireStale: true },
			{ ifIdle: true, forceReleaseStaleWorktree: true },
		]) {
			expect(
				await host.broker.handleRequest(
					"session.close",
					{ sessionId: host.sessionId, ...input },
					JSON.stringify(input),
				),
			).toMatchObject({ ok: false, error: { code: "invalid_input" } });
			expect(await host.client.query("context.get")).toMatchObject({ ok: true });
		}
	} finally {
		await host.cleanup();
	}
}, 30_000);

test("an unsupported idle executor refuses without falling back to signals", async () => {
	const host = await fixture();
	try {
		await host.state("unsupported");
		expect(await host.close()).toMatchObject({ ok: false, error: { code: "close_refused" } });
		expect(await host.client.query("context.get")).toMatchObject({ ok: true });
		expect(await host.client.control("turn.prompt", { text: "host survived" })).toMatchObject({ ok: true });
		await waitFor(async () => ((await host.state()).turnEntered ? true : undefined), "surviving provider");
	} finally {
		await host.cleanup();
	}
}, 30_000);

test("notification runtime tears down an accepted close whose response write is rejected", async () => {
	const host = await fixture();
	try {
		await host.idle();
		await host.state("reject-close");
		expect(await host.close()).toMatchObject({ ok: false });
		expect(await Bun.file(path.join(host.root, "close-response-rejected.json")).json()).toEqual({ accepted: true });
		await waitFor(
			async () =>
				await host.state().then(
					() => undefined,
					() => true,
				),
			"accepted host shutdown despite failed write",
		);
		expect(await host.broker.handleRequest("session.get_endpoint", { sessionId: host.sessionId })).toMatchObject({
			ok: false,
		});
	} finally {
		await host.cleanup();
	}
}, 30_000);

test("the source CLI forwards --if-idle and exposes a real broker busy refusal", async () => {
	const host = await fixture();
	const closeCli = async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				"run",
				path.join(import.meta.dirname, "../src/cli.ts"),
				"sdk",
				"session",
				"close",
				host.sessionId,
				"--if-idle",
				"--json",
				"--agent-dir",
				host.agentDir,
			],
			{
				cwd: host.root,
				env: { ...process.env, HOME: host.root, GJC_AGENT_DIR: host.agentDir, GJC_CODING_AGENT_DIR: host.agentDir },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { code, response: JSON.parse(stdout), stderr };
	};
	try {
		await host.client.control("turn.prompt", { text: "hold" });
		await waitFor(async () => ((await host.state()).turnEntered ? true : undefined), "running provider");
		expect(await closeCli()).toMatchObject({
			code: 1,
			response: { ok: false, error: { code: "busy", outcomeCertainty: "not-applied", retryability: "yes" } },
			stderr: "",
		});
		await host.state("release");
		await host.idle();
		expect(await closeCli()).toMatchObject({
			code: 0,
			response: { ok: true, result: { sessionId: host.sessionId } },
			stderr: "",
		});
	} finally {
		await host.cleanup();
	}
}, 30_000);

test("spawn child busy refusal preserves authority, then idle close retires it without substrate signalling", async () => {
	const host = await fixture(true);
	try {
		await waitFor(async () => ((await host.state()).turnEntered ? true : undefined), "spawn seed turn");
		const claims = async () => {
			const store = new SpawnAuthorityStore(host.agentDir, await getBrokerIdentityKey(host.agentDir));
			await store.open();
			return store.claims();
		};
		const before = (await claims()).find(claim => claim.childId === host.sessionId)!;
		expect(await host.close()).toMatchObject({ ok: false, error: { code: "busy" } });
		expect((await claims()).find(claim => claim.childId === host.sessionId)).toEqual(before);
		expect(host.substrateClose).not.toHaveBeenCalled();
		await host.state("release");
		await host.idle();
		expect(await host.close()).toMatchObject({ ok: true });
		expect((await claims()).find(claim => claim.childId === host.sessionId)).toMatchObject({ state: "closed" });
		const store = new SpawnAuthorityStore(host.agentDir, await getBrokerIdentityKey(host.agentDir));
		await store.open();
		expect(store.authority(before.lifecycleIdentity)).toMatchObject({ closeState: "closed" });
		expect(host.substrateClose).not.toHaveBeenCalled();
		const created = await host.broker.handleRequest(
			"session.create",
			{ cwd: host.root, env: { ANTHROPIC_API_KEY: "fixture-key" } },
			"after-spawn-close",
		);
		expect(created).toMatchObject({ ok: true });
		if (created.ok) {
			const { sessionId } = created.result as { sessionId: string };
			expect(await host.broker.handleRequest("session.close", { sessionId }, "close-after-spawn")).toMatchObject({
				ok: true,
			});
		}
	} finally {
		await host.cleanup();
	}
}, 30_000);

for (const mismatch of [false, true]) {
	test(`managed child idle close settles only the exactly exited owner (mismatch=${mismatch})`, async () => {
		const host = await fixture(true, true, mismatch);
		try {
			await waitFor(async () => ((await host.state()).turnEntered ? true : undefined), "managed seed turn");
			expect(await host.close()).toMatchObject({ ok: false, error: { code: "busy" } });
			expect(host.substrateClose).not.toHaveBeenCalled();
			await host.state("release");
			await host.idle();
			expect(await host.close()).toMatchObject(
				mismatch ? { ok: false, error: { code: "terminal_uncertain" } } : { ok: true },
			);
			const store = new SpawnAuthorityStore(host.agentDir, await getBrokerIdentityKey(host.agentDir));
			await store.open();
			const claim = store.claims().find(row => row.childId === host.sessionId)!;
			expect(store.authority(claim.lifecycleIdentity)).toMatchObject({
				closeState: mismatch ? "uncertain" : "closed",
			});
			if (!mismatch) expect(claim.state).toBe("closed");
			expect(host.substrateClose).not.toHaveBeenCalled();
		} finally {
			await host.cleanup();
		}
	}, 30_000);
}

for (const closeFailure of ["gone", "throws"] as const) {
	test(`managed idle cleanup reconciles verify-to-gone race when close ${closeFailure}`, async () => {
		const host = await fixture(true, true);
		let verifySpy: ReturnType<typeof spyOn> | undefined;
		try {
			await waitFor(async () => ((await host.state()).turnEntered ? true : undefined), "managed seed turn");
			await host.state("release");
			await host.idle();
			const originalVerify = host.provider.verify.bind(host.provider);
			let emittedVerifiedBeforeGone = false;
			verifySpy = spyOn(host.provider, "verify").mockImplementation(async proof => {
				const verdict = await originalVerify(proof);
				if (verdict === "gone" && !emittedVerifiedBeforeGone) {
					emittedVerifiedBeforeGone = true;
					return "verified";
				}
				return verdict;
			});
			if (closeFailure === "throws") {
				host.substrateClose.mockImplementation(async proof => {
					const result = await host.originalSubstrateClose(proof);
					if (!result.ok && result.code === "substrate_gone") throw new Error("owner exited during close");
					return result;
				});
			}
			expect(await host.close()).toMatchObject({ ok: true });
			expect(emittedVerifiedBeforeGone).toBe(true);
			expect(host.substrateClose).toHaveBeenCalledTimes(1);
			const store = new SpawnAuthorityStore(host.agentDir, await getBrokerIdentityKey(host.agentDir));
			await store.open();
			const claim = store.claims().find(row => row.childId === host.sessionId)!;
			expect(claim.state).toBe("closed");
			expect(store.authority(claim.lifecycleIdentity)).toMatchObject({ closeState: "closed" });
		} finally {
			verifySpy?.mockRestore();
			await host.cleanup();
		}
	}, 30_000);
}

test("gone managed substrate cannot settle a complete host pin with a different incarnation", async () => {
	const host = await fixture(true, true);
	const originalAuthority = SpawnAuthorityStore.prototype.authority;
	let changedPin = false;
	const authoritySpy = spyOn(SpawnAuthorityStore.prototype, "authority").mockImplementation(function (
		this: SpawnAuthorityStore,
		identity,
	) {
		const authority = originalAuthority.call(this, identity);
		if (authority?.childId !== host.sessionId) return authority;
		changedPin = true;
		return { ...authority, endpointIncarnation: "different-host-incarnation" };
	});
	try {
		await waitFor(async () => ((await host.state()).turnEntered ? true : undefined), "managed seed turn");
		await host.state("release");
		await host.idle();
		expect(await host.close()).toMatchObject({ ok: false, error: { code: "close_refused" } });
		expect(changedPin).toBe(true);
		const store = new SpawnAuthorityStore(host.agentDir, await getBrokerIdentityKey(host.agentDir));
		await store.open();
		const claim = store.claims().find(row => row.childId === host.sessionId)!;
		expect(claim.state).not.toBe("closed");
		expect(store.authority(claim.lifecycleIdentity)?.closeState).not.toBe("closed");
	} finally {
		authoritySpy.mockRestore();
		await host.cleanup();
	}
}, 30_000);

for (const recheck of ["mismatch", "throws"] as const) {
	test(`managed idle cleanup refuses an unproven post-close recheck (${recheck})`, async () => {
		const host = await fixture(true, true);
		const originalVerify = host.provider.verify.bind(host.provider);
		let emittedVerifiedBeforeGone = false;
		let rechecked = false;
		const verifySpy = spyOn(host.provider, "verify").mockImplementation(async proof => {
			const verdict = await originalVerify(proof);
			if (verdict !== "gone") return verdict;
			if (!emittedVerifiedBeforeGone) {
				emittedVerifiedBeforeGone = true;
				return "verified";
			}
			rechecked = true;
			if (recheck === "throws") throw new Error("cannot prove managed owner identity");
			return "mismatch";
		});
		try {
			await waitFor(async () => ((await host.state()).turnEntered ? true : undefined), "managed seed turn");
			await host.state("release");
			await host.idle();
			expect(await host.close()).toMatchObject({ ok: false, error: { code: "close_refused" } });
			expect(rechecked).toBe(true);
			const store = new SpawnAuthorityStore(host.agentDir, await getBrokerIdentityKey(host.agentDir));
			await store.open();
			const claim = store.claims().find(row => row.childId === host.sessionId)!;
			expect(claim.state).not.toBe("closed");
			expect(store.authority(claim.lifecycleIdentity)?.closeState).not.toBe("closed");
		} finally {
			verifySpy.mockRestore();
			await host.cleanup();
		}
	}, 30_000);
}
