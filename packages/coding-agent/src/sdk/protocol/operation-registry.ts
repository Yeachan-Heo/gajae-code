export const ADAPTERS = ["telegram", "discord", "slack", "mcp", "acp", "daemonCli"] as const;

export type Adapter = (typeof ADAPTERS)[number];
export type AdapterDisposition = "native_alias" | "generic_safe" | "machine_only" | "provider_only" | "prohibited";
export type OperationKind = "control" | "global" | "query" | "reverse";
export type Idempotency = "idempotent" | "ordered" | "fast_lane";
export type QueryContinuityClass = "stable_prefix" | "retained_revision" | "scalar_snapshot" | "content_addressed";

/** Legacy kind-specific selectors for canonical Q26 `turn.result`. */
export const TURN_RESULT_PROMPT_ALIAS = "turn.prompt_status";
export const TURN_RESULT_SKILL_ALIAS = "skill.invoke_status";

export interface Operation {
	id: string;
	sdkId: string;
	kind: OperationKind;
	description: string;
	idempotency: Idempotency;
	errorCodes: string[];
	revisionResource?: string;
	continuityClass?: QueryContinuityClass;
	/** Non-canonical request IDs that resolve to this operation's contract. */
	aliases?: readonly string[];

	adapterDispositions: Record<Adapter, AdapterDisposition>;
	testIds: string[];
}

export function findOperation(kind: OperationKind, sdkId: string): Operation | undefined {
	return OPERATIONS.find(
		operation => operation.kind === kind && (operation.sdkId === sdkId || operation.aliases?.includes(sdkId)),
	);
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

// IDs are permanent identities, not tuple positions; omitted operations leave gaps.
const controls = [
	["C01", "turn.prompt", "Submit a new turn prompt."],
	["C02", "turn.steer", "Steer the active turn."],
	["C03", "turn.follow_up", "Queue a follow-up turn."],
	["C04", "turn.abort", "Abort the active turn."],
	[
		"C05",
		"turn.abort_and_prompt",
		"Abort the requester's own active turn and submit a replacement prompt; otherwise queue a steer bound to the selected run, never a successor.",
	],
	["C06", "ask.answer", "Answer an outstanding user question."],
	["C07", "workflow.gate_answer", "Answer a workflow gate."],
	["C08", "workflow.plan_approve", "Approve a workflow plan."],
	["C09", "skill.invoke", "Invoke a skill."],
	["C10", "mode.plan.set", "Set plan mode."],
	["C11", "mode.goal.operate", "Operate goal mode."],
	["C12", "todo.replace", "Replace the session todo list."],
	["C13", "model.set", "Set the active model, optionally promoting its effective thinking level as the default."],
	["C14", "model.cycle", "Cycle the active model."],
	["C15", "thinking.set", "Set thinking level."],
	["C16", "thinking.cycle", "Cycle thinking level."],
	["C17", "permission_mode.set", "Set permission mode."],
	["C18", "queue.steering_mode.set", "Set steering queue mode."],
	["C19", "queue.follow_up_mode.set", "Set follow-up queue mode."],
	["C20", "queue.tool_interrupt_policy.set", "Set whether a steer aborts or finishes in-flight tools."],
	["C21", "compaction.run", "Run context compaction."],
	["C22", "compaction.auto.set", "Set automatic compaction."],
	["C23", "retry.auto.set", "Set automatic retry."],
	["C24", "retry.abort", "Abort retry backoff."],
	["C25", "bash.execute", "Execute managed bash."],
	["C26", "bash.abort", "Abort managed bash."],
	["C27", "session.new", "Create a session."],
	["C28", "session.fork", "Fork the active session."],
	["C29", "session.resume", "Resume a session."],
	["C30", "session.close", "Close the active session."],
	["C31", "session.switch", "Switch the active session."],
	["C32", "session.branch", "Create a session branch."],
	["C33", "session.rename", "Rename a session."],
	["C34", "session.handoff", "Hand off a session."],
	["C35", "session.export_html", "Export session HTML."],
	["C36", "config.patch", "Patch runtime configuration; secret fields are rejected outside secure local paths."],
	["C37", "runtime.reload", "Reload allowlisted runtime components."],
	["C38", "auth.login", "Begin secure authentication login."],
	["C39", "host_tools.register", "Register a host-tool callback provider."],
	["C40", "host_uri.register", "Register a host-URI callback provider."],
	["C41", "service_tier.set", "Set service tier intent."],
	["C42", "tools.active.set", "Replace the active tool set."],
	["C43", "queue.message.remove", "Remove a queued message by stable ID."],
	["C44", "queue.message.move", "Move a queued message by stable ID."],
	["C45", "queue.message.update", "Update a queued message by stable ID."],
	["C46", "extension.set_enabled", "Enable or disable an extension."],
	["C47", "context.clear", "Clear active conversation context."],
	["C48", "session.delete", "Permanently delete a saved session."],
	["C49", "session.cwd.move", "Move a session working directory."],
	["C50", "retry.last", "Retry the last interrupted or failed turn."],
	["C51", "retry.now", "Immediately retry pending backoff."],
	["C52", "bash.background", "Move active managed bash to the background."],
	["C53", "model.profile.set", "Activate a model profile for the current session."],
	["C54", "turn.image.begin", "Begin a bounded host-owned image upload."],
	["C55", "turn.image.append", "Append a canonical base64 image chunk."],
	["C56", "turn.image.finish", "Verify and stage a complete image."],
	["C57", "turn.image.discard", "Discard an unfinished or staged image."],
	["C58", "permission.channel.set", "Enable or disable session-owned external permission polling."],
	["C59", "permission.respond", "Answer a pending external permission request."],
	["C60", "btw.ask", "Ask an ephemeral side question using the current session context without persisting it."],
	["C69", "operator.execute", "Admit session-owned Bash or Python execution with observable terminal results."],
	["C70", "operator.cancel", "Request cancellation of one exact operator execution."],
	["C61", "model.role.set", "Set or clear a session-owned task-role model selection."],
	["C62", "model.select", "Select a concrete model with explicit session or global default scope."],
	["C63", "model.profile.select", "Select a profile with explicit session or global default scope."],
	["C64", "config.write", "Validate and write configuration with explicit session, global, or project scope."],
	["C84", "session.revise", "Broker-authorized same-session revision executor; not a public endpoint control."],
] as const;

const globals = [
	["G01", "session.list", "List saved sessions."],
	["G02", "session.get_endpoint", "Get the session endpoint credential for a local machine attachment."],
	["G03", "session.create", "Create a saved session."],
	["G04", "session.fork", "Fork a saved session."],
	["G05", "session.resume", "Resume a saved session."],
	["G06", "session.close", "Close a saved session."],
	["G07", "session.delete", "Delete a saved session."],
	["G08", "session.reconcile_uncertain", "Retire an indexed terminalUncertain create effect after dead-host proof."],
	["G09", "session.spawn", "Spawn a task-seeded background child session (local interactive master only)."],
	["G10", "session.lookup", "Read a prior session.create outcome without replaying it."],
	[
		"G11",
		"session.revise",
		"Revise a user entry in the same session through Broker authority, preserving sibling history.",
	],
] as const;

// Q28 was folded into Q26; preserve the independent Q29/Q30 query identities.
const queries = [
	["Q01", "transcript.list", "List transcript entries."],
	["Q02", "transcript.body", "Read transcript body."],
	["Q03", "context.get", "Read session context."],
	["Q04", "goal.list/get", "List or get goals."],
	["Q05", "todo.list", "List todos."],
	["Q06", "diff.list_files", "List changed files."],
	["Q07", "diff.list_hunks", "List diff hunks."],
	["Q08", "diff.read_hunk", "Read a diff hunk."],
	["Q09", "usage.get", "Read usage."],
	["Q10", "models.list/current", "List models or read the current model."],
	["Q11", "skill.list/state", "List skills or read skill state."],
	["Q12", "workflow.gates.list", "List workflow gates."],
	["Q13", "config.list/get", "List or read non-secret configuration."],
	["Q14", "session.metadata", "Read session metadata."],
	["Q15", "session.stats", "Read session statistics."],
	["Q16", "session.branch_candidates", "List branch candidates."],
	["Q17", "session.last_assistant", "Read the last assistant message."],
	["Q18", "runtime.capabilities", "Read runtime capabilities."],
	["Q19", "auth.providers", "List authentication provider status without credentials."],
	["Q20", "tools.list", "List tools."],
	["Q21", "queue.messages.list", "List queued messages."],
	["Q22", "extensions.list", "List extensions without secrets."],
	["Q23", "resource.body", "Read a bounded resource continuation."],
	["Q24", "artifact.read", "Read a bounded artifact range."],
	["Q25", "runtime.jobs.list", "List managed jobs."],
	[
		"Q26",
		"turn.result",
		"Read the authoritative durable result of a submitted turn by command/turn IDs or clientRef.",
	],
	[
		"Q27",
		"models.profiles.list",
		"List the effective embedded, signed-registry, and configured model profiles for this session.",
	],
	["Q29", "providers.list/active", "List active providers."],
	["Q30", "session.checkpoint", "Resolve a durable transcript checkpoint into a connection-owned replay cursor."],
	["Q31", "turn.steer_status", "Read the durable acknowledgement status of a correlated steer by clientRef."],
	[
		"Q32",
		"session.progress",
		"Read the read-only project progress snapshot (gjc.project_progress.v1) derived from durable session state.",
	],
	["Q33", "permission.requests.list", "Read the live session-owned pending external permission requests."],
	["Q34", "ask.requests.list", "List pending ordinary interactive ask requests and their answer schemas."],
	["Q35", "model.roles.get", "Observe configured and effective task-role models and their selection source."],
	["Q39", "operator.read", "Read bounded operator output deltas and terminal status by execution identity."],
	["Q47", "diff.scopes", "List installed SDK diff observation scopes."],
	["Q48", "diff.summary", "Capture a bounded working-tree diff snapshot including staged and untracked files."],
	["Q49", "diff.file", "Read a bounded file patch by its frozen snapshot reference."],
] as const;

const queryAliases: Readonly<Record<string, readonly string[]>> = {
	Q26: [TURN_RESULT_PROMPT_ALIAS, TURN_RESULT_SKILL_ALIAS],
};

const reverse = [
	["R01", "terminal.create/output/release/wait", "Direct terminal lifecycle requests."],
	["R02", "filesystem.read/write", "Direct filesystem read and write requests."],
	["R03", "permission.request", "Request a permission decision."],
	["R04", "ui.select/confirm/input/editor/open_url", "Request host UI interaction."],
	["R05", "host_tool.invoke/cancel/update/result", "Direct host-tool callback requests."],
	["R06", "host_uri.read/write/cancel/result", "Direct host-URI callback requests."],
] as const;

function controlDisposition(id: string): Record<Adapter, AdapterDisposition> {
	if (id === "C84")
		return dispositions({
			telegram: "prohibited",
			discord: "prohibited",
			slack: "prohibited",
			mcp: "prohibited",
			acp: "prohibited",
			daemonCli: "prohibited",
		});

	if (id === "C38")
		return dispositions({
			telegram: "prohibited",
			discord: "prohibited",
			slack: "prohibited",
			mcp: "prohibited",
			acp: "provider_only",
			daemonCli: "machine_only",
		});
	if (["C61", "C62", "C63", "C64", "C69", "C70"].includes(id))
		return dispositions({
			telegram: "prohibited",
			discord: "prohibited",
			slack: "prohibited",
			mcp: "prohibited",
			acp: "prohibited",
			daemonCli: "machine_only",
		});
	if (["C54", "C55", "C56", "C57", "C58", "C59"].includes(id))
		return dispositions({
			telegram: "prohibited",
			discord: "prohibited",
			slack: "prohibited",
			mcp: "prohibited",
			acp: "prohibited",
			daemonCli: "machine_only",
		});
	if (["C25", "C26", "C27", "C28", "C29", "C30", "C31", "C32", "C34", "C48"].includes(id))
		return dispositions({
			telegram: "prohibited",
			discord: "prohibited",
			slack: "prohibited",
			mcp: "prohibited",
			acp: "prohibited",
			daemonCli: "prohibited",
		});
	if (id === "C52") return dispositions({ telegram: "prohibited", discord: "prohibited", slack: "prohibited" });
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
	if (["C69", "C70"].includes(id))
		return [
			"invalid_input",
			"busy",
			"disposed",
			"stale_session",
			"session_transitioning",
			"not_found",
			"already_terminal",
			"stale_cursor",
			"backend_failure",
		];
	if (id === "C84")
		return [
			"invalid_input",
			"busy",
			"resource_gone",
			"revision_cancelled",
			"revision_not_applied",
			"revision_failed",
			"provider_failed",
		];

	const errors: Record<string, string[]> = {
		// C01/C05 submit a prompt and therefore run the prompt preflight, which
		// refuses a session with no selected model before admission. The code is
		// appended: ACP machine-only mapping reads errorCodes[0].
		C01: [
			"client_ref_conflict",
			"reconciliation_capacity",
			"reconciliation_persist_failed",
			"model_not_selected",
			"image_upload_unavailable",
		],
		C02: ["turn_not_active", "client_ref_conflict", "reconciliation_capacity", "reconciliation_persist_failed"],
		C09: ["client_ref_conflict", "reconciliation_capacity", "reconciliation_persist_failed"],
		C06: ["stale_request"],
		C07: ["action_claimed", "terminal_uncertain"],
		C05: [
			"invalid_request",
			"busy",
			"model_not_selected",
			"turn_not_active",
			"client_ref_conflict",
			"reconciliation_capacity",
			"reconciliation_persist_failed",
		],
		C08: ["action_claimed", "terminal_uncertain"],
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
		C54: ["invalid_input", "busy", "resource_gone", "operation_prohibited"],
		C55: ["invalid_input", "busy", "resource_gone", "operation_prohibited"],
		C56: ["invalid_input", "busy", "resource_gone", "operation_prohibited"],
		C57: ["invalid_input", "resource_gone", "operation_prohibited"],
		C60: ["invalid_input", "busy", "unavailable"],
		C61: ["invalid_input", "stale_preferences", "preference_busy", "preference_failed"],
		C62: ["invalid_input", "stale_preferences", "preference_busy", "preference_failed", "persistence_unavailable"],
		C63: ["invalid_input", "stale_preferences", "preference_busy", "preference_failed", "persistence_unavailable"],
		C64: [
			"invalid_input",
			"secret_field_forbidden",
			"stale_preferences",
			"preference_busy",
			"persistence_unavailable",
			"preference_failed",
		],
		C58: ["invalid_input", "provider_lease_conflict"],
		C59: ["invalid_input", "resource_gone"],
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
	if (["Q04", "Q05", "Q06", "Q07", "Q08", "Q11", "Q12", "Q13", "Q20", "Q21", "Q22", "Q23", "Q27", "Q30"].includes(id))
		return "retained_revision";

	if (id === "Q24") return "content_addressed";
	return "scalar_snapshot";
}

function queryDisposition(id: string): Record<Adapter, AdapterDisposition> {
	if (["Q33", "Q39", "Q47", "Q48", "Q49"].includes(id))
		return dispositions({
			telegram: "prohibited",
			discord: "prohibited",
			slack: "prohibited",
			mcp: "prohibited",
			acp: "prohibited",
			daemonCli: "machine_only",
		});
	if (["Q23", "Q24", "Q25", "Q26", "Q27", "Q29", "Q30", "Q31", "Q32"].includes(id))
		return dispositions({ telegram: "prohibited", discord: "prohibited", slack: "prohibited" });
	return dispositions();
}

function queryErrors(id: string): string[] {
	const common = [
		"invalid_input",
		"resource_gone",
		"unavailable",
		"operation_not_session_owned",
		"response_too_large",
	];
	if (id === "Q39") return [...common, ...controlErrors("C69")];
	if (["Q06", "Q07", "Q08", "Q47", "Q48", "Q49"].includes(id))
		return [
			...common,
			"not_git_repository",
			"diff_too_large",
			"git_failure",
			"busy",
			"disposed",
			"stale_session",
			"session_transitioning",
			"stale_ref",
		];
	if (id === "Q35") return [...common, "stale_preferences", "preference_busy", "preference_failed"];
	return id === "Q29"
		? ["invalid_request", "resource_gone", "internal"]
		: id === "Q27"
			? ["invalid_request", "resource_gone", "model_profile_registry_error"]
			: id === "Q32"
				? ["invalid_request", "resource_gone", "unavailable"]
				: ["invalid_request", "resource_gone"];
}

export const OPERATIONS: readonly Operation[] = [
	...controls.map(([id, sdkId, description]) => {
		return {
			id,
			sdkId,
			kind: "control" as const,
			description,
			idempotency: (["C04", "C24", "C26", "C43", "C51"] as string[]).includes(id)
				? ("idempotent" as const)
				: (["C25", "C52", "C59", "C60", "C69", "C70"] as string[]).includes(id)
					? ("fast_lane" as const)
					: ("ordered" as const),
			errorCodes: controlErrors(id),
			revisionResource: revision(id),
			adapterDispositions: controlDisposition(id),
			testIds: ["packages/coding-agent/test/sdk-operation-inventory.test.ts"],
		};
	}),
	...globals.map(([id, sdkId, description]) => {
		return {
			id,
			sdkId,
			kind: "global" as const,
			description,
			idempotency: "idempotent" as const,
			errorCodes:
				id === "G11"
					? [
							"invalid_input",
							"busy",
							"resource_gone",
							"operation_prohibited",
							"idempotency_conflict",
							"revision_cancelled",
							"revision_not_applied",
							"revision_failed",
							"provider_failed",
						]
					: id === "G02"
						? ["endpoint_credential_forbidden"]
						: id === "G10"
							? ["invalid_input", "not_found", "idempotency_conflict", "lifecycle_pending", "terminal_uncertain"]
							: ["G03", "G04", "G05"].includes(id)
								? [
										"invalid_request",
										"unknown_model_profile",
										"model_profile_registry_error",
										"legacy_lifecycle_ambiguous",
									]
								: ["G06", "G07", "G08"].includes(id)
									? ["invalid_request", "legacy_lifecycle_ambiguous"]
									: ["invalid_request"],
			adapterDispositions:
				id === "G11"
					? dispositions({
							telegram: "prohibited",
							discord: "prohibited",
							slack: "prohibited",
							mcp: "prohibited",
							acp: "prohibited",
							daemonCli: "machine_only",
						})
					: id === "G02"
						? dispositions({
								telegram: "prohibited",
								discord: "prohibited",
								slack: "prohibited",
								mcp: "prohibited",
								acp: "machine_only",
								daemonCli: "machine_only",
							})
						: id === "G10"
							? dispositions({
									telegram: "prohibited",
									discord: "prohibited",
									slack: "prohibited",
									mcp: "prohibited",
									acp: "prohibited",
									daemonCli: "generic_safe",
								})
							: id === "G09"
								? dispositions({
										telegram: "prohibited",
										discord: "prohibited",
										slack: "prohibited",
										mcp: "prohibited",
										acp: "prohibited",
										daemonCli: "prohibited",
									})
								: ["G03", "G04", "G05", "G06", "G07", "G08"].includes(id)
									? dispositions({ telegram: "prohibited", discord: "prohibited", slack: "prohibited" })
									: dispositions(),
			testIds: ["packages/coding-agent/test/sdk-operation-inventory.test.ts"],
		};
	}),
	...queries.map(([id, sdkId, description]) => {
		return {
			id,
			sdkId,
			kind: "query" as const,
			description,
			idempotency: "idempotent" as const,
			errorCodes: [...new Set(queryErrors(id))],
			continuityClass: queryContinuityClass(id),
			...(queryAliases[id] === undefined ? {} : { aliases: queryAliases[id] }),
			adapterDispositions: queryDisposition(id),
			testIds: ["packages/coding-agent/test/sdk-operation-inventory.test.ts"],
		};
	}),
	...reverse.map(([id, sdkId, description]) => ({
		id,
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
