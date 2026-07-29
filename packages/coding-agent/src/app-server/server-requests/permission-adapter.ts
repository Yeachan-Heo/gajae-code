// Adapter between a child SDK permission reverse request and Codex approval requests.
// The mapping is deliberately closed: a tool or ReviewDecision that has no honest Codex
// equivalent fails with a typed error instead of being silently coerced into approval.

import { logger as defaultLogger } from "@gajae-code/utils";
import type { ApplyPatchApprovalParams } from "../../../vendor/codex-app-server-schema/stable/typescript/ApplyPatchApprovalParams";
import type { ExecCommandApprovalParams } from "../../../vendor/codex-app-server-schema/stable/typescript/ExecCommandApprovalParams";
import type { ParsedCommand } from "../../../vendor/codex-app-server-schema/stable/typescript/ParsedCommand";
import type { ReviewDecision } from "../../../vendor/codex-app-server-schema/stable/typescript/ReviewDecision";
import { mapToolKind } from "../../modes/acp/acp-event-mapper";
import type {
	ClientBridgePermissionOption,
	ClientBridgePermissionOptionKind,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "../../session/client-bridge";
import { experimentalValidators, stableValidators } from "../protocol-source/schema-validators.generated";
import type { ReverseLeaseProvider } from "../reverse-lease-controller";

export type CodexApprovalMethod = "execCommandApproval" | "applyPatchApproval";
export type CodexApprovalParams = ExecCommandApprovalParams | ApplyPatchApprovalParams;

export type ChildPermissionRequest = {
	readonly toolCall: ClientBridgePermissionToolCall;
	readonly options: readonly ClientBridgePermissionOption[];
};

export type PermissionAdapterLog = {
	warn(message: string, context?: Record<string, unknown>): void;
};

export type CodexApprovalRequester = (
	method: CodexApprovalMethod,
	params: CodexApprovalParams,
	signal?: AbortSignal,
) => Promise<unknown>;

export interface PermissionAdapterOptions {
	/** Conversation/thread id sent to the Codex approval method. */
	readonly conversationId?: string;
	/** Working directory used by execCommandApproval when the child omits one. */
	readonly cwd?: string;
	readonly grantRoot?: string;
	readonly reason?: string;
	readonly approvalId?: string;
	/** Canonical request seam. */
	readonly requestApproval?: CodexApprovalRequester;
	readonly logger?: PermissionAdapterLog;
}

export type PermissionAdapterErrorCode =
	| "invalid_child_request"
	| "invalid_child_options"
	| "unmappable_tool_call"
	| "missing_approval_field"
	| "unmappable_review_decision"
	| "invalid_codex_response";

export class PermissionAdapterError extends Error {
	readonly code: PermissionAdapterErrorCode;
	readonly reason: string;

	constructor(code: PermissionAdapterErrorCode, reason: string) {
		super(reason);
		this.name = "PermissionAdapterError";
		this.code = code;
		this.reason = reason;
	}
}

// Tool classification reuses the single existing authority, `mapToolKind`, rather than a second
// hand-maintained name list that would silently drift from it. Only the ACP kinds that a Codex
// approval method can honestly represent are mapped; everything else fails closed.
const COMMAND_TOOL_KINDS: ReadonlySet<string> = new Set(["execute"]);
const PATCH_TOOL_KINDS: ReadonlySet<string> = new Set(["edit", "delete", "move"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
	const candidate = value[field];
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function optionKind(value: string): ClientBridgePermissionOptionKind | undefined {
	switch (value) {
		case "allow_once":
		case "allow_always":
		case "reject_once":
		case "reject_always":
			return value;
		default:
			return undefined;
	}
}

function readToolCall(value: unknown): ClientBridgePermissionToolCall {
	if (!isRecord(value))
		throw new PermissionAdapterError("invalid_child_request", "Permission request must be an object.");
	const toolCallId = stringField(value, "toolCallId");
	const toolName = stringField(value, "toolName");
	const title = stringField(value, "title");
	if (!toolCallId || !toolName || !title)
		throw new PermissionAdapterError(
			"invalid_child_request",
			"Permission toolCall requires non-empty toolCallId, toolName, and title.",
		);
	return value as unknown as ClientBridgePermissionToolCall;
}

function readOptions(value: unknown): readonly ClientBridgePermissionOption[] {
	if (!Array.isArray(value))
		throw new PermissionAdapterError("invalid_child_options", "Permission request options must be an array.");
	const options: ClientBridgePermissionOption[] = [];
	for (const candidate of value) {
		if (!isRecord(candidate))
			throw new PermissionAdapterError("invalid_child_options", "Permission option must be an object.");
		const optionId = stringField(candidate, "optionId");
		const name = stringField(candidate, "name");
		const kind = stringField(candidate, "kind");
		const normalizedKind = kind === undefined ? undefined : optionKind(kind);
		if (!optionId || !name || !normalizedKind)
			throw new PermissionAdapterError(
				"invalid_child_options",
				"Permission option has an invalid id, name, or kind.",
			);
		if (normalizedKind !== optionId)
			throw new PermissionAdapterError(
				"invalid_child_options",
				`Permission option ${optionId} does not honestly advertise kind ${normalizedKind}.`,
			);
		options.push({ optionId, name, kind: normalizedKind });
	}
	return options;
}

function rawInput(toolCall: ClientBridgePermissionToolCall): Record<string, unknown> | undefined {
	return isRecord(toolCall.rawInput) ? toolCall.rawInput : undefined;
}

function toolKind(toolCall: ClientBridgePermissionToolCall): "command" | "patch" | undefined {
	// A supplied `kind` is the declared ACP discriminator and wins; otherwise derive it from the
	// tool name through the same authority the ACP surface uses, so the two can never disagree.
	const kind = toolCall.kind ?? mapToolKind(toolCall.toolName);
	if (COMMAND_TOOL_KINDS.has(kind)) return "command";
	if (PATCH_TOOL_KINDS.has(kind)) return "patch";
	return undefined;
}

function requiredConversationId(options: PermissionAdapterOptions, input: Record<string, unknown> | undefined): string {
	const conversationId = options.conversationId ?? (input ? stringField(input, "conversationId") : undefined);
	if (!conversationId)
		throw new PermissionAdapterError(
			"missing_approval_field",
			"Permission adapter requires conversationId for the Codex approval request.",
		);
	return conversationId;
}

function optionFor(
	options: readonly ClientBridgePermissionOption[],
	kind: ClientBridgePermissionOptionKind,
): ClientBridgePermissionOutcome {
	const option = options.find(candidate => candidate.kind === kind && candidate.optionId === kind);
	if (!option)
		throw new PermissionAdapterError(
			"unmappable_review_decision",
			`Child permission options do not expose the required ${kind} choice.`,
		);
	return { outcome: "selected", optionId: option.optionId, kind: option.kind };
}

function commandParts(value: unknown): string[] {
	if (typeof value === "string" && value.length > 0) return [value];
	if (Array.isArray(value) && value.length > 0 && value.every(part => typeof part === "string" && part.length > 0))
		return [...value] as string[];
	throw new PermissionAdapterError(
		"missing_approval_field",
		"Command permission requires a non-empty command string or argv array.",
	);
}

function parsedCommands(value: unknown, command: readonly string[]): ParsedCommand[] {
	if (value === undefined) return [{ type: "unknown", cmd: command.join(" ") }];
	if (!Array.isArray(value))
		throw new PermissionAdapterError("missing_approval_field", "Command permission requires parsedCmd entries.");
	const parsed: ParsedCommand[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.cmd !== "string" || typeof entry.type !== "string")
			throw new PermissionAdapterError("missing_approval_field", "parsedCmd contains an invalid command entry.");
		parsed.push(entry as unknown as ParsedCommand);
	}
	return parsed;
}

/**
 * Every mapped param object crosses the wire, so it must satisfy the generated server-request
 * validator here. Without this a malformed projection reaches the child transport and is only
 * rejected downstream, where the failure is far harder to attribute.
 */
function assertApprovalParams<P extends CodexApprovalParams>(method: CodexApprovalMethod, params: P): P {
	const validate = stableValidators.serverRequestParams[method] ?? experimentalValidators.serverRequestParams[method];
	if (validate && !validate(params))
		throw new PermissionAdapterError(
			"missing_approval_field",
			`Mapped ${method} params do not satisfy the pinned protocol shape.`,
		);
	return params;
}

/** A pinned `FileChange` member: add/delete carry content, update carries a unified diff. */
function isFileChange(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.type === "add" || value.type === "delete") return typeof value.content === "string";
	if (value.type === "update") return typeof value.unified_diff === "string";
	return false;
}

/**
 * Normalize the REAL child tool arguments into pinned `FileChange` members.
 *
 * `AgentSession` forwards raw tool args (`rawInput: args`), so a `write` is `{path, content}`,
 * a `delete` is `{path}`, and a `move` is `{oldPath, newPath}` — none of which are Codex
 * `FileChange` maps. Casting them through produced params the generated validator rejects.
 * Anything that cannot be represented honestly fails closed instead of being coerced.
 */
function fileChangesFor(
	toolName: string,
	input: Record<string, unknown> | undefined,
): ApplyPatchApprovalParams["fileChanges"] {
	// A child that already speaks the Codex shape is passed through, but only after validation.
	const supplied = input?.fileChanges ?? input?.changes;
	if (isRecord(supplied)) {
		for (const [path, change] of Object.entries(supplied)) {
			if (!isFileChange(change))
				throw new PermissionAdapterError(
					"missing_approval_field",
					`Patch permission fileChanges entry ${path} is not a pinned FileChange.`,
				);
		}
		if (Object.keys(supplied).length === 0)
			throw new PermissionAdapterError("missing_approval_field", "Patch permission fileChanges map is empty.");
		return supplied as ApplyPatchApprovalParams["fileChanges"];
	}
	const path = input ? stringField(input, "path") : undefined;
	if (toolName === "write" && path !== undefined && typeof input?.content === "string") {
		// WriteTool creates OR overwrites. `add` would assert the file does not exist, so only claim
		// that when the caller states it; otherwise describe the full replacement as an update whose
		// diff is the new content. Never assert a fact about the filesystem we have not established.
		const overwrites = input.overwrites === true || input.exists === true;
		return {
			[path]: overwrites
				? { type: "update", unified_diff: input.content, move_path: null }
				: { type: "add", content: input.content },
		} as ApplyPatchApprovalParams["fileChanges"];
	}
	if (toolName === "delete" && path !== undefined) {
		// A delete event carries only a path. `content` is required by the pinned union, and we do not
		// know the file's contents here, so pass through a caller-supplied body and otherwise state
		// the empty string rather than inventing one.
		const content = typeof input?.content === "string" ? input.content : "";
		return { [path]: { type: "delete", content } } as ApplyPatchApprovalParams["fileChanges"];
	}
	const oldPath = input ? stringField(input, "oldPath") : undefined;
	const newPath = input ? stringField(input, "newPath") : undefined;
	if (toolName === "move" && oldPath !== undefined && newPath !== undefined)
		return {
			[oldPath]: { type: "update", unified_diff: "", move_path: newPath },
		} as ApplyPatchApprovalParams["fileChanges"];
	// `edit`/`apply_patch` arguments are mode-dependent and carry no unified diff at this seam, so
	// a faithful FileChange cannot be derived. Refuse rather than invent one.
	throw new PermissionAdapterError(
		"missing_approval_field",
		`Patch permission for ${toolName} did not supply a representable file change.`,
	);
}

/**
 * `eval` is permission-gated and classified as an execution tool, but its input is `cells`
 * (`{language, code, ...}[]`), never `command`. Project each cell into an argv-shaped entry so the
 * approval states honestly what will run; refuse when no usable cell body is present.
 */
function evalCommandParts(input: Record<string, unknown> | undefined): string[] {
	const cells = input?.cells;
	if (!Array.isArray(cells) || cells.length === 0)
		throw new PermissionAdapterError("missing_approval_field", "Eval permission supplied no cells to approve.");
	const parts: string[] = ["eval"];
	for (const cell of cells) {
		if (!isRecord(cell) || typeof cell.code !== "string" || cell.code.length === 0)
			throw new PermissionAdapterError("missing_approval_field", "Eval permission cell omitted its code body.");
		const language = typeof cell.language === "string" ? cell.language : "unknown";
		parts.push(`${language}:${cell.code}`);
	}
	return parts;
}

/** Map a child tool call to the only Codex approval method that can represent it. */
export function mapToolCallToCodexRequest(
	toolCall: ClientBridgePermissionToolCall,
	options: PermissionAdapterOptions = {},
): { readonly method: CodexApprovalMethod; readonly params: CodexApprovalParams } {
	const input = rawInput(toolCall);
	const kind = toolKind(toolCall);
	if (!kind)
		throw new PermissionAdapterError(
			"unmappable_tool_call",
			`No Codex approval method can honestly represent child tool ${toolCall.toolName}.`,
		);
	const conversationId = requiredConversationId(options, input);
	const callId = toolCall.toolCallId;
	const reason = options.reason ?? (input ? stringField(input, "reason") : undefined);
	if (kind === "command") {
		const command =
			toolCall.toolName === "eval" ? evalCommandParts(input) : commandParts(input?.command ?? input?.cmd);
		const cwd = options.cwd ?? (input ? stringField(input, "cwd") : undefined);
		if (!cwd)
			throw new PermissionAdapterError(
				"missing_approval_field",
				"Command permission requires rawInput.cwd or an adapter cwd.",
			);
		const parsedCmd = parsedCommands(input?.parsedCmd ?? input?.parsedCommand, command);
		const approvalId = options.approvalId ?? (input ? stringField(input, "approvalId") : undefined);
		const params: ExecCommandApprovalParams = {
			conversationId,
			callId,
			approvalId: approvalId ?? null,
			command,
			cwd,
			reason: reason ?? null,
			parsedCmd,
		};
		return { method: "execCommandApproval", params: assertApprovalParams("execCommandApproval", params) };
	}
	const patchChanges = fileChangesFor(toolCall.toolName, input);
	const grantRoot = options.grantRoot ?? (input ? stringField(input, "grantRoot") : undefined);
	const params: ApplyPatchApprovalParams = {
		conversationId,
		callId,
		fileChanges: patchChanges,
		reason: reason ?? null,
		grantRoot: grantRoot ?? null,
	};
	return { method: "applyPatchApproval", params: assertApprovalParams("applyPatchApproval", params) };
}

/** Map every supported Codex ReviewDecision to an offered child option. */
export function mapReviewDecisionToChildOutcome(
	decision: ReviewDecision,
	options: readonly ClientBridgePermissionOption[],
): ClientBridgePermissionOutcome {
	if (decision === "approved") return optionFor(options, "allow_once");
	if (decision === "approved_for_session") return optionFor(options, "allow_always");
	if (decision === "timed_out" || decision === "abort") return { outcome: "cancelled" };
	if (isRecord(decision)) {
		// Check the amendment discriminators first: a denied-plus-amendment object is ambiguous and
		// must not be silently reduced to a plain rejection.
		if (Object.hasOwn(decision, "approved_execpolicy_amendment"))
			throw new PermissionAdapterError(
				"unmappable_review_decision",
				"Codex execpolicy amendments cannot be represented by a child permission choice.",
			);
		if (Object.hasOwn(decision, "network_policy_amendment"))
			throw new PermissionAdapterError(
				"unmappable_review_decision",
				"Codex network-policy amendments cannot be represented by a child permission choice.",
			);
		if (Object.hasOwn(decision, "denied")) {
			if (Object.keys(decision).length !== 1)
				throw new PermissionAdapterError(
					"unmappable_review_decision",
					"Codex denied decision carried extra discriminators and is ambiguous.",
				);
			const denied = (decision as Record<string, unknown>).denied;
			if (!isRecord(denied) || typeof denied.rejection !== "string" || denied.rejection.trim().length === 0)
				throw new PermissionAdapterError(
					"unmappable_review_decision",
					"Codex denied decision omitted its rejection reason.",
				);
			// The child wire shape has no rejection field; reject_once is the only
			// honest non-persistent equivalent, so the reason cannot be serialized there.
			return optionFor(options, "reject_once");
		}
	}
	throw new PermissionAdapterError("unmappable_review_decision", "Codex returned an unknown ReviewDecision variant.");
}

/** Map and validate the child payload before making a Codex approval request. */
export function mapPermissionRequest(
	payload: unknown,
	options: PermissionAdapterOptions = {},
): {
	readonly request: ChildPermissionRequest;
	readonly method: CodexApprovalMethod;
	readonly params: CodexApprovalParams;
} {
	if (!isRecord(payload))
		throw new PermissionAdapterError("invalid_child_request", "Permission reverse payload must be an object.");
	const toolCall = readToolCall(payload.toolCall);
	const requestOptions = readOptions(payload.options);
	const mapped = mapToolCallToCodexRequest(toolCall, options);
	return { request: { toolCall, options: requestOptions }, ...mapped };
}

function readDecision(result: unknown): ReviewDecision {
	if (!isRecord(result) || !Object.hasOwn(result, "decision"))
		throw new PermissionAdapterError("invalid_codex_response", "Codex approval response must contain a decision.");
	return result.decision as ReviewDecision;
}

type ApprovalAttempt =
	| { readonly kind: "response"; readonly value: unknown }
	| { readonly kind: "error"; readonly error: unknown }
	| { readonly kind: "aborted" };

function awaitApproval(
	requester: CodexApprovalRequester,
	method: CodexApprovalMethod,
	params: CodexApprovalParams,
	signal: AbortSignal | undefined,
): Promise<ApprovalAttempt> {
	if (!signal) {
		return Promise.resolve()
			.then(() => requester(method, params))
			.then(
				value => ({ kind: "response", value }) as const,
				error => ({ kind: "error", error }) as const,
			);
	}
	return new Promise<ApprovalAttempt>(resolve => {
		let done = false;
		const finish = (attempt: ApprovalAttempt): void => {
			if (done) return;
			done = true;
			signal.removeEventListener("abort", onAbort);
			resolve(attempt);
		};
		const onAbort = (): void => finish({ kind: "aborted" });
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		void Promise.resolve()
			.then(() => requester(method, params, signal))
			.then(
				value => finish({ kind: "response", value }),
				error => finish({ kind: "error", error }),
			);
	});
}

/**
 * Handles one child reverse request. Provider failures become cancellation so a child
 * approval waiter always settles even when the Codex provider disappears mid-approval.
 */
export class PermissionAdapter {
	readonly #options: PermissionAdapterOptions;
	readonly #requestApproval: CodexApprovalRequester | undefined;
	readonly #logger: PermissionAdapterLog;

	constructor(options: PermissionAdapterOptions) {
		this.#options = options;
		this.#requestApproval = options.requestApproval;
		this.#logger = options.logger ?? defaultLogger;
	}

	async handle(payload: unknown, signal?: AbortSignal): Promise<ClientBridgePermissionOutcome> {
		if (signal?.aborted) return { outcome: "cancelled" };
		const mapped = mapPermissionRequest(payload, this.#options);
		if (!this.#requestApproval) {
			this.#logger.warn("Permission provider is unavailable before approval", { method: mapped.method });
			return { outcome: "cancelled" };
		}
		const attempt = await awaitApproval(this.#requestApproval, mapped.method, mapped.params, signal);
		if (attempt.kind === "aborted") return { outcome: "cancelled" };
		if (attempt.kind === "error") {
			this.#logger.warn("Permission provider was lost during approval", {
				method: mapped.method,
				error: attempt.error instanceof Error ? attempt.error.message : String(attempt.error),
			});
			return { outcome: "cancelled" };
		}
		return mapReviewDecisionToChildOutcome(readDecision(attempt.value), mapped.request.options);
	}

	/** ReverseLeaseProvider-compatible entrypoint. */
	async handleReverse(
		method: string,
		payload: unknown,
		_frame?: Readonly<Record<string, unknown>>,
	): Promise<ClientBridgePermissionOutcome> {
		if (method !== "request")
			throw new PermissionAdapterError(
				"invalid_child_request",
				`Permission provider does not expose reverse method ${method}.`,
			);
		return this.handle(payload);
	}

	/** Build the provider registration consumed by ReverseLeaseController. */
	provider(): ReverseLeaseProvider {
		return {
			capability: "permission",
			definitions: [{ name: "request" }],
			handle: (method, payload, frame) => this.handleReverse(method, payload, frame),
		};
	}
}

export function createPermissionAdapter(options: PermissionAdapterOptions): PermissionAdapter {
	return new PermissionAdapter(options);
}

export function createPermissionProvider(options: PermissionAdapterOptions): ReverseLeaseProvider {
	return new PermissionAdapter(options).provider();
}
