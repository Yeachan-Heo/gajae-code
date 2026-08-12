import { createHash } from "node:crypto";

export const TASK_EXECUTION_POLICY_MIN_DURATION_MS = 1_000;
export const TASK_EXECUTION_POLICY_MAX_DURATION_MS = 24 * 60 * 60 * 1_000;

/** Completion/reporting/workflow control-plane tools; these are not execution capabilities and are never policy-filtered. */
export const TASK_CONTROL_PLANE_TOOL_IDS = Object.freeze(["yield", "report_finding", "ask"] satisfies readonly [
	"yield",
	"report_finding",
	"ask",
]);

export interface TaskExecutionPolicy {
	readonly isolation: "current" | "worktree";
	readonly toolAccess: {
		readonly allow: readonly string[];
		readonly deny: readonly string[];
	};
	readonly mcpDiscovery: "configured" | "disabled";
	readonly maxDurationMs: number | null;
	readonly simpleMode: boolean;
}

export type TaskExecutionPolicySourceKind = "default" | "session";

export interface TaskExecutionPolicySourceReceipt {
	readonly kind: TaskExecutionPolicySourceKind;
	readonly revision: number;
	readonly fingerprint: string;
}

export interface TaskExecutionPolicySnapshot {
	readonly policy: TaskExecutionPolicy;
	readonly revision: number;
	readonly fingerprint: string;
	readonly source: TaskExecutionPolicySourceReceipt;
	readonly sourceReceipt: TaskExecutionPolicySourceReceipt;
}

export type TaskExecutionPolicyErrorCode =
	| "invalid_shape"
	| "unknown_field"
	| "invalid_isolation"
	| "invalid_tool_access"
	| "invalid_tool_id"
	| "overlapping_tools"
	| "invalid_mcp_discovery"
	| "invalid_duration"
	| "invalid_simple_mode"
	| "policy_locked";

export interface TaskExecutionPolicyErrorReceipt {
	readonly code: TaskExecutionPolicyErrorCode;
	readonly message: string;
}

export type TaskExecutionPolicyApplyResult =
	| { readonly ok: true; readonly snapshot: TaskExecutionPolicySnapshot }
	| { readonly ok: false; readonly error: TaskExecutionPolicyErrorReceipt };

export class TaskExecutionPolicyValidationError extends Error {
	readonly code: TaskExecutionPolicyErrorCode;

	constructor(error: TaskExecutionPolicyErrorReceipt) {
		super(error.message);
		this.name = "TaskExecutionPolicyValidationError";
		this.code = error.code;
	}
}

export interface TaskExecutionPolicyLaunchLease {
	readonly snapshot: TaskExecutionPolicySnapshot;
	readonly released: boolean;
	release(): void;
}

const EMPTY_TOOL_IDS: readonly string[] = Object.freeze([]);

export const DEFAULT_TASK_EXECUTION_POLICY: TaskExecutionPolicy = Object.freeze({
	isolation: "current",
	toolAccess: Object.freeze({ allow: EMPTY_TOOL_IDS, deny: EMPTY_TOOL_IDS }),
	mcpDiscovery: "configured",
	maxDurationMs: null,
	simpleMode: false,
});

export const FAILED_PERSISTENT_TASK_EXECUTION_POLICY: TaskExecutionPolicy = Object.freeze({
	isolation: "worktree",
	toolAccess: Object.freeze({
		allow: TASK_CONTROL_PLANE_TOOL_IDS,
		deny: Object.freeze(["bash", "edit", "write"]),
	}),
	mcpDiscovery: "disabled",
	maxDurationMs: TASK_EXECUTION_POLICY_MIN_DURATION_MS,
	simpleMode: true,
});

const TASK_EXECUTION_POLICY_FIELDS = [
	"isolation",
	"toolAccess",
	"mcpDiscovery",
	"maxDurationMs",
	"simpleMode",
] satisfies readonly string[];
const TASK_ACCESS_FIELDS = ["allow", "deny"] satisfies readonly string[];
const SAFE_TOOL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function safeError(code: TaskExecutionPolicyErrorCode): TaskExecutionPolicyErrorReceipt {
	const messages: Record<TaskExecutionPolicyErrorCode, string> = {
		invalid_shape: "Execution policy must be an object with the supported fields.",
		unknown_field: "Execution policy contains an unsupported field.",
		invalid_isolation: "Execution policy isolation is invalid.",
		invalid_tool_access: "Execution policy tool access is invalid.",
		invalid_tool_id: "Execution policy contains an unsafe tool identifier.",
		overlapping_tools: "Execution policy allow and deny lists must not overlap.",
		invalid_mcp_discovery: "Execution policy MCP discovery is invalid.",
		invalid_duration: "Execution policy duration must be null or between one second and twenty-four hours.",
		invalid_simple_mode: "Execution policy simpleMode must be boolean.",
		policy_locked: "Execution policy is locked for this launch.",
	};
	return Object.freeze({ code, message: messages[code] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(
	value: Record<string, unknown>,
	fields: readonly string[],
): TaskExecutionPolicyErrorReceipt | undefined {
	if (Object.keys(value).every(field => fields.includes(field))) return undefined;
	return safeError("unknown_field");
}

function normalizeToolIds(value: unknown): {
	readonly ids?: readonly string[];
	readonly error?: TaskExecutionPolicyErrorReceipt;
} {
	if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !SAFE_TOOL_ID.test(id))) {
		return { error: safeError("invalid_tool_id") };
	}
	const ids = value.map(id => id.toLowerCase());
	if (new Set(ids).size !== ids.length) return { error: safeError("invalid_tool_access") };
	return { ids: Object.freeze(ids) };
}

function canonicalPolicy(policy: TaskExecutionPolicy): string {
	return JSON.stringify({
		isolation: policy.isolation,
		toolAccess: { allow: [...policy.toolAccess.allow], deny: [...policy.toolAccess.deny] },
		mcpDiscovery: policy.mcpDiscovery,
		maxDurationMs: policy.maxDurationMs,
		simpleMode: policy.simpleMode,
	});
}

function fingerprintPolicy(policy: TaskExecutionPolicy): string {
	return createHash("sha256").update(canonicalPolicy(policy), "utf8").digest("hex");
}

function freezePolicy(policy: TaskExecutionPolicy): TaskExecutionPolicy {
	return Object.freeze({
		isolation: policy.isolation,
		toolAccess: Object.freeze({
			allow: Object.freeze([...policy.toolAccess.allow]),
			deny: Object.freeze([...policy.toolAccess.deny]),
		}),
		mcpDiscovery: policy.mcpDiscovery,
		maxDurationMs: policy.maxDurationMs,
		simpleMode: policy.simpleMode,
	});
}

export function compileTaskExecutionPolicy(
	value: unknown,
):
	| { readonly ok: true; readonly policy: TaskExecutionPolicy; readonly fingerprint: string }
	| { readonly ok: false; readonly error: TaskExecutionPolicyErrorReceipt } {
	if (!isRecord(value)) return { ok: false, error: safeError("invalid_shape") };
	const fieldError = hasOnlyFields(value, TASK_EXECUTION_POLICY_FIELDS);
	if (fieldError) return { ok: false, error: fieldError };

	if (value.isolation !== "current" && value.isolation !== "worktree") {
		return { ok: false, error: safeError("invalid_isolation") };
	}
	if (!isRecord(value.toolAccess)) return { ok: false, error: safeError("invalid_tool_access") };
	const accessFieldError = hasOnlyFields(value.toolAccess, TASK_ACCESS_FIELDS);
	if (accessFieldError) return { ok: false, error: accessFieldError };
	const allow = normalizeToolIds(value.toolAccess.allow ?? []);
	if (allow.error) return { ok: false, error: allow.error };
	const deny = normalizeToolIds(value.toolAccess.deny ?? []);
	if (deny.error) return { ok: false, error: deny.error };
	if (!allow.ids || !deny.ids) return { ok: false, error: safeError("invalid_tool_access") };
	const denied = new Set(deny.ids);
	if (allow.ids.some(name => denied.has(name))) return { ok: false, error: safeError("overlapping_tools") };

	if (value.mcpDiscovery !== "configured" && value.mcpDiscovery !== "disabled") {
		return { ok: false, error: safeError("invalid_mcp_discovery") };
	}
	if (
		value.maxDurationMs !== null &&
		(typeof value.maxDurationMs !== "number" ||
			!Number.isSafeInteger(value.maxDurationMs) ||
			value.maxDurationMs < TASK_EXECUTION_POLICY_MIN_DURATION_MS ||
			value.maxDurationMs > TASK_EXECUTION_POLICY_MAX_DURATION_MS)
	) {
		return { ok: false, error: safeError("invalid_duration") };
	}
	if (typeof value.simpleMode !== "boolean") return { ok: false, error: safeError("invalid_simple_mode") };

	const policy = freezePolicy({
		isolation: value.isolation,
		toolAccess: { allow: allow.ids, deny: deny.ids },
		mcpDiscovery: value.mcpDiscovery,
		maxDurationMs: value.maxDurationMs,
		simpleMode: value.simpleMode,
	});
	return { ok: true, policy, fingerprint: fingerprintPolicy(policy) };
}

function cloneSnapshot(snapshot: TaskExecutionPolicySnapshot): TaskExecutionPolicySnapshot {
	const policy = freezePolicy(snapshot.policy);
	const source = Object.freeze({
		kind: snapshot.source.kind,
		revision: snapshot.revision,
		fingerprint: snapshot.fingerprint,
	});
	return Object.freeze({
		policy,
		revision: snapshot.revision,
		fingerprint: snapshot.fingerprint,
		source,
		sourceReceipt: source,
	});
}

function makeSnapshot(
	policy: TaskExecutionPolicy,
	revision: number,
	kind: TaskExecutionPolicySourceKind,
): TaskExecutionPolicySnapshot {
	const frozenPolicy = freezePolicy(policy);
	const fingerprint = fingerprintPolicy(frozenPolicy);
	const source = Object.freeze({ kind, revision, fingerprint });
	return Object.freeze({
		policy: frozenPolicy,
		revision,
		fingerprint,
		source,
		sourceReceipt: source,
	});
}

export class TaskExecutionPolicyController {
	#snapshot: TaskExecutionPolicySnapshot;
	#policyLocked = false;

	#activeLaunches = 0;

	constructor(initialPolicy?: TaskExecutionPolicy) {
		const compiled = compileTaskExecutionPolicy(initialPolicy ?? DEFAULT_TASK_EXECUTION_POLICY);
		if (!compiled.ok) throw new TaskExecutionPolicyValidationError(compiled.error);
		this.#snapshot = makeSnapshot(compiled.policy, 0, initialPolicy === undefined ? "default" : "session");
	}

	static fromSnapshot(snapshot: TaskExecutionPolicySnapshot): TaskExecutionPolicyController {
		const controller = new TaskExecutionPolicyController();
		controller.#snapshot = cloneSnapshot(snapshot);
		controller.#policyLocked = true;

		return controller;
	}

	get(): TaskExecutionPolicySnapshot {
		return this.#snapshot;
	}

	getSnapshot(): TaskExecutionPolicySnapshot {
		return this.#snapshot;
	}

	get activeLaunchCount(): number {
		return this.#activeLaunches;
	}

	apply(value: unknown): TaskExecutionPolicySnapshot {
		const result = this.tryApply(value);
		if (!result.ok) throw new TaskExecutionPolicyValidationError(result.error);
		return result.snapshot;
	}

	previewApply(value: unknown): TaskExecutionPolicyApplyResult {
		const compiled = compileTaskExecutionPolicy(value);
		if (!compiled.ok) return compiled;
		return {
			ok: true,
			snapshot: makeSnapshot(compiled.policy, this.#snapshot.revision + 1, "session"),
		};
	}

	tryApply(value: unknown): TaskExecutionPolicyApplyResult {
		if (this.#policyLocked) return { ok: false, error: safeError("policy_locked") };
		const compiled = compileTaskExecutionPolicy(value);
		if (!compiled.ok) return compiled;
		this.#snapshot = makeSnapshot(compiled.policy, this.#snapshot.revision + 1, "session");
		return { ok: true, snapshot: this.#snapshot };
	}

	clear(): TaskExecutionPolicySnapshot {
		if (this.#policyLocked) return this.#snapshot;
		this.#snapshot = makeSnapshot(DEFAULT_TASK_EXECUTION_POLICY, this.#snapshot.revision + 1, "default");
		return this.#snapshot;
	}

	acquireLaunchLease(): TaskExecutionPolicyLaunchLease {
		const snapshot = this.#snapshot;
		this.#activeLaunches += 1;
		let released = false;
		return {
			snapshot,
			get released() {
				return released;
			},
			release: () => {
				if (released) return;
				released = true;
				this.#activeLaunches = Math.max(0, this.#activeLaunches - 1);
			},
		};
	}
}

const controllerBySession = new WeakMap<object, TaskExecutionPolicyController>();

export function bindTaskExecutionPolicyController(session: object, controller: TaskExecutionPolicyController): void {
	controllerBySession.set(session, controller);
}

export function getTaskExecutionPolicyController(session: object): TaskExecutionPolicyController | undefined {
	return controllerBySession.get(session);
}

export function isTaskToolAllowed(snapshot: TaskExecutionPolicySnapshot, toolName: string): boolean {
	const normalized = toolName.toLowerCase();
	if (TASK_CONTROL_PLANE_TOOL_IDS.some(id => id === normalized)) return true;
	if (snapshot.source.kind === "default") return true;
	if (snapshot.policy.toolAccess.deny.includes(normalized)) return false;
	return snapshot.policy.toolAccess.allow.length === 0 || snapshot.policy.toolAccess.allow.includes(normalized);
}

export function isTaskMcpAllowed(snapshot: TaskExecutionPolicySnapshot, toolName: string): boolean {
	if (!toolName.toLowerCase().startsWith("mcp__")) return true;
	return snapshot.source.kind === "default" || snapshot.policy.mcpDiscovery === "configured";
}

export function isTaskExecutionPolicyIsolationEnforced(snapshot: TaskExecutionPolicySnapshot): boolean {
	return snapshot.source.kind === "session";
}
