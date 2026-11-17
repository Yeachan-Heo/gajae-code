/**
 * Submit result tool for structured subagent output.
 *
 * Subagents must call this tool to finish and return structured JSON output.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { TSchema } from "@gajae-code/ai/types";
import {
	dereferenceJsonSchema,
	isValidJsonSchema,
	type JsonSchemaValidationIssue,
	type JsonSchemaValidationResult,
	sanitizeSchemaForStrictMode,
	tryEnforceStrictSchema,
	validateJsonSchemaValue,
} from "@gajae-code/ai/utils/schema";
import { wrapUntrustedContent } from "../session/messages";
import { truncateMiddle, truncateTail } from "../session/streaming-output";
import { subprocessToolRegistry } from "../task/subprocess-tool-registry";
import type { ToolSession } from ".";
import { jtdToJsonSchema, normalizeSchema } from "./jtd-to-json-schema";

export interface YieldDetails {
	data: unknown;
	status: "success" | "aborted";
	error?: string;
}

function formatSchema(schema: unknown): string {
	if (schema === undefined) return "No schema provided.";
	if (typeof schema === "string") return schema;
	try {
		return JSON.stringify(schema, null, 2);
	} catch {
		return "[unserializable schema]";
	}
}

/** Finished fence, after closer escaping, stays within this many bytes. */
const YIELD_SCHEMA_TEXT_MAX_BYTES = 4096;

const SCHEMA_PROSE_KEYS = new Set(["description", "title", "$comment"]);
const SCHEMA_LITERAL_KEYS = new Set(["default", "const", "enum", "examples", "example"]);
const SCHEMA_MAP_KEYS = new Set([
	"properties",
	"patternProperties",
	"dependencies",
	"dependentSchemas",
	"$defs",
	"definitions",
]);
const SCHEMA_LIST_KEYS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

function cutSchemaExcerpt(text: string, budget: number, direction: "tail" | "head-tail"): string {
	if (budget <= 0) return "";
	const limits = { maxBytes: budget, maxLines: 10_000 };
	const cut =
		direction === "tail"
			? truncateTail(text, limits)
			: truncateMiddle(text, {
					...limits,
					maxHeadBytes: Math.floor(budget / 2),
					maxHeadLines: 5_000,
				});
	return cut.content;
}

/**
 * Truncate repository schema text first, then frame it. Closer escaping can grow
 * the excerpt, so the raw budget shrinks until the finished fence fits. The
 * fence itself is never sliced.
 */
function frameYieldSchemaText(text: string, direction: "tail" | "head-tail"): string {
	let budget = Buffer.byteLength(text, "utf-8");
	let excerpt = text;
	let framed = wrapUntrustedContent(excerpt);
	while (Buffer.byteLength(framed, "utf-8") > YIELD_SCHEMA_TEXT_MAX_BYTES) {
		const framedBytes = Buffer.byteLength(framed, "utf-8");
		const scaled = Math.floor((budget * YIELD_SCHEMA_TEXT_MAX_BYTES) / Math.max(1, framedBytes));
		const next = Math.max(0, Math.min(budget - 1, scaled));
		if (next === 0) return wrapUntrustedContent("");
		budget = next;
		excerpt = cutSchemaExcerpt(text, budget, direction);
		framed = wrapUntrustedContent(excerpt);
	}
	return framed;
}

function frameSchemaMap(map: Record<string, unknown>, seen: WeakSet<object>): Record<string, unknown> {
	const output: Record<string, unknown> = Object.create(null);
	for (const name of Object.keys(map)) output[name] = frameSchemaProse(map[name], seen);
	return output;
}

function frameSchemaProse(value: unknown, seen: WeakSet<object>, keepRootDescription = false): unknown {
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return value;
	seen.add(value);
	if (Array.isArray(value)) return value.map(item => frameSchemaProse(item, seen));
	const output: Record<string, unknown> = Object.create(null);
	for (const key of Object.keys(value)) {
		const child = (value as Record<string, unknown>)[key];
		if (SCHEMA_MAP_KEYS.has(key) && child && typeof child === "object" && !Array.isArray(child)) {
			output[key] = frameSchemaMap(child as Record<string, unknown>, seen);
			continue;
		}
		if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(child)) {
			output[key] = child.map(item => frameSchemaProse(item, seen));
			continue;
		}
		if (SCHEMA_LITERAL_KEYS.has(key)) {
			output[key] = child;
			continue;
		}
		if (keepRootDescription && key === "description") {
			output[key] = child;
			continue;
		}
		if (SCHEMA_PROSE_KEYS.has(key) && typeof child === "string") {
			output[key] = frameYieldSchemaText(child, "tail");
			continue;
		}
		output[key] = frameSchemaProse(child, seen);
	}
	return output;
}

function formatJsonSchemaIssues(issues: ReadonlyArray<JsonSchemaValidationIssue> | undefined): string {
	if (!issues || issues.length === 0) return "Unknown schema validation error.";
	return issues
		.map(issue => {
			const path = issue.path.length === 0 ? "" : `${issue.path.map(seg => String(seg)).join("/")}: `;
			return `${path}${issue.message}`;
		})
		.join("; ");
}

function looseRecordSchema(description: string): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: true,
		description,
	};
}

function hasUnresolvedRefs(schema: unknown): boolean {
	if (schema == null) return false;
	if (Array.isArray(schema)) {
		for (const item of schema) {
			if (hasUnresolvedRefs(item)) return true;
		}
		return false;
	}
	if (typeof schema !== "object") return false;
	const record = schema as Record<string, unknown>;
	if (typeof record.$ref === "string") return true;
	for (const key in record) {
		if (key === "const" || key === "default" || key === "enum" || key === "examples") continue;
		if (hasUnresolvedRefs(record[key])) return true;
	}
	return false;
}

function wrapYieldParameters(dataSchema: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: false,
		description: "submit data or error",
		properties: {
			result: {
				anyOf: [
					{
						type: "object",
						additionalProperties: false,
						description: "task succeeded",
						properties: { data: dataSchema },
						required: ["data"],
					},
					{
						type: "object",
						additionalProperties: false,
						properties: {
							error: { type: "string", description: "error message" },
						},
						required: ["error"],
					},
				],
			},
		},
		required: ["result"],
	};
}

export class YieldTool implements AgentTool<TSchema, YieldDetails> {
	readonly name = "yield";
	readonly label = "Submit Result";
	readonly description =
		"Finish the task with structured JSON output. Call exactly once at the end of the task.\n\n" +
		'Pass `result: { data: <your output> }` for success, or `result: { error: "message" }` for failure.\n' +
		"The `data`/`error` wrapper is required — do not put your output directly in `result`.";
	readonly parameters: TSchema;
	strict = true;
	readonly intent = "omit" as const;
	lenientArgValidation = true;

	readonly #validate?: (value: unknown) => JsonSchemaValidationResult;
	#schemaValidationFailures = 0;

	constructor(session: ToolSession) {
		let validate: ((value: unknown) => JsonSchemaValidationResult) | undefined;
		let parameters: TSchema;

		try {
			const schemaResult = normalizeSchema(session.outputSchema);
			const normalizedSchema =
				schemaResult.normalized !== undefined ? jtdToJsonSchema(schemaResult.normalized) : undefined;
			let schemaError = schemaResult.error;

			if (!schemaError && normalizedSchema === false) {
				schemaError = "boolean false schema rejects all outputs";
			}

			if (normalizedSchema !== undefined && normalizedSchema !== false && !schemaError) {
				if (!isValidJsonSchema(normalizedSchema)) {
					schemaError = "invalid JSON schema";
				} else {
					validate = value => validateJsonSchemaValue(normalizedSchema, value);
				}
			}

			const schemaHint = formatSchema(normalizedSchema ?? session.outputSchema);
			const schemaDescription = schemaError
				? `Structured JSON output (output schema invalid; accepting unconstrained object):\n${frameYieldSchemaText(schemaError, "tail")}`
				: `Structured output matching the schema:\n${frameYieldSchemaText(schemaHint, "head-tail")}`;
			let sanitizedSchema: Record<string, unknown> | undefined;
			if (
				!schemaError &&
				normalizedSchema != null &&
				typeof normalizedSchema === "object" &&
				!Array.isArray(normalizedSchema)
			) {
				const normalizedRecord = normalizedSchema as Record<string, unknown>;
				const strictProbe = tryEnforceStrictSchema(normalizedRecord);
				if (strictProbe.strict) {
					sanitizedSchema = sanitizeSchemaForStrictMode(normalizedRecord);
				} else {
					sanitizedSchema = normalizedRecord;
					this.strict = false;
				}
			} else if (!schemaError && normalizedSchema === true) {
				sanitizedSchema = {};
				this.strict = false;
			}

			let dataSchema: Record<string, unknown>;
			if (sanitizedSchema !== undefined) {
				const resolved = dereferenceJsonSchema({
					...sanitizedSchema,
					description: schemaDescription,
				}) as Record<string, unknown>;
				if (hasUnresolvedRefs(resolved)) {
					throw new Error("schema contains unresolved $ref after dereferencing");
				}
				dataSchema = frameSchemaProse(resolved, new WeakSet(), true) as Record<string, unknown>;
			} else {
				this.strict = false;
				dataSchema = looseRecordSchema(
					schemaError ? schemaDescription : "Structured JSON output (no schema specified)",
				);
			}
			parameters = wrapYieldParameters(dataSchema);
			JSON.stringify(parameters);
			if (!isValidJsonSchema(parameters)) throw new Error("yield parameters schema is invalid");
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			parameters = wrapYieldParameters(
				looseRecordSchema(
					`Structured JSON output (schema processing failed):\n${frameYieldSchemaText(errorMsg, "tail")}`,
				),
			);
			validate = undefined;
			this.strict = false;
		}

		this.#validate = validate;
		this.parameters = parameters;
	}

	async execute(
		_toolCallId: string,
		params: unknown,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<YieldDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<YieldDetails>> {
		const raw = params as Record<string, unknown>;
		const rawResult = raw.result;
		if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
			throw new Error("result must be an object containing either data or error");
		}

		const resultRecord = rawResult as Record<string, unknown>;
		const errorMessage = typeof resultRecord.error === "string" ? resultRecord.error : undefined;
		const data = resultRecord.data;

		if (errorMessage !== undefined && data !== undefined) {
			throw new Error("result cannot contain both data and error");
		}
		if (errorMessage === undefined && data === undefined) {
			throw new Error(
				'result must contain either `data` or `error`. Use `{result: {data: <your output>}}` for success or `{result: {error: "message"}}` for failure.',
			);
		}

		const status = errorMessage !== undefined ? "aborted" : "success";
		let schemaValidationOverridden = false;
		if (status === "success") {
			if (data === undefined || data === null) {
				throw new Error("data is required when yield indicates success");
			}
			if (this.#validate) {
				const parsed = this.#validate(data);
				if (!parsed.success) {
					this.#schemaValidationFailures++;
					if (this.#schemaValidationFailures <= 1) {
						throw new Error(`Output does not match schema: ${formatJsonSchemaIssues(parsed.issues)}`);
					}
					schemaValidationOverridden = true;
				}
			}
		}

		const responseText =
			status === "aborted"
				? `Task aborted: ${errorMessage}`
				: schemaValidationOverridden
					? `Result submitted (schema validation overridden after ${this.#schemaValidationFailures} failed attempt(s)).`
					: "Result submitted.";
		return {
			content: [{ type: "text", text: responseText }],
			details: { data, status, error: errorMessage },
		};
	}
}

// Register subprocess tool handler for extraction + termination.
subprocessToolRegistry.register<YieldDetails>("yield", {
	extractData: event => {
		const details = event.result?.details;
		if (!details || typeof details !== "object") return undefined;
		const record = details as Record<string, unknown>;
		const status = record.status;
		if (status !== "success" && status !== "aborted") return undefined;
		return {
			data: record.data,
			status,
			error: typeof record.error === "string" ? record.error : undefined,
		};
	},
	shouldTerminate: event => !event.isError,
});
