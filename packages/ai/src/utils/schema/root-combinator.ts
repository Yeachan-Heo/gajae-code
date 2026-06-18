/**
 * Tool `input_schema` root flattening.
 *
 * Tool/function-calling `input_schema` roots MUST be a single JSON Schema object.
 * Bedrock Converse (`toolConfig.tools[*].toolSpec.inputSchema.json.type must be
 * one of the following: object`), OpenAI strict mode, Gemini, and Anthropic all
 * reject roots whose top level is a bare `oneOf`/`anyOf`/`allOf` combinator (the
 * validators require `type: "object"`).
 *
 * Zod `z.union(...)` / `z.discriminatedUnion(...)` tool parameters serialize to
 * exactly such a combinator root, so this normalization is provider-agnostic and
 * runs inside the shared wire pipeline (`toolWireSchema`).
 */
import { isRecord } from "@gajae-code/utils";
import { COMBINATOR_KEYS } from "./fields";
import { spillToDescription } from "./spill";

/** `minItems` / `maxItems` apply to arrays; some validators reject them on `type: "object"`. */
function isJsonSchemaArrayNode(schema: Record<string, unknown>): boolean {
	const t = schema.type;
	if (t === "array") return true;
	if (Array.isArray(t) && t.includes("array") && !t.includes("object")) return true;
	return false;
}

/** True when a JSON Schema node describes an object (explicit `type` or `properties`). */
export function isJsonSchemaObjectNode(schema: Record<string, unknown>): boolean {
	if (isJsonSchemaArrayNode(schema)) return false;
	if (schema.type === "object") return true;
	if (Array.isArray(schema.type) && schema.type.includes("object")) return true;
	if (isRecord(schema.properties)) return true;
	return false;
}

function getRequiredNames(schema: Record<string, unknown>): Set<string> {
	return new Set(
		Array.isArray(schema.required)
			? schema.required.filter((entry): entry is string => typeof entry === "string")
			: [],
	);
}

function getSingleLiteralValue(schema: unknown): unknown | undefined {
	if (!isRecord(schema)) return undefined;
	if (Object.hasOwn(schema, "const")) return schema.const;
	if (Array.isArray(schema.enum) && schema.enum.length === 1) return schema.enum[0];
	return undefined;
}

function describeRootBranch(index: number, branch: Record<string, unknown>, action: unknown): string {
	const required = [...getRequiredNames(branch)];
	const parts = [`Branch ${index + 1}`];
	if (typeof action === "string" || typeof action === "number" || typeof action === "boolean") {
		parts.push(`action ${JSON.stringify(action)}`);
	}
	if (required.length > 0) parts.push(`branch-required fields: ${required.join(", ")}`);
	if (typeof branch.description === "string" && branch.description.length > 0) parts.push(branch.description);
	return parts.join("; ");
}

function collectRootObjectBranches(schema: unknown): Record<string, unknown>[] | undefined {
	if (!isRecord(schema)) return undefined;
	if (isJsonSchemaObjectNode(schema)) return [schema];

	const combinatorKeys = COMBINATOR_KEYS.filter(key => Array.isArray(schema[key]));
	if (combinatorKeys.length === 0) return undefined;

	const branches: Record<string, unknown>[] = [];
	for (const key of combinatorKeys) {
		const variants = schema[key];
		if (!Array.isArray(variants) || variants.length === 0) return undefined;
		for (const variant of variants) {
			const nestedBranches = collectRootObjectBranches(variant);
			if (nestedBranches === undefined) return undefined;
			branches.push(...nestedBranches);
		}
	}
	return branches;
}

/**
 * Flatten a provider-emitted tool ROOT whose top level is a `oneOf`/`anyOf`/`allOf`
 * combinator into one `type: "object"` schema: merge object-branch properties,
 * derive the discriminant (`action`) enum, keep the common required set, and demote
 * leftover combinators plus per-branch guidance into the description. Nested
 * combinators (inside individual properties) are left untouched.
 *
 * Idempotent: a root that already lacks top-level combinators is returned unchanged.
 */
export function flattenToolRootCombinators(schema: Record<string, unknown>): Record<string, unknown> {
	const rootCombinators = COMBINATOR_KEYS.filter(key => Array.isArray(schema[key]));
	if (rootCombinators.length === 0) return schema;
	const result: Record<string, unknown> = { ...schema };

	const baseProperties = isRecord(result.properties) ? { ...result.properties } : {};
	const flattenedBranches = rootCombinators
		.map(key => ({ key, branches: collectRootObjectBranches({ [key]: result[key] }) }))
		.find(entry => entry.branches !== undefined && entry.branches.length > 0);

	result.type = "object";
	result.properties = baseProperties;
	result.additionalProperties = result.additionalProperties === undefined ? false : result.additionalProperties;

	if (flattenedBranches?.branches !== undefined) {
		const variants = flattenedBranches.branches;
		const commonRequired = variants.map(variant => getRequiredNames(variant));
		const required = [...commonRequired[0]].filter(name => commonRequired.every(set => set.has(name)));
		const actionValues: unknown[] = [];
		const guidance: string[] = [];

		for (const [index, branch] of variants.entries()) {
			if (isRecord(branch.properties)) {
				Object.assign(baseProperties, branch.properties);
				const actionValue = getSingleLiteralValue(branch.properties.action);
				if (actionValue !== undefined && !actionValues.includes(actionValue)) actionValues.push(actionValue);
				guidance.push(describeRootBranch(index, branch, actionValue));
			} else {
				guidance.push(describeRootBranch(index, branch, undefined));
			}
		}

		if (actionValues.length > 0) {
			const existingAction = isRecord(baseProperties.action) ? { ...baseProperties.action } : {};
			delete existingAction.const;
			baseProperties.action = { ...existingAction, enum: actionValues };
		}
		result.required = required;
		spillToDescription(result, [
			["rootCombinatorGuidance", guidance],
			...rootCombinators
				.filter(key => key !== flattenedBranches.key)
				.map(key => [key, result[key]] as [string, unknown]),
		]);
	} else {
		spillToDescription(
			result,
			rootCombinators.map(key => [key, result[key]]),
		);
	}

	for (const key of COMBINATOR_KEYS) delete result[key];
	return result;
}
