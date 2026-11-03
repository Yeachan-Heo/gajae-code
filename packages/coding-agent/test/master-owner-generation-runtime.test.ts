import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";
import { createOwnerEndpointGenerationTracker } from "../src/master-mode/first-request";
import { Broker } from "../src/sdk/broker/broker";
import { ensureBroker } from "../src/sdk/broker/ensure";
import { createSdkSessionRuntimeExtension } from "../src/sdk/host/session-runtime";

// The master peer snapshot tells its own stale owner row from an independent
// resume by endpoint generation (#7459). This drives the production SDK session
// runtime against a real Broker: the host's broker registration must reach the
// tracker `createAgentSession` wires in, and a post-switch registration of the
// new session must not overwrite the owner's generation.

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

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

/** One SDK session runtime (one process's host) wired the way `createAgentSession` wires a master. */
function startRuntime(agentDir: string, onBrokerRegistered: (sessionId: string, generation: number) => void) {
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, context: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	createSdkSessionRuntimeExtension(api, {
		agentDir,
		ensureBrokerImpl: ensureBroker,
		onBrokerRegistered,
		setIntervalImpl: (() => ({}) as NodeJS.Timeout) as unknown as typeof setInterval,
		clearIntervalImpl: (() => {}) as typeof clearInterval,
		createTransport: async ({ sessionId, stateRoot, token }) => ({
			sessionId,
			stateRoot,
			token,
			onFrame: () => undefined,
			sendFrame: () => undefined,
			start: async () => {
				const endpoint = path.join(stateRoot, "sdk", `${sessionId}.json`);
				await fs.mkdir(path.dirname(endpoint), { recursive: true });
				await fs.writeFile(
					endpoint,
					JSON.stringify({ sessionId, pid: process.pid, url: "ws://127.0.0.1:1", token }),
				);
				return { url: "ws://127.0.0.1:1" };
			},
			stop: async () => {},
		}),
	});
	const handler = (name: string) => {
		const found = handlers.get(name);
		if (!found) throw new Error(`SDK lifecycle handler ${name} was not installed.`);
		return found;
	};
	return {
		start: (context: ExtensionContext) => handler("session_start")({}, context),
		switchTo: (context: ExtensionContext) => handler("session_switch")({}, context),
		stop: (context: ExtensionContext) => handler("session_shutdown")({}, context),
	};
}

test("the owner's broker-registered generation reaches the master tracker and survives a switch", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-generation-"));
	const agentDir = path.join(root, "agent");
	const cwd = await fs.mkdtemp(path.join(root, "project-"));
	const broker = new Broker({ agentDir });
	await broker.start();
	cleanups.push(async () => {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	});
	const owner = `owner-${path.basename(root)}`;
	const switched = `switched-${path.basename(root)}`;

	// No startup (lifecycle rollback) generation: an interactive master.
	const tracker = createOwnerEndpointGenerationTracker(owner, () => undefined);
	const registrations: [string, number][] = [];
	const master = startRuntime(agentDir, (sessionId, generation) => {
		registrations.push([sessionId, generation]);
		tracker.record(sessionId, generation);
	});

	await master.start(sdkContext(owner, cwd));
	const ownerGeneration = await waitFor(() => tracker.get(), "the owner registration");
	expect(registrations).toEqual([[owner, ownerGeneration]]);

	// The switch stops the owner's host and registers the new session's host.
	await master.switchTo(sdkContext(switched, cwd));
	await waitFor(() => registrations.find(([sessionId]) => sessionId === switched), "the switched registration");
	expect(tracker.get()).toBe(ownerGeneration);

	// Another process resuming the owner session is issued a newer generation for it.
	const resumedGenerations: number[] = [];
	const resumed = startRuntime(agentDir, (sessionId, generation) => {
		if (sessionId === owner) resumedGenerations.push(generation);
	});
	await resumed.start(sdkContext(owner, cwd));
	const resumedGeneration = await waitFor(() => resumedGenerations[0], "the resumed registration");
	expect(resumedGeneration).toBeGreaterThan(ownerGeneration);
	expect(tracker.get()).toBe(ownerGeneration);

	await resumed.stop(sdkContext(owner, cwd));
	await master.stop(sdkContext(switched, cwd));
}, 30_000);

test("the tracker prefers the latest owner registration over the startup generation", () => {
	let startup: number | null | undefined = 3;
	const tracker = createOwnerEndpointGenerationTracker("owner", () => startup);
	expect(tracker.get()).toBe(3);
	tracker.record("other", 9);
	expect(tracker.get()).toBe(3);
	tracker.record("owner", 4);
	expect(tracker.get()).toBe(4);
	tracker.record("owner", 5);
	expect(tracker.get()).toBe(5);
	startup = null;
	expect(createOwnerEndpointGenerationTracker("owner", () => startup).get()).toBeUndefined();
});
