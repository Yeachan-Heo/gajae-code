import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { ChatDaemonRuntime } from "../src/sdk/bus/chat-daemon-runtime";
import { HEARTBEAT_TTL_MS } from "../src/sdk/bus/daemon-paths";
import type { SlackProviderClient } from "../src/sdk/bus/slack-provider";
import { ACP_SESSION_RECONNECT } from "../src/sdk/session-reconnect";
import { drainReconnects, expectedBackoffs, FakeWebSocket, withFakeTransport } from "./helpers/fake-sdk-transport";

const SESSION_ID = "chat-reconnect-session";
const GENERATION = 4;

class FakeSlackProvider implements SlackProviderClient {
	readonly transportHealthy = true;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async ack(): Promise<void> {}
	async postMessage(input: {
		channel: string;
		text: string;
		threadTs?: string;
		clientMsgId: string;
	}): Promise<{ channel: string; ts: string; client_msg_id: string }> {
		return { channel: input.channel, ts: "7.1", client_msg_id: input.clientMsgId };
	}
	async findMessageByClientMsgId(): Promise<null> {
		return null;
	}
	async findMessageByTimestamp(): Promise<null> {
		return null;
	}
}

/**
 * Runs the real attach path: one live indexed session with a readable, non-stale
 * discovery endpoint, and no `createClient` override, so the runtime connects its
 * attached-session client itself.
 */
async function withAttachedSessionRuntime(run: (runtime: ChatDaemonRuntime) => Promise<void>): Promise<void> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-chat-reconnect-"));
	let runtime: ChatDaemonRuntime | undefined;
	try {
		const stateRoot = path.join(agentDir, ".gjc", "state");
		const endpointFile = path.join(stateRoot, "sdk", `${SESSION_ID}.json`);
		await fs.mkdir(path.dirname(endpointFile), { recursive: true });
		await fs.writeFile(
			endpointFile,
			`${JSON.stringify({ version: 1, url: "ws://localhost:1/", token: "not-persisted", pid: process.pid })}\n`,
		);
		const endpointMtimeMs = (await fs.stat(endpointFile)).mtimeMs;
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: SESSION_ID,
			locator: { repo: agentDir, stateRoot },
			endpointGeneration: GENERATION,
			pid: process.pid,
			endpointMtimeMs,
		});

		runtime = new ChatDaemonRuntime(
			{
				kind: "slack",
				agentDir,
				config: {
					identity: "test-identity",
					notifications: {
						slack: {
							botToken: "xoxb-not-persisted",
							appToken: "xapp-not-persisted",
							workspaceId: "T1",
							channelId: "C1",
						},
					},
				},
			},
			{
				createSlackProvider: () => new FakeSlackProvider(),
				setInterval: (() => 0) as unknown as typeof setInterval,
				clearInterval: (() => undefined) as unknown as typeof clearInterval,
			},
		);
		await run(runtime);
	} finally {
		await runtime?.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

/** The runtime does its index and endpoint IO before it dials, so wait for the dial. */
async function awaitFirstSocket(): Promise<void> {
	for (let attempt = 0; attempt < 2_000 && FakeWebSocket.instances.length === 0; attempt++) await Bun.sleep(1);
	expect(FakeWebSocket.instances).toHaveLength(1);
}

test("an attached chat session reconnects on a budget that outlives the host heartbeat TTL", async () => {
	await withAttachedSessionRuntime(async runtime => {
		await withFakeTransport(async clock => {
			const starting = runtime.start();
			await awaitFirstSocket();
			const observed = await drainReconnects(clock);
			await expect(starting).rejects.toMatchObject({ code: "reconnect_exhausted" });

			// The attached-session client must follow the shared long-lived schedule,
			// not the transport's one-shot defaults (3 attempts, 25/50/100ms = 175ms).
			expect(observed).toEqual(expectedBackoffs(ACP_SESSION_RECONNECT));
			expect(FakeWebSocket.instances).toHaveLength(ACP_SESSION_RECONNECT.reconnectAttempts + 1);
			expect(observed.slice(0, 5)).toEqual([250, 500, 1_000, 2_000, 2_000]);
			expect(Math.max(...observed)).toBe(2_000);

			// The host reaps a session whose client has not ponged within
			// HEARTBEAT_TTL_MS, so the whole retry window must cover that TTL twice.
			const totalBudgetMs = observed.reduce((total, backoff) => total + backoff, 0);
			expect(totalBudgetMs).toBeGreaterThanOrEqual(2 * HEARTBEAT_TTL_MS);
			expect(observed.length).toBeGreaterThan(3);
		});
	});
}, 20_000);
