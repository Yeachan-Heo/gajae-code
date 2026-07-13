import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { readSdkSessionEndpoint, SdkClient } from "../sdk/client";
import type { HarnessSessionTransport, SessionStateSnapshot } from "./session-transport";

const DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_POLL_MS = 50;
const TERM_GRACE_MS = 2_000;
const KILL_VERIFY_MS = 1_000;

export class HarnessSdkTransportError extends Error {
	constructor(
		readonly code: "endpoint_unavailable" | "invalid_response",
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "HarnessSdkTransportError";
	}
}

export interface SpawnedHarnessSession {
	stop(): Promise<void>;
}

export interface CreateSdkSessionTransportOptions {
	repo: string;
	sessionId: string;
	/** Starts the normal GJC session before discovery. Test callers may provide a deterministic SDK host. */
	spawn?: () => SpawnedHarnessSession | Promise<SpawnedHarnessSession>;
	discoveryTimeoutMs?: number;
	/** Test seam: inject SDK client/endpoint resolution to avoid a process-global module mock. */
	connect?: typeof SdkClient.connect;
	readEndpoint?: (repo: string, sessionId: string) => Promise<{ url: string; token: string } | null>;
}

function invalidResponse(detail: string): never {
	throw new HarnessSdkTransportError("invalid_response", detail);
}

function record(value: unknown, detail = "SDK returned a non-object response."): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse(detail);
	return value as Record<string, unknown>;
}

function stringAt(value: Record<string, unknown>, key: string, detail: string): string {
	const candidate = value[key];
	if (typeof candidate !== "string" || candidate.length === 0) invalidResponse(detail);
	return candidate;
}

function nonNegativeIntegerAt(value: Record<string, unknown>, key: string, detail: string): number {
	const candidate = value[key];
	if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) invalidResponse(detail);
	return candidate;
}

function queryItem(value: unknown, query: string): Record<string, unknown> {
	const response = record(value, `SDK ${query} response was not an object.`);
	if (response.type !== "query_response" || response.ok !== true || typeof response.id !== "string")
		invalidResponse(`SDK ${query} response had an invalid envelope.`);
	const page = record(response.page, `SDK ${query} response was missing a page.`);
	if (page.complete !== true || typeof page.revision !== "string")
		invalidResponse(`SDK ${query} response had an invalid page.`);
	const items = page.items;
	if (!Array.isArray(items) || items.length !== 1)
		invalidResponse(`SDK ${query} response did not contain exactly one item.`);
	return record(items[0], `SDK ${query} response item was not an object.`);
}

function metadataItem(value: unknown): void {
	const metadata = queryItem(value, "session.metadata");
	for (const key of ["sessionId", "name", "cwd", "kind"])
		stringAt(metadata, key, "SDK session.metadata response was missing required fields.");
}

function contextItem(value: unknown): SessionStateSnapshot {
	const context = queryItem(value, "context.get");
	if (typeof context.isStreaming !== "boolean") invalidResponse("SDK context.get response was missing isStreaming.");
	return {
		isStreaming: context.isStreaming,
		steeringQueueDepth: nonNegativeIntegerAt(
			context,
			"steeringQueueDepth",
			"SDK context.get response had an invalid steeringQueueDepth.",
		),
		followupQueueDepth: nonNegativeIntegerAt(
			context,
			"followupQueueDepth",
			"SDK context.get response had an invalid followupQueueDepth.",
		),
	};
}

function replayEvents(value: unknown): Record<string, unknown>[] {
	const response = record(value, "SDK event replay response was not an object.");
	if (response.type !== "event_replay_result" || response.ok !== true || typeof response.id !== "string")
		invalidResponse("SDK event replay response had an invalid envelope.");
	nonNegativeIntegerAt(response, "generation", "SDK event replay response had an invalid generation.");
	nonNegativeIntegerAt(response, "lastSeq", "SDK event replay response had an invalid lastSeq.");
	if (!Array.isArray(response.events)) invalidResponse("SDK event replay response was missing events.");
	return response.events.map(event => record(event, "SDK event replay response contained a malformed event."));
}

function acceptedPrompt(value: unknown): string {
	const response = record(value, "SDK control response was not an object.");
	if (response.type !== "control_response" || response.ok !== true || typeof response.id !== "string")
		invalidResponse("SDK control response had an invalid envelope.");
	const result = record(response.result, "SDK control response was missing a result.");
	// Only a literal accepted:true acknowledges the prompt; false, missing, or
	// any non-boolean value is a contract violation, never a silent acceptance.
	if (result.accepted !== true) invalidResponse("SDK control response did not accept the prompt.");
	return stringAt(result, "commandId", "SDK control response was missing commandId.");
}

function sdkEventToAgentWire(frame: Record<string, unknown>): Record<string, unknown> {
	if (frame.type !== "event") return frame;
	const payload = frame.payload;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return frame;
	const event = payload as Record<string, unknown>;
	const eventType =
		typeof event.type === "string" ? event.type : typeof event.kind === "string" ? event.kind : undefined;
	return eventType ? { type: "event", payload: { event_type: eventType, event } } : frame;
}

/**
 * Connects an owner to the child session's public SDK endpoint. The SDK client owns
 * hello-gated reconnects; this adapter only owns the bounded discovery wait and child
 * lifecycle.
 */
export async function createSdkSessionTransport(
	options: CreateSdkSessionTransportOptions,
): Promise<HarnessSessionTransport> {
	let child: SpawnedHarnessSession | undefined;
	const readEndpoint = options.readEndpoint ?? readSdkSessionEndpoint;
	let endpoint = await readEndpoint(options.repo, options.sessionId);
	if (!endpoint && options.spawn) child = await options.spawn();
	const timeoutMs = options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
	while (!endpoint && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, DISCOVERY_POLL_MS));
		try {
			endpoint = await readEndpoint(options.repo, options.sessionId);
		} catch (error) {
			// A discovery read that fails after spawn must not orphan the spawned child;
			// await stop before propagating, preserving both causes on dual failure (no double stop).
			try {
				await child?.stop();
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"SDK endpoint discovery and spawned harness child cleanup both failed.",
				);
			}
			throw error;
		}
	}
	if (!endpoint) {
		const timeoutError = new HarnessSdkTransportError(
			"endpoint_unavailable",
			`SDK endpoint for harness session ${options.sessionId} did not appear within ${timeoutMs}ms.`,
		);
		try {
			// Await child stop so a discovery timeout never orphans the spawned session.
			await child?.stop();
		} catch (cleanupError) {
			throw new AggregateError(
				[timeoutError, cleanupError],
				"SDK endpoint discovery timed out and spawned harness child cleanup failed.",
			);
		}
		throw timeoutError;
	}

	let client: SdkClient;
	try {
		client = await (options.connect ?? SdkClient.connect)(endpoint.url, endpoint.token);
	} catch (error) {
		try {
			await child?.stop();
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"SDK connection and spawned harness child cleanup both failed.",
			);
		}
		throw error;
	}
	let cursor = 0;
	let lastFrameAt: string | null = null;
	let live = true;
	const frames = new Set<(frame: Record<string, unknown>) => void>();
	client.onFrame(frame => {
		if (frame.type === "hello" || frame.type === "server_hello") return;
		cursor += 1;
		lastFrameAt = new Date().toISOString();
		const normalized = sdkEventToAgentWire(frame);
		for (const listener of frames) listener(normalized);
	});
	client.onReconnectFailed(() => {
		live = false;
	});

	const replay = async (): Promise<void> => {
		const response = await client.request({
			type: "event_replay",
			id: randomUUID(),
			sinceGeneration: 0,
			sinceSeq: 0,
		});
		for (const event of replayEvents(response)) {
			cursor += 1;
			lastFrameAt = new Date().toISOString();
			const normalized = sdkEventToAgentWire(event);
			for (const listener of frames) listener(normalized);
		}
	};
	try {
		await replay();
	} catch (error) {
		const failures: unknown[] = [error];
		try {
			await client.close();
		} catch (cleanupError) {
			failures.push(cleanupError);
		}
		try {
			await child?.stop();
		} catch (cleanupError) {
			failures.push(cleanupError);
		}
		if (failures.length > 1) throw new AggregateError(failures, "SDK replay and harness child cleanup failed.");
		throw error;
	}

	return {
		async getState(): Promise<SessionStateSnapshot> {
			const [metadata, context] = await Promise.all([client.query("session.metadata"), client.query("context.get")]);
			metadataItem(metadata);
			return contextItem(context);
		},
		async sendPrompt(prompt: string): Promise<{ commandId: string; ack: boolean }> {
			return {
				commandId: acceptedPrompt(
					await client.control("turn.prompt", { text: prompt }, { idempotencyKey: randomUUID() }),
				),
				ack: true,
			};
		},
		eventCursor: () => cursor,
		async waitForAgentStart(afterCursor: number, timeout: number): Promise<{ cursor: number } | null> {
			return await new Promise(resolve => {
				const listener = (frame: Record<string, unknown>): void => {
					const payload = frame.payload;
					const event =
						payload && typeof payload === "object" && !Array.isArray(payload)
							? (payload as Record<string, unknown>)
							: {};
					if (cursor > afterCursor && event.event_type === "agent_start") {
						clearTimeout(timer);
						frames.delete(listener);
						resolve({ cursor });
					}
				};
				frames.add(listener);
				const timer = setTimeout(() => {
					frames.delete(listener);
					resolve(null);
				}, timeout);
			});
		},
		onEventFrame(listener) {
			frames.add(listener);
			return () => frames.delete(listener);
		},
		isLive: () => live,
		lastFrameAt: () => lastFrameAt,
		async getLastAssistantText(): Promise<string | null> {
			const value = queryItem(await client.query("session.last_assistant"), "session.last_assistant");
			return typeof value.text === "string" ? value.text : typeof value.content === "string" ? value.content : null;
		},
		async close(): Promise<void> {
			live = false;
			const failures: unknown[] = [];
			try {
				await client.close();
			} catch (error) {
				failures.push(error);
			}
			try {
				// Await child stop so close never orphans the spawned session.
				await child?.stop();
			} catch (error) {
				failures.push(error);
			}
			if (failures.length > 1)
				throw new AggregateError(failures, "SDK client and harness child cleanup both failed.");
			if (failures.length === 1) throw failures[0];
		},
	};
}

export interface ReapableHarnessChild {
	kill(signal?: number | NodeJS.Signals): void;
	readonly exited: Promise<number>;
	readonly exitCode: number | null;
}

/**
 * Stop an exact spawned child: SIGTERM with bounded grace, SIGKILL escalation, then
 * authoritative `child.exited` verification. A rejected exit promise is NOT proof of exit
 * and therefore fails closed after SIGKILL rather than being mistaken for termination.
 * Failure to verify exit after SIGKILL throws — the caller must not assume the child died.
 */
async function reapChild(child: ReapableHarnessChild, termGraceMs: number, killVerifyMs: number): Promise<void> {
	const exited = child.exited.then(
		() => true,
		() => false,
	);
	const send = (signal: NodeJS.Signals): void => {
		if (child.exitCode !== null) return;
		try {
			child.kill(signal);
		} catch {
			// Kill may fail if the child already exited; the exited race below is authoritative.
		}
	};
	if (child.exitCode !== null) return;
	send("SIGTERM");
	let verified = await Promise.race([exited, Bun.sleep(termGraceMs).then(() => false)]);
	if (!verified) {
		send("SIGKILL");
		verified = await Promise.race([exited, Bun.sleep(killVerifyMs).then(() => false)]);
	}
	if (!verified) {
		throw new HarnessSdkTransportError("endpoint_unavailable", "Harness child session did not exit after SIGKILL.");
	}
}

function ownedHarnessSession(
	child: ReapableHarnessChild,
	termGraceMs: number,
	killVerifyMs: number,
): SpawnedHarnessSession {
	let stopPromise: Promise<void> | null = null;
	return {
		stop(): Promise<void> {
			if (stopPromise) return stopPromise;
			const pending = reapChild(child, termGraceMs, killVerifyMs);
			stopPromise = pending;
			void pending.catch(() => {
				if (stopPromise === pending) stopPromise = null;
			});
			return pending;
		},
	};
}

export function spawnNormalHarnessSession(
	repo: string,
	sessionId: string,
	options: { termGraceMs?: number; killVerifyMs?: number } = {},
): SpawnedHarnessSession {
	const entry = process.argv[1];
	if (process.env.GJC_SDK_DISABLE === "1") {
		throw new HarnessSdkTransportError(
			"endpoint_unavailable",
			"SDK hosting is disabled for the harness child session.",
		);
	}
	if (!entry)
		throw new HarnessSdkTransportError(
			"endpoint_unavailable",
			"Cannot determine the GJC CLI entrypoint for harness session startup.",
		);
	const child = Bun.spawn([process.execPath, path.resolve(entry)], {
		cwd: repo,
		env: { ...process.env, GJC_LIFECYCLE_REQUEST_ID: `harness-${sessionId}`, GJC_SESSION_ID: sessionId },
		terminal: { cols: 80, rows: 24 },
		stdout: "ignore",
		stderr: "ignore",
	});
	child.unref();
	const termGraceMs = options.termGraceMs ?? TERM_GRACE_MS;
	const killVerifyMs = options.killVerifyMs ?? KILL_VERIFY_MS;
	return ownedHarnessSession(child, termGraceMs, killVerifyMs);
}

/** Test hook for exact-child stop serialization and retry semantics. */
export function ownedHarnessSessionForTest(
	child: ReapableHarnessChild,
	options: { termGraceMs?: number; killVerifyMs?: number } = {},
): SpawnedHarnessSession {
	return ownedHarnessSession(child, options.termGraceMs ?? TERM_GRACE_MS, options.killVerifyMs ?? KILL_VERIFY_MS);
}
