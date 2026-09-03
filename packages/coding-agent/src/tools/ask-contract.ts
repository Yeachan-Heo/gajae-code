/** Canonical AskTool schema and deferred raw-argument recovery contract.
 *
 * Kept dependency-light so both eager AskTool and the cold descriptor registry
 * validate the same payloads without importing the AskTool implementation.
 */
import { INTENT_FIELD } from "@gajae-code/agent-core";
import type { RawArgumentValidationResult } from "@gajae-code/ai/types";
import * as z from "zod/v4";
import { deepInterviewCharacterCount } from "../gjc-runtime/deep-interview-state";
import {
	isLegacyDeepInterviewPlaceholder,
	isWorkflowPlaceholderText,
	WORKFLOW_PLACEHOLDER_CORRECTION,
} from "../gjc-runtime/workflow-placeholder";

function deepInterviewBoundedString(maximum: number) {
	return z.string().superRefine((value, context) => {
		if (deepInterviewCharacterCount(value) > maximum)
			context.addIssue({
				code: "too_big",
				maximum,
				inclusive: true,
				origin: "string",
				message: `Too big: expected string to have <=${maximum} characters`,
			});
	});
}

function isReservedCustomInputOptionLabel(label: string): boolean {
	const unicodeNormalized = label.normalize("NFKC").toLowerCase().trim();
	if (/^other[\p{P}\p{S}]+/u.test(unicodeNormalized)) return true;
	const normalized = unicodeNormalized.replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ");
	return (
		/\bother\s+(?:type\s+your\s+own|specify|please\s+specify)\b/.test(normalized) ||
		/(?:\b)(?:type|write)\s+your\s+own\b/.test(normalized) ||
		/\benter\s+manually\b/.test(normalized) ||
		/\bcustom\s+input\b/.test(normalized) ||
		/직접\s*입력/u.test(normalized) ||
		/기타(?:\s*입력)?/u.test(normalized)
	);
}

const OptionItem = z.object({
	label: z
		.string()
		.describe("display label")
		.superRefine((value, context) => {
			if (isReservedCustomInputOptionLabel(value))
				context.addIssue({
					code: "custom",
					message:
						"ask option labels must not imitate the reserved custom-input control; omit the pseudo-option and let the Ask UI add Other (type your own)",
				});
		}),
});

const DEEP_INTERVIEW_INTENT_ID_PATTERN = /^(artifact|surface|integration|constraint):[a-z0-9][a-z0-9._/-]{0,127}$/;

const DeepInterviewReferenceId = z.string().superRefine((value, context) => {
	if (!DEEP_INTERVIEW_INTENT_ID_PATTERN.test(value))
		context.addIssue({ code: "custom", message: "invalid deep-interview intent ID" });
});

const DeepInterviewIntentItem = z
	.object({
		id: z.string().regex(DEEP_INTERVIEW_INTENT_ID_PATTERN),
		category: z.enum(["artifact", "surface", "integration", "constraint"]),
		statement: deepInterviewBoundedString(1_000).min(1),
	})
	.strict()
	.superRefine((value, context) => {
		if (!value.id.startsWith(`${value.category}:`))
			context.addIssue({ code: "custom", message: "intent ID must use its category prefix", path: ["id"] });
	});

const DeepInterviewIntentContract = z
	.object({
		items: z.array(DeepInterviewIntentItem).min(1).max(64),
		confirmation_options: z.array(deepInterviewBoundedString(200).min(1)).min(1).max(5),
	})
	.strict();

const DeepInterviewIntentReview = z
	.object({
		observed_items: z.array(DeepInterviewIntentItem).min(1).max(64),
		supporting_substitutions: z
			.array(
				z
					.object({
						removed_id: DeepInterviewReferenceId,
						replacement_ids: z.array(DeepInterviewReferenceId).min(1).max(64),
						rationale: deepInterviewBoundedString(500).min(1),
					})
					.strict(),
			)
			.max(64),
		approval_options: z.array(deepInterviewBoundedString(200).min(1)).min(1).max(5),
	})
	.strict();

/** Optional structured deep-interview round metadata; when present the round is recorded automatically. */
const DeepInterviewMetadata = z.object({
	round_id: deepInterviewBoundedString(128).describe("stable optional round identity").optional(),
	round: z.number().int().nonnegative().describe("round number"),
	component: deepInterviewBoundedString(128).min(1).describe("targeted topology component"),
	dimension: deepInterviewBoundedString(128).min(1).describe("targeted clarity dimension"),
	ambiguity: z.number().min(0).max(1).describe("ambiguity at ask time (0..1)"),
	confused_terms: z
		.array(deepInterviewBoundedString(256).min(1))
		.max(32)
		.describe("explicit terms the user does not understand; glossary help only, never inferred")
		.optional(),
	references: z
		.array(
			z
				.object({
					reference_id: deepInterviewBoundedString(256).min(1),
					label: deepInterviewBoundedString(256).min(1),
					origin: deepInterviewBoundedString(256).min(1),
					url: deepInterviewBoundedString(2048).min(1).optional(),
					excerpt: deepInterviewBoundedString(2048).min(1).optional(),
				})
				.strict(),
		)
		.max(32)
		.describe("inert reference context for contrast questions only; url/excerpt are never auto-fetched")
		.optional(),
});

const DeepInterviewTopologyMeta = DeepInterviewMetadata.extend({
	round: z.number().int().min(0).max(0).describe("Round 0 topology confirmation"),
	component: z.literal("review-topology"),
	dimension: z.literal("topology"),
	intent_contract: DeepInterviewIntentContract.describe("required Round 0 locked-intent contract"),
}).strict();

const DeepInterviewRoundMeta = DeepInterviewMetadata.extend({
	round: z.number().int().positive().describe("positive interview round number"),
}).strict();

const DeepInterviewReviewMeta = DeepInterviewMetadata.extend({
	round: z.number().int().positive().describe("positive post-Round-0 review number"),
	intent_review: DeepInterviewIntentReview.describe("post-Round-0 locked-intent reduction review"),
}).strict();

const DeepInterviewMeta = z.union([DeepInterviewTopologyMeta, DeepInterviewRoundMeta, DeepInterviewReviewMeta]);
export type DeepInterviewMeta = z.infer<typeof DeepInterviewMeta>;

export function intentContract(
	metadata: DeepInterviewMeta | undefined,
): z.infer<typeof DeepInterviewIntentContract> | undefined {
	return metadata && "intent_contract" in metadata ? metadata.intent_contract : undefined;
}

export function intentReview(
	metadata: DeepInterviewMeta | undefined,
): z.infer<typeof DeepInterviewIntentReview> | undefined {
	return metadata && "intent_review" in metadata ? metadata.intent_review : undefined;
}

const WorkflowGateMeta = z.object({
	stage: z.enum(["deep-interview", "ralplan", "ultragoal"]).describe("workflow gate stage"),
	kind: z.enum(["question", "approval", "execution"]).describe("workflow gate kind"),
});

function createQuestionItemSchema(deepInterviewSchema: z.ZodType<DeepInterviewMeta>) {
	return z
		.object({
			id: z.string().describe("question id"),
			question: z.string().describe("question text"),
			options: z.array(OptionItem).describe("available options"),
			multi: z.boolean().describe("allow multiple selections").optional(),
			recommended: z.number().describe("recommended option index").optional(),
			deepInterview: deepInterviewSchema.describe("optional deep-interview round metadata").optional(),
			workflowGate: WorkflowGateMeta.describe("optional workflow gate stage/kind override").optional(),
		})
		.superRefine((value, context) => {
			if (value.deepInterview !== undefined && isWorkflowPlaceholderText(value.question)) {
				context.addIssue({
					code: "custom",
					message: `deep-interview question body must ${WORKFLOW_PLACEHOLDER_CORRECTION}`,
					path: ["question"],
				});
			}
			const labels = new Set(value.options.map(option => option.label));
			const contract = intentContract(value.deepInterview);
			const review = intentReview(value.deepInterview);
			if (
				value.deepInterview &&
				value.workflowGate &&
				(value.workflowGate.stage !== "deep-interview" || value.workflowGate.kind !== "question")
			)
				context.addIssue({
					code: "custom",
					message: "deep-interview metadata requires a deep-interview question workflow gate",
					path: ["workflowGate"],
				});
			if (contract && review)
				context.addIssue({
					code: "custom",
					message: "intent contract and review are mutually exclusive",
					path: ["deepInterview"],
				});
			if (
				contract &&
				(value.deepInterview?.round !== 0 ||
					value.deepInterview.component !== "review-topology" ||
					value.deepInterview.dimension !== "topology")
			)
				context.addIssue({
					code: "custom",
					message: "intent contract requires round-0 review topology metadata",
					path: ["deepInterview"],
				});
			if (review && (value.deepInterview?.round ?? 0) <= 0)
				context.addIssue({
					code: "custom",
					message: "intent review requires a positive round",
					path: ["deepInterview", "round"],
				});
			if ((contract || review) && value.multi === true)
				context.addIssue({ code: "custom", message: "intent gates must be single-select", path: ["multi"] });
			const confirmationOptions = contract?.confirmation_options ?? [];
			if (new Set(confirmationOptions).size !== confirmationOptions.length)
				context.addIssue({
					code: "custom",
					message: "intent confirmation options must be unique",
					path: ["deepInterview", "intent_contract"],
				});
			const approvalOptions = review?.approval_options ?? [];
			if (new Set(approvalOptions).size !== approvalOptions.length)
				context.addIssue({
					code: "custom",
					message: "intent approval options must be unique",
					path: ["deepInterview", "intent_review"],
				});
			for (const label of confirmationOptions) {
				if (!labels.has(label))
					context.addIssue({
						code: "custom",
						message: "intent confirmation option must be displayed",
						path: ["deepInterview", "intent_contract"],
					});
			}
			for (const label of approvalOptions) {
				if (!labels.has(label))
					context.addIssue({
						code: "custom",
						message: "intent approval option must be displayed",
						path: ["deepInterview", "intent_review"],
					});
			}
		});
}

const QuestionItem = createQuestionItemSchema(DeepInterviewMeta);
const TopologyQuestionItem = createQuestionItemSchema(DeepInterviewTopologyMeta);
const PostTopologyQuestionItem = createQuestionItemSchema(z.union([DeepInterviewRoundMeta, DeepInterviewReviewMeta]));

const OrdinaryQuestionItem = z.object({
	id: z.string().describe("question id"),
	question: z.string().describe("question text"),
	options: z.array(OptionItem).describe("available options"),
	multi: z.boolean().describe("allow multiple selections").optional(),
	recommended: z.number().describe("recommended option index").optional(),
	workflowGate: WorkflowGateMeta.describe("optional workflow gate stage/kind override").optional(),
});

export const askSchema = z.object({
	questions: z.array(QuestionItem).min(1).describe("questions to ask"),
});

export const topologyAskSchema = z.object({
	questions: z.array(TopologyQuestionItem).min(1).describe("questions to ask"),
});

export const postTopologyAskSchema = z.object({
	questions: z.array(PostTopologyQuestionItem).min(1).describe("questions to ask"),
});

export const ordinaryAskSchema = z.object({
	questions: z.array(OrdinaryQuestionItem).min(1).describe("questions to ask"),
});

export type DeepInterviewAskStage = "topology" | "post-topology" | undefined;
export type AskParametersSchema =
	| typeof ordinaryAskSchema
	| typeof askSchema
	| typeof topologyAskSchema
	| typeof postTopologyAskSchema;

export function selectAskParameters(stage?: DeepInterviewAskStage): AskParametersSchema {
	if (stage === "topology") return topologyAskSchema;
	if (stage === "post-topology") return postTopologyAskSchema;
	return ordinaryAskSchema;
}
export type AskToolInput = z.infer<typeof askSchema>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isOnlyPlainData(value: unknown): boolean {
	if (Array.isArray(value))
		return (
			Reflect.ownKeys(value).length === value.length + 1 &&
			value.every((item, index) => Object.hasOwn(value, index) && isOnlyPlainData(item))
		);
	if (typeof value !== "object" || value === null) return true;
	return isPlainRecord(value) && Object.values(value).every(isOnlyPlainData);
}

/**
 * Exact-key check. `required` defaults to `allowed`, so callers that tolerate an
 * optional key still demand every mandatory one.
 */
function hasExactOwnKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	required: readonly string[] = allowed,
): boolean {
	const keys = Reflect.ownKeys(value);
	return (
		keys.every(key => typeof key === "string" && allowed.includes(key)) &&
		required.every(key => Object.hasOwn(value, key))
	);
}

function hasOnlyAllowedOwnKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Reflect.ownKeys(value).every(key => typeof key === "string" && allowed.includes(key));
}

function hasUniqueDisplayedLabels(labels: readonly string[], optionLabels: ReadonlySet<string>): boolean {
	return new Set(labels).size === labels.length && labels.every(label => optionLabels.has(label));
}

/** Parse only to recognize a retired recovery shape; parsed values are never eligible for recovery. */
function parseEncodedContainer(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/** Whether malformed input is close enough to the retired pair shape to require a terminal rejection. */
function isRoundZeroRecoveryCandidate(value: unknown): boolean {
	const root = parseEncodedContainer(value);
	if (typeof root !== "object" || root === null || !Object.hasOwn(root, "questions")) return false;
	const rawQuestions = (root as Record<string, unknown>).questions;
	const questionsValue = parseEncodedContainer(rawQuestions);
	if (!Array.isArray(questionsValue)) return questionsValue === null;
	const rootEncoded = typeof value === "string" || typeof rawQuestions === "string";
	return questionsValue.some(rawQuestion => {
		const question = parseEncodedContainer(rawQuestion);
		if (typeof question !== "object" || question === null || !Object.hasOwn(question, "deepInterview")) return false;
		const rawDeepInterview = (question as Record<string, unknown>).deepInterview;
		const deepInterview = parseEncodedContainer(rawDeepInterview);
		if (typeof deepInterview !== "object" || deepInterview === null) return false;
		const metadata = deepInterview as Record<string, unknown>;
		const hasContract = Object.hasOwn(metadata, "intent_contract");
		const hasReview = Object.hasOwn(metadata, "intent_review");
		// A JSON-string container is terminal only for the retired contract+review
		// pair; canonical single-sided asks stay eligible for generic JSON coercion.
		const encoded = rootEncoded || typeof rawQuestion === "string" || typeof rawDeepInterview === "string";
		return encoded ? hasContract && hasReview : hasContract || hasReview;
	});
}
/**
 * Detect the incident-#4649 shape: a Round-0 topology `deepInterview` object is
 * present but omits required topology metadata. Without this check the payload
 * passthroughs (it is not a retired-pair recovery candidate) and dies in generic
 * Zod validation, whose message names neither the contract nor what a corrected
 * retry must contain — the model re-sends a still-incomplete object and loops.
 *
 * Only the exact incident topology is detected: `round === 0` with the
 * `review-topology`/`topology` component/dimension pair. Recovery is limited to
 * the ambiguity score (an observed 0..1 measurement whose absence carries no
 * intent-lock meaning); `intent_contract` is never derivable — items and the
 * affirmative option set are the locked-intent evidence — so it is always
 * demanded explicitly.
 */
function isRoundZeroTopologyMetadata(deepInterview: Record<string, unknown>): boolean {
	return (
		deepInterview.round === 0 &&
		deepInterview.component === "review-topology" &&
		deepInterview.dimension === "topology"
	);
}

/** Names the fields an incident-shaped retry must carry, in the contract's own terms. */
function roundZeroTopologyCorrection(fields: readonly string[]): string {
	const hints = [
		...(fields.includes("ambiguity")
			? ["ambiguity is the observed 0..1 score at ask time (1 before Round 1), never a guess"]
			: []),
		...(fields.includes("intent_contract")
			? [
					"intent_contract = { items: [{ id, category, statement }], confirmation_options } of displayed items/labels",
				]
			: []),
	];
	return hints.join("; ");
}

/** Targeted rejection for Round-0 topology metadata missing required fields (#4649). */
function roundZeroMetadataRejection(
	arguments_: Record<string, unknown>,
	stage: "topology" | "post-topology" | undefined,
): RawArgumentValidationResult | undefined {
	if (stage !== "topology") return undefined;
	if (!isPlainRecord(arguments_) || !Array.isArray(arguments_.questions) || arguments_.questions.length !== 1)
		return undefined;
	const question = arguments_.questions[0];
	if (!isPlainRecord(question) || !isPlainRecord(question.deepInterview)) return undefined;
	const deepInterview: Record<string, unknown> = question.deepInterview;
	if (!isRoundZeroTopologyMetadata(deepInterview)) return undefined;
	const missing = ["ambiguity", "intent_contract"].filter(field => deepInterview[field] === undefined);
	if (missing.length === 0) return undefined;
	return {
		outcome: "reject",
		code: "ask-round-zero-metadata-requires-full-topology-fields",
		detail: {
			rejectedKeys: missing.map(field => `deepInterview.${field}`),
			hint: roundZeroTopologyCorrection(missing),
		},
	};
}

/** Remove only strict-provider null placeholders for fields optional in the canonical Ask contract. */
function normalizeRoundZeroOptionalNulls(arguments_: Record<string, unknown>): Record<string, unknown> {
	if (!isPlainRecord(arguments_) || !Array.isArray(arguments_.questions) || arguments_.questions.length !== 1)
		return arguments_;
	const question = arguments_.questions[0];
	if (!isPlainRecord(question) || !isPlainRecord(question.deepInterview)) return arguments_;
	const normalizedQuestion = { ...question };
	let changed = false;
	for (const key of ["multi", "recommended", "workflowGate"] as const) {
		if (Object.hasOwn(normalizedQuestion, key) && normalizedQuestion[key] === null) {
			delete normalizedQuestion[key];
			changed = true;
		}
	}
	const normalizedDeepInterview = { ...question.deepInterview };
	for (const key of ["round_id", "confused_terms", "references"] as const) {
		if (Object.hasOwn(normalizedDeepInterview, key) && normalizedDeepInterview[key] === null) {
			delete normalizedDeepInterview[key];
			changed = true;
		}
	}
	if (Array.isArray(normalizedDeepInterview.references)) {
		const references = normalizedDeepInterview.references.map(reference => {
			if (!isPlainRecord(reference)) return reference;
			const normalizedReference = { ...reference };
			for (const key of ["url", "excerpt"] as const) {
				if (Object.hasOwn(normalizedReference, key) && normalizedReference[key] === null) {
					delete normalizedReference[key];
					changed = true;
				}
			}
			return normalizedReference;
		});
		normalizedDeepInterview.references = references;
	}
	if (changed) normalizedQuestion.deepInterview = normalizedDeepInterview;
	return changed ? { ...arguments_, questions: [normalizedQuestion] } : arguments_;
}

function knownIntentRejection(arguments_: Record<string, unknown>): RawArgumentValidationResult | undefined {
	if (!isPlainRecord(arguments_) || !Array.isArray(arguments_.questions) || arguments_.questions.length !== 1)
		return undefined;
	const question = arguments_.questions[0];
	if (!isPlainRecord(question) || !isPlainRecord(question.deepInterview)) return undefined;
	const metadata = question.deepInterview;
	const hasContract = Object.hasOwn(metadata, "intent_contract");
	const hasReview = Object.hasOwn(metadata, "intent_review");
	const workflowGate = question.workflowGate;
	if (
		Object.hasOwn(question, "workflowGate") &&
		(!isPlainRecord(workflowGate) || workflowGate.stage !== "deep-interview" || workflowGate.kind !== "question")
	)
		return { outcome: "reject", code: "ask-deep-interview-metadata-requires-deep-interview-gate" };
	if (hasReview && !hasContract && metadata.round === 0) {
		return { outcome: "reject", code: "ask-intent-review-requires-positive-round" };
	}
	if (!hasContract || !isPlainRecord(metadata.intent_contract)) return undefined;
	const contract = metadata.intent_contract;
	if (
		(Array.isArray(contract.items) && contract.items.length === 0) ||
		(Array.isArray(contract.confirmation_options) && contract.confirmation_options.length === 0)
	)
		return { outcome: "reject", code: "ask-intent-contract-requires-non-empty-authority" };
	return undefined;
}

function deepInterviewPlaceholderRejection(
	arguments_: Record<string, unknown>,
): RawArgumentValidationResult | undefined {
	const root = parseEncodedContainer(arguments_);
	if (!isPlainRecord(root)) return undefined;
	const questions = parseEncodedContainer(root.questions);
	if (!Array.isArray(questions)) return undefined;
	for (const [index, rawValue] of questions.entries()) {
		const rawQuestion = parseEncodedContainer(rawValue);
		if (!isPlainRecord(rawQuestion) || !Object.hasOwn(rawQuestion, "deepInterview")) continue;
		const metadata = parseEncodedContainer(rawQuestion.deepInterview);
		if (metadata !== null && metadata !== undefined && isWorkflowPlaceholderText(rawQuestion.question)) {
			return {
				outcome: "reject",
				code: "ask-deep-interview-question-body-required",
				detail: {
					rejectedKeys: [`questions[${index}].question`],
					hint: WORKFLOW_PLACEHOLDER_CORRECTION,
				},
			};
		}
	}
	for (const [index, rawValue] of questions.entries()) {
		const question = parseEncodedContainer(rawValue);
		if (isPlainRecord(question) && isLegacyDeepInterviewPlaceholder(question.question)) {
			return {
				outcome: "reject",
				code: "ask-deep-interview-question-body-required",
				detail: { rejectedKeys: [`questions[${index}].question`], hint: WORKFLOW_PLACEHOLDER_CORRECTION },
			};
		}
	}
	return undefined;
}

export function recoverRoundZeroIntentContract(
	arguments_: Record<string, unknown>,
	stage?: "topology" | "post-topology",
): RawArgumentValidationResult {
	const normalizedInput = normalizeRoundZeroOptionalNulls(arguments_);
	const placeholderRejection = deepInterviewPlaceholderRejection(normalizedInput);
	if (placeholderRejection) return placeholderRejection;
	// #4649: an incomplete Round-0 topology object (deepInterview present,
	// required fields omitted) is NOT a retired-pair recovery candidate, so it
	// would passthrough into generic Zod validation whose error names no contract
	// and no correction — the repeat-invalid-bisect loop. Non-candidates get the
	// targeted correction here; candidates get it only after the stricter known
	// intent rejections below, so every previously-covered verdict is unchanged.
	if (!isRoundZeroRecoveryCandidate(normalizedInput))
		return roundZeroMetadataRejection(normalizedInput, stage) ?? { outcome: "passthrough" };
	const normalizedArguments = normalizedInput;
	const knownRejection = knownIntentRejection(normalizedArguments);
	if (knownRejection) return knownRejection;
	const missingTopologyFields = roundZeroMetadataRejection(normalizedArguments, stage);
	if (missingTopologyFields) return missingTopologyFields;
	if (!isOnlyPlainData(normalizedArguments) || !isPlainRecord(normalizedArguments)) return { outcome: "reject" };
	// `_i` is the intent field the agent loop injects into every tool schema. The
	// loop strips it before validation, but replayed and directly validated calls
	// can still carry it, and rejecting an otherwise canonical payload for the
	// harness's own field fails a call the model cannot correct.
	if (
		!hasExactOwnKeys(normalizedArguments, ["questions", INTENT_FIELD], ["questions"]) ||
		!Array.isArray(normalizedArguments.questions) ||
		normalizedArguments.questions.length !== 1
	)
		return { outcome: "reject" };

	const question = normalizedArguments.questions[0];
	if (!isPlainRecord(question)) return { outcome: "reject" };
	const questionKeys = ["id", "question", "options", "multi", "recommended", "deepInterview", "workflowGate"];
	if (!hasOnlyAllowedOwnKeys(question, questionKeys)) return { outcome: "reject" };
	if (
		typeof question.id !== "string" ||
		typeof question.question !== "string" ||
		!Array.isArray(question.options) ||
		!Object.hasOwn(question, "deepInterview") ||
		!isPlainRecord(question.deepInterview) ||
		(Object.hasOwn(question, "multi") && question.multi !== false) ||
		(Object.hasOwn(question, "recommended") && typeof question.recommended !== "number")
	)
		return { outcome: "reject" };
	const deepInterview = question.deepInterview;
	const hasIntentContract = Object.hasOwn(deepInterview, "intent_contract");
	const hasIntentReview = Object.hasOwn(deepInterview, "intent_review");
	if (hasIntentContract && hasIntentReview && stage !== "topology") return { outcome: "reject" };
	if (hasIntentContract !== hasIntentReview && askSchema.safeParse(normalizedArguments).success)
		return { outcome: "passthrough" };

	if (
		Object.hasOwn(question, "workflowGate") &&
		(!isPlainRecord(question.workflowGate) ||
			!hasExactOwnKeys(question.workflowGate, ["stage", "kind"]) ||
			question.workflowGate.stage !== "deep-interview" ||
			question.workflowGate.kind !== "question")
	)
		return { outcome: "reject" };

	if (
		!question.options.every(
			option => isPlainRecord(option) && hasExactOwnKeys(option, ["label"]) && typeof option.label === "string",
		)
	)
		return { outcome: "reject" };
	const optionLabels = question.options.map(option => (option as { label: string }).label);
	if (new Set(optionLabels).size !== optionLabels.length) return { outcome: "reject" };

	const deepInterviewKeys = [
		"round_id",
		"round",
		"component",
		"dimension",
		"ambiguity",
		"confused_terms",
		"references",
		"intent_contract",
		"intent_review",
	];
	if (!hasOnlyAllowedOwnKeys(deepInterview, deepInterviewKeys)) return { outcome: "reject" };
	if (
		stage === "post-topology" &&
		!hasIntentContract &&
		hasIntentReview &&
		typeof deepInterview.round === "number" &&
		Number.isInteger(deepInterview.round) &&
		deepInterview.round > 0
	)
		return { outcome: "passthrough" };
	if (
		!hasIntentContract ||
		!hasIntentReview ||
		deepInterview.round !== 0 ||
		typeof deepInterview.component !== "string" ||
		deepInterview.component !== "review-topology" ||
		typeof deepInterview.dimension !== "string" ||
		deepInterview.dimension !== "topology" ||
		typeof deepInterview.ambiguity !== "number" ||
		(Object.hasOwn(deepInterview, "round_id") && typeof deepInterview.round_id !== "string")
	)
		return { outcome: "reject" };

	const contract = DeepInterviewIntentContract.safeParse(deepInterview.intent_contract);
	const review = DeepInterviewIntentReview.safeParse(deepInterview.intent_review);
	if (!contract.success || !review.success) return { outcome: "reject" };
	const displayedLabels = new Set(optionLabels);
	if (
		!hasUniqueDisplayedLabels(contract.data.confirmation_options, displayedLabels) ||
		!hasUniqueDisplayedLabels(review.data.approval_options, displayedLabels)
	)
		return { outcome: "reject" };

	const { intent_review: _intentReview, ...recoveredDeepInterview } = deepInterview;
	const recovered = {
		questions: [
			{
				...question,
				deepInterview: { ...recoveredDeepInterview, intent_contract: contract.data },
			},
		],
	};
	return askSchema.safeParse(recovered).success ? { outcome: "accept", arguments: recovered } : { outcome: "reject" };
}
