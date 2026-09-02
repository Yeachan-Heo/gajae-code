import { randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { replaceTabs, truncateToWidth } from "@gajae-code/tui";
import { getAgentDir } from "@gajae-code/utils";
import { repo as resolveGitRepository } from "../../utils/git";
import { ensureBroker } from "../broker/ensure";
import { resolveSessionLocator } from "../broker/session-index";
import {
	resolveScopeRequest,
	type ScopeNameV1,
	type ScopeRequestV1,
	type SdkSearchResultV1,
	type SdkSearchRowV1,
} from "../broker/session-scope";
import { lifecycleRequestTimeoutMs } from "../broker/startup-budget";
import { readSdkBrokerDiscovery, SdkClient, SdkClientError } from "../client";
import { createBrokerSessionLifecycleService } from "../lifecycle/broker-client";
import type {
	SessionLifecycleMutationRequest,
	SessionLifecycleOperation,
	SessionLifecycleSavedSession,
	SessionLifecycleSavedSessionIdentity,
	SessionLifecycleService,
	SessionReconcileUncertainTarget,
} from "../lifecycle/service";
import { PROMPT_CLIENT_REF_MAX_LENGTH } from "../prompt-status";
import {
	validateAdapterControl,
	validateAdapterSecretFields,
	validateRequiredPromptText,
} from "../protocol/adapter-validation";
import { adapterDispositionError, findOperation, type OperationKind } from "../protocol/operation-registry";
import { type SessionAttachment, SessionRouter, SessionRouterError, type SessionRouterFrame } from "../router";
import { SessionListTraversalError, sessionListPageFromResponse, traverseSessionList } from "../session-list";
import { SESSION_REQUEST_TIMEOUT_MS } from "../session-reconnect";
import {
	type SdkCheckpointRecordV1,
	type SdkRetentionGapV1,
	type SdkSessionRowV1,
	type SdkTailItemV1,
	SESSION_ROWS_VERSION,
	stripSecretFields,
	toCheckpointRecordV1,
	toRetentionGapV1,
	toSessionRowV1,
	toTailItemV1,
} from "./rows";

export type SdkSessionCliAction =
	| "list"
	| "search"
	| "inspect"
	| "send"
	| "status"
	| "tail"
	| "retire"
	| "global"
	| "raw"
	| "control"
	| "query"
	| "global";
export type SdkSessionListScope = "repo" | "cwd" | "worktree" | "all";
export type SdkSessionCliRawKind = "control" | "query" | "global";

export interface SdkSessionCliArgs {
	action?: string;
	rawAction?: string;
	sessionId?: string;
	opRef?: string;
	operation?: string;
	query?: string;
	text?: string;
	jsonInput?: string;
	jsonInputFile?: string;
	jsonInputStdin?: boolean;
	idempotencyKey?: string;
	confirm?: boolean;
	cursor?: string;
	wait?: boolean;
	timeoutMs?: number;
	strict?: boolean;
	untilIdle?: boolean;
	allEvents?: boolean;
	repo?: string;
	scope?: string;
	limit?: number;
	json?: boolean;

	agentDir?: string;
}

type JsonRecord = Record<string, unknown>;
type LifecycleMutationOperation = Exclude<SessionLifecycleOperation, "session.list">;
type TailExitReason = "idle" | "close";
export interface RetainedTranscriptTailReader {
	readonly size: number;
	readRange(start: number, end: number): Promise<Uint8Array>;
}

const SECRET_FIELD = /(?:secret|token|password|credential|authorization|api[_-]?key)/i;
const SDK_SESSION_CLI_LIFECYCLE_ACTOR = { id: "gjc-sdk-session-cli", namespace: "sdk:session-cli" } as const;
const ROUTER_START_TIMEOUT_MS = 10_000;
const ROUTER_STOP_TIMEOUT_MS = 5_000;
const TAIL_STATUS_POLL_MS = 100;
const TAIL_OFFLINE_MAX_ENTRIES = 200;
const TAIL_OFFLINE_SCAN_CHUNK_BYTES = 64 * 1024;
const TAIL_OFFLINE_MAX_SCAN_BYTES = 4 * 1024 * 1024;
const TAIL_OFFLINE_MAX_SCANNED_LINES = 4_096;
const TAIL_OFFLINE_MAX_LINE_BYTES = 256 * 1024;
const transcriptDecoder = new TextDecoder("utf-8", { fatal: true });
const SEARCH_PROBE_TIMEOUT_MS = 2_000;
const SEARCH_PROBE_MAX_ROWS = 100;
const SEARCH_TEXT_WIDTH = 80;

const TERMINAL_TURN_KINDS = new Set(["turn_end", "agent_end"]);
const START_TURN_KINDS = new Set(["turn_start", "agent_start"]);
const CLOSE_EVENT_KINDS = new Set(["session_closed", "session_terminated"]);
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

class RetainedTranscriptTailError extends Error {
	constructor(
		readonly reason: "unavailable" | "corrupt" | "line_limit" | "scan_limit" | "changed",
		message: string,
	) {
		super(message);
	}
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown): JsonRecord | undefined {
	return isRecord(value) ? value : undefined;
}

function arrayOf(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function resultObject(response: unknown): JsonRecord | undefined {
	const record = object(response);
	return object(record?.result);
}

function parseInput(raw: string | undefined, source: string): JsonRecord {
	if (raw === undefined) return {};
	try {
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value)) throw new SdkSessionCliError("invalid_input", `${source} must be a JSON object.`, 2);
		return value;
	} catch (error) {
		if (error instanceof SdkSessionCliError) throw error;
		throw new SdkSessionCliError("invalid_json", `${source} must contain valid JSON.`, 2);
	}
}

function containsSecretField(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsSecretField);
	if (!isRecord(value)) return false;
	return Object.entries(value).some(([key, nested]) => SECRET_FIELD.test(key) || containsSecretField(nested));
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

function isRawSpawnOperation(kind: OperationKind, operation: string): boolean {
	return kind === "global" && operation === "session.spawn";
}

function isLifecycleOperation(operation: string): operation is LifecycleMutationOperation {
	return (
		operation === "session.create" ||
		operation === "session.fork" ||
		operation === "session.resume" ||
		operation === "session.close" ||
		operation === "session.delete" ||
		operation === "session.reconcile_uncertain"
	);
}

function cliOperationError(kind: OperationKind, operation: string): { code: string; message: string } | undefined {
	const row = findOperation(kind, operation);
	const error = adapterDispositionError("daemonCli", kind, operation);
	if (!error) return undefined;
	if (row?.adapterDispositions.daemonCli === "prohibited")
		return {
			code: error.code,
			message: `${operation} is unavailable through the SDK session CLI.`,
		};
	return error;
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = Promise.withResolvers<never>();
	try {
		timer = setTimeout(() => timeout.reject(new SdkClientError("timeout", message)), timeoutMs);
		return await Promise.race([promise, timeout.promise]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function reportRouterCleanupFailure(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`SDK session Router cleanup failed: ${message}\n`);
}

async function withRouter<T>(
	agentDir: string,
	action: (router: SessionRouter) => Promise<T>,
	onFrame?: (attachment: SessionAttachment, frame: SessionRouterFrame) => void,
	sessionIds?: readonly string[],
): Promise<T> {
	const router = new SessionRouter({
		agentDir,
		...(sessionIds === undefined ? {} : { sessionIds }),
		...(onFrame === undefined ? {} : { deps: { onFrame } }),
	});
	let result!: T;
	let actionFailed = false;
	let actionError: unknown;
	try {
		await bounded(router.start(), ROUTER_START_TIMEOUT_MS, "SDK session Router startup timed out.");
		result = await action(router);
	} catch (error) {
		actionFailed = true;
		actionError = error;
	}
	try {
		await bounded(router.stop(), ROUTER_STOP_TIMEOUT_MS, "SDK session Router shutdown timed out.");
	} catch (error) {
		reportRouterCleanupFailure(error);
	}
	if (actionFailed) throw actionError;
	return result;
}

function attachmentFor(router: SessionRouter, sessionId: string): SessionAttachment {
	const attachment = router.attachment(sessionId);
	if (!attachment)
		throw new SdkSessionCliError(
			"session_unavailable",
			`SDK session ${sessionId} is unavailable through the session Router.`,
			1,
		);
	return attachment;
}

function throwResponseFailure(response: unknown): void {
	const record = object(response);
	if (record?.ok !== false) return;
	const failure = object(record.error);
	throw new SdkSessionCliError(
		typeof failure?.code === "string" ? failure.code : "unavailable",
		typeof failure?.message === "string" ? failure.message : "SDK request failed.",
		1,
		failure,
	);
}

async function paginatedSessionList(
	router: SessionRouter,
	input: JsonRecord = {},
	requestKey = `${SDK_SESSION_CLI_LIFECYCLE_ACTOR.namespace}:session.list`,
): Promise<unknown> {
	try {
		const pages = await traverseSessionList(
			input,
			async pageInput => {
				const response = object(await router.listBrokerSessions(pageInput, requestKey));
				if (response?.ok === false) {
					const failure = object(response.error);
					throw new SdkClientError(
						typeof failure?.code === "string" ? failure.code : "broker_error",
						typeof failure?.message === "string" ? failure.message : "session.list failed",
					);
				}
				return response;
			},
			response => sessionListPageFromResponse(response),
		);
		const aggregate: JsonRecord = {};
		const sessions: unknown[] = [];
		for (const { page } of pages) {
			for (const [key, value] of Object.entries(page)) {
				if (key !== "sessions" && key !== "continuationCursor") aggregate[key] = value;
			}
			sessions.push(...page.sessions);
		}
		const result = { ...aggregate, sessions };
		const firstResponse = pages[0]?.response;
		return firstResponse && Object.hasOwn(firstResponse, "result") ? { ...firstResponse, result } : result;
	} catch (error) {
		if (error instanceof SessionListTraversalError) throw new SdkClientError("protocol_error", error.message);
		throw error;
	}
}

type SessionRows = {
	indexSeq?: number;
	warnings: unknown[];
	sessions: SdkSessionRowV1[];
};

async function sessionRows(agentDir: string): Promise<SessionRows> {
	await ensureBroker({ agentDir });
	return await withRouter(agentDir, async router => {
		const response = await paginatedSessionList(router);
		const result = resultObject(response) ?? {};
		let sessions: SdkSessionRowV1[];
		try {
			sessions = arrayOf(result.sessions).map(toSessionRowV1);
		} catch {
			throw new SdkClientError("protocol_error", "session.list returned a malformed session row.");
		}
		return {
			...(typeof result.indexSeq === "number" ? { indexSeq: result.indexSeq } : {}),
			warnings: arrayOf(result.warnings),
			sessions,
		};
	});
}

function searchScopeRequest(scope: ScopeNameV1, locator: { cwd: string; worktreeRoot: string | null }): ScopeRequestV1 {
	return { version: 1, requested: scope, requestAnchor: { cwd: locator.cwd, worktreeRoot: locator.worktreeRoot } };
}

function searchProbe(row: SdkSearchRowV1, router: SessionRouter): Promise<SdkSearchRowV1> {
	if (!row.live) return Promise.resolve({ ...row, probe: "stale" });
	return (async () => {
		try {
			const attachment = router.attachment(row.id);
			if (!attachment) return { ...row, probe: "unreachable" };
			const response = await router.request(
				row.id,
				{ type: "query_request", query: "session.checkpoint", input: {} },
				attachment.generation,
				attachment,
				{ timeoutMs: SEARCH_PROBE_TIMEOUT_MS },
			);
			return { ...row, probe: response.ok === true ? "reachable" : "unreachable" };
		} catch {
			return { ...row, probe: "unreachable" };
		}
	})();
}

export function mergeProbedSearchRows(
	rows: readonly SdkSearchRowV1[],
	probedRows: readonly SdkSearchRowV1[],
): readonly SdkSearchRowV1[] {
	return [...probedRows, ...rows.slice(probedRows.length)];
}

async function probeSearchRows(agentDir: string, result: SdkSearchResultV1): Promise<SdkSearchResultV1> {
	if (result.status === "unavailable" || result.status === "not-in-git-worktree" || result.rows.length === 0)
		return result;
	const rows = result.rows.slice(0, SEARCH_PROBE_MAX_ROWS);
	try {
		const probes = await withRouter(
			agentDir,
			async router => await Promise.all(rows.map(row => searchProbe(row, router))),
			undefined,
			rows.map(row => row.id),
		);
		return { ...result, rows: mergeProbedSearchRows(result.rows, probes) };
	} catch {
		return {
			...result,
			rows: mergeProbedSearchRows(
				result.rows,
				rows.map(row => ({ ...row, probe: row.live ? "unreachable" : "stale" })),
			),
		};
	}
}

/** Resolves, lists, and probes only the exact rows selected by the Broker-scoped search. */
export async function runSdkSearch(
	args: Pick<SdkSessionCliArgs, "agentDir" | "repo" | "scope" | "limit" | "cursor">,
	createService: (agentDir: string) => SessionLifecycleService = createBrokerSessionLifecycleService,
	probe: (agentDir: string, result: SdkSearchResultV1) => Promise<SdkSearchResultV1> = probeSearchRows,
): Promise<{ result: SdkSearchResultV1; exitCode: 0 | 1 }> {
	const agentDir = args.agentDir ?? getAgentDir();
	const locator = await resolveSessionLocator(args.repo ?? process.cwd(), agentDir);
	const scope: ScopeNameV1 =
		args.scope === undefined || args.scope === "repo" || args.scope === "pwd" || args.scope === "global"
			? ((args.scope ?? "repo") as ScopeNameV1)
			: (() => {
					throw new SdkSessionCliError(
						"usage",
						`Invalid search scope "${args.scope}". Expected repo, pwd, or global.`,
						2,
					);
				})();
	const request = searchScopeRequest(scope, locator);
	const resolved = await resolveScopeRequest(request);
	const outcome = await createService(agentDir).scopedList(request, args.limit, args.cursor);
	if (outcome.ok) {
		if ("rows" in outcome.result) {
			if (outcome.result.status === "not-in-git-worktree") return { result: outcome.result, exitCode: 0 };
			if (outcome.result.status === "unavailable") return { result: outcome.result, exitCode: 1 };
			return { result: await probe(agentDir, outcome.result), exitCode: 0 };
		}
		return {
			result: {
				version: 1,
				scope: resolved,
				status: "unavailable",
				observedAt: new Date().toISOString(),
				rows: [],
				warnings: [],
				error: { code: "malformed_response", message: "broker search returned an unscoped result" },
			},
			exitCode: 1,
		};
	}
	if (!outcome.ok && outcome.result?.status === "unavailable") return { result: outcome.result, exitCode: 1 };
	return {
		result: {
			version: 1,
			scope: resolved,
			status: "unavailable",
			observedAt: new Date().toISOString(),
			rows: [],
			warnings: [],
			error: { code: outcome.error.code, message: outcome.error.message },
		},
		exitCode: 1,
	};
}

function searchScopeLabel(result: SdkSearchResultV1): string {
	const resolved = result.scope.resolved;
	if (resolved === null) return "not-in-git-worktree";
	if (resolved.kind === "repo") return resolved.worktreeRoot;
	if (resolved.kind === "pwd") return resolved.cwd;
	return resolved.visibility;
}

function safeSearchText(value: string): string {
	return truncateToWidth(replaceTabs(value).replaceAll(/[\r\n]/g, " "), SEARCH_TEXT_WIDTH);
}

/** Renders a credential-free scope/status preamble and bounded search table. */
export function renderSdkSearchTable(result: SdkSearchResultV1): string {
	const lines = [
		`Scope requested: ${result.scope.requested}`,
		`Scope resolved: ${safeSearchText(searchScopeLabel(result))}`,
		`Status: ${result.status}`,
		`Observed at: ${result.observedAt}`,
		...(result.cursor === undefined ? [] : [`Continuation cursor: ${safeSearchText(result.cursor)}`]),
	];
	if (result.rows.length === 0) return lines.join("\n");
	lines.push("ID  PROBE        LIVE  CWD");
	for (const row of result.rows)
		lines.push(
			`${safeSearchText(row.id).padEnd(20)}  ${(row.probe ?? "-").padEnd(11)}  ${String(row.live).padEnd(4)}  ${safeSearchText(row.locator.cwd)}`,
		);
	return lines.join("\n");
}

const SESSION_LIST_SCOPES: readonly SdkSessionListScope[] = ["repo", "cwd", "worktree", "all"];
/** Row workspaces whose locator cannot be canonicalized still get one deterministic identity. */
const WORKSPACE_IDENTITY_CACHE_LIMIT = 4096;

interface WorkspaceIdentity {
	/** Canonical workspace path (realpath when it exists, lexical resolve otherwise). */
	canonicalPath: string;
	/** Canonical containing worktree root; null outside a Git checkout. */
	repoRoot: string | null;
	/** Canonical Git common dir; shared by the main checkout and linked worktrees. */
	commonDir: string | null;
}

export interface SdkSessionListSelection {
	scope: SdkSessionListScope;
	selection: WorkspaceIdentity;
	/** Bounded, credential-free descriptor included in list output. */
	descriptor: {
		scope: SdkSessionListScope;
		path: string;
		worktreeRoot?: string;
		commonDir?: string;
	};
}

/** Parses `--scope`; missing means `repo`, anything else invalid is a usage error. */
export function parseSessionListScope(value: string | undefined): SdkSessionListScope {
	if (value === undefined) return "repo";
	if ((SESSION_LIST_SCOPES as readonly string[]).includes(value)) return value as SdkSessionListScope;
	throw new SdkSessionCliError(
		"usage",
		`Invalid scope "${value}". Expected one of: ${SESSION_LIST_SCOPES.join(", ")}.`,
		2,
	);
}

async function canonicalWorkspacePath(target: string): Promise<string> {
	try {
		return await fs.realpath(target);
	} catch {
		// A removed or unreadable workspace keeps a deterministic lexical identity
		// instead of guessing a broader or narrower one.
		return path.resolve(target);
	}
}

const workspaceIdentityCache = new Map<string, WorkspaceIdentity>();

/** Resolves (and caches) the Git identity of one workspace locator. */
async function workspaceIdentity(target: string): Promise<WorkspaceIdentity> {
	const canonicalPath = await canonicalWorkspacePath(target);
	const cached = workspaceIdentityCache.get(canonicalPath);
	if (cached) return cached;
	if (target === "unknown") {
		const unavailable = { canonicalPath, repoRoot: null, commonDir: null };
		workspaceIdentityCache.set(canonicalPath, unavailable);
		return unavailable;
	}
	try {
		if (!(await fs.stat(target)).isDirectory()) throw new Error("workspace is not a directory");
	} catch {
		// A removed or unreadable locator cannot prove Git membership. Keeping it
		// outside every identity is the narrowest safe result for row filtering.
		const unavailable = { canonicalPath, repoRoot: null, commonDir: null };
		workspaceIdentityCache.set(canonicalPath, unavailable);
		return unavailable;
	}
	const repository = await resolveGitRepository.resolve(canonicalPath);
	const identity: WorkspaceIdentity = repository
		? {
				canonicalPath,
				repoRoot: await canonicalWorkspacePath(repository.repoRoot),
				commonDir: await canonicalWorkspacePath(repository.commonDir),
			}
		: { canonicalPath, repoRoot: null, commonDir: null };
	if (workspaceIdentityCache.size >= WORKSPACE_IDENTITY_CACHE_LIMIT) workspaceIdentityCache.clear();
	workspaceIdentityCache.set(canonicalPath, identity);
	return identity;
}

/**
 * Resolves the list selection from `--repo` (default: process cwd) under the
 * effective scope. Outside Git, `repo`/`worktree` fail typed and actionable —
 * they never broaden to `all`; `cwd` remains an exact canonical match.
 */
export async function resolveSessionListSelection(
	scope: SdkSessionListScope,
	repoArg: string | undefined,
): Promise<SdkSessionListSelection> {
	const selection = await workspaceIdentity(repoArg ?? process.cwd());
	if (scope !== "cwd" && !selection.repoRoot)
		throw new SdkSessionCliError(
			"not_a_repository",
			`--scope ${scope} requires a Git repository, but "${selection.canonicalPath}" is outside any Git checkout. ` +
				"Use --scope cwd for an exact workspace match or --scope all for the full broker listing.",
			1,
		);
	const descriptor: SdkSessionListSelection["descriptor"] = {
		scope,
		path: selection.canonicalPath,
		...(selection.repoRoot ? { worktreeRoot: selection.repoRoot, commonDir: selection.commonDir! } : {}),
	};
	return { scope, selection, descriptor };
}

/**
 * Filters fully traversed broker rows by the selection scope. Row workspaces
 * are canonicalized and cached per distinct locator; `repo` matches the shared
 * common dir across the main checkout and linked worktrees, `worktree` the
 * containing worktree only, and `cwd` the exact canonical workspace.
 */
export async function filterSessionRowsByScope(
	rows: readonly SdkSessionRowV1[],
	scope: SdkSessionListScope,
	selection: SdkSessionListSelection,
): Promise<{ sessions: SdkSessionRowV1[]; warnings: string[] }> {
	if (scope === "all") return { sessions: [...rows], warnings: [] };
	const warnings: string[] = [];
	const sessions: SdkSessionRowV1[] = [];
	for (const row of rows) {
		const identity = await workspaceIdentity(row.locator.cwd);
		let keep: boolean;
		if (scope === "cwd") keep = identity.canonicalPath === selection.selection.canonicalPath;
		else if (scope === "worktree")
			keep = identity.repoRoot !== null && identity.repoRoot === selection.selection.repoRoot;
		else keep = identity.commonDir !== null && identity.commonDir === selection.selection.commonDir;
		if (keep) sessions.push(row);
		else if (identity.repoRoot === null && identity.commonDir === null)
			warnings.push(
				`Session ${row.sessionId} workspace "${row.locator.cwd}" is outside Git; excluded by scope ${scope}.`,
			);
	}
	return { sessions, warnings };
}

async function runList(agentDir: string, args: SdkSessionCliArgs): Promise<unknown> {
	const scope = parseSessionListScope(args.scope);
	const { selection, descriptor } = await resolveSessionListSelection(scope, args.repo);
	const listing = await sessionRows(agentDir);
	const filtered = await filterSessionRowsByScope(listing.sessions, scope, { scope, selection, descriptor });
	return {
		ok: true,
		result: {
			version: SESSION_ROWS_VERSION,
			source: "broker",
			scope,
			selection: descriptor,
			...(listing.indexSeq === undefined ? {} : { indexSeq: listing.indexSeq }),
			sessions: filtered.sessions,
			warnings: [...listing.warnings, ...filtered.warnings],
		},
	};
}

async function runInspect(agentDir: string, sessionId: string): Promise<unknown> {
	const listing = await sessionRows(agentDir);
	const session = listing.sessions.find(candidate => candidate.sessionId === sessionId);
	if (!session)
		throw new SdkSessionCliError("session_unavailable", `Session ${sessionId} is not indexed by the broker.`, 1);
	return { ok: true, result: { version: SESSION_ROWS_VERSION, source: "broker", session } };
}

/** Creates a lowercase ULID operation reference for prompt reconciliation. */
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
	return typeof input.clientRef === "string" ? input.clientRef.trim() : undefined;
}

function assertClientRef(clientRef: string): void {
	if (!clientRef || clientRef.length > PROMPT_CLIENT_REF_MAX_LENGTH)
		throw new SdkSessionCliError(
			"invalid_input",
			`clientRef must be a non-empty string of at most ${PROMPT_CLIENT_REF_MAX_LENGTH} characters.`,
			2,
		);
}

async function requestControl(
	router: SessionRouter,
	sessionId: string,
	operation: string,
	input: JsonRecord,
	args: SdkSessionCliArgs,
): Promise<JsonRecord> {
	const attachment = attachmentFor(router, sessionId);
	const response = await router.request(
		sessionId,
		controlRequestFrame(operation, input, args),
		attachment.generation,
		attachment,
		args.timeoutMs === undefined ? undefined : { timeoutMs: args.timeoutMs },
	);
	throwResponseFailure(response);
	return response;
}

/** Builds the public CLI control envelope without leaking envelope fields into operation input. */
export function controlRequestFrame(
	operation: string,
	input: JsonRecord,
	args: Pick<SdkSessionCliArgs, "confirm" | "idempotencyKey">,
): JsonRecord {
	return {
		type: "control_request",
		operation,
		input,
		confirm: args.confirm === true,
		...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
	};
}

const BROKER_OPERATOR_ABORT_FIELDS = new Set(["mode", "scope", "operator"]);

export function operatorAbortBrokerRequest(
	sessionId: string,
	operation: string,
	input: JsonRecord,
	args: Pick<SdkSessionCliArgs, "confirm" | "idempotencyKey">,
): JsonRecord | undefined {
	if (!Object.hasOwn(input, "operator")) return undefined;
	if (operation !== "turn.abort")
		throw new SdkSessionCliError("invalid_input", "operator is only available for terminal turn.abort.", 2);
	if (input.operator !== true)
		throw new SdkSessionCliError("invalid_input", "turn.abort operator must be true when provided.", 2);
	if (input.mode !== "terminal")
		throw new SdkSessionCliError("invalid_input", 'operator turn.abort requires mode:"terminal".', 2);
	for (const key of Object.keys(input))
		if (!BROKER_OPERATOR_ABORT_FIELDS.has(key))
			throw new SdkSessionCliError(`invalid_input`, `Unknown turn.abort terminal field: ${key}`, 2);
	if (input.scope !== undefined && input.scope !== "turn" && input.scope !== "owned")
		throw new SdkSessionCliError("invalid_input", 'operator turn.abort scope must be "turn" or "owned".', 2);
	if (args.confirm !== true)
		throw new SdkSessionCliError("invalid_input", "operator terminal abort requires --confirm.", 2);
	if (!args.idempotencyKey)
		throw new SdkSessionCliError("invalid_input", "operator terminal abort requires --idempotency-key.", 2);
	return { sessionId, operation: "turn.abort", input, confirm: true };
}

async function requestBrokerOperatorAbort(
	agentDir: string,
	request: JsonRecord,
	args: SdkSessionCliArgs,
): Promise<JsonRecord> {
	const idempotencyKey = args.idempotencyKey;
	if (!idempotencyKey)
		throw new SdkSessionCliError("invalid_input", "operator terminal abort requires --idempotency-key.", 2);
	const discovery = await readSdkBrokerDiscovery(agentDir);
	if (!discovery) throw new SdkSessionCliError("session_unavailable", "SDK broker discovery is unavailable.", 1);
	const timeoutMs = args.timeoutMs ?? SESSION_REQUEST_TIMEOUT_MS;
	const client = await SdkClient.connect(discovery.url, discovery.token, {
		timeoutMs,
		reconnectAttempts: 0,
	});
	try {
		const response = await client.global("session.control", request, {
			idempotencyKey,
			timeoutMs,
		});
		const result = object(response);
		if (!result) throw new SdkClientError("protocol_error", "SDK broker returned a malformed control response.");
		throwResponseFailure(result);
		return result;
	} finally {
		await client.close().catch(error => {
			process.stderr.write(
				`SDK broker control cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		});
	}
}

async function requestQuery(
	router: SessionRouter,
	sessionId: string,
	query: string,
	input: JsonRecord,
	args: SdkSessionCliArgs,
): Promise<JsonRecord> {
	const attachment = attachmentFor(router, sessionId);
	const response = await router.request(
		sessionId,
		{
			type: "query_request",
			query,
			input,
			...(args.cursor === undefined ? {} : { cursor: args.cursor }),
		},
		attachment.generation,
		attachment,
		args.timeoutMs === undefined ? undefined : { timeoutMs: args.timeoutMs },
	);
	throwResponseFailure(response);
	return response;
}

/** Exported for tests: each status poll must stay inside the caller's wait window. */
export async function waitForTerminalStatus(
	router: SessionRouter,
	sessionId: string,
	clientRef: string,
	timeoutMs: number | undefined,
): Promise<{ terminal: boolean; status: string; detail: unknown }> {
	const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
	let status = "unknown";
	let detail: unknown = {};
	for (;;) {
		// Each poll is bounded by what is left of the caller's wait window, twice over.
		// The request budget bounds the reply, and `bounded` bounds the whole poll: a
		// disconnected transport reconnects before the reply timer is even installed,
		// so without the outer bound the router's independent reconnect budget could
		// still dispatch the query after the caller's window closed.
		const remainingMs = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
		const poll = requestQuery(
			router,
			sessionId,
			"turn.result",
			{ kind: "prompt", clientRef },
			remainingMs === undefined ? {} : { timeoutMs: remainingMs },
		);
		let response: JsonRecord;
		try {
			response =
				remainingMs === undefined
					? await poll
					: await bounded(poll, remainingMs, `Prompt ${clientRef} status poll exceeded the wait window.`);
		} catch (error) {
			// An elapsed wait window is the documented `wait_timeout` outcome with the
			// last observed status, not a transport failure. Anything else — and any
			// failure with window left — is a real error the caller must see.
			if (deadline !== undefined && Date.now() >= deadline && isWaitWindowFailure(error))
				return { terminal: false, status, detail };
			throw error;
		}
		const result = resultObject(response) ?? {};
		status = typeof result.status === "string" ? result.status : "unknown";
		detail = result;
		if (status === "terminal_ok" || status === "failed") return { terminal: true, status, detail: result };
		if (deadline !== undefined && Date.now() >= deadline) return { terminal: false, status, detail: result };
		await Bun.sleep(TAIL_STATUS_POLL_MS);
	}
}

/**
 * True for the failures a poll produces when the wait window itself ends it:
 * the outer bound, the request reply timer, and the uncertain send the transport
 * reports when a request that was already on the wire is abandoned.
 */
function isWaitWindowFailure(error: unknown): boolean {
	if (error instanceof SdkClientError) return error.code === "timeout" || error.code === "uncertain_after_send";
	return error instanceof SdkSessionCliError && error.code === "timeout";
}

async function runSend(agentDir: string, sessionId: string, args: SdkSessionCliArgs): Promise<unknown> {
	const input = await inputFromArgs(args);
	if (args.text !== undefined && Object.keys(input).length > 0)
		throw new SdkSessionCliError("usage", "Use either --text or one JSON input source for the prompt, not both.", 2);
	const promptInput: JsonRecord = args.text === undefined ? { ...input } : { text: args.text };
	const promptError = validateRequiredPromptText("turn.prompt", promptInput);
	if (promptError) throw new SdkSessionCliError(promptError.code, promptError.message, 2);
	const inputRef = clientRefFromInput(promptInput);
	const clientRef = inputRef ?? args.opRef?.trim() ?? createOperationRef();
	if (args.opRef !== undefined && inputRef !== undefined && inputRef !== args.opRef.trim())
		throw new SdkSessionCliError("usage", "--op-ref must match the clientRef in the JSON input.", 2);
	assertClientRef(clientRef);
	if (inputRef === undefined) promptInput.clientRef = clientRef;
	const invalid = validateAdapterControl("turn.prompt", promptInput);
	if (invalid) throw new SdkSessionCliError(invalid.code, invalid.message, 2);
	await ensureBroker({ agentDir });

	return await withRouter(agentDir, async router => {
		const response = await requestControl(router, sessionId, "turn.prompt", promptInput, args);
		const result: JsonRecord = {
			version: SESSION_ROWS_VERSION,
			operationRef: clientRef,
			status: "accepted",
			receipt: resultObject(response) ?? response,
		};
		if (args.wait === true) {
			const outcome = await waitForTerminalStatus(router, sessionId, clientRef, args.timeoutMs ?? 30_000);
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
		return { ok: true, result };
	});
}

async function runStatus(
	agentDir: string,
	sessionId: string,
	opRef: string,
	args: SdkSessionCliArgs,
): Promise<unknown> {
	assertClientRef(opRef);
	await ensureBroker({ agentDir });
	return await withRouter(agentDir, async router => {
		const response = await requestQuery(router, sessionId, "turn.result", { kind: "prompt", clientRef: opRef }, args);
		const status = resultObject(response) ?? {};
		const raw = typeof status.status === "string" ? status.status : "unknown";
		return {
			ok: true,
			result: {
				version: SESSION_ROWS_VERSION,
				operationRef: opRef,
				status,
				summary: { completed: raw === "terminal_ok" || raw === "failed" },
			},
		};
	});
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
	const cursor =
		typeof result.checkpointToken === "string" && result.checkpointToken ? result.checkpointToken : undefined;
	return { record, cursor };
}

function extractTranscriptPage(response: unknown): { items: unknown[]; complete: boolean; cursor?: string } {
	const record = object(response);
	const page = object(record?.page) ?? object(resultObject(response)?.page);
	if (!page) return { items: arrayOf(resultObject(response)?.items), complete: true };
	return {
		items: arrayOf(page.items),
		complete: page.complete === true,
		cursor: typeof page.continuationCursor === "string" ? page.continuationCursor : undefined,
	};
}

function tailItemKey(item: SdkTailItemV1): string {
	if (item.generation !== undefined && item.seq !== undefined)
		return `${item.kind}\u0000${item.generation}\u0000${item.seq}`;
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

/** Canonical ring position of an event item, when the host stated one. */
type TailSeqKey = { generation: number; seq: number };

function isPositionCoordinate(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function malformedPositionError(
	sessionId: string,
	kind: string,
	generation: unknown,
	seq: unknown,
): SdkSessionCliError {
	return new SdkSessionCliError(
		"protocol_error",
		"The event ring stated an incomplete or invalid generation and sequence position.",
		1,
		{
			sessionId,
			kind,
			...(generation === undefined ? {} : { generation }),
			...(seq === undefined ? {} : { seq }),
		},
	);
}

/**
 * Classifies a raw event-ring row's position claim before projection.
 *
 * `toTailItemV1` keeps a coordinate only when it is already a number, so a raw
 * `null` — which is also what a non-finite JS number becomes once it crosses
 * JSON — would lose its property presence and read as genuinely unpositioned.
 * Presence is therefore decided on the raw row, where the claim still exists.
 */
function classifyRawEventPosition(event: unknown): "unpositioned" | "malformed" | "positioned" {
	if (!isRecord(event)) return "unpositioned";
	const hasGeneration = "generation" in event;
	const hasSeq = "seq" in event;
	if (!hasGeneration && !hasSeq) return "unpositioned";
	return isPositionCoordinate(event.generation) && isPositionCoordinate(event.seq) ? "positioned" : "malformed";
}

/**
 * Classifies an event-ring item's claimed position.
 *
 * Only a pair of non-negative safe integers is canonical. Claiming exactly one
 * coordinate, or a negative, fractional, non-finite, or unsafe-integer value,
 * is a malformed claim: the host stated a position it cannot substantiate, so
 * it is never silently downgraded to unpositioned. Claiming neither coordinate
 * is a genuine unpositioned event.
 */
function classifyTailPosition(item: SdkTailItemV1): TailSeqKey | "unpositioned" | "malformed" {
	if (item.generation === undefined && item.seq === undefined) return "unpositioned";
	if (!isPositionCoordinate(item.generation) || !isPositionCoordinate(item.seq)) return "malformed";
	return { generation: item.generation, seq: item.seq };
}

function tailSeqKey(item: SdkTailItemV1): TailSeqKey | undefined {
	const position = classifyTailPosition(item);
	return typeof position === "string" ? undefined : position;
}

function compareTailSeqKeys(left: TailSeqKey, right: TailSeqKey): number {
	return left.generation !== right.generation ? left.generation - right.generation : left.seq - right.seq;
}

/** Event items split by whether the host stated a canonical ring position. */
type EventTailSegments = { positioned: SdkTailItemV1[]; unpositioned: SdkTailItemV1[] };

/**
 * Merges event items into canonical `(generation, seq)` order and returns only
 * the ones observed for the first time.
 *
 * The Router's attach/live frames and the CLI's explicit replay are out-of-band
 * with each other, so arrival order is not ring order: a live frame can be seen
 * before an older replayed event resolves. Ordering is established at insertion
 * rather than by sorting a completed arrival-order list, so the caller can fold
 * lifecycle state against the same canonical positions the caller returns.
 *
 * Positioned and unpositioned events are kept in separate segments. An
 * unpositioned event states no position, so it can neither be ordered against a
 * positioned event nor act as an anchor that strands positioned events on
 * either side of it; it stays visible in arrival order after the canonical
 * segment.
 */
function mergeEventTailItems(
	target: EventTailSegments,
	seen: Set<string>,
	items: SdkTailItemV1[],
	include: (kind: string) => boolean,
): { merged: SdkTailItemV1[]; malformed: SdkTailItemV1 | undefined } {
	const merged: SdkTailItemV1[] = [];
	for (const item of items) {
		// Validated before dedupe, ordering, or state so a malformed claim can
		// never occupy a key or influence turn state on its way to failing closed.
		const position = classifyTailPosition(item);
		if (position === "malformed") return { merged, malformed: item };
		const key = tailItemKey(item);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(item);
		if (!include(item.kind)) continue;
		if (position === "unpositioned") {
			target.unpositioned.push(item);
			continue;
		}
		let index = target.positioned.length;
		for (; index > 0; index--) {
			const previous = tailSeqKey(target.positioned[index - 1]!);
			if (previous === undefined || compareTailSeqKeys(previous, position) <= 0) break;
		}
		target.positioned.splice(index, 0, item);
	}
	return { merged, malformed: undefined };
}

function eventGapToRetentionGap(
	value: unknown,
	frame: JsonRecord,
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

function tailItemFromRouterFrame(frame: SessionRouterFrame): SdkTailItemV1 | undefined {
	if (frame.name === undefined) return undefined;
	// The replay response is an out-of-band control frame, not an event-ring
	// item. Its generation/lastSeq metadata is a response position, and it
	// intentionally has no event `seq`; projecting it as a tail item would make
	// the strict event-position validator reject every otherwise valid tail.
	if (frame.name === "event_replay_result") return undefined;
	const seq = frame.seq;
	return toTailItemV1(
		{
			kind: frame.name,
			...(seq === undefined ? {} : { generation: frame.generation, seq }),
			payload: frame.body,
		},
		{
			kind: frame.name,
			...(seq === undefined ? {} : { generation: frame.generation, seq }),
		},
	);
}

function retainedTranscriptUnavailable(): RetainedTranscriptTailError {
	return new RetainedTranscriptTailError("unavailable", "Retained transcript history is unavailable.");
}

function retainedTranscriptOpenFlags(): number {
	const noFollow = process.platform === "win32" ? 0 : fsSync.constants.O_NOFOLLOW;
	if (process.platform !== "win32" && !noFollow) throw retainedTranscriptUnavailable();
	return (
		fsSync.constants.O_RDONLY | noFollow | (process.platform === "win32" ? 0 : (fsSync.constants.O_NONBLOCK ?? 0))
	);
}

function retainedTranscriptIdentityMismatch(): RetainedTranscriptTailError {
	return new RetainedTranscriptTailError(
		"changed",
		"Retained transcript history no longer matches the Broker-selected identity; refusing to replay it.",
	);
}

function matchesRetainedTranscriptIdentity(
	identity: SessionLifecycleSavedSessionIdentity,
	descriptor: fsSync.BigIntStats,
): boolean {
	try {
		return (
			descriptor.isFile() &&
			descriptor.dev === BigInt(identity.dev) &&
			descriptor.ino === BigInt(identity.ino) &&
			descriptor.nlink === BigInt(identity.nlink) &&
			descriptor.size === BigInt(identity.size) &&
			descriptor.mtimeMs === BigInt(identity.mtimeMs) &&
			descriptor.mtimeNs === BigInt(identity.mtimeNs) &&
			descriptor.ctimeNs === BigInt(identity.ctimeNs)
		);
	} catch {
		return false;
	}
}

function retainedTranscriptCorrupt(): RetainedTranscriptTailError {
	return new RetainedTranscriptTailError(
		"corrupt",
		"Retained transcript history contains unparseable entries; refusing to replay corrupted history.",
	);
}

export async function scanRetainedTranscriptTail(reader: RetainedTranscriptTailReader): Promise<unknown[]> {
	if (!Number.isSafeInteger(reader.size) || reader.size < 0) throw retainedTranscriptUnavailable();
	const entries: unknown[] = [];
	let position = reader.size;
	let scannedBytes = 0;
	let scannedLines = 0;
	let trailingFragment = new Uint8Array();
	while (position > 0 && entries.length < TAIL_OFFLINE_MAX_ENTRIES) {
		const remainingBytes = TAIL_OFFLINE_MAX_SCAN_BYTES - scannedBytes;
		if (remainingBytes <= 0)
			throw new RetainedTranscriptTailError(
				"scan_limit",
				"Retained transcript history exceeds the bounded tail replay limit.",
			);
		const length = Math.min(TAIL_OFFLINE_SCAN_CHUNK_BYTES, position, remainingBytes);
		const start = position - length;
		let chunk: Uint8Array;
		try {
			chunk = await reader.readRange(start, position);
		} catch {
			throw retainedTranscriptUnavailable();
		}
		if (chunk.byteLength !== length) throw retainedTranscriptUnavailable();
		scannedBytes += chunk.byteLength;
		const combined = new Uint8Array(chunk.byteLength + trailingFragment.byteLength);
		combined.set(chunk);
		combined.set(trailingFragment, chunk.byteLength);

		let complete = combined;
		let partial = new Uint8Array();
		if (start > 0) {
			const firstNewline = combined.indexOf(0x0a);
			if (firstNewline === -1) {
				if (combined.byteLength > TAIL_OFFLINE_MAX_LINE_BYTES)
					throw new RetainedTranscriptTailError(
						"line_limit",
						"Retained transcript history exceeds the bounded tail replay limit.",
					);
				trailingFragment = combined;
				position = start;
				continue;
			}
			partial = combined.subarray(0, firstNewline);
			complete = combined.subarray(firstNewline + 1);
		}

		let lineEnd = complete.byteLength;
		while (lineEnd > 0 && entries.length < TAIL_OFFLINE_MAX_ENTRIES) {
			const newline = complete.lastIndexOf(0x0a, lineEnd - 1);
			const lineStart = newline < 0 ? 0 : newline + 1;
			const line = complete.subarray(lineStart, lineEnd);
			lineEnd = newline < 0 ? 0 : newline;
			scannedLines++;
			if (scannedLines > TAIL_OFFLINE_MAX_SCANNED_LINES)
				throw new RetainedTranscriptTailError(
					"scan_limit",
					"Retained transcript history exceeds the bounded tail replay limit.",
				);
			if (line.byteLength === 0) continue;
			if (line.byteLength > TAIL_OFFLINE_MAX_LINE_BYTES)
				throw new RetainedTranscriptTailError(
					"line_limit",
					"Retained transcript history exceeds the bounded tail replay limit.",
				);
			try {
				entries.push(JSON.parse(transcriptDecoder.decode(line)));
			} catch {
				throw retainedTranscriptCorrupt();
			}
		}
		if (entries.length === TAIL_OFFLINE_MAX_ENTRIES) break;
		if (start > 0) {
			if (partial.byteLength > TAIL_OFFLINE_MAX_LINE_BYTES)
				throw new RetainedTranscriptTailError(
					"line_limit",
					"Retained transcript history exceeds the bounded tail replay limit.",
				);
			trailingFragment = partial;
		}
		position = start;
	}
	return entries.reverse();
}

async function readRetainedTranscriptTail(savedSession: SessionLifecycleSavedSession): Promise<unknown[]> {
	let descriptor: fs.FileHandle | undefined;
	try {
		descriptor = await fs.open(savedSession.path, retainedTranscriptOpenFlags());
		const before = await descriptor.stat({ bigint: true });
		if (!matchesRetainedTranscriptIdentity(savedSession.identity, before)) throw retainedTranscriptIdentityMismatch();
		if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw retainedTranscriptUnavailable();
		// Bind every range read to the opened descriptor so a later pathname replacement
		// cannot change the retained history selected by the lifecycle lookup.
		const file = Bun.file(descriptor.fd);
		const entries = await scanRetainedTranscriptTail({
			size: Number(before.size),
			readRange: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
		});
		const after = await descriptor.stat({ bigint: true });
		if (
			!matchesRetainedTranscriptIdentity(savedSession.identity, after) ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs ||
			before.ctimeNs !== after.ctimeNs
		)
			throw new RetainedTranscriptTailError(
				"changed",
				"Retained transcript history changed while reading; refusing to replay it.",
			);
		return entries;
	} catch (error) {
		if (error instanceof RetainedTranscriptTailError) throw error;
		throw retainedTranscriptUnavailable();
	} finally {
		if (descriptor !== undefined) await descriptor.close().catch(() => {});
	}
}

async function offlineTailReplay(
	repo: string,
	agentDir: string,
	sessionId: string,
	row: SdkSessionRowV1,
): Promise<unknown> {
	const lifecycle = createBrokerSessionLifecycleService(agentDir);
	const outcome = await lifecycle.list({
		actor: SDK_SESSION_CLI_LIFECYCLE_ACTOR,
		capability: "session.list",
		target: { cwd: repo, resolveSessionId: sessionId },
	});
	if (!outcome.ok)
		throw new SdkSessionCliError(outcome.error.code, outcome.error.message, 1, { certainty: outcome.certainty });
	if ("rows" in outcome.result)
		throw new SdkSessionCliError(
			"malformed_response",
			"broker returned a scoped result for retained transcript replay",
			1,
		);
	const savedSession = outcome.result.savedSession;
	if (!savedSession)
		throw new SdkSessionCliError(
			"session_unavailable",
			`Session ${sessionId} is stopped and has no retained transcript replay.`,
			1,
		);
	let entries: unknown[];
	try {
		entries = await readRetainedTranscriptTail(savedSession);
	} catch (error) {
		const retained = error instanceof RetainedTranscriptTailError ? error : retainedTranscriptUnavailable();
		throw new SdkSessionCliError("retention_gap", retained.message, 1, {
			code: "retention_gap",
			reason: retained.reason,
		});
	}
	return {
		ok: true,
		result: {
			version: SESSION_ROWS_VERSION,
			source: "offline",
			session: row,
			items: entries.map((entry, index) =>
				toTailItemV1(entry, { kind: "transcript", revision: index + 1, seq: index }),
			),
			terminal: true,
		},
	};
}

async function runLiveTail(
	agentDir: string,
	sessionId: string,
	row: SdkSessionRowV1,
	args: SdkSessionCliArgs,
): Promise<unknown> {
	const include = (kind: string): boolean =>
		kind === "transcript" || args.allEvents === true || DEFAULT_TAIL_KINDS.has(kind);
	// Retained transcript entries keep arrival order; event items are emitted as
	// a canonical positioned segment followed by the arrival-ordered unpositioned
	// segment.
	const transcriptItems: SdkTailItemV1[] = [];
	const eventItems: EventTailSegments = { positioned: [], unpositioned: [] };
	const tailItems = (): SdkTailItemV1[] => [...transcriptItems, ...eventItems.positioned, ...eventItems.unpositioned];
	// Independent dedupe domains. A transcript row may project the same kind,
	// generation, and seq as a real event-ring row; one shared domain would let
	// whichever arrived first suppress the other, and a transcript row is not
	// event-ring authority, so it must never erase lifecycle or conflict
	// evidence.
	const seenTranscript = new Set<string>();
	const seenEvents = new Set<string>();
	let checkpoint: SdkCheckpointRecordV1 | undefined;
	let gap: SdkRetentionGapV1 | undefined;
	let liveReason: TailExitReason | undefined;
	let resolveLive: ((reason: TailExitReason) => void) | undefined;
	let rejectLive: ((error: SdkSessionCliError) => void) | undefined;
	// Lifecycle state of the newest turn, tracked by canonical ring position
	// rather than arrival order. A terminal event idles the turn and a start
	// event reopens it, but only when that event is canonically at or after the
	// event that last decided the state. An older terminal that arrives late
	// therefore cannot complete a newer turn that is still running, and a newer
	// terminal that arrives early is not undone by replayed history behind it.
	let turnIdle = false;
	let turnStateKey: TailSeqKey | undefined;
	let closed = false;
	// Lifecycle kind already claimed at each canonical position. A same-kind
	// duplicate never reaches here (dedupe keys include kind), so any entry that
	// disagrees is a host stating two different lifecycle kinds at one position.
	const claimedLifecycleKinds = new Map<string, string>();
	let malformed: SdkSessionCliError | undefined;

	const applyLifecycle = (outcome: { merged: SdkTailItemV1[]; malformed: SdkTailItemV1 | undefined }): void => {
		if (outcome.malformed !== undefined) {
			const item = outcome.malformed;
			malformed ??= malformedPositionError(sessionId, item.kind, item.generation, item.seq);
			rejectLive?.(malformed);
			return;
		}
		for (const item of outcome.merged) {
			const isStart = START_TURN_KINDS.has(item.kind);
			const isClose = CLOSE_EVENT_KINDS.has(item.kind);
			const isLifecycle = isStart || isClose || TERMINAL_TURN_KINDS.has(item.kind);
			const position = isLifecycle ? tailSeqKey(item) : undefined;
			if (position !== undefined) {
				// Every positioned lifecycle kind tail semantics consumes claims its
				// position, close kinds included, and the claim is checked before any
				// kind-specific handling. Checking it after close handling would let a
				// close at a contested position win instead of failing closed, and
				// checking it after the monotonic guard would silently skip a
				// conflicting kind at an already-decided position.
				const positionKey = `${position.generation}\u0000${position.seq}`;
				const claimed = claimedLifecycleKinds.get(positionKey);
				if (claimed !== undefined && claimed !== item.kind) {
					malformed ??= new SdkSessionCliError(
						"protocol_error",
						"The event ring stated different lifecycle kinds at one generation and sequence.",
						1,
						{
							sessionId,
							generation: position.generation,
							seq: position.seq,
							kinds: [claimed, item.kind].sort(),
						},
					);
					rejectLive?.(malformed);
					return;
				}
				claimedLifecycleKinds.set(positionKey, item.kind);
			}
			if (isClose) closed = true;
			if (!isStart && !TERMINAL_TURN_KINDS.has(item.kind)) continue;
			// An unsequenced lifecycle event states no position, so it cannot be
			// proven at or after a positioned state and must not supersede it. It
			// stays visible in the emitted items either way.
			if (position === undefined && turnStateKey !== undefined) continue;
			if (position !== undefined && turnStateKey !== undefined && compareTailSeqKeys(position, turnStateKey) <= 0)
				continue;
			if (position !== undefined) turnStateKey = position;
			turnIdle = !isStart;
		}
		if (closed) {
			liveReason = "close";
			resolveLive?.("close");
			return;
		}
		if (args.untilIdle === true && turnIdle) resolveLive?.("idle");
	};

	const recordLiveFrame = (attachment: SessionAttachment, frame: SessionRouterFrame): void => {
		if (attachment.sessionId !== sessionId) return;
		const item = tailItemFromRouterFrame(frame);
		if (!item) return;
										if (item.revision === undefined && checkpoint?.revision !== undefined) item.revision = checkpoint.revision;
		// If checkpoint was undefined, queue for later stamping? For now leave without rev
		applyLifecycle(mergeEventTailItems(eventItems, seenEvents, [item], include));
	};

	return await withRouter(
		agentDir,
		async router => {
			const attachment = attachmentFor(router, sessionId);
			const checkpointResponse = await router.request(
				sessionId,
				{
					type: "query_request",
					query: "session.checkpoint",
					input: args.cursor === undefined ? {} : { checkpointToken: args.cursor },
				},
				attachment.generation,
				attachment,
				args.timeoutMs === undefined ? undefined : { timeoutMs: args.timeoutMs },
			);
			throwResponseFailure(checkpointResponse);
			const extraction = extractCheckpoint(checkpointResponse);
			checkpoint = extraction.record;
			gap = extraction.gap;
			if (gap !== undefined && args.strict === true)
				throw new SdkSessionCliError(
					"retention_gap",
					"Retained history is missing entries before the checkpoint (strict mode).",
					1,
					gap,
				);

			let cursor = extraction.cursor;
			while (cursor !== undefined) {
				const response = await router.request(
					sessionId,
					{ type: "query_request", query: "transcript.list", input: {}, cursor },
					attachment.generation,
					attachment,
					args.timeoutMs === undefined ? undefined : { timeoutMs: args.timeoutMs },
				);
				throwResponseFailure(response);
				const page = extractTranscriptPage(response);
				const rev = checkpoint?.revision;
				let nextSeq = transcriptItems.length;
				mergeTailItems(
					transcriptItems,
					seenTranscript,
					page.items.map(item => {
						const it = toTailItemV1(item, { kind: "transcript" });
						if (it.revision === undefined && rev !== undefined) it.revision = rev;
						if (it.generation === undefined) it.generation = checkpoint?.generation ?? 0;
						if (it.seq === undefined) it.seq = nextSeq++;
						return it;
					}),
					include,
				);
				if (page.complete || page.cursor === undefined) break;
				cursor = page.cursor;
			}

			const replayResponse = await router.request(
				sessionId,
				{
					type: "event_replay",
					...(checkpoint === undefined
						? {}
						: { sinceGeneration: checkpoint.generation, sinceSeq: checkpoint.seq }),
				},
				attachment.generation,
				attachment,
				args.timeoutMs === undefined ? undefined : { timeoutMs: args.timeoutMs },
			);
			throwResponseFailure(replayResponse);
			const replay = object(replayResponse) ?? {};
			const replayGap = eventGapToRetentionGap(replay.gap, replay, checkpoint);
			if (replayGap !== undefined) {
				gap = replayGap;
				if (args.strict === true)
					throw new SdkSessionCliError(
						"retention_gap",
						"The event ring dropped entries before the checkpoint (strict mode).",
						1,
						replayGap,
					);
			}
			// Raw rows are validated before projection: `toTailItemV1` drops a
			// non-numeric coordinate, so a null claim would otherwise reach the
			// projected check as a genuinely unpositioned event.
			const rawEvents = arrayOf(replay.events);
			const malformedRaw = rawEvents.find(event => classifyRawEventPosition(event) === "malformed");
			if (malformedRaw !== undefined) {
				const raw = isRecord(malformedRaw) ? malformedRaw : {};
				throw malformedPositionError(
					sessionId,
					typeof raw.kind === "string" ? raw.kind : "event",
					raw.generation,
					raw.seq,
				);
			}
			const replayItems = rawEvents.map(event => {
				const it = toTailItemV1(event, { kind: "event" });
				if (it.revision === undefined && checkpoint?.revision !== undefined) it.revision = checkpoint.revision;
				return it;
			});
			applyLifecycle(mergeEventTailItems(eventItems, seenEvents, replayItems, include));
			if (malformed !== undefined) throw malformed;
			if (checkpoint !== undefined) {
				const checkpointKey = { generation: checkpoint.generation, seq: checkpoint.seq };
				if (turnStateKey === undefined || compareTailSeqKeys(checkpointKey, turnStateKey) >= 0) {
					turnStateKey = checkpointKey;
					turnIdle = checkpoint.idle;
				}
			}
			if (liveReason === undefined && args.untilIdle === true && turnIdle) liveReason = "idle";
			if (liveReason === undefined) {
				const completion = Promise.withResolvers<TailExitReason>();
				resolveLive = completion.resolve;
				rejectLive = completion.reject;
				const timeoutMs = args.timeoutMs ?? 10_000;
				const timer = setTimeout(
					() =>
						completion.reject(
							new SdkSessionCliError(
								"tail_timeout",
								"Tail did not reach an exit condition within the wait window.",
								1,
								{ sessionId, timeoutMs },
							),
						),
					timeoutMs,
				);
				try {
					liveReason = await completion.promise;
				} finally {
					clearTimeout(timer);
					resolveLive = undefined;
					rejectLive = undefined;
				}
			}
			return {
				ok: true,
				result: {
					version: SESSION_ROWS_VERSION,
					source: "session",
					session: row,
					...(checkpoint === undefined ? {} : { checkpoint }),
					...(gap === undefined ? {} : { gap }),
					items: tailItems(),
					terminal: liveReason === "idle" || liveReason === "close",
				},
			};
		},
		recordLiveFrame,
	);
}

export async function runTail(
	repo: string,
	agentDir: string,
	sessionId: string,
	args: SdkSessionCliArgs,
): Promise<unknown> {
	const row = (await sessionRows(agentDir)).sessions.find(candidate => candidate.sessionId === sessionId);
	if (!row)
		throw new SdkSessionCliError("session_unavailable", `Session ${sessionId} is not indexed by the broker.`, 1);
	if (row.deleted)
		throw new SdkSessionCliError("session_deleted", `Session ${sessionId} was deleted and has no tail.`, 1);
	if (!row.live || row.terminalUncertain === true) return await offlineTailReplay(repo, agentDir, sessionId, row);
	return await runLiveTail(agentDir, sessionId, row, args);
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
	await ensureBroker({ agentDir });
	const operatorRequest = operatorAbortBrokerRequest(sessionId, operation, input, args);
	if (operatorRequest) return await requestBrokerOperatorAbort(agentDir, operatorRequest, args);
	return await withRouter(agentDir, async router => await requestControl(router, sessionId, operation, input, args));
}

async function runRawQuery(
	agentDir: string,
	sessionId: string,
	operation: string,
	input: JsonRecord,
	args: SdkSessionCliArgs,
): Promise<unknown> {
	await ensureBroker({ agentDir });
	return await withRouter(agentDir, async router => await requestQuery(router, sessionId, operation, input, args));
}

function lifecycleMutationRequest(
	operation: LifecycleMutationOperation,
	input: JsonRecord,
	requestKey: string,
	timeoutMs: number | undefined,
): SessionLifecycleMutationRequest {
	const base = {
		actor: SDK_SESSION_CLI_LIFECYCLE_ACTOR,
		requestKey,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	};
	if (operation === "session.create" || operation === "session.fork") {
		if (typeof input.cwd !== "string" || input.cwd.length === 0)
			throw new SdkSessionCliError("invalid_input", `${operation} requires a string cwd in the input payload.`, 2);
		const target = input as JsonRecord & { cwd: string };
		return operation === "session.create"
			? { ...base, operation, capability: operation, target }
			: { ...base, operation, capability: operation, target };
	}
	if (typeof input.sessionId !== "string" || input.sessionId.length === 0)
		throw new SdkSessionCliError(
			"invalid_input",
			`${operation} requires a string sessionId in the input payload.`,
			2,
		);
	const target = input as JsonRecord & { sessionId: string };
	if (operation === "session.resume") return { ...base, operation, capability: operation, target };
	if (operation === "session.close") return { ...base, operation, capability: operation, target };
	if (operation === "session.reconcile_uncertain")
		return {
			...base,
			operation,
			capability: operation,
			target: input as unknown as SessionReconcileUncertainTarget,
		};
	return { ...base, operation, capability: "session.delete", target };
}

async function runRawGlobal(
	agentDir: string,
	operation: string,
	input: JsonRecord,
	args: SdkSessionCliArgs,
): Promise<unknown> {
	if (operation === "session.list") {
		await ensureBroker({ agentDir });
		return await withRouter(agentDir, async router => await paginatedSessionList(router, input));
	}
	if (!isLifecycleOperation(operation))
		throw new SdkSessionCliError("unknown_operation", `Unknown global operation: ${operation}`, 1);
	if (!args.idempotencyKey)
		throw new SdkSessionCliError("invalid_input", "--idempotency-key is required for lifecycle operations.", 2);
	const lifecycle = createBrokerSessionLifecycleService(agentDir);
	const timeoutMs = lifecycleRequestTimeoutMs(operation, input);
	const response = await lifecycle.execute(lifecycleMutationRequest(operation, input, args.idempotencyKey, timeoutMs));
	throwResponseFailure(response);
	return response;
}

function rawKind(action: string, args: SdkSessionCliArgs): SdkSessionCliRawKind | undefined {
	if (action === "raw")
		return args.rawAction === "control" || args.rawAction === "query" || args.rawAction === "global"
			? args.rawAction
			: undefined;
	return action === "control" || action === "query" || action === "global" ? action : undefined;
}

/** Runs the broker-bound `gjc sdk session` command family without exposing endpoint credentials. */
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
			action !== "search" &&
			action !== "inspect" &&
			action !== "send" &&
			action !== "status" &&
			action !== "tail" &&
			action !== "retire" &&
			action !== "raw" &&
			action !== "control" &&
			action !== "query" &&
			action !== "global"
		)
			throw new SdkSessionCliError(
				"usage",
				"Expected one of: list, inspect, send, status, tail, retire, raw (control|query|global).",
				2,
			);
		const agentDir = args.agentDir ?? getAgentDir();
		if (action === "list") {
			writeOutput(stripSecretFields(await runList(agentDir, args)));
			return;
		}
		if (action === "search") {
			const search = await runSdkSearch(args);
			writeOutput(args.json === true ? search.result : renderSdkSearchTable(search.result));
			if (search.exitCode !== 0) setExitCode(search.exitCode);
			return;
		}
		if (action === "inspect") {
			writeOutput(stripSecretFields(await runInspect(agentDir, requireValue(args.sessionId, "<sessionId>"))));
			return;
		}
		if (action === "send") {
			writeOutput(stripSecretFields(await runSend(agentDir, requireValue(args.sessionId, "<sessionId>"), args)));
			return;
		}
		if (action === "status") {
			writeOutput(
				stripSecretFields(
					await runStatus(
						agentDir,
						requireValue(args.sessionId, "<sessionId>"),
						requireValue(args.opRef, "<opRef>"),
						args,
					),
				),
			);
			return;
		}
		if (action === "tail") {
			writeOutput(
				stripSecretFields(
					await runTail(args.repo ?? process.cwd(), agentDir, requireValue(args.sessionId, "<sessionId>"), args),
				),
			);
			return;
		}
		if (action === "retire") {
			const sessionId = requireValue(args.sessionId, "<sessionId>");
			const input = await inputFromArgs(args);
			if (input.sessionId !== undefined && input.sessionId !== sessionId)
				throw new SdkSessionCliError(
					"invalid_input",
					"Retirement sessionId does not match the selected session.",
					2,
				);
			const secretError = validateAdapterSecretFields("session.reconcile_uncertain", input);
			if (secretError) throw new SdkSessionCliError(secretError.code, secretError.message, 2);
			writeOutput(
				stripSecretFields(
					await runRawGlobal(agentDir, "session.reconcile_uncertain", { ...input, sessionId }, args),
				),
			);
			return;
		}

		const kind = rawKind(requireValue(action, "<verb>"), args);
		if (!kind) throw new SdkSessionCliError("usage", "raw requires one of: control, query, global.", 2);
		const operation = kind === "query" ? requireValue(args.query, "--query") : requireValue(args.operation, "--op");
		if (isRawSpawnOperation(kind, operation))
			throw new SdkSessionCliError(
				"adapter_operation_prohibited",
				"session.spawn is unavailable through the SDK session CLI.",
				1,
			);
		const dispositionError = cliOperationError(kind, operation);
		if (dispositionError) throw new SdkSessionCliError(dispositionError.code, dispositionError.message, 1);
		if (isEndpointOperation(operation))
			throw new SdkSessionCliError(
				"endpoint_credential_forbidden",
				"session.get_endpoint is not available through the SDK session CLI.",
				1,
			);
		const input = await inputFromArgs(args);
		const secretError = validateAdapterSecretFields(operation, input);
		if (secretError) throw new SdkSessionCliError(secretError.code, secretError.message, 2);
		if (kind === "global") {
			writeOutput(stripSecretFields(await runRawGlobal(agentDir, operation, input, args)));
			return;
		}
		const sessionId = requireValue(args.sessionId, "<sessionId>");
		writeOutput(
			stripSecretFields(
				kind === "control"
					? await runRawControl(agentDir, sessionId, operation, input, args)
					: await runRawQuery(agentDir, sessionId, operation, input, args),
			),
		);
	} catch (error) {
		const cliError =
			error instanceof SdkSessionCliError
				? error
				: error instanceof SessionRouterError
					? new SdkSessionCliError(error.phase, error.message, 1)
					: error instanceof SdkClientError
						? new SdkSessionCliError(error.code, error.message, 1, error.details)
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
				...(cliError.details === undefined ? {} : { details: stripSecretFields(cliError.details) }),
			},
		});
		setExitCode(cliError.exitCode);
	}
}
