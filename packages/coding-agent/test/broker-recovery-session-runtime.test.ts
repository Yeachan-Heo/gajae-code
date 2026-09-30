import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";
import { Broker } from "../src/sdk/broker/broker";
import { ensureBroker } from "../src/sdk/broker/ensure";
import { createSdkSessionRuntimeExtension } from "../src/sdk/host/session-runtime";

// Drives the real `runBrokerRecovery` in session-runtime.ts through the SDK lifecycle
// seams (#6040): the recovery tick is captured from the injected `setIntervalImpl`
// and invoked by hand, so every assertion is about the production recovery path.

function sdkContext(sessionId: string, cwd: string): ExtensionContext {
	return {
		cwd,
		workflowGate: undefined,
		sdkBindings: () => [],
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => path.join(cwd, `${sessionId}.json`),
			getSessionName: () => undefined,
			getBranch: () => [],
		},
		getTranscript: () => [],
		getGoalState: () => undefined,
	} as unknown as ExtensionContext;
}

interface Harness {
	tick(): Promise<void>;
	ensureCalls(): number;
	advance(ms: number): void;
	intervalArmed(): boolean;
	cleared(): boolean;
	dispose(): Promise<void>;
}

async function startRuntime(options: {
	replaced: () => boolean | Promise<boolean>;
	failStartupRegistration?: boolean;
}): Promise<Harness> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-broker-recovery-6040-"));
	const agentDir = path.join(root, "agent");
	const cwd = await fs.mkdtemp(path.join(root, "session-"));
	const sessionId = `recovery-${path.basename(root)}`;
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, context: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const broker = new Broker({ agentDir });
	await broker.start();

	let ensureCount = 0;
	let recoveryTick: (() => void) | undefined;
	let cleared = false;
	const clock = { value: 1_000_000 };

	createSdkSessionRuntimeExtension(api, {
		agentDir,
		// The first ensure (startup registration) reaches the real broker; every
		// recovery ensure after that fails, like a broker that keeps dying.
		ensureBrokerImpl: async input => {
			ensureCount++;
			if (ensureCount === 1 && !options.failStartupRegistration) return await ensureBroker(input);
			throw Object.assign(new Error("broker unavailable"), { code: "unavailable" });
		},
		setIntervalImpl: ((callback: () => void) => {
			recoveryTick = callback;
			return { callback } as unknown as NodeJS.Timeout;
		}) as typeof setInterval,
		clearIntervalImpl: (() => {
			cleared = true;
		}) as typeof clearInterval,
		setRecoveryBackoffClockForTest: inject => inject({ now: () => clock.value }),
		setRuntimeImageIdentityForTest: register =>
			register(
				() => undefined,
				async () => options.replaced(),
			),
		createTransport: async ({ sessionId: transportSessionId, stateRoot, token }) => ({
			sessionId: transportSessionId,
			stateRoot,
			token,
			onFrame: () => undefined,
			sendFrame: () => undefined,
			start: async () => {
				const endpoint = path.join(stateRoot, "sdk", `${transportSessionId}.json`);
				await fs.mkdir(path.dirname(endpoint), { recursive: true });
				await fs.writeFile(
					endpoint,
					JSON.stringify({ sessionId: transportSessionId, pid: process.pid, url: "ws://127.0.0.1:1", token }),
				);
				return { url: "ws://127.0.0.1:1" };
			},
			stop: async () => {},
		}),
	});
	const context = sdkContext(sessionId, cwd);
	const start = handlers.get("session_start");
	const stop = handlers.get("session_shutdown");
	if (!start || !stop) throw new Error("SDK lifecycle handlers were not installed.");
	await start({}, context);

	return {
		async tick() {
			if (!recoveryTick) throw new Error("broker recovery was never armed");
			recoveryTick();
			// Let the async recovery body (identity probe, ensure, bookkeeping) settle.
			for (let i = 0; i < 20; i++) await Bun.sleep(0);
		},
		ensureCalls: () => ensureCount - 1,
		advance: ms => {
			clock.value += ms;
		},
		intervalArmed: () => recoveryTick !== undefined,
		cleared: () => cleared,
		async dispose() {
			await stop({}, context);
			await broker.stop();
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

test("a replaced runtime image stops broker recovery without spawning (#6040)", async () => {
	let replaced = false;
	const harness = await startRuntime({ replaced: () => replaced });
	try {
		expect(harness.intervalArmed()).toBe(true);
		replaced = true;
		for (let i = 0; i < 5; i++) {
			await harness.tick();
			harness.advance(10 * 60_000);
		}
		expect(harness.ensureCalls()).toBe(0);
		expect(harness.cleared()).toBe(true);
	} finally {
		await harness.dispose();
	}
});

test("repeated broker recovery failures back off instead of respawning every tick (#6040)", async () => {
	const harness = await startRuntime({ replaced: () => false });
	try {
		// Recovery ticks every 30 s. Over the first 20 minutes (40 ticks) an ungated
		// loop would try 40 spawns; the backoff allows only a handful.
		for (let i = 0; i < 40; i++) {
			await harness.tick();
			harness.advance(30_000);
		}
		const firstTwentyMinutes = harness.ensureCalls();
		expect(firstTwentyMinutes).toBeGreaterThan(0);
		expect(firstTwentyMinutes).toBeLessThanOrEqual(6);

		// Steady state: over the next two hours (240 ticks) the delay has reached its
		// 30-minute ceiling, so only a few more attempts may happen -- but some must,
		// or a broker that comes back would never be re-registered.
		for (let i = 0; i < 240; i++) {
			await harness.tick();
			harness.advance(30_000);
		}
		const steadyState = harness.ensureCalls() - firstTwentyMinutes;
		expect(steadyState).toBeGreaterThan(0);
		expect(steadyState).toBeLessThanOrEqual(5);
		expect(harness.cleared()).toBe(false);
	} finally {
		await harness.dispose();
	}
});

test("failed optional registration still backs off instead of resetting every tick (#6040)", async () => {
	// Startup registration fails; SDK-only sessions do not require it, so it only logs.
	// Recovery then retries through registerBroker(), which also only logs on failure.
	const harness = await startRuntime({ replaced: () => false, failStartupRegistration: true });
	try {
		for (let i = 0; i < 40; i++) {
			await harness.tick();
			harness.advance(30_000);
		}
		// Every attempt fails; a tracker reset on each resolved-but-failed registration
		// would allow one attempt per tick (40).
		expect(harness.ensureCalls()).toBeGreaterThan(0);
		expect(harness.ensureCalls()).toBeLessThanOrEqual(6);
	} finally {
		await harness.dispose();
	}
});

test("overlapping recovery ticks during a slow probe start only one attempt (#6040)", async () => {
	let releaseProbe: (() => void) | undefined;
	let probes = 0;
	const harness = await startRuntime({
		replaced: () => {
			probes++;
			return new Promise<boolean>(resolve => {
				releaseProbe = () => resolve(false);
			});
		},
	});
	try {
		// Three ticks fire while the first probe is still pending.
		await harness.tick();
		await harness.tick();
		await harness.tick();
		expect(probes).toBe(1);
		releaseProbe?.();
		for (let i = 0; i < 20; i++) await Bun.sleep(0);
		expect(harness.ensureCalls()).toBe(1);
	} finally {
		releaseProbe?.();
		await harness.dispose();
	}
});
