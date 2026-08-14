import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { getAgentDir } from "@gajae-code/utils";
import { ensureBroker } from "../broker/ensure";
import { lifecycleRequestTimeoutMs } from "../broker/startup-budget";
import {
	readSdkBrokerDiscovery,
	readSdkSessionEndpoint,
	SdkClient,
	SdkClientError,
	SdkDiscoveryError,
	type SdkSentRecord,
} from "../client";
import { PROMPT_CLIENT_REF_MAX_LENGTH } from "../prompt-status.js";
import { validateAdapterControl } from "../protocol/adapter-validation";
import { adapterDispositionError, findOperation, type OperationKind } from "../protocol/operation-registry";
import {
	type SdkCheckpointRecordV1,
	type SdkRetentionGapV1,
	type SdkSessionRowV1,
	type SdkTailItemV1,
	SESSION_ROWS_VERSION,
	stripSecretFields,
	toCheckpointRecordV1,
	toOfflineSessionRowV1,
	toRetentionGapV1,
	toSessionRowV1,
	toTailItemV1,
} from "./rows";

export type SdkSessionCliAction = "list" | "inspect" | "send" | "status" | "tail" | "elevate" | "raw";
export type SdkSessionCliRawKind = "control" | "query" | "global";

export interface SdkSessionCliArgs {
	action?: string;
	/** Raw dispatch kind when action is "raw" (control | query | global). */
	rawAction?: string;
	sessionId?: string;
	/** Caller-chosen operation reference (ULID) for `send`; required target for `status`. */
	opRef?: string;
	operation?: string;
	query?: string;
	/** Convenience `send` body: forwarded as the `text` field of turn.prompt. */
	text?: string;
	jsonInput?: string;
	jsonInputFile?: string;
	jsonInputStdin?: boolean;
	idempotencyKey?: string;
	elevationRequestId?: string;
	operationKind?: OperationKind;
	confirm?: boolean;
	/** Raw query continuation cursor, or a saved checkpoint token to resume `tail` from (re-minted per connection). */
	cursor?: string;
	showEndpointCredential?: boolean;
	yes?: boolean;
	/** `send --wait`: poll turn.prompt_status until terminal or the wait window elapses. */
	wait?: boolean;
	/** Bounded wait for `send --wait`, `status`, and live `tail` follow. */
	timeoutMs?: number;
	/** `tail --strict`: fail closed on retention gaps (exit 1 retention_gap). */
	strict?: boolean;
	/** `tail --until-idle`: exit once the observed event stream reaches a terminal turn state. */
	untilIdle?: boolean;
	/** `tail --all-events`: include every event-ring kind instead of the tail subset. */
	allEvents?: boolean;
	repo?: string;
	agentDir?: string;
}

type JsonRecord = Record<string, unknown>;
const SECRET_FIELD = /(?:secret|token|password|credential|authorization|api[_-]?key)/i;
const MAX_SESSION_LIST_PAGES = 10_000;

class SdkSessionCliError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly exitCode: 1 | 2,
		readonly details?: unknown,
	) {
		super(message);
	}
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseInput(raw: string | undefined, source: string): JsonRecord {
	if (raw === undefined) return {};
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new SdkSessionCliError("invalid_input", `${source} must be a JSON object.`, 2);
		return value as JsonRecord;
	} catch (error) {
		if (error instanceof SdkSessionCliError) throw error;
		throw new SdkSessionCliError("invalid_json", `${source} must contain valid JSON.`, 2);
	}
}

function containsSecretField(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsSecretField);
	if (!value || typeof value !== "object") return false;
	return Object.entries(value).some(([key, nested]) => SECRET_FIELD.test(key) || containsSecretField(nested));
}

function object(value: unknown): JsonRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

async function inputFromArgs(args: SdkSessionCliArgs): Promise<JsonRecord> {
	const sources = [
		args.jsonInput !== undefined,
		args.jsonInputFile !== undefined,
		args.jsonInputStdin === true,
	].filter(Boolean).length;
	if (sources > 1) throw new SdkSessionCliError("usage", "Use only one JSON input source.", 2);
	if (args.jsonInput !== undefined) {
		const input = parseInput(args.jsonInput, "--json-input");
		if (containsSecretField(input))
			throw new SdkSessionCliError(
				"secret_field_forbidden",
				"Secret values must use --json-input-file or --json-input-stdin.",
				2,
			);
		return input;
	}
	if (args.jsonInputFile !== undefined) {
		try {
			const stat = await fs.stat(args.jsonInputFile);
			if (!stat.isFile() || (stat.mode & 0o077) !== 0)
				throw new SdkSessionCliError(
					"input_file_permissions",
					"--json-input-file must be a regular file with 0600 permissions.",
					2,
				);
			return parseInput(await Bun.file(args.jsonInputFile).text(), "--json-input-file");
		} catch (error) {
			if (error instanceof SdkSessionCliError) throw error;
			throw new SdkSessionCliError("input_file_unavailable", "Unable to read --json-input-file.", 2);
		}
	}
	return args.jsonInputStdin ? parseInput(await Bun.stdin.text(), "--json-input-stdin") : {};
}

function requireValue(value: string | undefined, flag: string): string {
	if (!value) throw new SdkSessionCliError("usage", `${flag} is required.`, 2);
	return value;
}

function isEndpointOperation(operation: string): boolean {
	return operation === "session.get_endpoint";
}

function isCredentialBearingOperation(operation: string): boolean {
	return (
		isEndpointOperation(operation) ||
		operation === "session.create" ||
		operation === "session.fork" ||
		operation === "session.resume"
	);
}

function cliOperationError(kind: OperationKind, operation: string): { code: string; message: string } | undefined {
	const row = findOperation(kind, operation);
	const error = adapterDispositionError("daemonCli", kind, operation);
	if (!error) return undefined;
	if (row?.adapterDispositions.daemonCli === "prohibited")
		return {
			code: error.code,
			message: `${operation} is unavailable through the ordinary CLI; provider mode is out of scope this phase.`,
		};
	return error;
}

function isLifecycleOperation(operation: string): boolean {
	return (
		operation === "session.create" ||
		operation === "session.fork" ||
		operation === "session.resume" ||
		operation === "session.close" ||
		operation === "session.delete"
	);
}

async function confirmEndpointCredentialOutput(): Promise<boolean> {
	const prompt = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return (await prompt.question("Print the endpoint credential to stdout? [y/N] ")).trim().toLowerCase() === "y";
	} finally {
		prompt.close();
	}
}

async function connectBroker(agentDir: string): Promise<SdkClient> {
	await ensureBroker({ agentDir });
	const discovery = await readSdkBrokerDiscovery(agentDir);
	if (!discovery) throw new SdkSessionCliError("broker_unavailable", "SDK broker discovery is unavailable.", 1);
	return await SdkClient.connect(discovery.url, discovery.token);
}

async function connectExistingBroker(agentDir: string): Promise<SdkClient> {
	const discovery = await readSdkBrokerDiscovery(agentDir);
	if (!discovery) throw new SdkSessionCliError("broker_unavailable", "SDK broker discovery is unavailable.", 1);
	return await SdkClient.connect(discovery.url, discovery.token);
}

function brokerAbsent(error: unknown): boolean {
	if (error instanceof SdkSessionCliError) return error.code === "broker_unavailable";
	const details = error instanceof SdkClientError ? error.details : error;
	const code = (details as { code?: unknown } | undefined)?.code;
	return (
		code === "ENOENT" ||
		code === "ECONNREFUSED" ||
		/(?:ENOENT|ECONNREFUSED|connection refused)/i.test(error instanceof Error ? error.message : "")
	);
}

async function paginatedSessionList(client: SdkClient, input: JsonRecord = {}): Promise<unknown> {
	const aggregate: JsonRecord = {};
	const sessions: unknown[] = [];
	let firstResponse: JsonRecord | undefined;
	let cursor: string | undefined;
	for (let pageCount = 0; pageCount < MAX_SESSION_LIST_PAGES; pageCount++) {
		const response = object(
			await client.global("session.list", { ...input, ...(cursor === undefined ? {} : { cursor }) }),
		);
		firstResponse ??= response;
		if (response?.ok === false) {
			const failure = object(response.error);
			throw new SdkClientError(
				typeof failure?.code === "string" ? failure.code : "broker_error",
				typeof failure?.message === "string" ? failure.message : "session.list failed",
			);
		}
		const listing = object(response?.result) ?? response;
		if (listing) {
			for (const [key, value] of Object.entries(listing)) {
				if (key !== "sessions" && key !== "continuationCursor") aggregate[key] = value;
			}
			if (Array.isArray(listing.sessions)) sessions.push(...listing.sessions);
			const nextCursor =
				typeof listing.continuationCursor === "string" && listing.continuationCursor.length > 0
					? listing.continuationCursor
					: undefined;
			if (nextCursor) {
				cursor = nextCursor;
				continue;
			}
		}
		const result = { ...aggregate, sessions };
		return firstResponse && "result" in firstResponse ? { ...firstResponse, result } : result;
	}
	throw new SdkClientError("protocol_error", "session.list exceeded the page budget.");
}

/**
 * Broker-bound session endpoint resolution (C10): the broker validates the
 * indexed session against its durable endpoint record and returns the
 * credential, which the CLI uses to connect and never renders. Both clients
 * (broker + session) are returned so callers close exactly what they opened.
 */
async function connectSessionViaBroker(
	agentDir: string,
	sessionId: string,
): Promise<{ broker: SdkClient; session: SdkClient; endpoint: unknown }> {
	const broker = await connectBroker(agentDir);
	try {
		const response = await broker.global("session.get_endpoint", { sessionId });
		const endpoint = (response as { result?: unknown } | undefined)?.result;
		const url = (endpoint as { url?: unknown } | undefined)?.url;
		const token = (endpoint as { token?: unknown } | undefined)?.token;
		if (typeof url !== "string" || !url || typeof token !== "string")
			throw new SdkSessionCliError(
				"session_unavailable",
				`SDK endpoint for session ${sessionId} is unavailable.`,
				1,
			);
		const session = await SdkClient.connect(url, token);
		return { broker, session, endpoint };
	} catch (error) {
		await broker.close();
		throw error;
	}
}

function resultObject(response: unknown): Record<string, unknown> | undefined {
	const result = (response as { result?: unknown } | undefined)?.result;
	return result && typeof result === "object" && !Array.isArray(result)
		? (result as Record<string, unknown>)
		: undefined;
}

function arrayOf(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

const TERMINAL_TURN_KINDS = new Set(["turn_end", "agent_end", "agent_failed"]);
const CLOSE_EVENT_KINDS = new Set(["session_closed", "session_terminated"]);
/** Default tail emission subset; `--all-events` widens to every ring kind. */
const DEFAULT_TAIL_KINDS = new Set([
	"session_ready",
	"session_prepared",
	"session_closed",
	"session_terminated",
	"turn_start",
	"turn_end",
	"agent_start",
	"agent_end",
	"agent_failed",
]);
const TAIL_OFFLINE_MAX_ENTRIES = 200;
const TAIL_STATUS_POLL_MS = 100;

/**
 * Time-ordered operation reference (ULID): 48-bit millisecond timestamp plus
 * 80 bits of randomness, Crockford base32, lowercase. The ref is used as the
 * `turn.prompt` clientRef so `send`/`status` correlate without a broker round
 * trip, and matches the plan's durable op-ref ledger shape (C7).
 */
export function createOperationRef(now: number = Date.now()): string {
	const crockford = "0123456789abcdefghjkmnpqrstvwxyz";
	let random = 0n;
	for (const byte of randomBytes(10)) random = (random << 8n) | BigInt(byte);
	const value = (BigInt(now) << 80n) | random;
	let encoded = "";
	for (let shift = 125n; shift >= 0n; shift -= 5n) encoded += crockford[Number((value >> shift) & 0x1fn)];
	return encoded;
}

function clientRefFromInput(input: JsonRecord): string | undefined {
	const raw = typeof input.clientRef === "string" ? input.clientRef.trim() : undefined;
	return raw;
}

function assertClientRef(clientRef: string): void {
	if (!clientRef || clientRef.length > PROMPT_CLIENT_REF_MAX_LENGTH)
		throw new SdkSessionCliError(
			"invalid_input",
			`clientRef must be a non-empty string of at most ${PROMPT_CLIENT_REF_MAX_LENGTH} characters.`,
			2,
		);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Renders the broker `session.list` result as a versioned, credential-free DTO. */
async function runList(agentDir: string): Promise<unknown> {
	const client = await connectBroker(agentDir);
	try {
		const response = await paginatedSessionList(client);
		const result = resultObject(response) ?? {};
		const sessions = arrayOf(result.sessions).map(toSessionRowV1);
		return {
			ok: true,
			result: {
				version: SESSION_ROWS_VERSION,
				source: "broker",
				indexSeq: typeof result.indexSeq === "number" ? result.indexSeq : undefined,
				sessions,
				warnings: arrayOf(result.warnings),
			},
		};
	} finally {
		await client.close();
	}
}

async function runInspect(repo: string, agentDir: string, sessionId: string): Promise<unknown> {
	try {
		const client = await connectExistingBroker(agentDir);
		try {
			const response = await paginatedSessionList(client);
			const sessions = arrayOf(resultObject(response)?.sessions).map(toSessionRowV1);
			const row = sessions.find(candidate => candidate.sessionId === sessionId);
			if (!row)
				throw new SdkSessionCliError(
					"session_unavailable",
					`Session ${sessionId} is not indexed by the broker.`,
					1,
				);
			return { ok: true, result: { version: SESSION_ROWS_VERSION, source: "broker", session: row } };
		} finally {
			await client.close();
		}
	} catch (error) {
		// Broker absent: offline inspect-only (principle 1) from the local
		// endpoint discovery record, still projected without credentials.
		if (!brokerAbsent(error)) throw error;
		const endpoint = await readSdkSessionEndpoint(repo, sessionId);
		if (!endpoint)
			throw new SdkSessionCliError(
				"session_unavailable",
				`SDK endpoint for session ${sessionId} is unavailable.`,
				1,
			);
		return {
			ok: true,
			result: { version: SESSION_ROWS_VERSION, source: "offline", session: toOfflineSessionRowV1(endpoint) },
		};
	}
}

async function waitForTerminalStatus(
	session: SdkClient,
	clientRef: string,
	timeoutMs: number | undefined,
): Promise<{ terminal: boolean; status: string; detail: unknown }> {
	const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
	for (;;) {
		const response = await session.query("turn.prompt_status", { clientRef });
		const result = resultObject(response);
		const status = typeof result?.status === "string" ? result.status : "unknown";
		if (status === "terminal_ok" || status === "failed") return { terminal: true, status, detail: result };
		if (deadline !== undefined && Date.now() >= deadline) return { terminal: false, status, detail: undefined };
		await Bun.sleep(TAIL_STATUS_POLL_MS);
	}
}

async function runSend(agentDir: string, sessionId: string, args: SdkSessionCliArgs): Promise<unknown> {
	const generatedRef = createOperationRef();
	const input = await inputFromArgs(args);
	if (args.text !== undefined && Object.keys(input).length > 0)
		throw new SdkSessionCliError("usage", "Use either --text or one JSON input source for the prompt, not both.", 2);
	const promptInput: JsonRecord = args.text !== undefined ? { text: args.text } : { ...input };
	const inputRef = clientRefFromInput(promptInput);
	const clientRef = inputRef ?? args.opRef?.trim() ?? generatedRef;
	if (args.opRef !== undefined && inputRef !== undefined && inputRef !== args.opRef.trim())
		throw new SdkSessionCliError("usage", "--op-ref must match the clientRef in the JSON input.", 2);
	assertClientRef(clientRef);
	if (inputRef === undefined) promptInput.clientRef = clientRef;
	const invalid = validateAdapterControl("turn.prompt", promptInput);
	if (invalid) throw new SdkSessionCliError(invalid.code, invalid.message, 2);
	const { broker, session } = await connectSessionViaBroker(agentDir, sessionId);
	try {
		const response = await broker.global("session.control", {
			sessionId,
			operation: "turn.prompt",
			input: promptInput,
			confirm: args.confirm === true,
		});
		if (isRecord(response) && response.ok === false) {
			const responseError = isRecord(response.error) ? response.error : {};
			throw new SdkSessionCliError(
				typeof responseError.code === "string" ? responseError.code : "unavailable",
				typeof responseError.message === "string" ? responseError.message : "Prompt dispatch failed.",
				1,
			);
		}
		const receipt = resultObject(response) ?? response;
		const result: JsonRecord = {
			version: SESSION_ROWS_VERSION,
			operationRef: clientRef,
			status: "accepted",
			receipt,
		};
		if (args.wait === true) {
			const outcome = await waitForTerminalStatus(session, clientRef, args.timeoutMs ?? 30_000);
			if (!outcome.terminal)
				throw new SdkSessionCliError(
					"wait_timeout",
					`Prompt ${clientRef} did not reach a terminal state within the wait window.`,
					1,
					{ operationRef: clientRef, status: outcome.status },
				);
			result.status = outcome.status;
			result.statusDetail = outcome.detail;
		}
		return { ok: true, result: stripSecretFields(result) };
	} finally {
		await session.close();
		await broker.close();
	}
}

async function runStatus(agentDir: string, sessionId: string, opRef: string): Promise<unknown> {
	assertClientRef(opRef);
	const { broker, session } = await connectSessionViaBroker(agentDir, sessionId);
	try {
		const response = await session.query("turn.prompt_status", { clientRef: opRef });
		const status = resultObject(response);
		const record = status ?? (isRecord(response) ? response : {});
		const raw = typeof record.status === "string" ? record.status : "unknown";
		return {
			ok: true,
			result: stripSecretFields({
				version: SESSION_ROWS_VERSION,
				operationRef: opRef,
				status: record,
				summary: { completed: raw === "terminal_ok" || raw === "failed" },
			}),
		};
	} finally {
		await session.close();
		await broker.close();
	}
}

type CheckpointExtraction = {
	record?: SdkCheckpointRecordV1;
	cursor?: string;
	gap?: SdkRetentionGapV1;
};

function extractCheckpoint(response: unknown): CheckpointExtraction {
	const result = resultObject(response);
	if (!result) return {};
	const gap = toRetentionGapV1(result.gap);
	if (gap !== undefined) return { gap };
	const record = toCheckpointRecordV1(result.checkpoint ?? result);
	// The Q30 result's `cursor`/`checkpointToken` is the signed checkpoint
	// cursor: `cursor` is the legacy alias kept for wire compatibility, and the
	// signed token is the resume artifact (`--cursor`) consumed by Q01.
	const cursor =
		typeof result.cursor === "string" && result.cursor
			? result.cursor
			: typeof result.checkpointToken === "string" && result.checkpointToken
				? result.checkpointToken
				: undefined;
	return { record, cursor };
}

function extractTranscriptPage(response: unknown): { items: unknown[]; complete: boolean; cursor?: string } {
	const page = (response as { page?: unknown } | undefined)?.page;
	if (!isRecord(page)) return { items: arrayOf(resultObject(response)?.items), complete: true };
	return {
		items: arrayOf(page.items),
		complete: page.complete === true,
		cursor: typeof page.continuationCursor === "string" ? page.continuationCursor : undefined,
	};
}

function eventKindOf(frame: Record<string, unknown>): string | undefined {
	if (typeof frame.kind === "string" && frame.kind) return frame.kind;
	if (typeof frame.name === "string" && frame.name) return frame.name;
	return undefined;
}

function tailItemKey(item: SdkTailItemV1): string {
	// Ring events carry a synchronous generation/seq identity; keying on it (not
	// kind+optional id) keeps repeated same-kind no-id events distinct and
	// dedupes the replay/live overlap exactly once.
	if (item.generation !== undefined && item.seq !== undefined)
		return `${item.kind}\u0000${item.generation}\u0000${item.seq}`;
	// Retained transcript entries have stable ids (or none); never silently drop
	// distinct identity-less items, so fall back to the payload itself.
	if (item.id !== undefined) return `${item.kind}\u0000${item.id}`;
	return `${item.kind}\u0000${JSON.stringify(item.payload)}`;
}

function mergeTailItems(
	target: SdkTailItemV1[],
	seen: Set<string>,
	items: SdkTailItemV1[],
	include: (kind: string) => boolean,
): void {
	for (const item of items) {
		const key = tailItemKey(item);
		if (seen.has(key)) continue;
		seen.add(key);
		if (include(item.kind)) target.push(item);
	}
}

function eventGapToRetentionGap(
	value: unknown,
	frame: Record<string, unknown>,
	record: SdkCheckpointRecordV1 | undefined,
): SdkRetentionGapV1 | undefined {
	const existing = toRetentionGapV1(value);
	if (existing !== undefined) return existing;
	if (!isRecord(value)) return undefined;
	const revision = record?.revision ?? 0;
	if (value.kind === "sequence_gap" && typeof value.fromSeq === "number" && typeof value.toSeq === "number") {
		return {
			code: "retention_gap",
			missing: { from: value.fromSeq, to: value.toSeq },
			resync: {
				revision,
				generation: typeof frame.generation === "number" ? frame.generation : (record?.generation ?? 0),
				seq: typeof frame.lastSeq === "number" ? frame.lastSeq : value.toSeq,
			},
		};
	}
	if (value.kind === "generation_reset" && typeof value.toGeneration === "number")
		return { code: "retention_gap", resync: { revision, generation: value.toGeneration, seq: 0 } };
	return undefined;
}

async function requestEventReplay(
	session: SdkClient,
	record: SdkCheckpointRecordV1 | undefined,
	timeoutMs: number,
): Promise<{ events: SdkTailItemV1[]; gap?: SdkRetentionGapV1; closed: boolean }> {
	const id = randomUUID();
	const { promise, resolve, reject } = Promise.withResolvers<{
		events: SdkTailItemV1[];
		gap?: SdkRetentionGapV1;
		closed: boolean;
	}>();
	const bufferedLiveEvents: SdkTailItemV1[] = [];
	const off = session.onFrame(frame => {
		if (frame.type === "event") {
			bufferedLiveEvents.push(toTailItemV1(frame, { kind: eventKindOf(frame) ?? "event" }));
			return;
		}
		if (frame.type !== "event_replay_result" || frame.id !== id) return;
		const replayFrame = frame as Record<string, unknown>;
		const events = [
			...arrayOf(replayFrame.events).map(event => toTailItemV1(event, { kind: "event" })),
			...bufferedLiveEvents,
		];
		const gap = eventGapToRetentionGap(replayFrame.gap, replayFrame, record);
		resolve({ events, ...(gap !== undefined ? { gap } : {}), closed: false });
	});
	const offFailed = session.onReconnectFailed(() => resolve({ events: [], closed: true }));
	const timer = setTimeout(
		() => reject(new SdkSessionCliError("tail_timeout", "Timed out waiting for the event replay response.", 1)),
		timeoutMs,
	);
	try {
		session.send({
			type: "event_replay",
			id,
			// Resume strictly after the checkpoint sequence: the checkpoint event
			// was already observed, so re-emitting it would let a terminal
			// checkpoint event satisfy --until-idle without any new turn.
			...(record !== undefined ? { sinceGeneration: record.generation, sinceSeq: record.seq } : {}),
		});
		return await promise;
	} finally {
		clearTimeout(timer);
		off();
		offFailed();
	}
}

async function followLiveEvents(
	session: SdkClient,
	items: SdkTailItemV1[],
	seen: Set<string>,
	args: SdkSessionCliArgs,
	include: (kind: string) => boolean,
	timeoutMs: number,
): Promise<{ reason: "idle" | "close" | "timeout" | "reconnect" | "reconnect_failed" }> {
	const { promise, resolve } = Promise.withResolvers<{
		reason: "idle" | "close" | "timeout" | "reconnect" | "reconnect_failed";
	}>();
	const off = session.onFrame(frame => {
		if (!isRecord(frame) || frame.type !== "event") return;
		const kind = eventKindOf(frame);
		if (kind === undefined) return;
		const item = toTailItemV1(frame, { kind });
		const key = tailItemKey(item);
		if (!seen.has(key)) {
			seen.add(key);
			if (include(kind)) items.push(item);
		}
		if (TERMINAL_TURN_KINDS.has(kind) && args.untilIdle === true) resolve({ reason: "idle" });
		if (CLOSE_EVENT_KINDS.has(kind)) resolve({ reason: "close" });
	});
	const offClosed = session.onReconnectFailed(() => resolve({ reason: "reconnect_failed" }));
	const offReconnect = session.onReconnect(() => resolve({ reason: "reconnect" }));
	const timer = setTimeout(() => resolve({ reason: "timeout" }), timeoutMs);
	try {
		const result = await promise;
		return result;
	} finally {
		clearTimeout(timer);
		off();
		offClosed();
		offReconnect();
	}
}

/** Read-only retained-history replay for a stopped/terminal session (offline, no endpoint). */
async function offlineTailReplay(
	repo: string,
	agentDir: string,
	sessionId: string,
	row: SdkSessionRowV1,
): Promise<unknown> {
	const broker = await connectBroker(agentDir);
	try {
		const response = await broker.global("session.list", { resolveSessionId: sessionId, cwd: repo });
		const savedSession = resultObject(response)?.savedSession;
		const savedPath = isRecord(savedSession) && typeof savedSession.path === "string" ? savedSession.path : undefined;
		if (!savedPath) {
			throw new SdkSessionCliError(
				"session_unavailable",
				`Session ${sessionId} is stopped and has no retained transcript replay.`,
				1,
			);
		}
		const text = await fs.readFile(savedPath, "utf8");
		const parsedEntries: unknown[] = [];
		const malformed: number[] = [];
		const lines = text.split("\n");
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			if (!line) continue;
			try {
				parsedEntries.push(JSON.parse(line));
			} catch {
				malformed.push(index);
			}
		}
		// Retained-history corruption is never silently skipped: a torn or
		// unparseable line means the retained replay is not trustworthy, so tail
		// fails closed with a typed retention error instead of reporting success.
		if (malformed.length > 0)
			throw new SdkSessionCliError(
				"retention_gap",
				"Retained transcript history contains unparseable entries; refusing to replay corrupted history.",
				1,
				{ code: "retention_gap", lines: malformed },
			);
		const entries = parsedEntries.slice(-TAIL_OFFLINE_MAX_ENTRIES);
		const items = entries.map((entry, index) => toTailItemV1(entry, { kind: "transcript", seq: index }));
		return {
			ok: true,
			result: {
				version: SESSION_ROWS_VERSION,
				source: "offline",
				session: row,
				items,
				terminal: true,
			},
		};
	} finally {
		await broker.close();
	}
}

export async function runTail(
	repo: string,
	agentDir: string,
	sessionId: string,
	args: SdkSessionCliArgs,
): Promise<unknown> {
	const broker = await connectBroker(agentDir);
	let row: SdkSessionRowV1 | undefined;
	try {
		const response = await paginatedSessionList(broker);
		row = arrayOf(resultObject(response)?.sessions ?? undefined)
			.map(toSessionRowV1)
			.find(candidate => candidate.sessionId === sessionId);
	} finally {
		await broker.close();
	}
	if (!row)
		throw new SdkSessionCliError("session_unavailable", `Session ${sessionId} is not indexed by the broker.`, 1);
	if (row.deleted)
		throw new SdkSessionCliError("session_deleted", `Session ${sessionId} was deleted and has no tail.`, 1);

	const include = (kind: string): boolean =>
		kind === "transcript" || args.allEvents === true || DEFAULT_TAIL_KINDS.has(kind);
	const items: SdkTailItemV1[] = [];
	const seen = new Set<string>();
	let checkpoint: SdkCheckpointRecordV1 | undefined;
	let gap: SdkRetentionGapV1 | undefined;
	const timeoutMs = args.timeoutMs ?? 10_000;

	let brokerClient: SdkClient | undefined;
	let session: SdkClient | undefined;
	try {
		try {
			const connected = await connectSessionViaBroker(agentDir, sessionId);
			brokerClient = connected.broker;
			session = connected.session;
		} catch (error) {
			if (row.live === false && brokerAbsent(error) === false)
				return await offlineTailReplay(repo, agentDir, sessionId, row);
			throw error;
		}

		let cursor: string | undefined;
		// Q30 exchanges a still-valid signed checkpoint claim into a fresh
		// connection-owned pin; direct cross-connection cursor consumption remains rejected.
		const checkpointResponse = await session.query(
			"session.checkpoint",
			args.cursor === undefined ? {} : { checkpointToken: args.cursor },
		);
		const extraction = extractCheckpoint(checkpointResponse);
		checkpoint = extraction.record;
		gap = extraction.gap;
		cursor = extraction.cursor;
		if (gap !== undefined && args.strict === true)
			throw new SdkSessionCliError(
				"retention_gap",
				"Retained history is missing entries before the checkpoint (strict mode).",
				1,
				gap,
			);

		// Continue paginating the retained transcript from the checkpoint cursor
		// (the resume page above may itself be incomplete).
		while (cursor !== undefined) {
			const page = extractTranscriptPage(await session.query("transcript.list", {}, cursor));
			mergeTailItems(
				items,
				seen,
				page.items.map(item => toTailItemV1(item, { kind: "transcript" })),
				include,
			);
			if (page.complete || !page.cursor) break;
			cursor = page.cursor;
		}

		// Stopped/terminal sessions replay retained history and exit; live
		// sessions follow the event ring from the checkpoint position. A
		// lifecycle-terminal row is treated as terminal for exit purposes even
		// when its process is still alive (uncertain stop), so `tail` never
		// hangs on a session whose lifecycle already ended.
		if (row.live === false || row.terminalUncertain === true) {
			return {
				ok: true,
				result: {
					version: SESSION_ROWS_VERSION,
					source: "session",
					session: row,
					...(checkpoint !== undefined ? { checkpoint } : {}),
					...(gap !== undefined ? { gap } : {}),
					items,
					terminal: true,
				},
			};
		}

		let outcome: { reason: "idle" | "close" | "timeout" | "reconnect" | "reconnect_failed" } = { reason: "close" };
		for (let reconnectAttempt = 0; reconnectAttempt <= 3; reconnectAttempt++) {
			const replay = await requestEventReplay(session, checkpoint, timeoutMs);
			if (replay.closed)
				throw new SdkSessionCliError(
					"reconnect_failed",
					"Tail connection exhausted reconnect attempts before replay continuity was restored.",
					1,
				);
			if (replay.gap !== undefined) {
				gap = replay.gap;
				if (args.strict === true)
					throw new SdkSessionCliError(
						"retention_gap",
						"The event ring dropped entries before the checkpoint (strict mode).",
						1,
						replay.gap,
					);
			}
			mergeTailItems(items, seen, replay.events, include);
			const terminal = replay.events.some(item => TERMINAL_TURN_KINDS.has(item.kind)) && args.untilIdle === true;
			if (args.untilIdle === true && terminal) {
				return {
					ok: true,
					result: {
						version: SESSION_ROWS_VERSION,
						source: "session",
						session: row,
						...(checkpoint !== undefined ? { checkpoint } : {}),
						items,
						terminal: true,
					},
				};
			}
			outcome = await followLiveEvents(session, items, seen, args, include, timeoutMs);
			if (outcome.reason !== "reconnect") break;
			if (reconnectAttempt === 3)
				throw new SdkSessionCliError(
					"reconnect_failed",
					"Tail could not restore replay continuity after reconnect.",
					1,
				);
			const lastEvent = [...items].reverse().find(item => item.generation !== undefined && item.seq !== undefined);
			if (lastEvent?.generation !== undefined && lastEvent.seq !== undefined)
				checkpoint = {
					revision: checkpoint?.revision ?? 0,
					generation: lastEvent.generation,
					seq: lastEvent.seq,
				};
		}
		if (outcome.reason === "reconnect_failed")
			throw new SdkSessionCliError(
				"reconnect_failed",
				"Tail connection exhausted reconnect attempts before continuity was restored.",
				1,
			);
		if (outcome.reason === "timeout")
			throw new SdkSessionCliError(
				"tail_timeout",
				`Tail did not reach an exit condition within the wait window.`,
				1,
				{ sessionId, timeoutMs },
			);
		return {
			ok: true,
			result: {
				version: SESSION_ROWS_VERSION,
				source: "session",
				session: row,
				...(checkpoint !== undefined ? { checkpoint } : {}),
				...(gap !== undefined ? { gap } : {}),
				items,
				terminal: outcome.reason === "idle" || outcome.reason === "close",
			},
		};
	} finally {
		if (session !== undefined) await session.close();
		if (brokerClient !== undefined) await brokerClient.close();
	}
}

async function runRawControl(
	agentDir: string,
	sessionId: string,
	operation: string,
	input: JsonRecord,
	args: SdkSessionCliArgs,
): Promise<unknown> {
	const invalid = validateAdapterControl(operation, input);
	if (invalid) throw new SdkSessionCliError(invalid.code, invalid.message, 2);
	const broker = await connectBroker(agentDir);
	try {
		return await broker.global("session.control", {
			sessionId,
			operation,
			input,
			confirm: args.confirm === true,
			...(args.elevationRequestId === undefined ? {} : { elevationRequestId: args.elevationRequestId }),
		});
	} finally {
		await broker.close();
	}
}

async function runRawQuery(
	agentDir: string,
	sessionId: string,
	operation: string,
	input: JsonRecord,
	args: SdkSessionCliArgs,
): Promise<unknown> {
	const { broker, session } = await connectSessionViaBroker(agentDir, sessionId);
	try {
		return await session.query(operation, input, args.cursor);
	} finally {
		await session.close();
		await broker.close();
	}
}

async function runRawGlobal(
	agentDir: string,
	operation: string,
	input: JsonRecord,
	args: SdkSessionCliArgs,
): Promise<unknown> {
	const idempotencyKey = args.idempotencyKey;
	if (isLifecycleOperation(operation) && !idempotencyKey)
		throw new SdkSessionCliError("invalid_input", "--idempotency-key is required for lifecycle operations.", 2);
	const client = await connectBroker(agentDir);
	try {
		try {
			const timeoutMs = lifecycleRequestTimeoutMs(operation, input);
			const response = await client.global(operation, input, {
				idempotencyKey,
				...(timeoutMs === undefined ? {} : { timeoutMs }),
				...(args.elevationRequestId === undefined ? {} : { elevationRequestId: args.elevationRequestId }),
			});
			return args.showEndpointCredential ? response : stripSecretFields(response);
		} catch (error) {
			if (
				isLifecycleOperation(operation) &&
				error instanceof SdkClientError &&
				error.code === "uncertain_after_send" &&
				error.details &&
				typeof error.details === "object"
			)
				return stripSecretFields(await client.lookupLifecycle(error.details as SdkSentRecord));
			throw error;
		}
	} finally {
		await client.close();
	}
}

async function runElevate(agentDir: string, sessionId: string, args: SdkSessionCliArgs): Promise<unknown> {
	if (args.confirm !== true || !process.stdin.isTTY)
		throw new SdkSessionCliError(
			"operator_confirmation_required",
			"Elevation approval requires an attended TTY and --confirm.",
			1,
		);
	const kind = args.operationKind;
	if (kind !== "control" && kind !== "global")
		throw new SdkSessionCliError("usage", "elevate requires --kind control|global.", 2);
	const operation = requireValue(args.operation, "--op");
	const input = await inputFromArgs(args);
	const broker = await connectBroker(agentDir);
	try {
		const issued = await broker.global("elevation.issue", {
			sessionId,
			operation: { kind, sdkId: operation },
			input,
			requester: { source: "broker_connection", connectionId: `operator-cli:${process.pid}` },
		});
		if (isRecord(issued) && issued.ok === false) return issued;
		const result = resultObject(issued);
		const elevationRequestId = typeof result?.elevationRequestId === "string" ? result.elevationRequestId : undefined;
		const presentedDigest = typeof result?.requestDigest === "string" ? result.requestDigest : undefined;
		if (!elevationRequestId || !presentedDigest)
			throw new SdkSessionCliError("unavailable", "Broker returned a malformed elevation request.", 1);
		const directory = path.join(agentDir, "sdk", "elevation", "operator");
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		const target = path.join(directory, `${elevationRequestId}.json`);
		const temporary = `${target}.${randomUUID()}.tmp`;
		await Bun.write(
			temporary,
			`${JSON.stringify({ version: 1, elevationRequestId, answer: "approve", presentedDigest, createdAt: Date.now() })}\n`,
		);
		await fs.chmod(temporary, 0o600);
		await fs.rename(temporary, target);
		return { ok: true, result: { elevationRequestId, requestDigest: presentedDigest, state: "approval_submitted" } };
	} finally {
		await broker.close();
	}
}

/**
 * Runs the `gjc sdk session` command family: semantic verbs (list, inspect,
 * send, status, tail) plus the explicit raw control/query/global hatch.
 */
export async function runSdkSessionCli(
	args: SdkSessionCliArgs,
	writeOutput: (value: unknown) => void = writeJson,
	setExitCode: (exitCode: 1 | 2) => void = exitCode => {
		process.exitCode = exitCode;
	},
): Promise<void> {
	try {
		const action = args.action;
		if (
			action !== "list" &&
			action !== "inspect" &&
			action !== "send" &&
			action !== "status" &&
			action !== "tail" &&
			action !== "elevate" &&
			action !== "raw"
		)
			throw new SdkSessionCliError(
				"usage",
				"Expected one of: list, inspect, send, status, tail, elevate, raw (control|query|global).",
				2,
			);
		const repo = args.repo ?? process.cwd();
		const agentDir = args.agentDir ?? getAgentDir();

		if (action === "list") {
			writeOutput(await runList(agentDir));
			return;
		}
		const sessionId =
			action === "raw" && args.rawAction === "global" ? undefined : requireValue(args.sessionId, "<sessionId>");
		if (action === "inspect") {
			writeOutput(await runInspect(repo, agentDir, requireValue(sessionId, "<sessionId>")));
			return;
		}
		if (action === "send") {
			writeOutput(await runSend(agentDir, requireValue(sessionId, "<sessionId>"), args));
			return;
		}
		if (action === "status") {
			writeOutput(
				await runStatus(agentDir, requireValue(sessionId, "<sessionId>"), requireValue(args.opRef, "<opRef>")),
			);
			return;
		}
		if (action === "tail") {
			writeOutput(await runTail(repo, agentDir, requireValue(sessionId, "<sessionId>"), args));
			return;
		}
		if (action === "elevate") {
			writeOutput(await runElevate(agentDir, requireValue(sessionId, "<sessionId>"), args));
			return;
		}
		const rawAction = args.rawAction;
		if (rawAction !== "control" && rawAction !== "query" && rawAction !== "global")
			throw new SdkSessionCliError("usage", "raw requires one of: control, query, global.", 2);
		const operation =
			rawAction === "query" ? requireValue(args.query, "--query") : requireValue(args.operation, "--op");
		const kind: OperationKind = rawAction === "query" ? "query" : rawAction === "global" ? "global" : "control";
		const dispositionError = cliOperationError(kind, operation);
		if (dispositionError) throw new SdkSessionCliError(dispositionError.code, dispositionError.message, 1);
		if (isEndpointOperation(operation) && !args.showEndpointCredential)
			throw new SdkSessionCliError(
				"endpoint_credential_forbidden",
				"session.get_endpoint requires --show-endpoint-credential.",
				1,
			);
		if (
			isCredentialBearingOperation(operation) &&
			args.showEndpointCredential &&
			process.stdout.isTTY &&
			!args.yes &&
			!(await confirmEndpointCredentialOutput())
		)
			throw new SdkSessionCliError(
				"endpoint_credential_confirmation_required",
				"Endpoint credential output was not confirmed.",
				1,
			);
		const input = await inputFromArgs(args);
		if (rawAction === "global") {
			writeOutput(await runRawGlobal(agentDir, operation, input, args));
			return;
		}
		if (rawAction === "control") {
			writeOutput(await runRawControl(agentDir, requireValue(sessionId, "<sessionId>"), operation, input, args));
			return;
		}
		writeOutput(await runRawQuery(agentDir, requireValue(sessionId, "<sessionId>"), operation, input, args));
	} catch (error) {
		if (brokerAbsent(error)) {
			writeOutput({ ok: false, error: { code: "broker_unavailable", message: "SDK broker is unavailable." } });
			setExitCode(1);
			return;
		}
		const cliError =
			error instanceof SdkSessionCliError
				? error
				: error instanceof SdkClientError
					? new SdkSessionCliError(
							error.code,
							error.message,
							1,
							(error.details as { details?: unknown } | undefined)?.details,
						)
					: error instanceof SdkDiscoveryError
						? new SdkSessionCliError(error.code, error.message, 1)
						: new SdkSessionCliError(
								"operation_failed",
								error instanceof Error ? error.message : "SDK operation failed.",
								1,
							);
		writeOutput({
			ok: false,
			error: {
				code: cliError.code,
				message: cliError.message,
				...(cliError.details ? { details: stripSecretFields(cliError.details) } : {}),
			},
		});
		setExitCode(cliError.exitCode);
	}
}
