import type { Effort } from "../../model-thinking";
import { requireSupportedEffort } from "../../model-thinking";
import type { Api, Model } from "../../types";

export interface ReasoningConfig {
	effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	summary?: "auto" | "concise" | "detailed";
}

export interface CodexRequestOptions {
	reasoningEffort?: ReasoningConfig["effort"];
	reasoningSummary?: ReasoningConfig["summary"] | null;
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];
}

export interface InputItem {
	id?: string | null;
	type?: string | null;
	role?: string;
	content?: unknown;
	call_id?: string | null;
	name?: string;
	output?: unknown;
	arguments?: unknown;
	encrypted_content?: unknown;
}

export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	input?: InputItem[];
	tools?: unknown;
	tool_choice?: unknown;
	temperature?: number;
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
	reasoning?: Partial<ReasoningConfig>;
	text?: {
		verbosity?: "low" | "medium" | "high";
	};
	include?: string[];
	prompt_cache_key?: string;
	prompt_cache_retention?: "in_memory" | "24h";
	max_output_tokens?: number;
	max_completion_tokens?: number;
	[key: string]: unknown;
}

function getReasoningConfig(model: Model<Api>, options: CodexRequestOptions): ReasoningConfig {
	const config: ReasoningConfig = {
		effort:
			options.reasoningEffort === "none" ? "none" : requireSupportedEffort(model, options.reasoningEffort as Effort),
	};
	if (options.reasoningSummary !== null) {
		config.summary = options.reasoningSummary ?? "detailed";
	}
	return config;
}

function describeTextPartValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function normalizeTextPartValue(value: unknown, path: string): string {
	if (typeof value === "string") return value.toWellFormed();
	try {
		const encoded = JSON.stringify(value);
		if (typeof encoded === "string") return encoded.toWellFormed();
	} catch {
		// Fall through to the actionable local error below.
	}
	throw new Error(
		`Invalid Codex request text part at ${path}: expected a string or JSON-serializable value, received ${describeTextPartValue(value)}. Normalize compacted continuation content before sending to Codex.`,
	);
}

function normalizeTextPartFields(content: unknown, path: string): unknown {
	if (typeof content === "string") return content.toWellFormed();
	if (!Array.isArray(content)) return content;
	return content.map((part, index) => {
		if (!part || typeof part !== "object") return part;
		const normalizedPart = { ...(part as Record<string, unknown>) };
		if ("text" in normalizedPart) {
			normalizedPart.text = normalizeTextPartValue(normalizedPart.text, `${path}[${index}].text`);
		}
		return normalizedPart;
	});
}

function normalizeInputTextPartFields(input: InputItem[] | undefined): InputItem[] | undefined {
	if (!Array.isArray(input)) return input;
	return input.map((item, itemIndex) => {
		const normalizedItem = { ...item };
		const itemRecord = normalizedItem as Record<string, unknown>;
		if ("encrypted_content" in itemRecord) {
			if (typeof itemRecord.encrypted_content === "string") {
				itemRecord.encrypted_content = itemRecord.encrypted_content.toWellFormed();
			} else {
				delete itemRecord.encrypted_content;
			}
		}
		if (normalizedItem.type === "message") {
			normalizedItem.content = normalizeTextPartFields(normalizedItem.content, `input[${itemIndex}].content`);
		}
		return normalizedItem;
	});
}

function filterInput(input: InputItem[] | undefined): InputItem[] | undefined {
	if (!Array.isArray(input)) return input;

	return input
		.filter(item => item.type !== "item_reference")
		.map(item => {
			if (item.id != null) {
				const { id: _id, ...rest } = item;
				return rest as InputItem;
			}
			return item;
		});
}

export async function transformRequestBody(
	body: RequestBody,
	model: Model<Api>,
	options: CodexRequestOptions = {},
	prompt?: { developerMessages: string[] },
): Promise<RequestBody> {
	body.store = false;
	body.stream = true;

	if (body.input && Array.isArray(body.input)) {
		body.input = filterInput(body.input);

		if (body.input) {
			const functionCallIds = new Set(
				body.input
					.filter(item => item.type === "function_call" && typeof item.call_id === "string")
					.map(item => item.call_id as string),
			);

			body.input = body.input.map(item => {
				if (item.type === "function_call_output" && typeof item.call_id === "string") {
					const callId = item.call_id as string;
					if (!functionCallIds.has(callId)) {
						const itemRecord = item as unknown as Record<string, unknown>;
						const toolName = typeof itemRecord.name === "string" ? itemRecord.name : "tool";
						let text = "";
						try {
							const output = itemRecord.output;
							text = typeof output === "string" ? output : JSON.stringify(output);
						} catch {
							text = String(itemRecord.output ?? "");
						}
						if (text.length > 16000) {
							text = `${text.slice(0, 16000)}\n...[truncated]`;
						}
						return {
							type: "message",
							role: "assistant",
							content: `[Previous ${toolName} result; call_id=${callId}]: ${text}`,
						} as InputItem;
					}
				}
				return item;
			});
		}
		body.input = normalizeInputTextPartFields(body.input);
	}

	if (prompt?.developerMessages && prompt.developerMessages.length > 0 && Array.isArray(body.input)) {
		const developerMessages = prompt.developerMessages.map(
			text =>
				({
					type: "message",
					role: "developer",
					content: [{ type: "input_text", text }],
				}) as InputItem,
		);
		body.input = [...developerMessages, ...body.input];
	}

	if (options.reasoningEffort !== undefined) {
		const reasoningConfig = getReasoningConfig(model, options);
		body.reasoning = {
			...body.reasoning,
			...reasoningConfig,
		};
	} else {
		delete body.reasoning;
	}

	body.text = {
		...body.text,
		verbosity: options.textVerbosity || "low",
	};

	const include = Array.isArray(options.include) ? [...options.include] : [];
	include.push("reasoning.encrypted_content");
	body.include = Array.from(new Set(include));

	delete body.max_output_tokens;
	delete body.max_completion_tokens;

	return body;
}
