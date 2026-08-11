import { createHash } from "node:crypto";
import {
	DEFAULT_MODEL_SELECTION_RECOVERY_MESSAGE,
	parseDefaultModelSelectionRecovery,
} from "../../../session/default-model-selection";
import { isElevationAllowlisted } from "../../elevation/allowlist";
import { OPERATIONS, type Operation } from "../../protocol/operation-registry";
import type { ControlInput, ControlSurface, ControlValue } from "./operations";
import { brokerRuntimeCloseCapability, hasBrokerRuntimeCloseCapability } from "./runtime-gate";

export interface ControlRequest {
	id: string;
	operation: string;
	input: unknown;
	expectedRevision?: string;
	idempotencyKey?: string;
	confirm?: boolean;
	/** Top-level elevation claim selector, preserved from the control frame. */
	elevationRequestId?: string;
}

export type ControlErrorCode = string;

export interface ControlError {
	code: ControlErrorCode;
	message: string;
	currentRevision?: string;
	details?: ControlValue;
}

export interface ControlResponse {
	id: string;
	ok: boolean;
	result?: ControlValue;
	error?: ControlError;
}

/** An error whose code is intentionally safe to expose on the control protocol. */
export class TypedControlError extends Error {
	constructor(
		readonly code: ControlErrorCode,
		message: string,
	) {
		super(message);
		this.name = "TypedControlError";
	}
}

/** Busy is reserved for explicitly typed transient unavailability. */
export class BusyError extends TypedControlError {
	constructor(message = "Control operation is temporarily unavailable.") {
		super("busy", message);
		this.name = "BusyError";
	}
}

const SHARED_ERROR_CODES = new Set([
	"revision_conflict",
	"unknown_operation",
	"invalid_input",
	"busy",
	"resource_gone",
	"unsupported_protocol",
	"provider_lease_conflict",
	"lease_expired",
	"not_lease_owner",
	"endpoint_stale",
	"idempotency_conflict",
	"snapshot_capacity_exceeded",
	"cursor_expired",
	"event_gap",
	"unavailable",
	"operation_prohibited",
	"internal",
]);

/** Lifecycle mutations must enter through the Broker-backed lifecycle service. */
const BROKER_LIFECYCLE_CONTROL_OPERATIONS = new Set([
	"session.new",
	"session.fork",
	"session.resume",
	"session.switch",
	"session.branch",
	"session.handoff",
	"session.close",
	"session.delete",
]);
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1_000;
const MAX_IDEMPOTENCY_ENTRIES = 256;

const sessionChains = new WeakMap<ControlSurface, Promise<void>>();
interface IdempotencyEntry {
	hash: string;
	expiresAt: number;
	response: Promise<ControlResponse>;
}
const idempotentRequests = new WeakMap<ControlSurface, Map<string, IdempotencyEntry>>();

type PreflightCancellableSurface = ControlSurface & {
	cancelPendingPreflights?(): void;
};

function failure(
	id: string,
	code: ControlErrorCode,
	message: string,
	currentRevision?: string,
	details?: ControlValue,
): ControlResponse {
	return {
		id,
		ok: false,
		error: {
			code,
			message,
			...(currentRevision === undefined ? {} : { currentRevision }),
			...(details === undefined ? {} : { details }),
		},
	};
}

function isInput(value: unknown): value is ControlInput {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Build the typed control request from a wire frame. Every runtime transport
 * mapper uses this helper so the top-level elevation claim selector cannot
 * drift between callsites.
 */
export function controlRequestFromFrame(frame: Record<string, unknown>): ControlRequest {
	return {
		id: typeof frame.id === "string" ? frame.id : "",
		operation: typeof frame.operation === "string" ? frame.operation : "",
		input: frame.input,
		expectedRevision: typeof frame.expectedRevision === "string" ? frame.expectedRevision : undefined,
		idempotencyKey: typeof frame.idempotencyKey === "string" ? frame.idempotencyKey : undefined,
		confirm: frame.confirm === true,
		elevationRequestId: typeof frame.elevationRequestId === "string" ? frame.elevationRequestId : undefined,
	};
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value as Record<string, unknown>)
				.sort()
				.map(key => [key, canonicalize((value as Record<string, unknown>)[key])]),
		);
	}
	return value;
}

function inputHash(input: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(input)))
		.digest("hex");
}

function text(input: ControlInput, key = "text"): string {
	return input[key] as string;
}

function invoke(
	surface: ControlSurface,
	operation: string,
	input: ControlInput,
	confirm: boolean | undefined,
	idempotencyKey: string | undefined,
	elevationRequestId: string | undefined,
): Promise<ControlValue> | ControlValue {
	switch (operation) {
		case "turn.prompt":
			return surface.prompt(text(input), input.images, input.clientRef as string | undefined);
		case "turn.steer":
			return surface.steer(text(input), typeof input.clientRef === "string" ? input.clientRef : undefined);
		case "turn.follow_up":
			return surface.followUp(text(input));
		case "turn.abort":
			return surface.abort();
		case "turn.abort_and_prompt":
			return surface.abortAndPrompt(text(input));
		case "ask.answer":
			return surface.answerAsk(text(input, "id"), input.answer);
		case "workflow.gate_answer":
			return surface.answerGate(
				text(input, "id"),
				input.response,
				input.expectedSessionId as string | undefined,
				idempotencyKey,
				elevationRequestId,
			);
		case "workflow.plan_approve":
			return surface.approvePlan(
				text(input, "id"),
				input.choice,
				input.expectedSessionId as string | undefined,
				elevationRequestId,
			);
		case "skill.invoke":
			return surface.invokeSkill(
				text(input, "name"),
				input.args,
				typeof input.clientRef === "string" ? input.clientRef : undefined,
			);
		case "mode.plan.set":
			return surface.setPlanMode(input.on as boolean);
		case "mode.goal.operate":
			return surface.operateGoal(text(input, "op"), input.objective as string | undefined);
		case "todo.replace":
			return surface.replaceTodo(input.items);
		case "model.set":
			return surface.setModel(text(input, "id"), input.thinkingLevel);
		case "model.profile.set":
			return surface.setModelProfile(text(input, "id"));
		case "model.cycle":
			return surface.cycleModel();
		case "thinking.set":
			return surface.setThinking(input.level);
		case "thinking.cycle":
			return surface.cycleThinking();
		case "permission_mode.set":
			return surface.setPermissionMode(input.mode);
		case "queue.steering_mode.set":
			return surface.setQueueMode("steering", input.mode);
		case "queue.follow_up_mode.set":
			return surface.setQueueMode("follow_up", input.mode);
		case "queue.interrupt_mode.set":
			return surface.setQueueMode("interrupt", input.mode);
		case "compaction.run":
			return surface.runCompaction();
		case "compaction.auto.set":
			return surface.setAutoCompaction(input.on as boolean);
		case "retry.auto.set":
			return surface.setAutoRetry(input.on as boolean);
		case "retry.abort":
			return surface.abortRetry();
		case "bash.execute":
			return surface.executeBash(text(input, "cmd"));
		case "bash.abort":
			return surface.abortBash();
		case "session.close":
			return surface.closeSession(brokerRuntimeCloseCapability(input));
		case "session.rename":
			return surface.renameSession(text(input, "name"));
		case "session.export_html":
			return surface.exportHtml();
		case "config.patch":
			return surface.patchConfig(input.patch);
		case "runtime.reload":
			return surface.reloadRuntime(input.components);
		case "auth.login":
			return surface.login(text(input, "provider"));
		case "host_tools.register":
			return surface.registerHostTools(input.defs);
		case "host_uri.register":
			return surface.registerHostUri(input.defs);
		case "service_tier.set":
			return surface.setServiceTier(input.tier);
		case "tools.active.set":
			return surface.setActiveTools(input.names);
		case "queue.message.remove":
			return surface.removeQueueMessage(text(input, "id"));
		case "queue.message.move":
			return surface.moveQueueMessage(text(input, "id"), {
				before: input.before as string | undefined,
				after: input.after as string | undefined,
			});
		case "queue.message.update":
			return surface.updateQueueMessage(text(input, "id"), input.patch);
		case "extension.set_enabled":
			return surface.setExtensionEnabled(text(input, "id"), input.on as boolean);
		case "context.clear":
			return surface.clearContext(confirm === true);
		case "session.cwd.move":
			return surface.moveCwd(text(input, "path"));
		case "retry.last":
			return surface.retryLast();
		case "retry.now":
			return surface.retryNow();
		case "bash.background":
			return surface.backgroundBash();
		default:
			throw new Error("unknown operation");
	}
}

function errorResponse(id: string, row: Operation, error: unknown): ControlResponse {
	const candidate = error as { code?: unknown; message?: unknown; recovery?: unknown; handoffDocument?: unknown };
	const code = typeof candidate?.code === "string" ? candidate.code : undefined;
	const message = typeof candidate?.message === "string" ? candidate.message : "Control operation failed.";
	// A failed session.handoff is non-destructive and retains the generated
	// document; surface it on the control protocol so external SDK/ACP/daemon
	// clients can copy/retry it, mirroring the in-process seams and TUI.
	const details: ControlValue | undefined =
		row.sdkId === "session.handoff" && typeof candidate?.handoffDocument === "string"
			? ({ handoffDocument: candidate.handoffDocument } as ControlValue)
			: undefined;
	if (error instanceof BusyError) return failure(id, "busy", message, undefined, details);
	if (code === "default_model_selection_recovery" && row.errorCodes.includes(code)) {
		const recovery = parseDefaultModelSelectionRecovery(candidate.recovery) ?? {
			message: DEFAULT_MODEL_SELECTION_RECOVERY_MESSAGE,
			rollback: { disposition: "unknown" as const, failures: [] },
		};
		return failure(id, code, DEFAULT_MODEL_SELECTION_RECOVERY_MESSAGE, undefined, recovery);
	}
	if (code && (row.errorCodes.includes(code) || SHARED_ERROR_CODES.has(code)))
		return failure(id, code, message, undefined, details);
	if (code === "resource_gone" || /not found|gone/i.test(message)) return failure(id, "resource_gone", message);
	if (code === "unknown_gate") return failure(id, "resource_gone", message);
	if (code === "invalid_input" || /invalid input/i.test(message))
		return failure(id, "invalid_input", message, undefined, details);
	return failure(id, "internal", "Control operation failed.", undefined, details);
}

async function execute(surface: ControlSurface, row: Operation, request: ControlRequest): Promise<ControlResponse> {
	if (row.revisionResource && request.expectedRevision !== undefined && surface.revisionProvider) {
		const currentRevision = await surface.revisionProvider(row.revisionResource);
		if (currentRevision !== request.expectedRevision)
			return failure(request.id, "revision_conflict", "The resource revision has changed.", currentRevision);
	}
	try {
		return {
			id: request.id,
			ok: true,
			result: await invoke(
				surface,
				row.sdkId,
				request.input as ControlInput,
				request.confirm,
				request.idempotencyKey,
				request.elevationRequestId,
			),
		};
	} catch (error) {
		return errorResponse(request.id, row, error);
	}
}

function serialize(surface: ControlSurface, work: () => Promise<ControlResponse>): Promise<ControlResponse> {
	const previous = sessionChains.get(surface) ?? Promise.resolve();
	const result = previous.then(work, work);
	sessionChains.set(
		surface,
		result.then(
			() => undefined,
			() => undefined,
		),
	);
	return result;
}

function idempotent(
	surface: ControlSurface,
	row: Operation,
	request: ControlRequest,
	work: () => Promise<ControlResponse>,
): Promise<ControlResponse> {
	let requests = idempotentRequests.get(surface);
	if (!requests) {
		requests = new Map();
		idempotentRequests.set(surface, requests);
	}
	const now = Date.now();
	for (const [key, entry] of requests) if (entry.expiresAt <= now) requests.delete(key);
	const key = `${row.sdkId}\u0000${request.idempotencyKey}`;
	const hash = inputHash(request.input);
	const existing = requests.get(key);
	if (existing) {
		requests.delete(key);
		requests.set(key, existing);
		if (existing.hash !== hash)
			return Promise.resolve(
				failure(request.id, "idempotency_conflict", "Idempotency key was reused with different input."),
			);
		return existing.response.then(response => ({ ...response, id: request.id }));
	}
	const response = work();
	requests.set(key, { hash, expiresAt: now + IDEMPOTENCY_TTL_MS, response });
	while (requests.size > MAX_IDEMPOTENCY_ENTRIES) requests.delete(requests.keys().next().value!);
	return response;
}

/** Dispatches a registry-defined per-session control operation. */
export function dispatchControl(
	surface: ControlSurface,
	registryRow: Operation | undefined,
	request: ControlRequest,
): Promise<ControlResponse> {
	const row =
		registryRow?.kind === "control" && registryRow.sdkId === request.operation
			? OPERATIONS.find(
					operation =>
						operation.kind === "control" &&
						operation.id === registryRow.id &&
						operation.sdkId === request.operation,
				)
			: undefined;
	if (!row)
		return Promise.resolve(
			failure(request.id, "unknown_operation", `Unknown control operation: ${request.operation}.`),
		);
	const brokerCloseAuthorized = row.sdkId === "session.close" && hasBrokerRuntimeCloseCapability(request.input);
	if (BROKER_LIFECYCLE_CONTROL_OPERATIONS.has(row.sdkId) && !brokerCloseAuthorized)
		return Promise.resolve(
			failure(
				request.id,
				"operation_prohibited",
				`${request.operation} is available only through the Broker lifecycle service.`,
			),
		);
	if (
		!brokerCloseAuthorized &&
		surface.installedOperations instanceof Set &&
		!surface.installedOperations.has(row.sdkId)
	)
		return Promise.resolve(
			failure(request.id, "operation_not_session_owned", `${request.operation} is not installed for this session.`),
		);
	if (!isInput(request.input))
		return Promise.resolve(failure(request.id, "invalid_input", "Control input must be an object."));
	const elevationEnabled =
		process.env.GJC_SDK_ELEVATION_ENABLED === "1" || process.env.GJC_SDK_ELEVATION_ENABLED === "true";
	const elevationAllowlisted = isElevationAllowlisted("control", row.sdkId);
	const elevationRequired = elevationEnabled && elevationAllowlisted;
	if (elevationRequired && request.elevationRequestId === undefined)
		return Promise.resolve(failure(request.id, "elevation_required", `${row.sdkId} requires an elevation grant.`));
	if (request.elevationRequestId !== undefined) {
		const claim = request.elevationRequestId.trim();
		if (!claim || claim.length > 128)
			return Promise.resolve(
				failure(request.id, "invalid_input", "elevationRequestId must be a non-empty bounded string."),
			);
		if (!elevationAllowlisted)
			return Promise.resolve(
				failure(request.id, "invalid_input", "Only allowlisted elevation operations may carry elevationRequestId."),
			);
		if (!surface.authorizeElevationClaim?.(row.sdkId, request.input, claim))
			return Promise.resolve(
				failure(request.id, "elevation_required", "The elevation claim is not broker-authorized for this control."),
			);
	}
	if ((row.sdkId === "context.clear" || row.sdkId === "session.delete") && request.confirm !== true)
		return Promise.resolve(
			failure(request.id, "invalid_input", "confirm: true is required for this destructive operation."),
		);
	const work = () => execute(surface, row, request);
	if (row.sdkId === "turn.abort_and_prompt") {
		const cancellable = surface as PreflightCancellableSurface;
		if (Object.hasOwn(cancellable, "cancelPendingPreflights")) cancellable.cancelPendingPreflights?.();
		return serialize(surface, work);
	}
	if (row.idempotency === "idempotent" && request.idempotencyKey) return idempotent(surface, row, request, work);
	return row.idempotency === "ordered" && row.sdkId !== "retry.now" ? serialize(surface, work) : work();
}
