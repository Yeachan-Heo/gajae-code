import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { openLifecycleSessionManager } from "../src/commands/sdk";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { Broker } from "../src/sdk/broker/broker";
import {
	deriveLifecycleDeadlines,
	readSessionLifecycleLaunchRequest,
	type SessionLifecycleLaunchRequest,
} from "../src/sdk/broker/lifecycle";
import { SdkClient } from "../src/sdk/client";
import { resolveServeSession, runSdkServe } from "../src/sdk/transport/serve-cli";

describe("ephemeral lifecycle host startup", () => {
	let root: string;
	let previousSessionId: string | undefined;
	let previousLifecycleRequestId: string | undefined;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ephemeral-host-"));
		previousSessionId = process.env.GJC_SESSION_ID;
		previousLifecycleRequestId = process.env.GJC_LIFECYCLE_REQUEST_ID;
		// Match the preallocated identity supplied to a real lifecycle host.
		process.env.GJC_SESSION_ID = "ephemeral-fixture";
		process.env.GJC_LIFECYCLE_REQUEST_ID = "ephemeral-fixture-marker";
	});
	afterEach(async () => {
		if (previousSessionId === undefined) delete process.env.GJC_SESSION_ID;
		else process.env.GJC_SESSION_ID = previousSessionId;
		if (previousLifecycleRequestId === undefined) delete process.env.GJC_LIFECYCLE_REQUEST_ID;
		else process.env.GJC_LIFECYCLE_REQUEST_ID = previousLifecycleRequestId;
		await fs.rm(root, { recursive: true, force: true });
	});

	function request(ephemeral: boolean): SessionLifecycleLaunchRequest {
		return {
			operation: "session.create",
			sessionId: "ephemeral-fixture",
			cwd: root,
			stateRoot: path.join(root, ".gjc", "state"),
			effectMarker: "ephemeral-fixture-marker",
			...deriveLifecycleDeadlines(Date.now(), 30_000),
			ephemeral,
		};
	}

	it("rejects a nonboolean persistence flag", () => {
		expect(() => readSessionLifecycleLaunchRequest(JSON.stringify({ ...request(true), ephemeral: "true" }))).toThrow(
			"invalid",
		);
	});

	for (const ephemeral of [true, false]) {
		it(`${ephemeral ? "ephemeral" : "persistent"} host selects the appropriate transcript storage`, async () => {
			const agentDir = path.join(root, "agent");
			const { sessionManager } = await openLifecycleSessionManager(request(ephemeral), root, agentDir);
			if (!ephemeral) {
				// Ordinary create defers manager construction to createAgentSession.
				expect(sessionManager).toBeUndefined();
				return;
			}
			if (!sessionManager) throw new Error("Host did not return a session manager");
			try {
				sessionManager.appendMessage({ role: "user", content: "temporary fixture message", timestamp: Date.now() });
				await sessionManager.ensureOnDisk();
				const files = await fs.readdir(root, { recursive: true });
				expect(files.filter(file => file.endsWith(".jsonl"))).toEqual([]);
				expect(sessionManager.getEntries().length).toBeGreaterThan(0);
			} finally {
				await sessionManager.close();
			}
		});
	}

	it("rejects an ephemeral fork at the actual host entry point", async () => {
		const fork: SessionLifecycleLaunchRequest = {
			...request(true),
			operation: "session.fork",
			sourceSessionId: "source-session",
			sourceSessionPath: path.join(root, "source.jsonl"),
		};
		await expect(openLifecycleSessionManager(fork, root, path.join(root, "agent"))).rejects.toThrow(
			"Ephemeral sessions cannot be created via session.fork operations",
		);
	});

	it("public ACP attach and sdk serve --session refuse an indexed temporary ID", async () => {
		const agentDir = path.join(root, "agent");
		const broker = new Broker({ agentDir });
		const abort = new AbortController();
		const agent = new AcpAgent({ signal: abort.signal } as unknown as AgentSideConnection, { agentDir });
		let client: SdkClient | undefined;
		let transportStarts = 0;
		try {
			const discovery = await broker.start();
			await broker.index.append({
				type: "host_registered",
				sessionId: "private-temporary",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				endpointGeneration: 1,
				pid: process.pid,
				ephemeral: true,
			});
			client = await SdkClient.connect(discovery.url, discovery.token, { reconnectAttempts: 0 });
			await expect(resolveServeSession(client, "private-temporary")).rejects.toMatchObject({ code: "not_found" });
			const startTransport = async (): Promise<never> => {
				transportStarts++;
				throw new Error("A temporary session must not start a public relay");
			};
			await expect(
				runSdkServe(["--stdio", "--session", "private-temporary"], {
					readDiscovery: async () => discovery,
					connect: async () => SdkClient.connect(discovery.url, discovery.token, { reconnectAttempts: 0 }),
					startStdio: startTransport,
					startSocket: startTransport,
				}),
			).rejects.toMatchObject({ input: { kind: "unavailable", proof: "pre-effect" } });
			expect(transportStarts).toBe(0);
			for (const attach of [agent.loadSession.bind(agent), agent.resumeSession.bind(agent)]) {
				await expect(attach({ sessionId: "private-temporary", cwd: root, mcpServers: [] })).rejects.toMatchObject({
					code: "not_found",
				});
			}
		} finally {
			abort.abort();
			await client?.close();
			await broker.stop();
		}
	});
});
