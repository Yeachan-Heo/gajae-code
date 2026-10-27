import { untilAborted } from "@gajae-code/utils";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import type { AskAnswerSource, AskRemoteReceipt } from "../tools";
import type { MCPInputRequestHandler } from "./types";

export interface MCPFormInputDependencies {
	getUi(): { ui?: Pick<ExtensionUIContext, "select" | "input">; hasUI: boolean };
	getAskAnswerSource(): AskAnswerSource | undefined;
}

interface FormField {
	key: string;
	label: string;
	type: "string" | "boolean";
	choices?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayText(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").slice(0, 4000);
}

/** Unsupported constraints are rejected, never silently discarded. */
function decodeField(schema: unknown): FormField | undefined {
	if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) return undefined;
	const allowed = new Set(["type", "properties", "required", "additionalProperties", "title", "description"]);
	if (Object.keys(schema).some(key => !allowed.has(key))) return undefined;
	if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") return undefined;
	const entries = Object.entries(schema.properties);
	if (entries.length !== 1) return undefined;
	const [key, property] = entries[0]!;
	if (!isRecord(property) || (property.type !== "string" && property.type !== "boolean")) return undefined;
	if (
		schema.required !== undefined &&
		(!Array.isArray(schema.required) || schema.required.some(value => value !== key))
	)
		return undefined;
	const propertyKeys = new Set(["type", "title", "description", "enum"]);
	if (Object.keys(property).some(name => !propertyKeys.has(name))) return undefined;
	if (property.title !== undefined && typeof property.title !== "string") return undefined;
	if (property.description !== undefined && typeof property.description !== "string") return undefined;
	let choices: string[] | undefined;
	if (property.enum !== undefined) {
		if (
			property.type !== "string" ||
			!Array.isArray(property.enum) ||
			property.enum.length === 0 ||
			!property.enum.every(value => typeof value === "string") ||
			new Set(property.enum).size !== property.enum.length ||
			property.enum.some(value => displayText(value) !== value)
		)
			return undefined;
		choices = property.enum;
	}
	const description = typeof property.description === "string" ? ` — ${property.description}` : "";
	return { key, label: displayText(`${property.title ?? key}${description}`), type: property.type, choices };
}

/** Register on an owned manager; dependencies are resolved per call for late UI registration. */
export function createMCPFormInputHandler(deps: MCPFormInputDependencies): MCPInputRequestHandler {
	return async (_key, request, context) => {
		if (context.signal?.aborted) return { kind: "failed", reason: "cancelled" };
		if (request.method !== "elicitation/create") return { kind: "failed", reason: "unavailable" };
		const params = request.params;
		if (!params || typeof params.message !== "string" || (params.mode !== undefined && params.mode !== "form"))
			return { kind: "failed", reason: "unavailable", message: "Unsupported MCP form request" };
		const field = decodeField(params.requestedSchema);
		if (!field) return { kind: "failed", reason: "unavailable", message: "Unsupported MCP form schema" };
		const local = deps.getUi();
		const ui = local.hasUI ? local.ui : undefined;
		const source = ui ? undefined : deps.getAskAnswerSource();
		if (!ui && !source)
			return { kind: "failed", reason: "unavailable", message: "No user input surface is available" };
		const signal = context.signal;
		const ask = async (question: string, choices?: string[]): Promise<string | undefined> => {
			return untilAborted(signal, async () => {
				if (ui)
					return choices ? ui.select(question, choices, { signal }) : ui.input(question, undefined, { signal });
				if (!source) return undefined;
				const answer = source.awaitAnswerRequest
					? await source.awaitAnswerRequest(
							{
								question,
								options: choices ?? [],
								interaction: choices ? "selector" : "custom_editor",
								controls: [],
							},
							signal,
						)
					: await source.awaitAnswer(question, choices ?? [], signal);
				let receipt: AskRemoteReceipt | undefined;
				let value: string | undefined;
				if (typeof answer === "string") value = answer;
				else if (answer) {
					receipt = answer;
					if (answer.interaction.kind === "value") value = answer.interaction.value;
				}
				if (signal?.aborted) {
					await receipt?.settle({ kind: "resolve_without_commit", reason: "aborted" });
					return undefined;
				}
				if (receipt?.interaction.kind === "control") {
					await receipt.settle({ kind: "invalid", reason: "invalid_control" });
					throw new Error("Invalid MCP form control");
				}
				if (value !== undefined && choices && !choices.includes(value)) {
					await receipt?.settle({ kind: "invalid", reason: "invalid_option" });
					throw new Error("Invalid MCP form answer");
				}
				const settlement = await receipt?.settle(
					value === undefined ? { kind: "resolve_without_commit", reason: "cancelled" } : { kind: "commit" },
				);
				if (receipt && value !== undefined && settlement?.kind !== "committed") return undefined;
				return value;
			});
		};
		try {
			const title = `MCP server ${displayText(context.serverName)} requests input (untrusted server text): ${displayText(params.message)}`;
			const action = await ask(title, ["Accept", "Decline"]);
			if (signal?.aborted) return { kind: "failed", reason: "cancelled" };
			if (action === undefined) return { kind: "result", result: { action: "cancel" } };
			if (action === "Decline") return { kind: "result", result: { action: "decline" } };
			if (action !== "Accept") return { kind: "failed", reason: "error", message: "Invalid MCP form action" };
			const choices = field.type === "boolean" ? ["Yes", "No"] : field.choices;
			const answer = await ask(
				`MCP server ${displayText(context.serverName)} (untrusted server text): ${field.label}`,
				choices,
			);
			if (signal?.aborted) return { kind: "failed", reason: "cancelled" };
			if (answer === undefined) return { kind: "result", result: { action: "cancel" } };
			if (choices && !choices.includes(answer))
				return { kind: "failed", reason: "error", message: "Invalid MCP form answer" };
			const value = field.type === "boolean" ? answer === "Yes" : answer;
			return { kind: "result", result: { action: "accept", content: { [field.key]: value } } };
		} catch {
			return { kind: "failed", reason: signal?.aborted ? "cancelled" : "error" };
		}
	};
}
