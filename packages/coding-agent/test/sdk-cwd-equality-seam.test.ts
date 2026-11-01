import { expect, test, vi } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalEnvKey, type ProjectEnvSnapshot } from "@gajae-code/utils/env-file";
import fc from "fast-check";
import type { Args as ParsedArgs } from "../src/cli/args";
import { runSessionHost } from "../src/commands/sdk";
import { deriveLifecycleDeadlines, type SessionLifecycleLaunchRequest } from "../src/sdk/broker/lifecycle";
import type { AgentSession } from "../src/session/agent-session";

const SEAMS = [
	"GJC_SDK_TEST_HANG_MODEL_PROFILE",
	"GJC_SDK_TEST_FAIL_AFTER_REGISTRATION",
	"GJC_SDK_TEST_EXIT_AFTER_READY",
	"GJC_SDK_TEST_REJECT_AFTER_READY",
] as const;

const HOST_ENV = [
	"GJC_AGENT_DIR",
	"GJC_STATE_ROOT",
	"GJC_LIFECYCLE_REQUEST_ID",
	"GJC_SDK_LIFECYCLE_REQUEST",
	...SEAMS,
] as const;

function emptySnapshot(): ProjectEnvSnapshot {
	return { values: {}, dynamic: new Set() };
}

test("property: cwd-equality seams follow trusted provenance and child env", async () => {
	const sdk = await import("../src/commands/sdk");
	const activeFn = sdk.sdkCwdEqualityTestSeamActive;
	const omitFn = sdk.omitUntrustedSdkCwdEqualitySeams;
	if (typeof activeFn !== "function" || typeof omitFn !== "function") {
		throw new Error("cwd-equality seam helper is missing");
	}
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789/._- ".split("");
	fc.assert(
		fc.property(
			fc.constantFrom(...SEAMS),
			fc
				.array(fc.constantFrom(...chars), { minLength: 1, maxLength: 24 })
				.map(parts => parts.join(""))
				.filter(cwd => cwd.trim().length > 0),
			fc.constantFrom("absent", "equal", "other", "dynamic"),
			(name, cwd, mode) => {
				const key = canonicalEnvKey(name);
				const other = `${cwd}-other`;
				const env: NodeJS.ProcessEnv = { [name]: cwd, UNRELATED_KEEP: "kept" };
				const snapshot: ProjectEnvSnapshot =
					mode === "absent"
						? emptySnapshot()
						: mode === "equal"
							? { values: { [key]: cwd }, dynamic: new Set() }
							: mode === "other"
								? { values: { [key]: other }, dynamic: new Set() }
								: { values: { [key]: "$PWD" }, dynamic: new Set([key]) };
				const snapshots = [snapshot, snapshot];
				const expected = mode === "absent" || mode === "other";
				const active = activeFn(name, cwd, env, snapshots);
				const disagree =
					activeFn(name, cwd, env, [emptySnapshot(), { values: { [key]: cwd }, dynamic: new Set<string>() }]) ===
					false;
				const child = omitFn(env, snapshots);
				const twice = omitFn(child, snapshots);
				return (
					active === expected &&
					disagree &&
					(child[name] === cwd) === expected &&
					child.UNRELATED_KEEP === "kept" &&
					twice[name] === child[name] &&
					twice.UNRELATED_KEEP === "kept" &&
					env[name] === cwd
				);
			},
		),
		{ seed: 30921, numRuns: 64 },
	);
	expect(activeFn("NOT_A_SEAM", "/repo", { NOT_A_SEAM: "/repo" }, [emptySnapshot()])).toBe(false);
	const spaced = "/repo ";
	expect(activeFn(SEAMS[0], spaced, { [SEAMS[0]]: spaced }, [emptySnapshot(), emptySnapshot()])).toBe(true);
});

function childProcessEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value !== "string" || (SEAMS as readonly string[]).includes(key)) continue;
		env[key] = value;
	}
	return env;
}

async function childEnvValue(name: string): Promise<string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	const child = Bun.spawn(
		[process.execPath, "-e", `process.stdout.write(process.env[${JSON.stringify(name)}] ?? "")`],
		{ env, stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`child exit ${code}: ${stderr}`);
	return stdout;
}

function yieldTurns(times: number): Promise<void> {
	let chain = Promise.resolve();
	for (let index = 0; index < times; index += 1) {
		chain = chain.then(() => new Promise(resolve => setImmediate(resolve)));
	}
	return chain;
}

/**
 * Drives `runSessionHost` to the cwd-equality seams with the production entry
 * and stubbed session construction.
 */
async function runHostSeam(input: {
	cwd: string;
	seam: (typeof SEAMS)[number];
	stopAfter: "profile" | "ensure" | "ready";
	probeChild?: boolean;
}): Promise<{ profileCalled: boolean; ensureCalled: boolean; childValue?: string; error: unknown }> {
	const agentDir = path.join(input.cwd, "agent");
	const stateRoot = path.join(input.cwd, ".gjc", "state");
	const sessionId = "cwd-seam";
	const effectMarker = "cwd-seam-marker";
	const deadlines = deriveLifecycleDeadlines(1_000, 60_000);
	const previous = new Map<string, string | undefined>(HOST_ENV.map(name => [name, process.env[name]]));
	const held = Promise.withResolvers<void>();
	let nowMs = 1_000;
	let profileCalled = false;
	let ensureCalled = false;
	let constructed = false;
	let childValue: string | undefined;
	let host: Promise<void> | undefined;
	const originalSleep = Bun.sleep.bind(Bun);
	const sleepSpy = vi.spyOn(Bun, "sleep").mockImplementation(async (ms: number | Date) => {
		// The reject seam sleeps 5s. Later host watchers must not block the test.
		const delay = typeof ms === "number" ? ms : ms.getTime() - Date.now();
		if (delay === 5_000) throw new Error("reject-seam-slept");
		if (delay >= 15_000) throw new Error("stop-watchers");
		return originalSleep(ms);
	});
	await mkdir(path.join(stateRoot, "sdk"), { recursive: true, mode: 0o700 });
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	await writeFile(
		path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`),
		JSON.stringify({ pid: process.pid, effectMarker, incarnation: "test-incarnation" }),
	);
	process.env.GJC_AGENT_DIR = agentDir;
	process.env.GJC_STATE_ROOT = stateRoot;
	process.env.GJC_LIFECYCLE_REQUEST_ID = effectMarker;
	process.env[input.seam] = input.cwd;
	const request: SessionLifecycleLaunchRequest = {
		operation: "session.create",
		sessionId,
		cwd: input.cwd,
		stateRoot,
		effectMarker,
		...deadlines,
	};
	process.env.GJC_SDK_LIFECYCLE_REQUEST = JSON.stringify(request);
	const session = {
		settings: {},
		modelRegistry: {},
		sessionManager: {
			getSessionId: () => sessionId,
			ensureOnDisk: async () => {
				ensureCalled = true;
				if (input.stopAfter === "ensure") throw new Error("past-fail-seam");
			},
			getSessionFile: () => undefined,
			close: async () => {},
		},
		registerToolSessionTransitionCleanup: () => {},
		dispose: async () => {},
		awaitDisposeCompletion: async () => {},
	} as unknown as AgentSession;
	try {
		host = runSessionHost({
			cwd: input.cwd,
			now: () => nowMs,
			sleep: async ms => {
				if (ms > 0) await held.promise;
			},
			processIncarnation: () => "test-incarnation",
			initTheme: async () => {},
			openLifecycleSessionManager: async () => ({
				parsed: { messages: [], fileArgs: [], unknownFlags: new Map() } as ParsedArgs,
				sessionManager: session.sessionManager,
			}),
			createLifecycleAgentSession: async (_options, owner) => {
				if (!owner) throw new Error("Expected lifecycle startup owner.");
				constructed = true;
				owner.capability.settleStarted();
				return {
					session,
					capability: owner.capability,
					rollback: owner.rollback,
					startDeferredMemoryBackend: async () => {},
				};
			},
			applyStartupModelProfiles: async () => {
				profileCalled = true;
				if (input.probeChild) childValue = await childEnvValue(input.seam);
				if (input.stopAfter === "profile") throw new Error("profile-ran");
			},
			initializeLifecycleExtensions: async () => {},
			writeSessionLifecycleReady: async (_root, _id, _marker, canPublish, onPublishing, onPublished) => {
				if (canPublish && !canPublish()) throw new Error("cannot-publish");
				onPublishing?.(async () => true);
				onPublished?.();
			},
		});
		const settled = host.then(
			() => ({ error: undefined as unknown }),
			(caught: unknown) => ({ error: caught }),
		);
		if (input.stopAfter !== "profile") {
			const done = await settled;
			return { profileCalled, ensureCalled, childValue, error: done.error };
		}
		const constructedBy = Date.now() + 3_000;
		while (!constructed && Date.now() < constructedBy) await Bun.sleep(5);
		await yieldTurns(12);
		if (!profileCalled) {
			// Base still hangs this seam. Release the cutoff so the test fails instead of waiting.
			nowMs = deadlines.semanticReadyDeadlineAt + 1;
			held.resolve();
		}
		const done = await settled;
		return { profileCalled, ensureCalled, childValue, error: done.error };
	} finally {
		nowMs = deadlines.semanticReadyDeadlineAt + 1;
		held.resolve();
		await host?.catch(() => {});
		await yieldTurns(2);
		sleepSpy.mockRestore();
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(input.cwd, { recursive: true, force: true }).catch(() => {});
	}
}

async function tempCwd(prefix: string, dotenv?: string): Promise<string> {
	const cwd = await mkdtemp(path.join(tmpdir(), prefix));
	if (dotenv !== undefined) await writeFile(path.join(cwd, ".env"), dotenv);
	return cwd;
}

test("project dotenv cwd line does not hang model-profile startup", async () => {
	const cwd = await tempCwd("gjc-seam-hang-dotenv-", "");
	await writeFile(path.join(cwd, ".env"), `GJC_SDK_TEST_HANG_MODEL_PROFILE=${cwd}\n`);
	const result = await runHostSeam({
		cwd,
		seam: "GJC_SDK_TEST_HANG_MODEL_PROFILE",
		stopAfter: "profile",
		probeChild: true,
	});
	expect(result.profileCalled).toBe(true);
	expect(result.childValue).toBe("");
	expect(result.error).toBeInstanceOf(Error);
	expect((result.error as Error).message).toBe("profile-ran");
});

async function spacedRepo(prefix: string): Promise<{ parent: string; cwd: string }> {
	const parent = await mkdtemp(path.join(tmpdir(), prefix));
	const cwd = path.join(parent, "repo ");
	await mkdir(cwd);
	return { parent, cwd };
}

test("trusted operator cwd with trailing space still hangs model-profile startup", async () => {
	const { parent, cwd } = await spacedRepo("gjc-seam-space-trusted-");
	try {
		const result = await runHostSeam({ cwd, seam: "GJC_SDK_TEST_HANG_MODEL_PROFILE", stopAfter: "profile" });
		expect(result.profileCalled).toBe(false);
		expect(result.error).toMatchObject({ phase: "startup", reason: "pending" });
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test("project dotenv does not hang when the cwd path has trailing space", async () => {
	const { parent, cwd } = await spacedRepo("gjc-seam-space-dotenv-");
	try {
		await writeFile(path.join(cwd, ".env"), `GJC_SDK_TEST_HANG_MODEL_PROFILE="${cwd}"\n`);
		const result = await runHostSeam({
			cwd,
			seam: "GJC_SDK_TEST_HANG_MODEL_PROFILE",
			stopAfter: "profile",
			probeChild: true,
		});
		expect(result.profileCalled).toBe(true);
		expect(result.childValue).toBe("");
		expect((result.error as Error).message).toBe("profile-ran");
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test("project dotenv $PWD expansion does not hang model-profile startup", async () => {
	const cwd = await tempCwd("gjc-seam-hang-pwd-");
	await writeFile(path.join(cwd, ".env"), "GJC_SDK_TEST_HANG_MODEL_PROFILE=$PWD\n");
	const result = await runHostSeam({
		cwd,
		seam: "GJC_SDK_TEST_HANG_MODEL_PROFILE",
		stopAfter: "profile",
		probeChild: true,
	});
	expect(result.profileCalled).toBe(true);
	expect(result.childValue).toBe("");
	expect((result.error as Error).message).toBe("profile-ran");
});

test("trusted operator cwd still hangs model-profile startup", async () => {
	const cwd = await tempCwd("gjc-seam-hang-trusted-");
	const seen = Promise.withResolvers<void>();
	const agentDir = path.join(cwd, "agent");
	const stateRoot = path.join(cwd, ".gjc", "state");
	const sessionId = "cwd-seam-trusted";
	const effectMarker = "cwd-seam-trusted-marker";
	const deadlines = deriveLifecycleDeadlines(1_000, 60_000);
	const previous = process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE;
	const saved = new Map(HOST_ENV.map(name => [name, process.env[name]] as const));
	const held = Promise.withResolvers<void>();
	let nowMs = 1_000;
	let profileCalled = false;
	let constructed = false;
	let host: Promise<void> | undefined;
	await mkdir(path.join(stateRoot, "sdk"), { recursive: true, mode: 0o700 });
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	await writeFile(
		path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`),
		JSON.stringify({ pid: process.pid, effectMarker, incarnation: "test-incarnation" }),
	);
	process.env.GJC_AGENT_DIR = agentDir;
	process.env.GJC_STATE_ROOT = stateRoot;
	process.env.GJC_LIFECYCLE_REQUEST_ID = effectMarker;
	process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE = cwd;
	process.env.GJC_SDK_LIFECYCLE_REQUEST = JSON.stringify({
		operation: "session.create",
		sessionId,
		cwd,
		stateRoot,
		effectMarker,
		...deadlines,
	} satisfies SessionLifecycleLaunchRequest);
	const session = {
		settings: {},
		modelRegistry: {},
		sessionManager: { getSessionId: () => sessionId, ensureOnDisk: async () => {}, close: async () => {} },
		registerToolSessionTransitionCleanup: () => {},
		dispose: async () => {},
		awaitDisposeCompletion: async () => {},
	} as unknown as AgentSession;
	try {
		host = runSessionHost({
			cwd,
			now: () => nowMs,
			sleep: async ms => {
				if (ms > 0) await held.promise;
			},
			processIncarnation: () => "test-incarnation",
			initTheme: async () => {},
			openLifecycleSessionManager: async () => ({
				parsed: { messages: [], fileArgs: [], unknownFlags: new Map() } as ParsedArgs,
				sessionManager: session.sessionManager,
			}),
			createLifecycleAgentSession: async (_options, owner) => {
				if (!owner) throw new Error("Expected lifecycle startup owner.");
				constructed = true;
				seen.resolve();
				owner.capability.settleStarted();
				return {
					session,
					capability: owner.capability,
					rollback: owner.rollback,
					startDeferredMemoryBackend: async () => {},
				};
			},
			applyStartupModelProfiles: async () => {
				profileCalled = true;
				throw new Error("profile-ran");
			},
			initializeLifecycleExtensions: async () => {},
		});
		await seen.promise;
		await yieldTurns(8);
		expect(constructed).toBe(true);
		expect(profileCalled).toBe(false);
		expect(process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE).toBe(cwd);
		expect(await childEnvValue("GJC_SDK_TEST_HANG_MODEL_PROFILE")).toBe(cwd);
		nowMs = deadlines.semanticReadyDeadlineAt + 1;
		held.resolve();
		await expect(host).rejects.toMatchObject({ phase: "startup", reason: "pending" });
		expect(profileCalled).toBe(false);
	} finally {
		held.resolve();
		await host?.catch(() => {});
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		if (previous === undefined) delete process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("trusted operator cwd still wins when dotenv declares a different value", async () => {
	const cwd = await tempCwd("gjc-seam-hang-override-");
	await writeFile(path.join(cwd, ".env"), "GJC_SDK_TEST_HANG_MODEL_PROFILE=/not-the-cwd\n");
	const seen = Promise.withResolvers<void>();
	const deadlines = deriveLifecycleDeadlines(1_000, 60_000);
	const saved = new Map(HOST_ENV.map(name => [name, process.env[name]] as const));
	const held = Promise.withResolvers<void>();
	let nowMs = 1_000;
	let profileCalled = false;
	let host: Promise<void> | undefined;
	const agentDir = path.join(cwd, "agent");
	const stateRoot = path.join(cwd, ".gjc", "state");
	const sessionId = "cwd-seam-override";
	const effectMarker = "cwd-seam-override-marker";
	await mkdir(path.join(stateRoot, "sdk"), { recursive: true, mode: 0o700 });
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	await writeFile(
		path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`),
		JSON.stringify({ pid: process.pid, effectMarker, incarnation: "test-incarnation" }),
	);
	process.env.GJC_AGENT_DIR = agentDir;
	process.env.GJC_STATE_ROOT = stateRoot;
	process.env.GJC_LIFECYCLE_REQUEST_ID = effectMarker;
	process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE = cwd;
	process.env.GJC_SDK_LIFECYCLE_REQUEST = JSON.stringify({
		operation: "session.create",
		sessionId,
		cwd,
		stateRoot,
		effectMarker,
		...deadlines,
	});
	const session = {
		settings: {},
		modelRegistry: {},
		sessionManager: { close: async () => {}, getSessionId: () => sessionId, ensureOnDisk: async () => {} },
		registerToolSessionTransitionCleanup: () => {},
		dispose: async () => {},
		awaitDisposeCompletion: async () => {},
	} as unknown as AgentSession;
	try {
		host = runSessionHost({
			cwd,
			now: () => nowMs,
			sleep: async ms => {
				if (ms > 0) await held.promise;
			},
			processIncarnation: () => "test-incarnation",
			initTheme: async () => {},
			openLifecycleSessionManager: async () => ({
				parsed: { messages: [], fileArgs: [], unknownFlags: new Map() } as ParsedArgs,
				sessionManager: session.sessionManager,
			}),
			createLifecycleAgentSession: async (_options, owner) => {
				if (!owner) throw new Error("Expected lifecycle startup owner.");
				seen.resolve();
				owner.capability.settleStarted();
				return {
					session,
					capability: owner.capability,
					rollback: owner.rollback,
					startDeferredMemoryBackend: async () => {},
				};
			},
			applyStartupModelProfiles: async () => {
				profileCalled = true;
			},
			initializeLifecycleExtensions: async () => {},
		});
		await seen.promise;
		await yieldTurns(8);
		expect(profileCalled).toBe(false);
		expect(process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE).toBe(cwd);
	} finally {
		nowMs = deadlines.semanticReadyDeadlineAt + 1;
		held.resolve();
		await host?.catch(() => {});
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(cwd, { recursive: true, force: true });
	}
});

test("project dotenv cwd line does not fail the host after registration", async () => {
	const cwd = await tempCwd("gjc-seam-fail-dotenv-");
	await writeFile(path.join(cwd, ".env"), `GJC_SDK_TEST_FAIL_AFTER_REGISTRATION=${cwd}\n`);
	const result = await runHostSeam({
		cwd,
		seam: "GJC_SDK_TEST_FAIL_AFTER_REGISTRATION",
		stopAfter: "ensure",
	});
	expect(result.ensureCalled).toBe(true);
	expect((result.error as Error).message).toBe("past-fail-seam");
});

test("trusted operator cwd still fails the host after registration", async () => {
	const cwd = await tempCwd("gjc-seam-fail-trusted-");
	const result = await runHostSeam({
		cwd,
		seam: "GJC_SDK_TEST_FAIL_AFTER_REGISTRATION",
		stopAfter: "ensure",
	});
	expect(result.ensureCalled).toBe(false);
	expect((result.error as Error).message).toBe("Lifecycle test failure after SDK host registration.");
});

test("trusted operator cwd still exits after ready", async () => {
	const cwd = await tempCwd("gjc-seam-exit-trusted-");
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`process.exit:${code ?? ""}`);
	}) as typeof process.exit);
	try {
		const result = await runHostSeam({ cwd, seam: "GJC_SDK_TEST_EXIT_AFTER_READY", stopAfter: "ready" });
		expect((result.error as Error).message).toBe("process.exit:7");
		expect(exitSpy).toHaveBeenCalledWith(7);
	} finally {
		exitSpy.mockRestore();
	}
});

test("project dotenv cwd line does not exit after ready", async () => {
	const cwd = await tempCwd("gjc-seam-exit-dotenv-");
	await writeFile(path.join(cwd, ".env"), `GJC_SDK_TEST_EXIT_AFTER_READY=${cwd}\n`);
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`process.exit:${code ?? ""}`);
	}) as typeof process.exit);
	try {
		const result = await runHostSeam({ cwd, seam: "GJC_SDK_TEST_EXIT_AFTER_READY", stopAfter: "ready" });
		expect(exitSpy).not.toHaveBeenCalled();
		expect((result.error as Error).message).toBe("stop-watchers");
	} finally {
		exitSpy.mockRestore();
	}
});

test("trusted operator cwd still rejects after ready", async () => {
	const cwd = await tempCwd("gjc-seam-reject-trusted-");
	const sdkEntry = path.resolve(import.meta.dir, "../src/commands/sdk.ts");
	const lifecycleEntry = path.resolve(import.meta.dir, "../src/sdk/broker/lifecycle.ts");
	const scriptPath = path.join(cwd, "reject-host.ts");
	await writeFile(
		scriptPath,
		`import { mkdir, writeFile } from "node:fs/promises";
import { runSessionHost } from ${JSON.stringify(sdkEntry)};
import { deriveLifecycleDeadlines } from ${JSON.stringify(lifecycleEntry)};
const cwd = ${JSON.stringify(cwd)};
const agentDir = ${JSON.stringify(path.join(cwd, "agent"))};
const stateRoot = ${JSON.stringify(path.join(cwd, ".gjc", "state"))};
const sessionId = "cwd-seam-reject";
const effectMarker = "cwd-seam-reject-marker";
process.on("unhandledRejection", error => {
	if (error instanceof Error && error.message === "GJC_SDK_TEST_REJECT_AFTER_READY") {
		process.stderr.write("rejected-after-ready\\n");
		process.exit(0);
	}
	process.stderr.write(String(error) + "\\n");
	process.exit(2);
});
await mkdir(agentDir, { recursive: true });
await mkdir(stateRoot + "/sdk", { recursive: true });
await writeFile(stateRoot + "/sdk/" + sessionId + ".lifecycle.json", JSON.stringify({
	pid: process.pid,
	effectMarker,
	incarnation: "test-incarnation",
}));
const deadlines = deriveLifecycleDeadlines(1_000, 60_000);
process.env.GJC_AGENT_DIR = agentDir;
process.env.GJC_STATE_ROOT = stateRoot;
process.env.GJC_LIFECYCLE_REQUEST_ID = effectMarker;
process.env.GJC_SDK_TEST_REJECT_AFTER_READY = cwd;
process.env.GJC_SDK_LIFECYCLE_REQUEST = JSON.stringify({
	operation: "session.create",
	sessionId,
	cwd,
	stateRoot,
	effectMarker,
	...deadlines,
});
const session = {
	settings: {},
	modelRegistry: {},
	sessionManager: { getSessionId: () => sessionId, ensureOnDisk: async () => {}, close: async () => {} },
	registerToolSessionTransitionCleanup: () => {},
	dispose: async () => {},
	awaitDisposeCompletion: async () => {},
};
await runSessionHost({
	cwd,
	now: () => 1_000,
	sleep: async () => new Promise(() => {}),
	processIncarnation: () => "test-incarnation",
	initTheme: async () => {},
	openLifecycleSessionManager: async () => ({
		parsed: { messages: [], fileArgs: [], unknownFlags: new Map() },
		sessionManager: session.sessionManager,
	}),
	createLifecycleAgentSession: async (_options, owner) => {
		if (!owner) throw new Error("Expected lifecycle startup owner.");
		owner.capability.settleStarted();
		return { session, capability: owner.capability, rollback: owner.rollback, startDeferredMemoryBackend: async () => {} };
	},
	applyStartupModelProfiles: async () => {},
	initializeLifecycleExtensions: async () => {},
	writeSessionLifecycleReady: async (_root, _id, _marker, canPublish, onPublishing, onPublished) => {
		if (!canPublish()) throw new Error("cannot-publish");
		onPublishing?.(async () => true);
		onPublished?.();
	},
});
process.stderr.write("settled-without-reject\\n");
process.exit(3);
`,
	);
	const child = Bun.spawn([process.execPath, scriptPath], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: childProcessEnv(),
	});
	const code = await Promise.race([child.exited, Bun.sleep(15_000).then(() => "timeout" as const)]);
	if (code === "timeout") child.kill();
	const stderr = await new Response(child.stderr).text();
	if (code === "timeout") await child.exited;
	expect(code).toBe(0);
	expect(stderr).toContain("rejected-after-ready");
	await rm(cwd, { recursive: true, force: true });
});

test("project dotenv cwd line does not reject after ready", async () => {
	const cwd = await tempCwd("gjc-seam-reject-dotenv-");
	await writeFile(path.join(cwd, ".env"), `GJC_SDK_TEST_REJECT_AFTER_READY=${cwd}\n`);
	const rejections: string[] = [];
	const onRejection = (error: unknown) => {
		if (error instanceof Error) rejections.push(error.message);
	};
	process.on("unhandledRejection", onRejection);
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`process.exit:${code ?? ""}`);
	}) as typeof process.exit);
	try {
		const result = await runHostSeam({ cwd, seam: "GJC_SDK_TEST_REJECT_AFTER_READY", stopAfter: "ready" });
		expect(rejections).not.toContain("GJC_SDK_TEST_REJECT_AFTER_READY");
		expect((result.error as Error).message).toBe("stop-watchers");
		expect(exitSpy).not.toHaveBeenCalled();
	} finally {
		exitSpy.mockRestore();
		process.off("unhandledRejection", onRejection);
	}
});
