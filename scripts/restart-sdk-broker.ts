#!/usr/bin/env bun

import { getAgentDir } from "@gajae-code/utils";
import { readBrokerDiscovery } from "../packages/coding-agent/src/sdk/broker/discovery";
import { ensureBroker } from "../packages/coding-agent/src/sdk/broker/ensure";
import { SdkClient } from "../packages/coding-agent/src/sdk/client";
import {
	restartSdkBroker,
	type RestartSdkBrokerDeps,
	type RestartSdkBrokerOptions,
} from "./restart-sdk-broker-core";

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
	const result = await restartSdkBroker(parseArgs(process.argv.slice(2)), defaultDeps);
	const transition = result.previousPid === undefined ? `started ${result.pid}` : `${result.previousPid} -> ${result.pid}`;
	console.log(`SDK broker ${transition}`);
}
