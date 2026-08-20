import { logger } from "@gajae-code/utils";
import { ensureBroker } from "../broker/ensure";
import { resolveSdkPackageGeneration } from "../broker/runtime";
import { SdkClient } from "../client/client";
import { readSdkBrokerDiscovery } from "../client/discovery";
import {
	type SessionLifecycleClient,
	type SessionLifecycleClientRequestOptions,
	type SessionLifecycleOperation,
	SessionLifecycleService,
} from "./service";

/** SDK-core Broker client that keeps Broker credentials inside the lifecycle boundary. */
export class AgentDirSessionLifecycleClient implements SessionLifecycleClient {
	readonly #agentDir: string;

	constructor(agentDir: string) {
		this.#agentDir = agentDir;
	}

	async global(
		operation: SessionLifecycleOperation,
		input: Record<string, unknown>,
		options: SessionLifecycleClientRequestOptions,
	): Promise<unknown> {
		await ensureBroker({ agentDir: this.#agentDir, expectedPackageGeneration: resolveSdkPackageGeneration() });
		const discovery = await readSdkBrokerDiscovery(this.#agentDir);
		if (!discovery) throw new Error("SDK broker discovery is unavailable.");
		const client = await SdkClient.connect(discovery.url, discovery.token, {
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		});
		let result: unknown;
		try {
			result = await client.global(operation, input, {
				...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
				...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
			});
		} finally {
			try {
				await client.close();
			} catch (error) {
				logger.warn("SDK lifecycle client cleanup failed", {
					operation,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return result;
	}
}

export function createBrokerSessionLifecycleService(agentDir: string): SessionLifecycleService {
	return new SessionLifecycleService(new AgentDirSessionLifecycleClient(agentDir));
}
