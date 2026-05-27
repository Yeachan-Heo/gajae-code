import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { formatNumber, prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme, ThemeColor } from "../../modes/theme/theme";
import createGoalDescription from "../../prompts/tools/create-goal.md" with { type: "text" };
import getGoalDescription from "../../prompts/tools/get-goal.md" with { type: "text" };
import goalDescription from "../../prompts/tools/goal.md" with { type: "text" };
import updateGoalDescription from "../../prompts/tools/update-goal.md" with { type: "text" };
import { formatDuration } from "../../slash-commands/helpers/format";
import type { ToolSession } from "../../tools";
import { formatErrorMessage, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { ToolError } from "../../tools/tool-errors";
import { renderStatusLine, truncateToWidth } from "../../tui";
import { completionBudgetReport, remainingTokens, validateGoalObjective } from "../runtime";
import type { Goal, GoalStatus, GoalToolDetails } from "../state";

const goalSchema = z.object({
	op: z.enum(["create", "get", "complete", "resume", "drop"]).describe("goal operation"),
	objective: z.string().describe("goal objective").optional(),
	token_budget: z.number().int().describe("token budget").optional(),
});

const getGoalSchema = z.object({});

const createGoalSchema = z.object({
	objective: z.string().describe("goal objective"),
	token_budget: z.number().int().describe("token budget").optional(),
});

const updateGoalSchema = z.object({
	status: z.enum(["complete", "dropped"]).describe("new goal status"),
});

export type GoalToolInput = z.infer<typeof goalSchema>;
export type GetGoalToolInput = z.infer<typeof getGoalSchema>;
export type CreateGoalToolInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalToolInput = z.infer<typeof updateGoalSchema>;

export interface GoalToolResponse {
	goal: Goal | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
}

export function buildGoalToolResponse(
	goal: Goal | null | undefined,
	options?: { includeCompletionReport?: boolean },
): GoalToolResponse {
	const resolvedGoal = goal ?? null;
	return {
		goal: resolvedGoal,
		remainingTokens: remainingTokens(resolvedGoal),
		completionBudgetReport:
			options?.includeCompletionReport && resolvedGoal?.status === "complete"
				? completionBudgetReport(resolvedGoal)
				: null,
	};
}

function validateCreateParams(params: { objective?: string; token_budget?: number }): {
	objective: string;
	tokenBudget?: number;
} {
	let objective: string;
	try {
		objective = validateGoalObjective(params.objective ?? "", "create");
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}
	const tokenBudget = params.token_budget;
	if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
		throw new ToolError("token_budget must be a positive integer when provided");
	}
	return { objective, tokenBudget };
}

function renderGoalToolResponse(response: GoalToolResponse): string {
	if (!response.goal) return "No active goal.";

	let text = `Goal: ${response.goal.objective}\nStatus: ${response.goal.status}\nTokens: ${response.goal.tokensUsed} used`;
	if (response.goal.tokenBudget !== undefined) {
		text += ` / ${response.goal.tokenBudget} budget`;
	}
	if (response.remainingTokens !== null) {
		text += `\nRemaining tokens: ${response.remainingTokens}`;
	}
	if (response.completionBudgetReport) {
		text += `\n\n${response.completionBudgetReport}`;
	}
	return text;
}

function buildGoalToolResult(op: GoalToolDetails["op"], response: GoalToolResponse): AgentToolResult<GoalToolDetails> {
	return {
		content: [{ type: "text", text: renderGoalToolResponse(response) }],
		details: {
			op,
			goal: response.goal,
			remainingTokens: response.remainingTokens,
			completionBudgetReport: response.completionBudgetReport,
		},
	};
}

async function executeGoalOperation(session: ToolSession, params: GoalToolInput): Promise<GoalToolResponse> {
	if (params.op === "get") {
		const state = session.getGoalModeState?.();
		return buildGoalToolResponse(state?.goal ?? null);
	}

	const runtime = session.getGoalRuntime?.();
	if (!runtime) {
		throw new ToolError("Goal mode is not active.");
	}

	if (params.op === "create") {
		const created = await runtime.createGoal(validateCreateParams(params));
		return buildGoalToolResponse(created.goal);
	}
	if (params.op === "resume") {
		const resumed = await runtime.resumeGoal();
		return buildGoalToolResponse(resumed.goal);
	}
	if (params.op === "drop") {
		const dropped = await runtime.dropGoal();
		return buildGoalToolResponse(dropped ?? null);
	}
	const completed = await runtime.completeGoalFromTool();
	return buildGoalToolResponse(completed, { includeCompletionReport: true });
}

export class GoalTool implements AgentTool<typeof goalSchema, GoalToolDetails> {
	readonly name = "goal";
	readonly label = "Goal";
	readonly loadMode = "essential" as const;
	readonly description = prompt.render(goalDescription);
	readonly parameters = goalSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: GoalToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		const response = await executeGoalOperation(this.#session, params);
		return buildGoalToolResult(params.op, response);
	}
}

export class GetGoalTool implements AgentTool<typeof getGoalSchema, GoalToolDetails> {
	readonly name = "get_goal";
	readonly label = "Get Goal";
	readonly loadMode = "essential" as const;
	readonly description = prompt.render(getGoalDescription);
	readonly parameters = getGoalSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	static createIf(session: ToolSession): GetGoalTool | null {
		return session.getGoalModeState || session.getGoalRuntime ? new GetGoalTool(session) : null;
	}

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		_params: GetGoalToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		const response = await executeGoalOperation(this.#session, { op: "get" });
		return buildGoalToolResult("get", response);
	}
}

export class CreateGoalTool implements AgentTool<typeof createGoalSchema, GoalToolDetails> {
	readonly name = "create_goal";
	readonly label = "Create Goal";
	readonly loadMode = "essential" as const;
	readonly description = prompt.render(createGoalDescription);
	readonly parameters = createGoalSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	static createIf(session: ToolSession): CreateGoalTool | null {
		return session.getGoalRuntime ? new CreateGoalTool(session) : null;
	}

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: CreateGoalToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		const response = await executeGoalOperation(this.#session, {
			op: "create",
			objective: params.objective,
			token_budget: params.token_budget,
		});
		return buildGoalToolResult("create", response);
	}
}

export class UpdateGoalTool implements AgentTool<typeof updateGoalSchema, GoalToolDetails> {
	readonly name = "update_goal";
	readonly label = "Update Goal";
	readonly loadMode = "essential" as const;
	readonly description = prompt.render(updateGoalDescription);
	readonly parameters = updateGoalSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	static createIf(session: ToolSession): UpdateGoalTool | null {
		return session.getGoalRuntime ? new UpdateGoalTool(session) : null;
	}

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: UpdateGoalToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		const response = await executeGoalOperation(this.#session, {
			op: params.status === "dropped" ? "drop" : "complete",
		});
		return buildGoalToolResult(params.status === "dropped" ? "drop" : "complete", response);
	}
}

function describeOp(op: string | undefined): string {
	switch (op) {
		case "create":
			return "set";
		case "complete":
			return "complete";
		case "get":
			return "check";
		case "resume":
			return "resume";
		case "drop":
			return "drop";
		default:
			return op ?? "?";
	}
}

function goalBadgeColor(status: GoalStatus): ThemeColor {
	switch (status) {
		case "complete":
			return "success";
		case "budget-limited":
			return "warning";
		case "paused":
		case "dropped":
			return "muted";
		default:
			return "accent";
	}
}

interface GoalRenderArgs {
	op?: GoalToolInput["op"];
	objective?: string;
	token_budget?: number;
}

export const goalToolRenderer = {
	renderCall(args: GoalRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const description = describeOp(args.op);
		const meta: string[] = [];
		const trimmedObjective = args.objective?.trim();
		if (args.op === "create" && trimmedObjective) {
			const objective = truncateToWidth(trimmedObjective, TRUNCATE_LENGTHS.TITLE);
			meta.push(uiTheme.italic(uiTheme.fg("muted", `"${objective}"`)));
		}
		if (args.op === "create" && args.token_budget !== undefined) {
			meta.push(`budget ${formatNumber(args.token_budget)}`);
		}
		const text = renderStatusLine({ icon: "pending", title: "Goal", description, meta }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GoalToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: GoalRenderArgs,
	): Component {
		const fallbackText = result.content?.find(c => c.type === "text")?.text ?? "";
		const details = result.details;
		const op = details?.op ?? args?.op;
		const description = describeOp(op);

		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Goal", description }, uiTheme);
			const body = formatErrorMessage(fallbackText || "Goal tool failed", uiTheme);
			return new Text([header, body].join("\n"), 0, 0);
		}

		const goal = details?.goal ?? null;
		if (!goal) {
			const header = renderStatusLine({ icon: "warning", title: "Goal", description }, uiTheme);
			const body = uiTheme.fg("muted", "No active goal.");
			return new Text([header, body].join("\n"), 0, 0);
		}

		const lines: string[] = [];
		lines.push(
			renderStatusLine(
				{
					icon: "success",
					title: "Goal",
					description,
					badge: { label: goal.status, color: goalBadgeColor(goal.status) },
				},
				uiTheme,
			),
		);

		const objectiveText = truncateToWidth(goal.objective.trim(), TRUNCATE_LENGTHS.LONG);
		lines.push(`  ${uiTheme.italic(uiTheme.fg("muted", `"${objectiveText}"`))}`);

		const used = formatNumber(goal.tokensUsed);
		const tokensLine =
			goal.tokenBudget !== undefined
				? `${used} / ${formatNumber(goal.tokenBudget)} tokens (${formatNumber(Math.max(0, goal.tokenBudget - goal.tokensUsed))} left)`
				: `${used} tokens`;
		lines.push(`  ${uiTheme.fg("dim", tokensLine)}`);

		if (goal.timeUsedSeconds > 0) {
			lines.push(`  ${uiTheme.fg("dim", `${formatDuration(goal.timeUsedSeconds * 1000)} elapsed`)}`);
		}

		const report = details?.completionBudgetReport;
		if (report) {
			lines.push("");
			lines.push(uiTheme.italic(uiTheme.fg("muted", report)));
		}

		return new Text(lines.join("\n"), 0, 0);
	},

	mergeCallAndResult: true,
};
