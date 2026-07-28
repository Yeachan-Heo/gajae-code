const DEFAULT_GRACEFUL_TIMEOUT_MS = 5_000;
const SHUTDOWN_POLL_INTERVAL_MS = 50;

export interface BrokerDiscoveryLike {
	pid: number;
	incarnation: string;
	url: string;
	token: string;
}

export interface RestartSdkBrokerOptions {
	agentDir: string;
	gracefulTimeoutMs?: number;
}

export interface RestartSdkBrokerResult {
	previousPid?: number;
	pid: number;
}

export interface RestartSdkBrokerDeps {
	readDiscovery(agentDir: string, heartbeatTtlMs: number): Promise<BrokerDiscoveryLike | null>;
	shutdown(discovery: BrokerDiscoveryLike): Promise<void>;
	ensure(agentDir: string): Promise<BrokerDiscoveryLike>;
	sleep(ms: number): Promise<void>;
}

export async function restartSdkBroker(
	options: RestartSdkBrokerOptions,
	deps: RestartSdkBrokerDeps,
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
