/**
 * Broker attach-or-wait (session single-owner design §13 H3): a `session.resume` of a session
 * another process holds never launches a second writer. It waits for the holder's endpoint and
 * reuses it, or refuses with `live_session` naming the holder; only a session nobody holds is
 * launched. A launched host whose own claim was refused crosses to the broker as that same outcome.
 *
 * The broker runs in this process; the holder is a separate process claiming through the same
 * owners home, and the launch command is a counter, so no host process is ever started.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Subprocess } from "bun";
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
import { SessionHeldError, SessionOwnershipTestHooks } from "../src/session/session-ownership";

const supported = process.platform === "linux" || process.platform === "darwin";
const holderScript = path.join(import.meta.dir, "session", "session-ownership-holder-child.ts");
const holders: Subprocess<"pipe", "pipe", "pipe">[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	delete SessionOwnershipTestHooks.mode;
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

/** A broker over a fresh agent dir with one saved session S that no process holds. */
async function brokerWithSavedSession() {
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
	setLifecycleCommandResolverForTest(broker, () => {
		launchAttempts += 1;
		return { file: "/bin/false", args: [] };
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
		stateRoot,
		sessionId,
		broker,
		launchAttempts: () => launchAttempts,
		/** One resume as ACP sends it, under a fresh idempotency key. */
		resume: (extra: Record<string, unknown> = {}): Promise<BrokerResponse> => {
			keys += 1;
			return broker.handleRequest(
				"session.resume",
				{ cwd: root, stateRoot, sessionId, sessionPath, ...extra },
				`held-resume-${keys}`,
			);
		},
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

	/** A virtual clock: each poll advances it, so the bound is observed without real waiting. */
	function virtualClock(broker: Broker) {
		const clock = { now: Date.now() };
		setLifecycleTimingForTest(broker, {
			now: () => clock.now,
			sleep: async ms => {
				clock.now += ms;
				await Bun.sleep(1);
			},
		});
		return clock;
	}

	it("observe: when no endpoint appears it launches as before, after the wait, and never refuses", async () => {
		SessionOwnershipTestHooks.mode = "observe";
		const fixture = await brokerWithSavedSession();
		await holdInAnotherProcess(fixture.sessionId);
		const clock = virtualClock(fixture.broker);
		const startedAt = clock.now;
		const resumed = await fixture.resume();
		expect(resumed.ok || resumed.error.code !== "live_session").toBe(true);
		expect(clock.now - startedAt).toBeGreaterThanOrEqual(8_000);
		expect(fixture.launchAttempts()).toBe(1);
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

describe.if(supported)("a launched host whose claim was refused", () => {
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
