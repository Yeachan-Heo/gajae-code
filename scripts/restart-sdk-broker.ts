#!/usr/bin/env bun

import { getAgentDir } from "@gajae-code/utils";
import type { BrokerDiscovery } from "../packages/coding-agent/src/sdk/broker/discovery";
import { readBrokerDiscovery } from "../packages/coding-agent/src/sdk/broker/discovery";
import { ensureBroker } from "../packages/coding-agent/src/sdk/broker/ensure";
import { SdkClient } from "../packages/coding-agent/src/sdk/client";

const DEFAULT_GRACEFUL_TIMEOUT_MS = 5_000;
const SHUTDOWN_POLL_INTERVAL_MS = 50;


export interface RestartSdkBrokerOptions {
	agentDir: string;
	gracefulTimeoutMs?: number;
}

export interface RestartSdkBrokerResult {
	previousPid?: number;
	pid: number;
}

export interface RestartSdkBrokerDeps {
	readDiscovery(agentDir: string, heartbeatTtlMs: number): Promise<BrokerDiscovery | null>;
	shutdown(discovery: BrokerDiscovery): Promise<void>;
	ensure(agentDir: string): Promise<BrokerDiscovery>;
	sleep(ms: number): Promise<void>;
}

const defaultDeps: RestartSdkBrokerDeps = {
	readDiscovery: async (agentDir, heartbeatTtlMs) => await readBrokerDiscovery(agentDir, heartbeatTtlMs),
	shutdown: async discovery => {
		const client = await SdkClient.connect(discovery.url, discovery.token);
		try {
			await client.global("broker.shutdown", {});
		} finally {
			await client.close();
		}
	},
	ensure: async agentDir => await ensureBroker({ agentDir }),
	sleep: Bun.sleep,
};

export async function restartSdkBroker(
	options: RestartSdkBrokerOptions,
	deps: RestartSdkBrokerDeps = defaultDeps,
): Promise<RestartSdkBrokerResult> {
	const gracefulTimeoutMs = options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;
	if (!Number.isSafeInteger(gracefulTimeoutMs) || gracefulTimeoutMs <= 0) {
		throw new Error("gracefulTimeoutMs must be a positive safe integer.");
	}

	const previous = await deps.readDiscovery(options.agentDir, Number.POSITIVE_INFINITY);
	if (previous) {
		await deps.shutdown(previous);
		const deadline = Date.now() + gracefulTimeoutMs;
		while (Date.now() < deadline) {
			const current = await deps.readDiscovery(options.agentDir, Number.POSITIVE_INFINITY);
			if (!current || current.pid !== previous.pid || current.incarnation !== previous.incarnation) break;
			await deps.sleep(SHUTDOWN_POLL_INTERVAL_MS);
		}
		const current = await deps.readDiscovery(options.agentDir, Number.POSITIVE_INFINITY);
		if (current?.pid === previous.pid && current.incarnation === previous.incarnation) {
			throw new Error(`SDK broker pid ${previous.pid} did not complete its authenticated shutdown.`);
		}
	}

	const replacement = await deps.ensure(options.agentDir);
	if (previous && replacement.pid === previous.pid && replacement.incarnation === previous.incarnation) {
		throw new Error("SDK broker restart returned the previous process identity.");
	}
	return { ...(previous ? { previousPid: previous.pid } : {}), pid: replacement.pid };
}

function parseArgs(argv: string[]): RestartSdkBrokerOptions {
	let agentDir = getAgentDir();
	let gracefulTimeoutMs: number | undefined;
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
		throw new Error(`Unknown argument: ${arg}`);
	}
	return { agentDir, ...(gracefulTimeoutMs === undefined ? {} : { gracefulTimeoutMs }) };
}

if (import.meta.main) {
	const result = await restartSdkBroker(parseArgs(process.argv.slice(2)));
	const transition = result.previousPid === undefined ? `started ${result.pid}` : `${result.previousPid} -> ${result.pid}`;
	console.log(`SDK broker ${transition}`);
}
