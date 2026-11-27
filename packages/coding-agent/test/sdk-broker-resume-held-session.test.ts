/**
 * Broker attach-or-wait (session single-owner design §13 H3): a `session.resume` of a session
 * another process holds never launches a second writer. It waits for the holder's endpoint and
 * reuses it, or refuses with `live_session` naming the holder; only a session nobody holds is
 * launched. A launched host whose own claim was refused crosses to the broker as that same outcome.
 *
 * The broker runs in this process; the holder is a separate process claiming through the same
 * owners home, and the launch command is a counter, except where a real session host is launched
 * to show its refused claim crossing the broker.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileLockAcquireStatus, FileLockProbeState, snapshotDirectoryTree } from "@gajae-code/natives";
import { getAgentDir } from "@gajae-code/utils";
import type { Subprocess } from "bun";
import { resetSettingsForTest } from "../src/config/settings";
import { Broker, type BrokerResponse } from "../src/sdk/broker/broker";
import {
	readSessionLifecycleFailureForTest,
	setLifecycleCommandResolverForTest,
	setLifecycleTimingForTest,
	writeSessionLifecycleFailure,
} from "../src/sdk/broker/lifecycle";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import { normalizeSdkStartupFailure } from "../src/sdk/startup-capability";
import { SessionManager } from "../src/session/session-manager";
import {
	claimSessionOwner,
	probeSessionOwner,
	SessionHeldError,
	SessionOwnershipTestHooks,
} from "../src/session/session-ownership";
import { FileSessionStorage } from "../src/session/session-storage";

const supported = process.platform === "linux" || process.platform === "darwin";
const holderScript = path.join(import.meta.dir, "session", "session-ownership-holder-child.ts");
const holders: Subprocess<"pipe", "pipe", "pipe">[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	delete SessionOwnershipTestHooks.mode;
	delete SessionOwnershipTestHooks.lockBackend;
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const child of holders.splice(0)) {
		child.kill("SIGKILL");
		await child.exited;
	}
});

/** Another process, with HOME at the test's owners home, that holds `sessionId` as a terminal. */
async function holdInAnotherProcess(sessionId: string): Promise<{ pid: number; release(): Promise<void> }> {
	const home = SessionOwnershipTestHooks.homeOverride;
	if (!home) throw new Error("the test preload sets the owners home");
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		OWNER_SESSION_ID: sessionId,
		OWNER_SURFACE: "terminal",
	};
	for (const key of Object.keys(env))
		if (key.startsWith("XDG_") || /^(GJC|PI)_(CONFIG|CODING_AGENT)_DIR$/.test(key)) delete env[key];
	const child = Bun.spawn([process.execPath, holderScript], {
		cwd: import.meta.dir,
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	holders.push(child);
	const reader = child.stdout.getReader();
	let text = "";
	const readLine = async (): Promise<string> => {
		while (!text.includes("\n")) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`holder exited early: ${await new Response(child.stderr).text()}`);
			text += new TextDecoder().decode(value);
		}
		const line = text.slice(0, text.indexOf("\n"));
		text = text.slice(line.length + 1);
		return line;
	};
	const ready = JSON.parse(await readLine()) as { status: string; pid: number };
	if (ready.status !== "claimed") throw new Error(`holder did not claim: ${ready.status}`);
	return {
		pid: ready.pid,
		release: async () => {
			child.stdin.write("release\n");
			child.stdin.flush();
			expect(await readLine()).toBe("released");
		},
	};
}

const clocks = new WeakMap<Broker, { now: number }>();

/** A virtual clock: each poll advances it, so the bound is observed without real waiting. */
function virtualClock(broker: Broker): { now: number } {
	const clock = { now: Date.now() };
	clocks.set(broker, clock);
	setLifecycleTimingForTest(broker, {
		now: () => clock.now,
		sleep: async ms => {
			clock.now += ms;
			await Bun.sleep(1);
		},
	});
	return clock;
}

/** The broker's clock: its virtual clock when it has one. */
function clockOf(broker: Broker): () => number {
	return () => clocks.get(broker)?.now ?? Date.now();
}

/** A broker over a fresh agent dir with one saved session S that no process holds. */
async function brokerWithSavedSession(
	options: { launch?: (agentDir: string) => { file: string; args: string[] } } = {},
) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-resume-held-")));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const saved = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
	await saved.ensureOnDisk();
	const sessionId = saved.getSessionId();
	const sessionPath = saved.getSessionFile();
	// Closing releases this process's claim, so the holder process can take it.
	await saved.close();
	if (!sessionPath) throw new Error("Expected a saved session path.");
	const broker = new Broker({ agentDir });
	await broker.start();
	let launchAttempts = 0;
	let launchedAt: number | undefined;
	setLifecycleCommandResolverForTest(broker, () => {
		launchAttempts += 1;
		launchedAt ??= clockOf(broker)();
		return options.launch?.(agentDir) ?? { file: "/bin/false", args: [] };
	});
	cleanups.push(async () => {
		setLifecycleCommandResolverForTest(broker, undefined);
		setLifecycleTimingForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	});
	let keys = 0;
	return {
		root,
		agentDir,
		stateRoot,
		sessionId,
		sessionPath,
		broker,
		launchAttempts: () => launchAttempts,
		/** The broker clock when the first launch was resolved. */
		launchedAt: () => launchedAt,
		/** One resume as ACP sends it, under a fresh idempotency key. */
		resume: (extra: Record<string, unknown> = {}): Promise<BrokerResponse> => {
			keys += 1;
			return broker.handleRequest(
				"session.resume",
				{ cwd: root, stateRoot, sessionId, sessionPath, ...extra },
				`held-resume-${keys}`,
			);
		},
		/** One delete as ACP sends it: every retry under the same per-session idempotency key. */
		delete: (via: Broker = broker, key = `acp:session.delete:${sessionId}`): Promise<BrokerResponse> =>
			via.handleRequest("session.delete", { cwd: root, sessionId, sessionPath }, key),
	};
}

describe.if(supported)("broker session.resume of a session another process holds", () => {
	it("observe: waits for the holder's endpoint and reuses it, launching nothing", async () => {
		SessionOwnershipTestHooks.mode = "observe";
		const fixture = await brokerWithSavedSession();
		const holder = await holdInAnotherProcess(fixture.sessionId);

		// The holder has no endpoint in the index yet: an interactive TUI starting up.
		const resumed = fixture.resume();
		await Bun.sleep(300);
		const endpointPath = path.join(fixture.stateRoot, "sdk", `${fixture.sessionId}.json`);
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: fixture.sessionId, pid: holder.pid, url: "ws://127.0.0.1:1", token: "holder" }),
		);
		const incarnation = processIncarnation(holder.pid);
		await fixture.broker.index.append({
			type: "host_registered",
			sessionId: fixture.sessionId,
			locator: { cwd: fixture.root, worktreeRoot: null, stateRoot: fixture.stateRoot },
			endpointGeneration: 1,
			pid: holder.pid,
			...(incarnation ? { processIncarnation: incarnation } : {}),
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		});

		expect(await resumed).toMatchObject({
			ok: true,
			result: { sessionId: fixture.sessionId, pid: holder.pid, reused: true, endpoint: { token: "holder" } },
		});
		expect(fixture.launchAttempts()).toBe(0);
	});

	// Continue here (design §13 L1): the terminal taking a session over fences the gap between the
	// closed host's exit and its own claim with a live generation-0 row. A resume in that gap, with
	// no claim held, waits for the terminal's endpoint instead of refusing the endpointless row.
	it("enforce: a live generation-0 row with the claim free waits for the endpoint published after it", async () => {
		SessionOwnershipTestHooks.mode = "enforce";
		const fixture = await brokerWithSavedSession();
		const terminal = await holdInAnotherProcess(fixture.sessionId);
		await terminal.release();
		const incarnation = processIncarnation(terminal.pid);
		const registration = (endpointGeneration: number, stateRoot: string, endpointMtimeMs?: number) => ({
			type: "host_registered" as const,
			sessionId: fixture.sessionId,
			locator: { cwd: fixture.root, worktreeRoot: null, stateRoot },
			endpointGeneration,
			pid: terminal.pid,
			...(incarnation ? { processIncarnation: incarnation } : {}),
			...(endpointMtimeMs === undefined ? {} : { endpointMtimeMs }),
		});
		await fixture.broker.index.append(registration(0, fixture.agentDir));

		const resumed = fixture.resume();
		await Bun.sleep(300);
		const endpointPath = path.join(fixture.stateRoot, "sdk", `${fixture.sessionId}.json`);
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({
				sessionId: fixture.sessionId,
				pid: terminal.pid,
				url: "ws://127.0.0.1:1",
				token: "terminal",
			}),
		);
		await fixture.broker.index.append(registration(1, fixture.stateRoot, (await fs.stat(endpointPath)).mtimeMs));

		expect(await resumed).toMatchObject({
			ok: true,
			result: { sessionId: fixture.sessionId, pid: terminal.pid, reused: true, endpoint: { token: "terminal" } },
		});
		expect(fixture.launchAttempts()).toBe(0);
	});

	it("observe: when no endpoint appears it launches as before after a 2 s wait, and never refuses", async () => {
		SessionOwnershipTestHooks.mode = "observe";
		const fixture = await brokerWithSavedSession();
		await holdInAnotherProcess(fixture.sessionId);
		const clock = virtualClock(fixture.broker);
		const startedAt = clock.now;
		const resumed = await fixture.resume();
		expect(resumed.ok || resumed.error.code !== "live_session").toBe(true);
		expect(fixture.launchAttempts()).toBe(1);
		expect(fixture.launchedAt()! - startedAt).toBe(2_000);
	});

	it("enforce: resumes queued on one session share the wait instead of stacking it", async () => {
		SessionOwnershipTestHooks.mode = "enforce";
		const fixture = await brokerWithSavedSession();
		await holdInAnotherProcess(fixture.sessionId);
		const clock = virtualClock(fixture.broker);
		const startedAt = clock.now;
		const outcomes = await Promise.all([fixture.resume(), fixture.resume(), fixture.resume()]);
		for (const outcome of outcomes) expect(outcome).toMatchObject({ ok: false, error: { code: "live_session" } });
		// The second and third queued behind the first for its whole wait, which used up theirs.
		expect(clock.now - startedAt).toBe(8_000);
		expect(fixture.launchAttempts()).toBe(0);
	});

	it("lowering the mode in config.yml reaches a running broker: the next resume neither waits nor refuses", async () => {
		// The real setting source: the operator's config file in this process's agent directory.
		const configFile = path.join(getAgentDir(), "config.yml");
		await Bun.write(configFile, "session:\n  ownership:\n    mode: enforce\n");
		resetSettingsForTest();
		cleanups.push(async () => {
			await fs.rm(configFile, { force: true });
			resetSettingsForTest();
		});
		const fixture = await brokerWithSavedSession();
		await holdInAnotherProcess(fixture.sessionId);
		const clock = virtualClock(fixture.broker);
		const startedAt = clock.now;
		expect(await fixture.resume()).toMatchObject({ ok: false, error: { code: "live_session" } });
		expect(clock.now - startedAt).toBe(8_000);

		await Bun.write(configFile, "session:\n  ownership:\n    mode: off\n");
		const loweredAt = clock.now;
		const resumed = await fixture.resume();
		expect(resumed.ok || resumed.error.code !== "live_session").toBe(true);
		expect(fixture.launchAttempts()).toBe(1);
		expect(fixture.launchedAt()! - loweredAt).toBe(0);
	});

	it("enforce: refuses with live_session naming the holder when no endpoint appears, and launches once it lets go", async () => {
		SessionOwnershipTestHooks.mode = "enforce";
		const fixture = await brokerWithSavedSession();
		const holder = await holdInAnotherProcess(fixture.sessionId);
		const clock = virtualClock(fixture.broker);
		const startedAt = clock.now;

		const refused = await fixture.resume();
		expect(refused).toEqual({
			ok: false,
			error: {
				code: "live_session",
				message: `Session ${fixture.sessionId} is open for writing in another terminal (pid ${holder.pid}), which has not published an SDK endpoint to attach to. Only one process can write a session at a time; try again once it is ready, or fork the session.`,
				holder: { surface: "terminal", pid: holder.pid },
			},
		});
		// The default bound, 8 s, inside the SDK client's default 10 s request timeout; a shorter
		// readiness timeout shortens it.
		expect(clock.now - startedAt).toBe(8_000);
		const shorter = clock.now;
		expect(await fixture.resume({ readinessTimeoutMs: 4_000 })).toMatchObject({
			ok: false,
			error: { code: "live_session" },
		});
		expect(clock.now - shorter).toBe(4_000);
		expect(fixture.launchAttempts()).toBe(0);

		// Nobody holds it any more: resume launches a host, as before ownership.
		await holder.release();
		setLifecycleTimingForTest(fixture.broker, undefined);
		await fixture.resume();
		expect(fixture.launchAttempts()).toBe(1);
	});
});

/** The session directory's entries: equal listings mean the delete detached nothing. */
async function listing(sessionPath: string): Promise<string[]> {
	return (await fs.readdir(path.dirname(sessionPath), { recursive: true })).sort();
}

// The holder has no live index row: a `-p` run, an SDK embedding, a TUI without the SDK. Only its
// claim tells the broker another process is writing the session.
describe.if(supported)("broker session.delete of a session another process holds", () => {
	it("enforce: refuses with live_session before touching the transcript; the holder keeps the session", async () => {
		SessionOwnershipTestHooks.mode = "enforce";
		const fixture = await brokerWithSavedSession();
		const holder = await holdInAnotherProcess(fixture.sessionId);
		const bytes = await fs.readFile(fixture.sessionPath);
		const entries = await listing(fixture.sessionPath);

		expect(await fixture.delete()).toEqual({
			ok: false,
			error: {
				code: "live_session",
				message: `Can't delete this session: it is open in another terminal (pid ${holder.pid}).`,
				holder: { surface: "terminal", pid: holder.pid },
			},
		});
		expect(await fs.readFile(fixture.sessionPath)).toEqual(bytes);
		expect(await listing(fixture.sessionPath)).toEqual(entries);
		expect(await probeSessionOwner(fixture.sessionId)).toMatchObject({
			state: "held",
			self: false,
			holder: { pid: holder.pid },
		});
		await holder.release();

		// The refusal changed nothing, so it is not stored: once the holder lets go, the same key
		// deletes, across a broker restart too, and the broker's claim is released when done.
		await fixture.broker.stop();
		const restarted = new Broker({ agentDir: fixture.agentDir });
		await restarted.start();
		cleanups.push(() => restarted.stop());
		expect(await fixture.delete(restarted)).toEqual({ ok: true, result: { sessionId: fixture.sessionId } });
		await expect(fs.stat(fixture.sessionPath)).rejects.toThrow();
		expect(await probeSessionOwner(fixture.sessionId)).toEqual({ state: "free" });
	});

	it("enforce: a claim that cannot be checked refuses with unavailable, and another key deletes once it can", async () => {
		SessionOwnershipTestHooks.mode = "enforce";
		const fixture = await brokerWithSavedSession();
		const bytes = await fs.readFile(fixture.sessionPath);
		// Every claim fails as an owners-directory lock error would.
		SessionOwnershipTestHooks.lockBackend = {
			tryAcquire: async () => ({ status: FileLockAcquireStatus.Failed, code: "EACCES" }),
			probe: async () => ({ state: FileLockProbeState.Free }),
		};

		expect(await fixture.delete()).toEqual({
			ok: false,
			error: {
				code: "unavailable",
				message: "Can't delete this session: gjc could not check whether another process has it open.",
			},
		});
		expect(await fs.readFile(fixture.sessionPath)).toEqual(bytes);

		// The refused key's retained binding does not fence another caller's key (`gjc sdk` picks its own).
		delete SessionOwnershipTestHooks.lockBackend;
		expect(await fixture.delete(fixture.broker, "sdk-cli-delete")).toEqual({
			ok: true,
			result: { sessionId: fixture.sessionId },
		});
		await expect(fs.stat(fixture.sessionPath)).rejects.toThrow();
	});

	it("enforce: a pending cleanup that meets a holder keeps its receipt and finishes under the same key", async () => {
		SessionOwnershipTestHooks.mode = "enforce";
		const fixture = await brokerWithSavedSession();
		const artifactsDir = fixture.sessionPath.slice(0, -6);
		await fs.mkdir(artifactsDir);
		// The first attempt quarantines the artifact root and stops there, as an interrupted cleanup does.
		let calls = 0;
		const verifiedDelete = vi
			.spyOn(FileSessionStorage.prototype, "deleteSessionVerified")
			.mockImplementation(async target => {
				calls += 1;
				if (calls === 1) {
					if (!target.plannedArtifactsPath || !target.expectedArtifactsIdentity)
						throw new Error("Expected preauthorized artifact quarantine");
					await fs.rename(artifactsDir, target.plannedArtifactsPath);
					const tree = snapshotDirectoryTree(target.plannedArtifactsPath);
					if (!tree.ok || !tree.snapshot) throw new Error("Expected a quarantined root tree snapshot");
					return {
						kind: "cleanup_pending",
						phase: "artifacts",
						error: new Error("interrupted cleanup"),
						artifactsIdentity: target.expectedArtifactsIdentity,
						artifactsTree: tree.snapshot,
						detachedArtifactsPath: target.plannedArtifactsPath,
						transcriptIdentity: target.transcriptIdentity,
					};
				}
				if (calls === 2) {
					if (!target.detachedArtifactsPath) throw new Error("Expected the quarantined root on retry");
					await fs.rmdir(target.detachedArtifactsPath);
					return { kind: "artifacts_removed", phase: "artifacts", transcriptIdentity: target.transcriptIdentity };
				}
				await fs.unlink(target.transcriptPath);
				return { kind: "deleted" };
			});
		cleanups.push(async () => verifiedDelete.mockRestore());

		expect(await fixture.delete()).toMatchObject({
			ok: false,
			error: { code: "cleanup_pending", cleanup: { phase: "artifacts", sessionId: fixture.sessionId } },
		});
		const holder = await holdInAnotherProcess(fixture.sessionId);
		const bytes = await fs.readFile(fixture.sessionPath);

		expect(await fixture.delete()).toMatchObject({ ok: false, error: { code: "live_session" } });
		expect(calls).toBe(1);
		expect(await fs.readFile(fixture.sessionPath)).toEqual(bytes);

		await holder.release();
		expect(await fixture.delete()).toEqual({ ok: true, result: { sessionId: fixture.sessionId } });
		expect(calls).toBe(3);
		await expect(fs.stat(fixture.sessionPath)).rejects.toThrow();
	});

	it("observe: deletes as before ownership", async () => {
		SessionOwnershipTestHooks.mode = "observe";
		const fixture = await brokerWithSavedSession();
		await holdInAnotherProcess(fixture.sessionId);

		expect(await fixture.delete()).toEqual({ ok: true, result: { sessionId: fixture.sessionId } });
		await expect(fs.stat(fixture.sessionPath)).rejects.toThrow();
	});
});

describe.if(supported)("a launched host whose claim was refused", () => {
	it("crosses the broker as live_session naming the holder, with no endpoint", async () => {
		const home = SessionOwnershipTestHooks.homeOverride;
		if (!home) throw new Error("the test preload sets the owners home");
		const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
		const cli = path.resolve(import.meta.dir, "../src/cli.ts");
		// A real session host, with HOME at the owners home so it meets this process's claim.
		const fixture = await brokerWithSavedSession({
			launch: () => ({
				file: "/bin/sh",
				args: [
					"-c",
					`HOME=${quote(home)} exec ${quote(process.execPath)} run ${quote(cli)} sdk session-host-internal`,
				],
			}),
		});
		await Bun.write(path.join(fixture.agentDir, "config.yml"), "session:\n  ownership:\n    mode: enforce\n");
		// This process holds S. The broker never counts its own process as another writer, so it
		// launches; the host's claim under `enforce` is what refuses.
		const claim = await claimSessionOwner(fixture.sessionId, { surface: "sdk" });
		if (claim.status !== "claimed") throw new Error(`claim failed: ${claim.status}`);
		cleanups.push(async () => claim.claim.release());

		const refused = await fixture.resume({ readinessTimeoutMs: 30_000 });
		expect(fixture.launchAttempts()).toBe(1);
		expect(refused).toMatchObject({
			ok: false,
			error: {
				code: "live_session",
				message: expect.stringContaining(
					`open for writing in an application using the gjc SDK (pid ${process.pid})`,
				),
				holder: { surface: "sdk", pid: process.pid },
				endpoint: "unavailable",
			},
		});
	}, 60_000);

	it("reports the holder through its startup failure receipt", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-host-held-")));
		cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
		const failure = normalizeSdkStartupFailure(
			"registration",
			"failed",
			new SessionHeldError("held-session", { surface: "terminal", pid: 4242, gjcVersion: "1.0.0" }),
		);
		expect(failure).toEqual({
			phase: "registration",
			reason: "failed",
			message:
				"Session held-ses is open for writing in another process (terminal, pid 4242). Only one process can write a session at a time.",
			code: "session_held",
			details: { holder: { surface: "terminal", pid: 4242 } },
		});
		const marker = { pid: process.pid, effectMarker: "held-marker", incarnation: processIncarnation(process.pid)! };
		await writeSessionLifecycleFailure(root, "held-session", marker.effectMarker, failure, {
			endpointGeneration: null,
			fenced: true,
			runtimeRemoved: true,
			hostStopped: true,
			brokerRegistrationReleased: true,
		});
		// The broker's read keeps the code and holder; it maps them to the resume's `live_session`.
		expect(await readSessionLifecycleFailureForTest(root, "held-session", marker)).toEqual(failure);
	});
});
