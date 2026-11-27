import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import { allocateSessionEventGeneration, SessionIndex, type SessionLocatorV2 } from "../src/sdk/broker/session-index";
import { SessionSdkHost } from "../src/sdk/host";
import { type SessionAttachment, SessionRouter, type SessionRouterClient } from "../src/sdk/router";

const tempDirs: string[] = [];
const hostIncarnation = processIncarnation(process.pid);
if (!hostIncarnation) throw new Error("Current process incarnation is unavailable.");

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

const HOUR_MS = 60 * 60 * 1_000;

async function fixture(sessionId: string) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-event-generation-"));
	tempDirs.push(cwd);
	const agentDir = path.join(cwd, ".gjc", "agent");
	const locator: SessionLocatorV2 = { cwd, worktreeRoot: null, stateRoot: path.join(cwd, ".gjc", "state") };
	const endpointFile = path.join(locator.stateRoot, "sdk", `${sessionId}.json`);
	await fs.mkdir(path.dirname(endpointFile), { recursive: true });
	await Bun.write(
		endpointFile,
		JSON.stringify({ sessionId, url: "ws://generation.test", token: "secret", pid: process.pid }),
	);
	const endpointMtimeMs = (await fs.stat(endpointFile)).mtimeMs;
	const index = await new SessionIndex(agentDir).open();
	return { agentDir, endpointMtimeMs, index, locator };
}

/**
 * A host as a new process starts it: a fresh event stream whose generation comes
 * from the agent-dir authority with at least the simulated `wallClock` floor,
 * published to the session index the way the production broker writer publishes it.
 */
async function startHost(
	context: Awaited<ReturnType<typeof fixture>>,
	sessionId: string,
	wallClock: number,
): Promise<SessionSdkHost> {
	const { agentDir, endpointMtimeMs, index, locator } = context;
	const host = new SessionSdkHost({
		sessionId,
		stateRoot: locator.stateRoot,
		token: "secret",
		allocateEventGeneration: (id, floor) => allocateSessionEventGeneration(agentDir, id, Math.max(floor, wallClock)),
		sendFrame: () => "written",
		onFrame: () => () => {},
	});
	const identity = { sessionId, locator, pid: process.pid, endpointMtimeMs, hostIncarnation };
	await host.registerWithBroker({
		register: async ({ endpointGeneration }) => {
			await index.append({ type: "host_registered", ...identity, endpointGeneration });
		},
		unregister: async ({ endpointGeneration }) => {
			await index.append({ type: "host_unregistered", ...identity, endpointGeneration });
		},
	});
	await host.start();
	return host;
}

/** Router fixture over the real index; the session transport is the only fake. */
function attachingRouter(agentDir: string, index: SessionIndex) {
	const attachments: SessionAttachment[] = [];
	const client = (): SessionRouterClient => ({
		onFrame: () => () => {},
		onReconnect: () => () => {},
		request: async operation =>
			operation.type === "event_replay"
				? { ok: true, generation: operation.sinceGeneration, lastSeq: 0, events: [] }
				: { events: [] },
		close: async () => {},
		send: () => {},
	});
	const router = new SessionRouter({
		agentDir,
		deps: {
			createIndex: () => index,
			createClient: async () => client(),
			onAttachment: attachment => {
				attachments.push(attachment);
			},
			setInterval: (() => 0) as unknown as typeof setInterval,
			clearInterval: (() => {}) as unknown as typeof clearInterval,
		},
	});
	return { attachments, router };
}

describe("SDK event generation authority", () => {
	test("a host resumed after the wall clock stepped backward outranks the retained earlier host", async () => {
		const sessionId = "clock-regression-session";
		const context = await fixture(sessionId);
		// The earlier host started while the clock read an hour ahead, then exited
		// and left its terminal identity retained in the index.
		const earlier = await startHost(context, sessionId, Date.now() + HOUR_MS);
		const earlierGeneration = earlier.generation;
		await earlier.stop();

		const resumed = await startHost(context, sessionId, Date.now());
		expect(resumed.generation).toBeGreaterThan(earlierGeneration);

		await context.index.refresh();
		expect(context.index.listSessions().sessions.find(session => session.sessionId === sessionId)).toMatchObject({
			endpointGeneration: resumed.generation,
			live: true,
		});
		const { attachments, router } = attachingRouter(context.agentDir, context.index);
		try {
			await router.start();
			expect(await router.generationStatus(sessionId, resumed.generation)).toMatchObject({ status: "current" });
			expect(attachments.map(attachment => [attachment.sessionId, attachment.generation])).toEqual([
				[sessionId, resumed.generation],
			]);
		} finally {
			await router.stop();
			await resumed.stop();
		}
	});

	test("hosts started in the same millisecond open distinct generations", async () => {
		const sessionId = "same-millisecond-session";
		const context = await fixture(sessionId);
		const wallClock = Date.now();
		const [first, second] = await Promise.all([
			startHost(context, sessionId, wallClock),
			startHost(context, sessionId, wallClock),
		]);
		expect(new Set([first.generation, second.generation]).size).toBe(2);
		expect(Math.min(first.generation, second.generation)).toBeGreaterThanOrEqual(wallClock);
		await Promise.all([first.stop(), second.stop()]);
	});

	test("independent processes allocating in the same millisecond receive distinct increasing generations", async () => {
		const sessionId = "cross-process-session";
		const { agentDir } = await fixture(sessionId);
		const wallClock = Date.now();
		const moduleUrl = new URL("../src/sdk/broker/session-index.ts", import.meta.url).href;
		const script = [
			`const { allocateSessionEventGeneration } = await import(${JSON.stringify(moduleUrl)});`,
			`process.stdout.write(String(await allocateSessionEventGeneration(${JSON.stringify(agentDir)}, ${JSON.stringify(sessionId)}, ${wallClock})));`,
		].join("\n");
		const workers = Array.from({ length: 4 }, () =>
			Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }),
		);
		const outputs = await Promise.all(
			workers.map(async worker => {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(worker.stdout).text(),
					new Response(worker.stderr).text(),
					worker.exited,
				]);
				if (exitCode !== 0) throw new Error(`allocation worker failed (${exitCode}): ${stderr}`);
				return Number(stdout);
			}),
		);
		expect(outputs.toSorted((a, b) => a - b)).toEqual([wallClock, wallClock + 1, wallClock + 2, wallClock + 3]);
		// A later start with the clock stepped back still continues above them.
		expect(await allocateSessionEventGeneration(agentDir, sessionId, wallClock - HOUR_MS)).toBe(wallClock + 4);
	}, 30_000);

	test("a host started without a usable agent dir publishes only a generation the recovered authority still owns", async () => {
		const sessionId = "unusable-agent-dir-session";
		const context = await fixture(sessionId);
		const blocked = path.join(path.dirname(context.agentDir), "blocked-agent");
		await Bun.write(blocked, "blocked");
		let authorityDir = blocked;
		const registered: number[] = [];
		const createHost = () =>
			new SessionSdkHost({
				sessionId,
				stateRoot: context.locator.stateRoot,
				token: "secret",
				allocateEventGeneration: (id, floor) => allocateSessionEventGeneration(authorityDir, id, floor),
				sendFrame: () => "written",
				onFrame: () => () => {},
			});
		const writer = {
			register: ({ endpointGeneration }: { endpointGeneration: number }) => void registered.push(endpointGeneration),
		};

		const degraded = createHost();
		await degraded.start();
		await expect(degraded.registerWithBroker(writer)).rejects.toThrow();
		authorityDir = context.agentDir;
		await degraded.registerWithBroker(writer);
		expect(registered).toEqual([degraded.generation]);
		// The reservation advanced the high-water mark past the degraded host.
		const next = createHost();
		await next.start();
		expect(next.generation).toBeGreaterThan(degraded.generation);
		await Promise.all([degraded.stop(), next.stop()]);

		// A degraded host whose generation the authority has since issued stays unpublished.
		authorityDir = blocked;
		const superseded = createHost();
		await superseded.start();
		authorityDir = context.agentDir;
		await allocateSessionEventGeneration(context.agentDir, sessionId, superseded.generation);
		await expect(superseded.registerWithBroker(writer)).rejects.toThrow("was superseded");
		expect(registered).toEqual([degraded.generation]);
		await superseded.stop();
	});

	test("a restart after failed reservation allocates the exact published generation despite clock regression", async () => {
		const sessionId = "restart-after-reservation-failure";
		const context = await fixture(sessionId);
		const blocked = path.join(path.dirname(context.agentDir), "blocked-restart-agent");
		await Bun.write(blocked, "blocked");
		let authorityDir = blocked;
		const registered: number[] = [];
		const host = new SessionSdkHost({
			sessionId,
			stateRoot: context.locator.stateRoot,
			token: "secret",
			allocateEventGeneration: (id, floor) => allocateSessionEventGeneration(authorityDir, id, floor),
			sendFrame: () => "written",
			onFrame: () => () => {},
		});
		const writer = {
			register: async ({ endpointGeneration }: { endpointGeneration: number }) => {
				registered.push(endpointGeneration);
				await context.index.append({
					type: "host_registered",
					sessionId,
					locator: context.locator,
					pid: process.pid,
					endpointMtimeMs: context.endpointMtimeMs,
					hostIncarnation,
					endpointGeneration,
				});
			},
		};
		const now = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(now + HOUR_MS);
		try {
			await host.start();
			const fallback = host.generation;
			await expect(host.registerWithBroker(writer)).rejects.toThrow();
			expect(registered).toEqual([]);
			await host.stop();

			clock.mockReturnValue(now);
			authorityDir = context.agentDir;
			await host.start();
			expect(host.generation).toBe(fallback + 1);
			expect(registered).toEqual([host.generation]);
			await context.index.refresh();
			expect(context.index.listSessions().sessions.find(session => session.sessionId === sessionId)).toMatchObject({
				endpointGeneration: host.generation,
				live: true,
			});
			expect(await allocateSessionEventGeneration(context.agentDir, sessionId, now)).toBe(host.generation + 1);
		} finally {
			clock.mockRestore();
			await host.stop();
		}
	});

	test("an unreadable high-water record fails closed instead of restarting from the wall clock", async () => {
		const sessionId = "unreadable-record-session";
		const { agentDir } = await fixture(sessionId);
		const first = await allocateSessionEventGeneration(agentDir, sessionId, 10);
		expect(first).toBe(10);
		const [record] = await fs.readdir(path.join(agentDir, "sdk", "event-generations"));
		if (!record) throw new Error("Expected a persisted high-water record.");
		const recordPath = path.join(agentDir, "sdk", "event-generations", record);
		await Bun.write(recordPath, "{");
		await expect(allocateSessionEventGeneration(agentDir, sessionId, 20)).rejects.toThrow(
			"SDK event generation record is unreadable",
		);
		await Bun.write(recordPath, JSON.stringify({ version: 1, sessionId: "another-session", generation: 99 }));
		await expect(allocateSessionEventGeneration(agentDir, sessionId, 20)).rejects.toThrow(
			"SDK event generation record is unreadable",
		);
	});
});
