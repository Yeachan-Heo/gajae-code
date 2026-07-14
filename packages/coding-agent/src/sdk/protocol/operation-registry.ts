export const ADAPTERS = ["telegram", "discord", "slack", "mcp", "acp", "daemonCli"] as const;

export type Adapter = (typeof ADAPTERS)[number];
export type AdapterDisposition = "native_alias" | "generic_safe" | "machine_only" | "provider_only" | "prohibited";
export type OperationKind = "control" | "global" | "query" | "reverse";
export type Idempotency = "idempotent" | "ordered" | "fast_lane";
export type QueryContinuityClass = "stable_prefix" | "retained_revision" | "scalar_snapshot" | "content_addressed";

export interface Operation {
	id: string;
	sdkId: string;
	kind: OperationKind;
	description: string;
	idempotency: Idempotency;
	errorCodes: string[];
	revisionResource?: string;
	continuityClass?: QueryContinuityClass;

	adapterDispositions: Record<Adapter, AdapterDisposition>;
	testIds: string[];
}

export function findOperation(kind: OperationKind, sdkId: string): Operation | undefined {
	return OPERATIONS.find(operation => operation.kind === kind && operation.sdkId === sdkId);
}

export function adapterDispositionError(
	adapter: Adapter,
	kind: OperationKind,
	sdkId: string,
	modelFacing = false,
): { code: string; message: string } | undefined {
	const operation = findOperation(kind, sdkId);
	if (!operation) return { code: "unknown_operation", message: `Unknown ${kind} operation: ${sdkId}` };
	const disposition = operation.adapterDispositions[adapter];
	if (disposition === "prohibited")
		return { code: "adapter_operation_prohibited", message: `${sdkId} is not available through ${adapter}.` };
	if (modelFacing && disposition === "machine_only")
		return {
			code: "adapter_machine_only",
			message: `${sdkId} is available only to machine-facing ${adapter} clients.`,
		};
	if (disposition === "provider_only")
		return {
			code: "adapter_provider_required",
			message: `${sdkId} requires a provider integration and is unavailable through ${adapter}.`,
		};
	return undefined;
}

const genericSafe: Record<Adapter, AdapterDisposition> = {
	telegram: "generic_safe",
	discord: "generic_safe",
	slack: "generic_safe",
	mcp: "generic_safe",
	acp: "generic_safe",
	daemonCli: "generic_safe",
};

function dispositions(
	overrides: Partial<Record<Adapter, AdapterDisposition>> = {},
): Record<Adapter, AdapterDisposition> {
	return { ...genericSafe, ...overrides };
}

const controls = [
	["turn.prompt", "Submit a new turn prompt."],
	["turn.steer", "Steer the active turn."],
	["turn.follow_up", "Queue a follow-up turn."],
	["turn.abort", "Abort the active turn."],
	["turn.abort_and_prompt", "Abort the active turn and submit a replacement prompt."],
	["ask.answer", "Answer an outstanding user question."],
	["workflow.gate_answer", "Answer a workflow gate."],
	["workflow.plan_approve", "Approve a workflow plan."],
	["skill.invoke", "Invoke a skill."],
	["mode.plan.set", "Set plan mode."],
	["mode.goal.operate", "Operate goal mode."],
	["todo.replace", "Replace the session todo list."],
	["model.set", "Set the active model, optionally promoting its effective thinking level as the default."],
	["model.cycle", "Cycle the active model."],
	["thinking.set", "Set thinking level."],
	["thinking.cycle", "Cycle thinking level."],
	["permission_mode.set", "Set permission mode."],
	["queue.steering_mode.set", "Set steering queue mode."],
	["queue.follow_up_mode.set", "Set follow-up queue mode."],
	["queue.interrupt_mode.set", "Set interrupt queue mode."],
	["compaction.run", "Run context compaction."],
	["compaction.auto.set", "Set automatic compaction."],
	["retry.auto.set", "Set automatic retry."],
	["retry.abort", "Abort retry backoff."],
	["bash.execute", "Execute managed bash."],
	["bash.abort", "Abort managed bash."],
	["session.new", "Create a session."],
	["session.fork", "Fork the active session."],
	["session.resume", "Resume a session."],
	["session.close", "Close the active session."],
	["session.switch", "Switch the active session."],
	["session.branch", "Create a session branch."],
	["session.rename", "Rename a session."],
	["session.handoff", "Hand off a session."],
	["session.export_html", "Export session HTML."],
	["config.patch", "Patch runtime configuration; secret fields are rejected outside secure local paths."],
	["runtime.reload", "Reload allowlisted runtime components."],
	["auth.login", "Begin secure authentication login."],
	["host_tools.register", "Register a host-tool callback provider."],
	["host_uri.register", "Register a host-URI callback provider."],
	["service_tier.set", "Set service tier intent."],
	["tools.active.set", "Replace the active tool set."],
	["queue.message.remove", "Remove a queued message by stable ID."],
	["queue.message.move", "Move a queued message by stable ID."],
	["queue.message.update", "Update a queued message by stable ID."],
	["extension.set_enabled", "Enable or disable an extension."],
	["context.clear", "Clear active conversation context."],
	["session.delete", "Permanently delete a saved session."],
	["session.cwd.move", "Move a session working directory."],
	["retry.last", "Retry the last interrupted or failed turn."],
	["retry.now", "Immediately retry pending backoff."],
	["bash.background", "Move active managed bash to the background."],
] as const;

const globals = [
	["session.list", "List saved sessions."],
	["session.get_endpoint", "Get the session endpoint credential for a local machine attachment."],
	["session.create", "Create a saved session."],
	["session.fork", "Fork a saved session."],
	["session.resume", "Resume a saved session."],
	["session.close", "Close a saved session."],
	["session.delete", "Delete a saved session."],
] as const;

const queries = [
	["transcript.list", "List transcript entries."],
	["transcript.body", "Read transcript body."],
	["context.get", "Read session context."],
	["goal.list/get", "List or get goals."],
	["todo.list", "List todos."],
	["diff.list_files", "List changed files."],
	["diff.list_hunks", "List diff hunks."],
	["diff.read_hunk", "Read a diff hunk."],
	["usage.get", "Read usage."],
	["models.list/current", "List models or read the current model."],
	["skill.list/state", "List skills or read skill state."],
	["workflow.gates.list", "List workflow gates."],
	["config.list/get", "List or read non-secret configuration."],
	["session.metadata", "Read session metadata."],
	["session.stats", "Read session statistics."],
	["session.branch_candidates", "List branch candidates."],
	["session.last_assistant", "Read the last assistant message."],
	["runtime.capabilities", "Read runtime capabilities."],
	["auth.providers", "List authentication provider status without credentials."],
	["tools.list", "List tools."],
	["queue.messages.list", "List queued messages."],
	["extensions.list", "List extensions without secrets."],
	["resource.body", "Read a bounded resource continuation."],
	["artifact.read", "Read a bounded artifact range."],
	["runtime.jobs.list", "List managed jobs."],
] as const;

const reverse = [
	["terminal.create/output/release/wait", "Direct terminal lifecycle requests."],
	["filesystem.read/write", "Direct filesystem read and write requests."],
	["permission.request", "Request a permission decision."],
	["ui.select/confirm/input/editor/open_url", "Request host UI interaction."],
	["host_tool.invoke/cancel/update/result", "Direct host-tool callback requests."],
	["host_uri.read/write/cancel/result", "Direct host-URI callback requests."],
] as const;

function controlDisposition(id: string): Record<Adapter, AdapterDisposition> {
	if (["C25", "C26", "C52"].includes(id))
		return dispositions({ telegram: "prohibited", discord: "prohibited", slack: "prohibited" });
	if (id === "C38")
		return dispositions({
			telegram: "prohibited",
			discord: "prohibited",
			slack: "prohibited",
			mcp: "prohibited",
			acp: "provider_only",
			daemonCli: "machine_only",
		});
	if (["C39", "C40"].includes(id))
		return dispositions({
			telegram: "prohibited",
			discord: "prohibited",
			slack: "prohibited",
			mcp: "prohibited",
			acp: "provider_only",
			daemonCli: "prohibited",
		});
	return dispositions();
}

function controlErrors(id: string): string[] {
	const errors: Record<string, string[]> = {
		C13: ["invalid_request", "busy", "default_model_selection_recovery"],
		C36: ["revision_conflict", "secret_input_forbidden"],
		C38: ["authentication_failed", "provider_required"],
		C39: ["provider_required", "registration_failed"],
		C40: ["provider_required", "registration_failed"],
		C42: ["unknown_tool", "required_tool", "revision_conflict"],
		C43: ["already_delivered", "resource_gone", "revision_conflict"],
		C44: ["already_delivered", "invalid_position", "resource_gone"],
		C45: ["already_delivered", "invalid_message", "resource_gone"],
		C46: ["unknown_extension", "reload_failed", "revision_conflict"],
		C47: ["busy", "clear_failed"],
		C48: ["live_session", "not_found", "delete_refused"],
		C49: ["invalid_path", "busy", "reload_failed"],
		C50: ["nothing_to_retry", "busy"],
		C51: ["retry_not_pending"],
		C52: ["not_foldable", "already_backgrounded", "no_active_bash"],
	};
	return errors[id] ?? ["invalid_request", "busy"];
}

function revision(id: string): string | undefined {
	if (["C36"].includes(id)) return "config";
	if (["C42"].includes(id)) return "tools";
	if (["C43", "C44", "C45"].includes(id)) return "queue";
	if (["C46"].includes(id)) return "extensions";
	if (["C49"].includes(id)) return "session";
	return undefined;
}
function queryContinuityClass(id: string): QueryContinuityClass {
	if (["Q01", "Q02"].includes(id)) return "stable_prefix";
	if (["Q04", "Q05", "Q06", "Q07", "Q08", "Q11", "Q12", "Q13", "Q20", "Q21", "Q22", "Q23"].includes(id))
		return "retained_revision";
	if (id === "Q24") return "content_addressed";
	return "scalar_snapshot";
}

function queryDisposition(id: string): Record<Adapter, AdapterDisposition> {
	if (["Q23", "Q24", "Q25"].includes(id))
		return dispositions({ telegram: "prohibited", discord: "prohibited", slack: "prohibited" });
	return dispositions();
}

export const OPERATIONS: readonly Operation[] = [
	...controls.map(([sdkId, description], index) => {
		const id = `C${String(index + 1).padStart(2, "0")}`;
		return {
			id,
			sdkId,
			kind: "control" as const,
			description,
			idempotency: (["C04", "C24", "C26", "C43", "C51"] as string[]).includes(id)
				? ("idempotent" as const)
				: (["C25", "C52"] as string[]).includes(id)
					? ("fast_lane" as const)
					: ("ordered" as const),
			errorCodes: controlErrors(id),
			revisionResource: revision(id),
			adapterDispositions: controlDisposition(id),
			testIds: ["packages/coding-agent/test/sdk-operation-inventory.test.ts"],
		};
	}),
	...globals.map(([sdkId, description], index) => {
		const id = `G${String(index + 1).padStart(2, "0")}`;
		return {
			id,
			sdkId,
			kind: "global" as const,
			description,
			idempotency: "idempotent" as const,
			errorCodes: id === "G02" ? ["endpoint_credential_forbidden"] : ["invalid_request"],
			adapterDispositions:
				id === "G02"
					? dispositions({
							telegram: "prohibited",
							discord: "prohibited",
							slack: "prohibited",
							mcp: "prohibited",
							acp: "machine_only",
							daemonCli: "machine_only",
						})
					: dispositions(),
			testIds: ["packages/coding-agent/test/sdk-operation-inventory.test.ts"],
		};
	}),
	...queries.map(([sdkId, description], index) => {
		const id = `Q${String(index + 1).padStart(2, "0")}`;
		return {
			id,
			sdkId,
			kind: "query" as const,
			description,
			idempotency: "idempotent" as const,
			errorCodes: ["invalid_request", "resource_gone"],
			continuityClass: queryContinuityClass(id),
			adapterDispositions: queryDisposition(id),
			testIds: ["packages/coding-agent/test/sdk-operation-inventory.test.ts"],
		};
	}),
	...reverse.map(([sdkId, description], index) => ({
		id: `R${String(index + 1).padStart(2, "0")}`,
		sdkId,
		kind: "reverse" as const,
		description,
		idempotency: "ordered" as const,
		errorCodes: ["provider_required", "request_cancelled"],
		adapterDispositions: dispositions({
			telegram: "prohibited",
			discord: "prohibited",
			slack: "prohibited",
			mcp: "prohibited",
			acp: "provider_only",
			daemonCli: "machine_only",
		}),
		testIds: ["packages/coding-agent/test/sdk-operation-inventory.test.ts"],
	})),
];
