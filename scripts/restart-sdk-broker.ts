#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { getAgentDir } from "@gajae-code/utils";
import { brokerProcessIncarnation, readBrokerDiscovery } from "../packages/coding-agent/src/sdk/broker/discovery";
import { ensureBroker } from "../packages/coding-agent/src/sdk/broker/ensure";
import { SdkClient } from "../packages/coding-agent/src/sdk/client";
import {
	restartSdkBroker,
	type RestartSdkBrokerDeps,
	type RestartSdkBrokerOptions,
} from "./restart-sdk-broker-core";

type SessionListEntry = { sessionId?: unknown; pid?: unknown; live?: unknown };

async function withClient<T>(
	discovery: { url: string; token: string },
	use: (client: SdkClient) => Promise<T>,
): Promise<T> {
	const client = await SdkClient.connect(discovery.url, discovery.token);
	try {
		return await use(client);
	} finally {
		await client.close();
	}
}

/**
 * Only `sdk session-host-internal` processes carry broker-spawned session code, so an
 * interactive session that publishes an endpoint from the user's own terminal is never
 * selected for closing.
 */
function isSessionHostProcess(pid: number): boolean {
	if (process.platform === "win32") return false;
	const result = Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)]);
	return result.success && result.stdout.toString().includes("session-host-internal");
}

const defaultDeps: RestartSdkBrokerDeps = {
	readDiscovery: async (agentDir, heartbeatTtlMs) => await readBrokerDiscovery(agentDir, heartbeatTtlMs),
	listSessionHosts: async discovery =>
		await withClient(discovery, async client => {
			const response = (await client.global("session.list", {})) as {
				result?: { sessions?: SessionListEntry[] };
			};
			return (response.result?.sessions ?? [])
				.filter(
					(entry): entry is { sessionId: string; pid: number; live: true } =>
						entry.live === true && typeof entry.sessionId === "string" && typeof entry.pid === "number",
				)
				.filter(entry => isSessionHostProcess(entry.pid))
				.map(entry => entry.sessionId);
		}),
	closeSession: async (discovery, sessionId) => {
		await withClient(
			discovery,
			async client => await client.global("session.close", { sessionId }, { idempotencyKey: randomUUID() }),
		);
	},
	shutdown: async discovery => {
		await withClient(discovery, async client => await client.global("broker.shutdown", {}));
	},
	signal: discovery => {
		if (brokerProcessIncarnation(discovery.pid) !== discovery.incarnation) return;
		process.kill(discovery.pid, "SIGTERM");
	},
	ensure: async agentDir => await ensureBroker({ agentDir }),
	sleep: Bun.sleep,
};

function parseArgs(argv: string[]): RestartSdkBrokerOptions {
	let agentDir = getAgentDir();
	let gracefulTimeoutMs: number | undefined;
	let closeSessionHosts = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--agent-dir") {
			const value = argv[++index];
			if (!value) throw new Error("--agent-dir requires a path.");
			agentDir = value;
			continue;
		}
		if (arg === "--graceful-timeout-ms") {
			const value = argv[++index];
			if (!value || !/^[1-9]\d*$/.test(value)) {
				throw new Error("--graceful-timeout-ms requires a positive integer.");
			}
			gracefulTimeoutMs = Number(value);
			continue;
		}
		if (arg === "--close-session-hosts") {
			closeSessionHosts = true;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return {
		agentDir,
		...(gracefulTimeoutMs === undefined ? {} : { gracefulTimeoutMs }),
		...(closeSessionHosts ? { closeSessionHosts } : {}),
	};
}

if (import.meta.main) {
	const result = await restartSdkBroker(parseArgs(process.argv.slice(2)), defaultDeps);
	const transition = result.previousPid === undefined ? `started ${result.pid}` : `${result.previousPid} -> ${result.pid}`;
	const closed = result.closedSessionIds?.length ?? 0;
	const sessions = result.closedSessionIds ? ` (closed ${closed} session host${closed === 1 ? "" : "s"})` : "";
	console.log(`SDK broker ${transition}${sessions}`);
}
