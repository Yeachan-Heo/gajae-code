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
	/** Close the broker-hosted session processes before replacing the broker. */
	closeSessionHosts?: boolean;
}

export interface RestartSdkBrokerResult {
	previousPid?: number;
	pid: number;
	closedSessionIds?: string[];
}

export interface RestartSdkBrokerDeps {
	readDiscovery(agentDir: string, heartbeatTtlMs: number): Promise<BrokerDiscoveryLike | null>;
	/** Live sessions served by a `sdk session-host-internal` process; never interactive sessions. */
	listSessionHosts(discovery: BrokerDiscoveryLike): Promise<string[]>;
	closeSession(discovery: BrokerDiscoveryLike, sessionId: string): Promise<void>;
	shutdown(discovery: BrokerDiscoveryLike): Promise<void>;
	/** Identity-fenced SIGTERM for brokers that predate the `broker.shutdown` operation. */
	signal(discovery: BrokerDiscoveryLike): void;
	ensure(agentDir: string): Promise<BrokerDiscoveryLike>;
	sleep(ms: number): Promise<void>;
}

function isUnknownOperation(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === "unknown_operation";
}

/**
 * Older published brokers answer `broker.shutdown` with `unknown_operation`; their
 * process still stops its published identity on SIGTERM, so fall back to that.
 */
async function stopPreviousBroker(discovery: BrokerDiscoveryLike, deps: RestartSdkBrokerDeps): Promise<void> {
	try {
		await deps.shutdown(discovery);
	} catch (error) {
		if (!isUnknownOperation(error)) throw error;
		deps.signal(discovery);
	}
}

/**
 * Session hosts outlive the broker that spawned them, so a broker-only restart keeps
 * serving whatever source those processes started with. Closing them through the live
 * broker reuses its verified-identity teardown instead of signalling pids from here.
 */
async function closeSessionHosts(discovery: BrokerDiscoveryLike, deps: RestartSdkBrokerDeps): Promise<string[]> {
	const sessionIds = await deps.listSessionHosts(discovery);
	for (const sessionId of sessionIds) await deps.closeSession(discovery, sessionId);
	return sessionIds;
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
	let closedSessionIds: string[] | undefined;
	if (previous) {
		if (options.closeSessionHosts) closedSessionIds = await closeSessionHosts(previous, deps);
		await stopPreviousBroker(previous, deps);
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
	return {
		...(previous ? { previousPid: previous.pid } : {}),
		pid: replacement.pid,
		...(closedSessionIds ? { closedSessionIds } : {}),
	};
}
