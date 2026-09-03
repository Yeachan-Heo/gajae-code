import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model } from "@gajae-code/ai/core";
import type { NativeExactFileIdentity, NativeExactUnlinkResult } from "@gajae-code/natives";
import { getAgentDir, isEnoent } from "@gajae-code/utils";
import * as z from "zod/v4";
import { splitSelectorThinkingSuffix } from "../thinking";
import { withFileLock } from "./file-lock";
import {
	getModelPresetRegistryTestTrustedKeys,
	modelPresetRegistryTestUrlsAllowed,
} from "./internal/model-preset-registry-test-state";
import { type ModelProfileDefinition, type ModelProfileRole, mergeModelProfiles } from "./model-profiles";
import type { ModelsConfig } from "./models-config-schema";

type NativeExactReplacePath = (
	sourcePath: string,
	destinationPath: string,
	expectedSource: NativeExactFileIdentity,
	expectedDestination: NativeExactFileIdentity,
) => NativeExactUnlinkResult;
let nativeExactReplacePath: NativeExactReplacePath | undefined;

function exactReplacePathNative(
	sourcePath: string,
	destinationPath: string,
	expectedSource: NativeExactFileIdentity,
	expectedDestination: NativeExactFileIdentity,
): NativeExactUnlinkResult {
	nativeExactReplacePath ??= (require("@gajae-code/natives") as { exactReplacePath: NativeExactReplacePath })
		.exactReplacePath;
	return nativeExactReplacePath(sourcePath, destinationPath, expectedSource, expectedDestination);
}

export const MODEL_PRESET_REGISTRY_CONTRACT_VERSION = "1.0.0";
export const DEFAULT_MODEL_PRESET_REGISTRY_URL =
	"https://raw.githubusercontent.com/Yeachan-Heo/gajae-code-presets/dev/latest.json";
export const MODEL_PRESET_REGISTRY_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MODEL_PRESET_REGISTRY_STARTUP_DELAY_MS = 30_000;
export const MODEL_PRESET_REGISTRY_MAX_MANIFEST_BYTES = 64 * 1024;
export const MODEL_PRESET_REGISTRY_MAX_SNAPSHOT_BYTES = 64 * 1024;
export const MODEL_PRESET_REGISTRY_MAX_PROFILES_BYTES = 256 * 1024;
export const MODEL_PRESET_REGISTRY_MAX_PRESETS_BYTES = 4 * 1024 * 1024;
const MODEL_PRESET_REGISTRY_MAX_STATE_BYTES = 32 * 1024 * 1024;
const MODEL_PRESET_REGISTRY_MAX_HISTORY = 4;
const MODEL_PRESET_REGISTRY_MAX_RETENTION_ANCESTRY = 64;
const MODEL_PRESET_REGISTRY_MAX_ERROR_BYTES = 1024;
const MODEL_PRESET_REGISTRY_IDENTITY_SKELETON_CACHE_MAX = 200_000;
const MODEL_PRESET_REGISTRY_FETCH_TIMEOUT_MS = 8_000;
const REVISION_PATTERN = /^[0-9]{8}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SELECTOR_PATTERN = /^[^\s\p{Cc}\p{Cf}]+$/u;
const PRESET_IDENTIFIER_PATTERN = /^[^\s\p{Cc}\p{Cf}]+$/u;
const SAFE_TEXT_PATTERN = /^[^\p{Cc}\p{Cf}]+$/u;
const CONTEXT_PROMOTION_TARGET_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[^\s\p{Cc}\p{Cf}]+$/u;
const ED25519_SIGNATURE_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/;

function isCanonicalEd25519SignatureBase64(value: string): boolean {
	if (!ED25519_SIGNATURE_BASE64_PATTERN.test(value)) return false;
	const decoded = Buffer.from(value, "base64");
	return decoded.length === 64 && decoded.toString("base64") === value;
}

function decodeCanonicalEd25519Signature(value: string): Buffer {
	if (!isCanonicalEd25519SignatureBase64(value)) throw new Error("Registry signature encoding is not canonical.");
	return Buffer.from(value, "base64");
}
const DESCRIPTOR_PATH_PATTERN = /^revisions\/[0-9]{8}\/[a-z]+\.json$/;
const SOURCE_REPOSITORY = "https://github.com/Yeachan-Heo/gajae-code";
const REGISTRY_RAW_PATH_PREFIX = "/Yeachan-Heo/gajae-code-presets/";
const RESERVED_IDENTITY_PREFIXES = ["gjc-", "gajae-", "system-", "internal-", "__"];
const IDENTITY_HOMOGLYPHS = new Map(
	Object.entries({
		а: "a",
		е: "e",
		о: "o",
		р: "p",
		с: "c",
		х: "x",
		у: "y",
		і: "i",
		ј: "j",
		к: "k",
		м: "m",
		т: "t",
		в: "b",
		н: "h",
		Α: "a",
		Β: "b",
		Ε: "e",
		Ζ: "z",
		Η: "h",
		Ι: "i",
		Κ: "k",
		Μ: "m",
		Ν: "n",
		Ο: "o",
		Ρ: "p",
		Τ: "t",
		Υ: "y",
		Χ: "x",
		α: "a",
		β: "b",
		ε: "e",
		ι: "i",
		κ: "k",
		ν: "v",
		ο: "o",
		ρ: "p",
		τ: "t",
		υ: "y",
		χ: "x",
	}),
);

export interface ModelPresetRegistryTrustedKey {
	keyId: string;
	publicKeyPem: string;
	validFrom: string;
	revokedAt?: string;
}

/** Compiled trust roots only. Runtime configuration cannot replace these keys. */
const MODEL_PRESET_REGISTRY_TRUSTED_KEYS: ReadonlyMap<string, ModelPresetRegistryTrustedKey> = new Map([
	[
		"registry-root-2026-01",
		{
			keyId: "registry-root-2026-01",
			publicKeyPem:
				"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAwDhA/c/hX++M+wcBddFEVSm5gB1tVSjKMZPtlMSlTSQ=\n-----END PUBLIC KEY-----\n",
			validFrom: "2026-01-01T00:00:00.000Z",
		},
	],
]);

const SemverSchema = z.string().max(32).regex(SEMVER_PATTERN);
const RevisionSchema = z.string().regex(REVISION_PATTERN);
const Sha256Schema = z.string().regex(SHA256_PATTERN);
const UtcTimestampSchema = z
	.string()
	.datetime({ offset: false })
	.refine(value => value.endsWith("Z"));
const DescriptorSchema = z
	.object({
		path: z.string().max(128).regex(DESCRIPTOR_PATH_PATTERN),
		sha256: Sha256Schema,
		bytes: z
			.number()
			.int()
			.positive()
			.max(16 * 1024 * 1024),
		count: z.number().int().nonnegative().max(100_000),
	})
	.strict();
const ConsumerCompatibilitySchema = z.object({ minVersion: SemverSchema, maxVersion: SemverSchema }).strict();
const CompatibilitySchema = z.object({ consumerContract: ConsumerCompatibilitySchema }).strict();
const ProvenanceSchema = z
	.object({
		sourceRepository: z.literal(SOURCE_REPOSITORY),
		sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
		sourcePaths: z
			.array(
				z
					.string()
					.max(256)
					.regex(/^[A-Za-z0-9._/-]+$/),
			)
			.min(1)
			.max(8)
			.refine(values => new Set(values).size === values.length, "Expected unique source paths."),
		generatedBy: z
			.string()
			.max(128)
			.regex(/^[A-Za-z0-9._/@-]+$/),
		generatedAt: UtcTimestampSchema,
	})
	.strict();
const ContentsSchema = z.object({ presets: DescriptorSchema, profiles: DescriptorSchema }).strict();
const ManifestSignedSchema = z
	.object({
		registryRevision: z.number().int().positive().max(99_999_999),
		revision: RevisionSchema,
		publishedAt: UtcTimestampSchema,
		compatibility: CompatibilitySchema,
		snapshot: DescriptorSchema,
		contents: ContentsSchema,
		provenance: ProvenanceSchema,
	})
	.strict();
const SignatureSchema = z
	.object({
		algorithm: z.literal("Ed25519"),
		keyId: z
			.string()
			.min(3)
			.max(64)
			.regex(/^[a-z0-9][a-z0-9._-]+$/),
		value: z
			.string()
			.regex(ED25519_SIGNATURE_BASE64_PATTERN)
			.refine(isCanonicalEd25519SignatureBase64, "Expected canonical Ed25519 Base64."),
	})
	.strict();

export const ModelPresetRegistryManifestSchema = z
	.object({ schemaVersion: z.literal("1.0.0"), signed: ManifestSignedSchema, signature: SignatureSchema })
	.strict();
export const ModelPresetRegistrySnapshotSchema = z
	.object({
		schemaVersion: z.literal("1.0.0"),
		registryRevision: z.number().int().positive().max(99_999_999),
		revision: RevisionSchema,
		compatibility: CompatibilitySchema,
		provenance: ProvenanceSchema,
		contents: ContentsSchema,
	})
	.strict();

const ProfileSelectorSchema = z.union([
	z.string().min(1).max(256).regex(SELECTOR_PATTERN),
	z
		.array(z.string().min(1).max(256).regex(SELECTOR_PATTERN))
		.min(1)
		.max(8)
		.refine(values => new Set(values).size === values.length, "Expected unique selectors."),
]);
const RoleBindingsSchema = z
	.object({
		default: ProfileSelectorSchema,
		executor: ProfileSelectorSchema.optional(),
		architect: ProfileSelectorSchema.optional(),
		planner: ProfileSelectorSchema.optional(),
		critic: ProfileSelectorSchema.optional(),
	})
	.strict();
const RegistryProfileSchema = z
	.object({
		id: z.string().min(1).max(128).regex(PROFILE_ID_PATTERN),
		displayName: z.string().min(1).max(160).regex(SAFE_TEXT_PATTERN),
		providerGroup: z.string().min(1).max(160).regex(SAFE_TEXT_PATTERN),
		requiredProviders: z
			.array(z.string().min(1).max(128).regex(PROFILE_ID_PATTERN))
			.max(32)
			.refine(values => new Set(values).size === values.length, "Expected unique providers."),
		alternativeProviderGroups: z
			.array(
				z
					.array(z.string().min(1).max(128).regex(PROFILE_ID_PATTERN))
					.min(2)
					.max(16)
					.refine(values => new Set(values).size === values.length, "Expected unique providers."),
			)
			.max(16)
			.optional(),
		roleBindings: RoleBindingsSchema,
	})
	.strict();
export const ModelPresetRegistryProfilesSchema = z
	.object({
		schemaVersion: z.literal("1.0.0"),
		revision: RevisionSchema,
		dynamicProviders: z
			.array(z.string().min(1).max(128).regex(PROFILE_ID_PATTERN))
			.max(128)
			.refine(values => new Set(values).size === values.length, "Expected unique dynamic providers."),
		profiles: z.array(RegistryProfileSchema).max(4096),
	})
	.strict()
	.superRefine((document, ctx) => {
		const seen = new Set<string>();
		for (const [index, profile] of document.profiles.entries()) {
			if (seen.has(profile.id))
				ctx.addIssue({ code: "custom", path: ["profiles", index, "id"], message: "Duplicate profile id." });
			seen.add(profile.id);
		}
	});

const EffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
const CostSchema = z
	.object({
		input: z.number().nonnegative().finite(),
		output: z.number().nonnegative().finite(),
		cacheRead: z.number().nonnegative().finite(),
		cacheWrite: z.number().nonnegative().finite(),
	})
	.strict();
const CompatSchema = z
	.object({
		maxTokensField: z.literal("max_tokens").optional(),
		reasoningContentField: z.literal("reasoning_content").optional(),
		thinkingFormat: z.literal("zai").optional(),
		reasoningEffortMap: z
			.object({
				minimal: EffortSchema.optional(),
				low: EffortSchema.optional(),
				medium: EffortSchema.optional(),
				high: EffortSchema.optional(),
				xhigh: EffortSchema.optional(),
				max: EffortSchema.optional(),
			})
			.strict()
			.refine(value => Object.keys(value).length > 0, "Expected at least one reasoning effort mapping.")
			.optional(),
		requiresAssistantContentForToolCalls: z.boolean().optional(),
		requiresReasoningContentForToolCalls: z.boolean().optional(),
		supportsDeveloperRole: z.boolean().optional(),
		supportsMultipleSystemMessages: z.boolean().optional(),
		supportsReasoningEffort: z.boolean().optional(),
		supportsStore: z.boolean().optional(),
		supportsToolChoice: z.boolean().optional(),
		supportsUsageInStreaming: z.boolean().optional(),
	})
	.strict();
const ThinkingSchema = z
	.object({
		mode: z.enum(["anthropic-adaptive", "anthropic-budget-effort", "budget", "effort", "google-level"]),
		minLevel: EffortSchema.optional(),
		maxLevel: EffortSchema.optional(),
		defaultLevel: EffortSchema.optional(),
		levels: z
			.array(EffortSchema)
			.min(1)
			.max(6)
			.refine(values => new Set(values).size === values.length, "Expected unique thinking levels.")
			.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		const effortOrder = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
		const rank = (level: (typeof effortOrder)[number]): number => effortOrder.indexOf(level);
		if (value.minLevel === undefined || value.maxLevel === undefined) {
			context.addIssue({ code: "custom", message: "Thinking metadata requires minLevel and maxLevel." });
		}
		if (value.minLevel !== undefined && value.maxLevel !== undefined && rank(value.minLevel) > rank(value.maxLevel)) {
			context.addIssue({ code: "custom", message: "Thinking minLevel must not exceed maxLevel." });
		}
		if (value.levels !== undefined && value.minLevel !== undefined && !value.levels.includes(value.minLevel)) {
			context.addIssue({ code: "custom", message: "Thinking levels must include minLevel." });
		}
		if (value.levels !== undefined && value.maxLevel !== undefined && !value.levels.includes(value.maxLevel)) {
			context.addIssue({ code: "custom", message: "Thinking levels must include maxLevel." });
		}
		if (value.levels !== undefined && value.minLevel !== undefined && value.maxLevel !== undefined) {
			for (const level of value.levels) {
				if (rank(level) < rank(value.minLevel) || rank(level) > rank(value.maxLevel)) {
					context.addIssue({ code: "custom", message: "Thinking levels must stay within minLevel and maxLevel." });
				}
			}
		}
		if (
			value.defaultLevel !== undefined &&
			(value.levels !== undefined
				? !value.levels.includes(value.defaultLevel)
				: value.minLevel !== undefined &&
					value.maxLevel !== undefined &&
					(rank(value.defaultLevel) < rank(value.minLevel) || rank(value.defaultLevel) > rank(value.maxLevel)))
		) {
			context.addIssue({ code: "custom", message: "Thinking defaultLevel must be within the supported levels." });
		}
	});
const LongContextPricingSchema = z.object({ threshold: z.number().int().positive(), cost: CostSchema }).strict();
const RegistryPresetSchema = z
	.object({
		id: z.string().min(1).max(192).regex(PRESET_IDENTIFIER_PATTERN),
		provider: z.string().min(1).max(192).regex(PROFILE_ID_PATTERN),
		name: z.string().min(1).max(256).regex(SAFE_TEXT_PATTERN),
		api: z.enum([
			"anthropic-messages",
			"azure-openai-responses",
			"bedrock-converse-stream",
			"cursor-agent",
			"google-gemini-cli",
			"google-generative-ai",
			"google-vertex",
			"ollama-chat",
			"openai-codex-responses",
			"openai-completions",
			"openai-responses",
		]),
		reasoning: z.boolean(),
		input: z
			.array(z.enum(["text", "image"]))
			.min(1)
			.max(2)
			.refine(values => new Set(values).size === values.length, "Expected unique input modalities."),
		output: z
			.array(z.enum(["text", "image"]))
			.min(1)
			.max(2)
			.refine(values => new Set(values).size === values.length, "Expected unique output modalities.")
			.optional(),
		cost: CostSchema,
		contextWindow: z.number().int().positive(),
		maxTokens: z.number().int().positive(),
		compat: CompatSchema.optional(),
		thinking: ThinkingSchema.optional(),
		longContextPricing: LongContextPricingSchema.optional(),
		applyPatchToolType: z.literal("freeform").optional(),
		preferWebsockets: z.boolean().optional(),
		premiumMultiplier: z.number().nonnegative().finite().optional(),
		priority: z.number().int().nonnegative().optional(),
		contextPromotionTarget: z.string().min(3).max(256).regex(CONTEXT_PROMOTION_TARGET_PATTERN).optional(),
	})
	.strict();
export const ModelPresetRegistryPresetsSchema = z
	.object({
		schemaVersion: z.literal("1.0.0"),
		revision: RevisionSchema,
		presets: z.array(RegistryPresetSchema).max(100_000),
	})
	.strict()
	.superRefine((document, ctx) => {
		const seen = new Set<string>();
		for (const [index, preset] of document.presets.entries()) {
			const key = `${preset.provider}\u0000${preset.id}`;
			if (seen.has(key))
				ctx.addIssue({ code: "custom", path: ["presets", index], message: "Duplicate provider/model preset." });
			seen.add(key);
		}
	});

export type ModelPresetRegistryManifest = z.infer<typeof ModelPresetRegistryManifestSchema>;
export type ModelPresetRegistrySnapshot = z.infer<typeof ModelPresetRegistrySnapshotSchema>;
export type ModelPresetRegistryProfiles = z.infer<typeof ModelPresetRegistryProfilesSchema>;
export type ModelPresetRegistryPresets = z.infer<typeof ModelPresetRegistryPresetsSchema>;

type AcceptedGeneration = {
	manifest: ModelPresetRegistryManifest;
	snapshot: ModelPresetRegistrySnapshot;
	profiles: ModelPresetRegistryProfiles;
	presets: ModelPresetRegistryPresets;
	manifestSha256: string;
	acceptedAt: string;
	etag?: string;
	/** Complete normalized manifest URL used to scope the validator token. */
	manifestUrl?: string;
	/** @deprecated Kept only to read pre-URL-scoped cache rows; never used for ETag reuse. */
	manifestOrigin?: string;
	retainedProfiles: ModelPresetRegistryProfiles["profiles"];
	retainedPresets: ModelPresetRegistryPresets["presets"];
	retainedDynamicProviders: string[];
	retainedFromRevision?: number;
	revoked?: boolean;
};

type RegistryState = {
	version: 1;
	activeRevision?: number;
	highestSeenRevision?: number;
	highestSeenManifestSha256?: string;
	history: AcceptedGeneration[];
	lastCheckedAt?: string;
	lastError?: string;
};

type RegistryControl = { version: 1; disabled: boolean; pinnedRevision?: number };

export interface ModelPresetRegistryDependencies {
	agentDir?: string;
	manifestUrl?: string;
	fetch?: typeof fetch;
	now?: () => Date;
	timeoutMs?: number;
	maxManifestBytes?: number;
	maxSnapshotBytes?: number;
	maxProfilesBytes?: number;
	maxPresetsBytes?: number;
	maxStateBytes?: number;
	automaticRefresh?: boolean;
	startupDelayMs?: number;
	refreshIntervalMs?: number;
	knownManifestSha256?: string;
}

export interface AcceptedModelPresetRegistry {
	profiles: Map<string, ModelProfileDefinition>;
	presets: Model<Api>[];
	dynamicProviders: string[];
	revision?: number;
	revisionId?: string;
	manifestSha256?: string;
	keyId?: string;
	sourceRevision?: string;
	retainedProfiles: string[];
	retainedPresets: string[];
	error?: string;
	disabled: boolean;
	pinnedRevision?: number;
}

export type ModelPresetRegistryRefreshResult =
	| {
			status: "updated";
			revision: number;
			revisionId: string;
			manifestSha256: string;
			retainedProfiles: string[];
			retainedPresets: string[];
	  }
	| { status: "not_modified"; revision?: number }
	| { status: "disabled"; revision?: number };

export interface ModelPresetRegistryStatus {
	contractVersion: string;
	source: "embedded" | "registry";
	cacheHealth: "empty" | "valid" | "corrupt";
	activeRevision?: number;
	activeRevisionId?: string;
	highestSeenRevision?: number;
	manifestSha256?: string;
	snapshotSha256?: string;
	profilesSha256?: string;
	presetsSha256?: string;
	keyId?: string;
	sourceRevision?: string;
	acceptedAt?: string;
	publishedAt?: string;
	lastCheckedAt?: string;
	lastError?: string;
	disabled: boolean;
	pinnedRevision?: number;
	retainedProfiles: string[];
	retainedPresets: string[];
	historyRevisions: number[];
	profileCount: number;
	presetCount: number;
}

function registryPaths(agentDir: string) {
	const root = path.join(agentDir, "model-presets");
	return {
		root,
		state: path.join(root, "state.json"),
		backup: path.join(root, "state.backup.json"),
		failure: path.join(root, "failure.json"),
		control: path.join(root, "control.json"),
		transaction: path.join(root, "transaction"),
	};
}

type RegistryStatePaths = { state: string; backup: string };

async function writeRegistryState(
	paths: RegistryStatePaths,
	state: RegistryState,
	canWrite: () => boolean = () => true,
): Promise<void> {
	// Publish the backup before replacing the primary. If the process stops in
	// the replacement window, recovery can still combine the old primary's
	// active intent with the newer backup's anti-rollback floor.
	if (!canWrite()) return;
	await writeAtomicJson(paths.backup, state);
	if (!canWrite()) return;
	await writeAtomicJson(paths.state, state);
}

function safeError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	if (!/^(?:Registry|Cached registry|Cannot pin|Cannot rollback|The preset registry)/.test(raw))
		return "Registry refresh failed.";
	const redacted = raw
		.replace(/https?:\/\/[^\s]+/gi, "<registry-url>")
		.replace(/(api[_-]?key|token|secret|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
		.replace(/[\p{Cc}\p{Cf}]+/gu, " ")
		.trim();
	if (Buffer.byteLength(redacted) <= MODEL_PRESET_REGISTRY_MAX_ERROR_BYTES) return redacted;
	let end = redacted.length;
	while (end > 0 && Buffer.byteLength(redacted.slice(0, end)) > MODEL_PRESET_REGISTRY_MAX_ERROR_BYTES) end--;
	return redacted.slice(0, end);
}

function assertSafeRegistryDocument(value: unknown, location = "$"): void {
	if (typeof value === "string") {
		if (/https?:\/\//i.test(value) && value !== SOURCE_REPOSITORY)
			throw new Error(`Registry document contains an unsafe URL at ${location}.`);
		if (/(?:^|[^a-z])(sk-[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}|Bearer\s+\S+)/i.test(value))
			throw new Error(`Registry document contains possible secret material at ${location}.`);
		return;
	}
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) assertSafeRegistryDocument(entry, `${location}[${index}]`);
		return;
	}
	for (const [key, entry] of Object.entries(value)) {
		if (/^(?:headers?|api[_-]?key|base[_-]?url|secret|password|command|script|extraBody)$/i.test(key))
			throw new Error(`Registry document contains unsafe field ${location}.${key}.`);
		assertSafeRegistryDocument(entry, `${location}.${key}`);
	}
}

/**
 * Confusable folding is a pure string function evaluated once per identity per
 * document, and startup validates the same catalog identities repeatedly. The
 * bounded memo keeps the fold cost proportional to the distinct identity count
 * instead of the number of validation passes.
 */
const identitySkeletonCache = new Map<string, string>();

function identitySkeleton(value: string): string {
	const cached = identitySkeletonCache.get(value);
	if (cached !== undefined) return cached;
	const skeleton = [...value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()]
		.map(character => IDENTITY_HOMOGLYPHS.get(character) ?? character)
		.join("");
	if (identitySkeletonCache.size >= MODEL_PRESET_REGISTRY_IDENTITY_SKELETON_CACHE_MAX) identitySkeletonCache.clear();
	identitySkeletonCache.set(value, skeleton);
	return skeleton;
}

function assertUniqueRegistryNames(values: readonly string[], label: string): void {
	const exact = new Set<string>();
	const folded = new Map<string, string>();
	for (const value of values) {
		if (exact.has(value)) throw new Error(`Registry document contains duplicate ${label}.`);
		exact.add(value);
		const skeleton = identitySkeleton(value);
		const previous = folded.get(skeleton);
		if (previous && previous !== value) throw new Error(`Registry document contains confusable ${label}.`);
		folded.set(skeleton, value);
		if (RESERVED_IDENTITY_PREFIXES.some(prefix => value.toLowerCase().startsWith(prefix)))
			throw new Error(`Registry document uses a reserved ${label} namespace.`);
	}
}

function assertRegistryIdentityPolicy(value: unknown): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const document = value as Record<string, unknown>;
	if (Array.isArray(document.profiles)) {
		assertUniqueRegistryNames(
			document.profiles.map(profile => String((profile as { id?: unknown }).id ?? "")),
			"profile id",
		);
	}
	if (Array.isArray(document.dynamicProviders))
		assertUniqueRegistryNames(document.dynamicProviders.map(String), "dynamic provider id");
	if (Array.isArray(document.presets)) {
		assertUniqueRegistryNames(
			document.presets.map(preset => {
				const record = preset as { provider?: unknown; id?: unknown };
				return `${String(record.provider ?? "")}/${String(record.id ?? "")}`;
			}),
			"preset selector",
		);
	}
}

function assertCanonicalUnicode(value: string): void {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
				throw new TypeError("Canonical JSON rejects lone high surrogates.");
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			throw new TypeError("Canonical JSON rejects lone low surrogates.");
		}
	}
}

function serializeCanonicalJson(value: unknown, stack: Set<object>): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers.");
		return JSON.stringify(Object.is(value, -0) ? 0 : value);
	}
	if (typeof value === "string") {
		assertCanonicalUnicode(value);
		return JSON.stringify(value);
	}
	if (typeof value !== "object") throw new TypeError(`Canonical JSON rejects ${typeof value}.`);
	if (stack.has(value)) throw new TypeError("Canonical JSON rejects cycles.");
	stack.add(value);
	try {
		if (Array.isArray(value)) {
			const entries: string[] = [];
			for (let index = 0; index < value.length; index++) {
				if (!Object.hasOwn(value, index)) throw new TypeError("Canonical JSON rejects sparse arrays.");
				entries.push(serializeCanonicalJson(value[index], stack));
			}
			return `[${entries.join(",")}]`;
		}
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
			throw new TypeError("Canonical JSON accepts plain objects only.");
		const record = value as Record<string, unknown>;
		const entries: string[] = [];
		for (const key of Object.keys(record).sort()) {
			assertCanonicalUnicode(key);
			entries.push(`${JSON.stringify(key)}:${serializeCanonicalJson(record[key], stack)}`);
		}
		return `{${entries.join(",")}}`;
	} finally {
		stack.delete(value);
	}
}

export function canonicalModelPresetRegistryJson(value: unknown): string {
	return serializeCanonicalJson(value, new Set());
}

function sha256(bytes: Uint8Array | string): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function serializedJsonByteLength(value: unknown): number {
	return Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8");
}

function parseCanonicalDocument<T>(bytes: Uint8Array, description: string, schema: z.ZodType<T>): T {
	let text: string;
	let value: unknown;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		value = JSON.parse(text);
	} catch {
		throw new Error(`${description} is not valid UTF-8 JSON.`);
	}
	const checked = schema.safeParse(value);
	if (!checked.success)
		throw new Error(`${description} schema rejected: ${checked.error.issues[0]?.message ?? "invalid"}.`);
	assertSafeRegistryDocument(checked.data);
	assertRegistryIdentityPolicy(checked.data);
	if (text !== canonicalModelPresetRegistryJson(checked.data))
		throw new Error(`${description} is not canonical JSON.`);
	return checked.data;
}

function compareSemver(left: string, right: string): number {
	const a = left.split(".").map(Number);
	const b = right.split(".").map(Number);
	for (let index = 0; index < 3; index++) {
		if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
	}
	return 0;
}

function assertCompatible(compatibility: z.infer<typeof CompatibilitySchema>): void {
	const { minVersion, maxVersion } = compatibility.consumerContract;
	if (compareSemver(minVersion, maxVersion) > 0) throw new Error("Registry compatibility bounds are inverted.");
	if (
		compareSemver(MODEL_PRESET_REGISTRY_CONTRACT_VERSION, minVersion) < 0 ||
		compareSemver(MODEL_PRESET_REGISTRY_CONTRACT_VERSION, maxVersion) > 0
	)
		throw new Error("Registry manifest is incompatible with this GJC preset contract.");
}

function verifyManifest(
	manifest: ModelPresetRegistryManifest,
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey>,
	allowRevoked = false,
): void {
	assertCompatible(manifest.signed.compatibility);
	if (manifest.signed.revision !== String(manifest.signed.registryRevision).padStart(8, "0"))
		throw new Error("Registry revision identity is inconsistent.");
	const key = trustedKeys.get(manifest.signature.keyId);
	if (!key || key.keyId !== manifest.signature.keyId)
		throw new Error(`Registry signature key id is not trusted: ${manifest.signature.keyId}.`);
	const publishedAt = Date.parse(manifest.signed.publishedAt);
	if (!Number.isFinite(publishedAt) || publishedAt < Date.parse(key.validFrom))
		throw new Error("Registry manifest predates its signing key validity.");
	if (key.revokedAt && !allowRevoked) throw new Error("Registry manifest signing key is revoked.");
	const signature = decodeCanonicalEd25519Signature(manifest.signature.value);
	if (
		!crypto.verify(null, Buffer.from(canonicalModelPresetRegistryJson(manifest.signed)), key.publicKeyPem, signature)
	)
		throw new Error("Registry manifest signature verification failed.");
}

function assertDescriptorRevision(descriptor: z.infer<typeof DescriptorSchema>, revision: string): void {
	if (!descriptor.path.startsWith(`revisions/${revision}/`))
		throw new Error("Registry descriptor path does not match its revision.");
}

function assertManifestBindings(manifest: ModelPresetRegistryManifest): void {
	for (const descriptor of [
		manifest.signed.snapshot,
		manifest.signed.contents.profiles,
		manifest.signed.contents.presets,
	])
		assertDescriptorRevision(descriptor, manifest.signed.revision);
}

function assertSnapshotBindings(manifest: ModelPresetRegistryManifest, snapshot: ModelPresetRegistrySnapshot): void {
	if (
		snapshot.registryRevision !== manifest.signed.registryRevision ||
		snapshot.revision !== manifest.signed.revision ||
		canonicalModelPresetRegistryJson(snapshot.compatibility) !==
			canonicalModelPresetRegistryJson(manifest.signed.compatibility) ||
		canonicalModelPresetRegistryJson(snapshot.provenance) !==
			canonicalModelPresetRegistryJson(manifest.signed.provenance) ||
		canonicalModelPresetRegistryJson(snapshot.contents) !== canonicalModelPresetRegistryJson(manifest.signed.contents)
	)
		throw new Error("Registry snapshot does not match the signed manifest.");
}

function assertContentDescriptor(
	bytes: Uint8Array,
	descriptor: z.infer<typeof DescriptorSchema>,
	description: string,
): void {
	if (bytes.byteLength !== descriptor.bytes) throw new Error(`${description} size mismatch.`);
	if (sha256(bytes) !== descriptor.sha256) throw new Error(`${description} digest mismatch.`);
}

function selectorIdentityCandidates(selector: string): string[] {
	const suffix = splitSelectorThinkingSuffix(selector);
	return suffix.thinkingLevel === undefined ? [selector] : [selector, suffix.selector];
}

function assertProfilePresetReferences(
	profiles: ModelPresetRegistryProfiles,
	presets: ModelPresetRegistryPresets,
): void {
	const exact = new Set(presets.presets.map(preset => `${preset.provider}/${preset.id}`));
	const bare = new Set(presets.presets.map(preset => preset.id));
	const dynamic = new Set(profiles.dynamicProviders);
	for (const profile of profiles.profiles) {
		for (const binding of Object.values(profile.roleBindings)) {
			for (const selector of Array.isArray(binding) ? binding : [binding]) {
				const identities = selectorIdentityCandidates(selector);
				const exactMatch = identities.find(identity => exact.has(identity));
				if (exactMatch) continue;
				const dynamicMatch = identities.find(identity => {
					const slash = identity.indexOf("/");
					return slash >= 0 && dynamic.has(identity.slice(0, slash));
				});
				if (dynamicMatch) continue;
				if (!identities.some(identity => bare.has(identity)))
					throw new Error(`Registry profile ${profile.id} references an unknown model alias.`);
			}
		}
	}
}

function validateGenerationUncached(
	generation: AcceptedGeneration,
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey>,
	allowRevoked: boolean,
): void {
	const { manifest, snapshot, profiles, presets } = generation;
	assertSafeRegistryDocument(manifest);
	verifyManifest(manifest, trustedKeys, allowRevoked);
	assertManifestBindings(manifest);
	const snapshotBytes = new TextEncoder().encode(canonicalModelPresetRegistryJson(snapshot));
	assertContentDescriptor(snapshotBytes, manifest.signed.snapshot, "Cached registry snapshot");
	assertSafeRegistryDocument(snapshot);
	assertSnapshotBindings(manifest, snapshot);
	const profileBytes = new TextEncoder().encode(canonicalModelPresetRegistryJson(profiles));
	assertContentDescriptor(profileBytes, manifest.signed.contents.profiles, "Cached registry profiles");
	assertSafeRegistryDocument(profiles);
	assertRegistryIdentityPolicy(profiles);
	if (
		profiles.revision !== manifest.signed.revision ||
		profiles.profiles.length !== manifest.signed.contents.profiles.count
	)
		throw new Error("Cached registry profile identity is invalid.");
	const presetBytes = new TextEncoder().encode(canonicalModelPresetRegistryJson(presets));
	assertContentDescriptor(presetBytes, manifest.signed.contents.presets, "Cached registry presets");
	assertSafeRegistryDocument(presets);
	assertRegistryIdentityPolicy(presets);
	if (
		presets.revision !== manifest.signed.revision ||
		presets.presets.length !== manifest.signed.contents.presets.count
	)
		throw new Error("Cached registry preset identity is invalid.");
	assertProfilePresetReferences(profiles, presets);
	if (sha256(canonicalModelPresetRegistryJson(manifest)) !== generation.manifestSha256)
		throw new Error("Cached registry manifest digest is invalid.");
	assertSafeRegistryDocument(generation.retainedProfiles);
	assertSafeRegistryDocument(generation.retainedPresets);
	assertSafeRegistryDocument(generation.retainedDynamicProviders);
	const effectiveProfiles: ModelPresetRegistryProfiles = {
		...profiles,
		dynamicProviders: [...generation.retainedDynamicProviders, ...profiles.dynamicProviders],
		profiles: [...generation.retainedProfiles, ...profiles.profiles],
	};
	const effectivePresets: ModelPresetRegistryPresets = {
		...presets,
		presets: [...generation.retainedPresets, ...presets.presets],
	};
	assertRegistryIdentityPolicy(effectiveProfiles);
	assertRegistryIdentityPolicy(effectivePresets);
	assertProfilePresetReferences(effectiveProfiles, effectivePresets);
}

/**
 * Signature and binding verification is a pure function of the generation, the
 * trusted key set, and the revocation allowance, and one accepted-registry read
 * verifies the same generation objects from several recovery angles. The memo
 * records both outcomes per (generation, keys, allowance) so a startup read
 * verifies each cached generation exactly once instead of once per angle.
 */
type GenerationValidationOutcome = { ok: true } | { ok: false; error: unknown };

const generationValidationCache = new WeakMap<
	AcceptedGeneration,
	WeakMap<ReadonlyMap<string, ModelPresetRegistryTrustedKey>, Map<boolean, GenerationValidationOutcome>>
>();

/**
 * Every caller supplies a generation whose documents were already schema-parsed
 * (cache reads through `parseState`, refresh through `parseCanonicalDocument`),
 * so this asserts the cryptographic and structural bindings and returns the
 * input rather than re-deriving an identical parse.
 */
function validateGeneration(
	generation: AcceptedGeneration,
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey>,
	allowRevoked = false,
): AcceptedGeneration {
	let byKeys = generationValidationCache.get(generation);
	if (!byKeys) {
		byKeys = new WeakMap();
		generationValidationCache.set(generation, byKeys);
	}
	let byAllowance = byKeys.get(trustedKeys);
	if (!byAllowance) {
		byAllowance = new Map();
		byKeys.set(trustedKeys, byAllowance);
	}
	const memoized = byAllowance.get(allowRevoked);
	if (memoized) {
		if (!memoized.ok) throw memoized.error;
		return generation;
	}
	try {
		validateGenerationUncached(generation, trustedKeys, allowRevoked);
	} catch (error) {
		byAllowance.set(allowRevoked, { ok: false, error });
		throw error;
	}
	byAllowance.set(allowRevoked, { ok: true });
	return generation;
}

function readJsonSync(file: string): unknown | undefined {
	try {
		const stat = fsSync.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Registry cache path is not a regular file.");
		if (stat.size > MODEL_PRESET_REGISTRY_MAX_STATE_BYTES) throw new Error("Registry cache is oversized.");
		return JSON.parse(fsSync.readFileSync(file, "utf8"));
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/**
 * Async cache reads for callers that already have an async lifecycle boundary.
 * Keep the synchronous reader above for legacy startup paths until their
 * constructor-wide migration can be completed without changing public APIs.
 */
async function readJsonBun(file: string): Promise<unknown | undefined> {
	try {
		const stat = await fs.lstat(file, { bigint: true });
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Registry cache path is not a regular file.");
		if (stat.size > BigInt(MODEL_PRESET_REGISTRY_MAX_STATE_BYTES)) throw new Error("Registry cache is oversized.");
		return JSON.parse(await Bun.file(file).text());
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function parseState(value: unknown): RegistryState {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Registry cache state is invalid.");
	const state = value as Partial<RegistryState>;
	if (state.version !== 1 || !Array.isArray(state.history))
		throw new Error("Registry cache state version is invalid.");
	for (const field of ["activeRevision", "highestSeenRevision"] as const) {
		const entry = state[field];
		if (entry !== undefined && (!Number.isSafeInteger(entry) || entry <= 0))
			throw new Error(`Registry cache ${field} is invalid.`);
	}
	if (state.highestSeenManifestSha256 !== undefined && !SHA256_PATTERN.test(state.highestSeenManifestSha256))
		throw new Error("Registry cache highest manifest digest is invalid.");
	if (state.lastCheckedAt !== undefined && !Number.isFinite(Date.parse(state.lastCheckedAt)))
		throw new Error("Registry cache check timestamp is invalid.");
	if (state.lastError !== undefined && typeof state.lastError !== "string")
		throw new Error("Registry cache error state is invalid.");
	const lastError = state.lastError === undefined ? undefined : safeError(state.lastError);
	const history = state.history.map((entry, index): AcceptedGeneration => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			throw new Error(`Registry cache generation ${index} is invalid.`);
		const generation = entry as Partial<AcceptedGeneration>;
		const manifest = ModelPresetRegistryManifestSchema.safeParse(generation.manifest);
		const snapshot = ModelPresetRegistrySnapshotSchema.safeParse(generation.snapshot);
		const profiles = ModelPresetRegistryProfilesSchema.safeParse(generation.profiles);
		const presets = ModelPresetRegistryPresetsSchema.safeParse(generation.presets);
		const retainedProfiles = z.array(RegistryProfileSchema).max(4096).safeParse(generation.retainedProfiles);
		const retainedPresets = z.array(RegistryPresetSchema).max(100_000).safeParse(generation.retainedPresets);
		const retainedDynamicProviders = z
			.array(z.string().min(1).max(128).regex(PROFILE_ID_PATTERN))
			.max(128)
			.refine(values => new Set(values).size === values.length)
			.safeParse(generation.retainedDynamicProviders);
		const retainedFromRevision = generation.retainedFromRevision;
		let manifestUrl: string | undefined;
		if (generation.manifestUrl !== undefined) {
			if (typeof generation.manifestUrl !== "string")
				throw new Error(`Registry cache generation ${index} is invalid.`);
			try {
				const parsed = new URL(generation.manifestUrl);
				if (
					parsed.protocol !== "https:" ||
					parsed.username ||
					parsed.password ||
					parsed.search ||
					parsed.hash ||
					parsed.href !== generation.manifestUrl
				)
					throw new Error();
				manifestUrl = parsed.href;
			} catch {
				throw new Error(`Registry cache generation ${index} is invalid.`);
			}
		}
		if (
			!manifest.success ||
			!snapshot.success ||
			!profiles.success ||
			!presets.success ||
			!retainedProfiles.success ||
			!retainedPresets.success ||
			!retainedDynamicProviders.success ||
			(retainedFromRevision !== undefined &&
				(!Number.isSafeInteger(retainedFromRevision) || retainedFromRevision <= 0)) ||
			typeof generation.manifestSha256 !== "string" ||
			!SHA256_PATTERN.test(generation.manifestSha256) ||
			typeof generation.acceptedAt !== "string" ||
			!Number.isFinite(Date.parse(generation.acceptedAt)) ||
			(generation.etag !== undefined && typeof generation.etag !== "string") ||
			(generation.manifestOrigin !== undefined &&
				(typeof generation.manifestOrigin !== "string" ||
					!generation.manifestOrigin.startsWith("https://") ||
					new URL(generation.manifestOrigin).origin !== generation.manifestOrigin)) ||
			(generation.revoked !== undefined && typeof generation.revoked !== "boolean")
		)
			throw new Error(`Registry cache generation ${index} is invalid.`);
		return {
			manifest: manifest.data,
			snapshot: snapshot.data,
			profiles: profiles.data,
			presets: presets.data,
			manifestSha256: generation.manifestSha256,
			acceptedAt: generation.acceptedAt,
			etag: generation.etag,
			manifestUrl,
			manifestOrigin: generation.manifestOrigin,
			retainedProfiles: retainedProfiles.data,
			retainedPresets: retainedPresets.data,
			retainedDynamicProviders: retainedDynamicProviders.data,
			retainedFromRevision,
			revoked: generation.revoked === true,
		};
	});
	return { ...state, version: 1, history, lastError };
}

type ParsedRegistryState = {
	present: boolean;
	state?: RegistryState;
	error?: unknown;
};

type RegistryStateEvidence = {
	state: RegistryState;
	fullyVerified: boolean;
	verifiedGenerations: AcceptedGeneration[];
	allGenerationsVerified: boolean;
	duplicateRevision: boolean;
	maxUnverifiedRevision?: number;
	activeRevision?: number;
	floor?: { revision: number; manifestSha256: string };
	unverifiedCheckpointRevision?: number;
	resetShaped: boolean;
};

type RegistryStateRecovery = {
	state: RegistryState;
	stateIsVerified: boolean;
	highestSeenRevision?: number;
	highestSeenManifestSha256?: string;
	hadInvalidCopy: boolean;
	firstRun: boolean;
};

function readParsedStateSync(file: string): ParsedRegistryState {
	try {
		const value = readJsonSync(file);
		if (value === undefined) return { present: false };
		return { present: true, state: parseState(value) };
	} catch (error) {
		return { present: true, error };
	}
}

function isResetShapedState(state: RegistryState): boolean {
	return state.history.length === 0 && state.activeRevision === undefined && state.highestSeenRevision === undefined;
}

function verifyGenerationForRecovery(
	generation: AcceptedGeneration,
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey>,
): AcceptedGeneration | undefined {
	try {
		return validateGeneration(generation, trustedKeys);
	} catch {
		try {
			const verified = validateGeneration(generation, trustedKeys, true);
			return { ...verified, revoked: true };
		} catch {
			return undefined;
		}
	}
}

function verifyManifestCheckpointForRecovery(
	generation: AcceptedGeneration,
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey>,
): boolean {
	try {
		const manifest = ModelPresetRegistryManifestSchema.parse(generation.manifest);
		assertSafeRegistryDocument(manifest);
		verifyManifest(manifest, trustedKeys, true);
		assertManifestBindings(manifest);
		return sha256(canonicalModelPresetRegistryJson(manifest)) === generation.manifestSha256;
	} catch {
		return false;
	}
}

function inspectStateEvidence(
	parsed: ParsedRegistryState,
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey>,
): RegistryStateEvidence | undefined {
	if (!parsed.state) return undefined;
	const state = parsed.state;
	let fullyVerified = true;
	try {
		validateStateGenerations(state, trustedKeys);
	} catch {
		fullyVerified = false;
	}
	const verifiedGenerations = state.history
		.map(generation => verifyGenerationForRecovery(generation, trustedKeys))
		.filter((generation): generation is AcceptedGeneration => generation !== undefined);
	const verifiedRevisionSet = new Set<number>();
	let duplicateRevision = false;
	for (const generation of state.history) {
		const revision = generation.manifest.signed.registryRevision;
		if (verifiedRevisionSet.has(revision)) duplicateRevision = true;
		verifiedRevisionSet.add(revision);
	}
	const verifiedGenerationRevisions = new Set(
		verifiedGenerations.map(generation => generation.manifest.signed.registryRevision),
	);
	const maxUnverifiedRevision = state.history
		.map(generation => generation.manifest.signed.registryRevision)
		.filter(revision => !verifiedGenerationRevisions.has(revision))
		.sort((left, right) => right - left)[0];
	const verifiedByRevision = new Map(
		verifiedGenerations.map(generation => [generation.manifest.signed.registryRevision, generation]),
	);
	const activeGeneration =
		state.activeRevision === undefined ? undefined : verifiedByRevision.get(state.activeRevision);
	const activeRevision = activeGeneration && !activeGeneration.revoked ? state.activeRevision : undefined;
	let floor: RegistryStateEvidence["floor"];
	let unverifiedCheckpointRevision: number | undefined;
	if (state.highestSeenRevision !== undefined && state.highestSeenManifestSha256 !== undefined) {
		const checkpoint = verifiedByRevision.get(state.highestSeenRevision);
		if (checkpoint?.manifestSha256 === state.highestSeenManifestSha256)
			floor = { revision: state.highestSeenRevision, manifestSha256: state.highestSeenManifestSha256 };
		else {
			const checkpointCandidate = state.history.find(
				generation => generation.manifest.signed.registryRevision === state.highestSeenRevision,
			);
			if (
				checkpointCandidate?.manifestSha256 === state.highestSeenManifestSha256 &&
				verifyManifestCheckpointForRecovery(checkpointCandidate, trustedKeys)
			)
				floor = { revision: state.highestSeenRevision, manifestSha256: state.highestSeenManifestSha256 };
			else if (checkpointCandidate) unverifiedCheckpointRevision = state.highestSeenRevision;
		}
	}
	for (const generation of verifiedGenerations) {
		const revision = generation.manifest.signed.registryRevision;
		if (!floor || revision > floor.revision) floor = { revision, manifestSha256: generation.manifestSha256 };
	}
	return {
		state,
		fullyVerified,
		verifiedGenerations,
		allGenerationsVerified: verifiedGenerations.length === state.history.length,
		duplicateRevision,
		maxUnverifiedRevision,
		activeRevision,
		floor,
		unverifiedCheckpointRevision,
		resetShaped: isResetShapedState(state),
	};
}

function recoverStateCopiesSync(
	agentDir: string,
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey>,
	options: { allowInvalidPrimaryFallback?: boolean; allowUnreadablePrimaryFallback?: boolean } = {},
): RegistryStateRecovery {
	const paths = registryPaths(agentDir);
	const primary = readParsedStateSync(paths.state);
	const backup = readParsedStateSync(paths.backup);
	if (!primary.present && !backup.present)
		return { state: { version: 1, history: [] }, stateIsVerified: true, hadInvalidCopy: false, firstRun: true };
	const primaryEvidence = inspectStateEvidence(primary, trustedKeys);
	const backupEvidence = inspectStateEvidence(backup, trustedKeys);
	if (primary.error !== undefined && !options.allowUnreadablePrimaryFallback)
		throw new Error("Registry primary cache state is unreadable.");
	if (
		primaryEvidence &&
		!primaryEvidence.resetShaped &&
		(!primaryEvidence.allGenerationsVerified || primaryEvidence.duplicateRevision)
	)
		if (!options.allowInvalidPrimaryFallback || !backupEvidence?.fullyVerified) {
			validateStateGenerations(primaryEvidence.state, trustedKeys);
		}
	if (
		backupEvidence &&
		(!backupEvidence.allGenerationsVerified || backupEvidence.duplicateRevision) &&
		(!primaryEvidence?.fullyVerified || primaryEvidence.resetShaped)
	)
		throw new Error("Registry backup cache contains an unverifiable accepted generation.");
	const evidences = [primaryEvidence, backupEvidence].filter(
		(evidence): evidence is RegistryStateEvidence => evidence !== undefined,
	);
	const byRevision = new Map<number, AcceptedGeneration>();
	for (const evidence of evidences) {
		for (const generation of evidence.verifiedGenerations) {
			const revision = generation.manifest.signed.registryRevision;
			const existing = byRevision.get(revision);
			if (existing && existing.manifestSha256 !== generation.manifestSha256)
				throw new Error(`Registry cache contains conflicting verified revision ${revision}.`);
			if (!existing || (generation.revoked && !existing.revoked)) byRevision.set(revision, generation);
		}
	}
	const floors = evidences.flatMap(evidence => (evidence.floor ? [evidence.floor] : []));
	const floor = floors.sort((left, right) => right.revision - left.revision)[0];
	if (
		primaryEvidence?.unverifiedCheckpointRevision !== undefined &&
		(primaryEvidence.unverifiedCheckpointRevision > (floor?.revision ?? 0) || floor === undefined)
	)
		throw new Error("Registry primary cache anti-rollback checkpoint is unverifiable.");
	if (
		primaryEvidence?.maxUnverifiedRevision !== undefined &&
		(primaryEvidence.maxUnverifiedRevision > (floor?.revision ?? 0) || floor === undefined)
	)
		throw new Error("Registry primary cache contains a revision without a verified checkpoint.");
	const primaryUsable =
		primaryEvidence !== undefined &&
		(!primaryEvidence.resetShaped
			? backupEvidence === undefined || primaryEvidence.fullyVerified
			: backupEvidence === undefined);
	const preferred = primaryUsable
		? primaryEvidence
		: options.allowInvalidPrimaryFallback && backupEvidence?.fullyVerified
			? backupEvidence
			: primaryEvidence && primary.error === undefined
				? primaryEvidence
				: (backupEvidence ?? primaryEvidence);
	const activeRevision =
		preferred?.activeRevision !== undefined && byRevision.has(preferred.activeRevision)
			? preferred.activeRevision
			: undefined;
	const history = [...byRevision.values()].sort(
		(left, right) => right.manifest.signed.registryRevision - left.manifest.signed.registryRevision,
	);
	const hadInvalidCopy =
		(primary.present && (primary.error !== undefined || primaryEvidence?.fullyVerified !== true)) ||
		(backup.present && (backup.error !== undefined || backupEvidence?.fullyVerified !== true));
	const firstRun =
		!hadInvalidCopy &&
		evidences.length > 0 &&
		evidences.every(evidence => evidence.resetShaped) &&
		floor === undefined;
	if (floor === undefined && !firstRun)
		throw new Error("Registry cache anti-rollback checkpoint cannot be reconstructed.");
	const recovered: RegistryState = {
		...(preferred?.state ?? {}),
		version: 1,
		activeRevision,
		highestSeenRevision: floor?.revision,
		highestSeenManifestSha256: floor?.manifestSha256,
		history,
		lastCheckedAt: preferred?.state.lastCheckedAt,
		lastError: preferred?.state.lastError,
	};
	try {
		validateStateGenerations(recovered, trustedKeys);
	} catch (error) {
		if (!preferred?.fullyVerified) throw error;
		if (
			preferred.state.highestSeenRevision !== undefined &&
			floor !== undefined &&
			preferred.state.highestSeenRevision >= floor.revision
		)
			return {
				state: preferred.state,
				stateIsVerified: true,
				highestSeenRevision: preferred.state.highestSeenRevision,
				highestSeenManifestSha256: preferred.state.highestSeenManifestSha256,
				hadInvalidCopy,
				firstRun: false,
			};
		throw error;
	}
	return {
		state: recovered,
		stateIsVerified: true,
		highestSeenRevision: floor?.revision,
		highestSeenManifestSha256: floor?.manifestSha256,
		hadInvalidCopy,
		firstRun,
	};
}

function loadControlSync(agentDir: string): RegistryControl {
	const value = readJsonSync(registryPaths(agentDir).control);
	if (value === undefined) return { version: 1, disabled: false };
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Registry control state is invalid.");
	const control = value as Partial<RegistryControl>;
	if (control.version !== 1 || typeof control.disabled !== "boolean")
		throw new Error("Registry control version is invalid.");
	if (
		control.pinnedRevision !== undefined &&
		(!Number.isSafeInteger(control.pinnedRevision) || control.pinnedRevision <= 0)
	)
		throw new Error("Registry pin is invalid.");
	return { version: 1, disabled: control.disabled, pinnedRevision: control.pinnedRevision };
}

async function loadControlBun(agentDir: string): Promise<RegistryControl> {
	const value = await readJsonBun(registryPaths(agentDir).control);
	if (value === undefined) return { version: 1, disabled: false };
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Registry control state is invalid.");
	const control = value as Partial<RegistryControl>;
	if (control.version !== 1 || typeof control.disabled !== "boolean")
		throw new Error("Registry control version is invalid.");
	if (
		control.pinnedRevision !== undefined &&
		(!Number.isSafeInteger(control.pinnedRevision) || control.pinnedRevision <= 0)
	)
		throw new Error("Registry pin is invalid.");
	return { version: 1, disabled: control.disabled, pinnedRevision: control.pinnedRevision };
}

async function syncDirectory(directory: string): Promise<void> {
	// Windows does not expose a directory fsync barrier through Bun/Node. The
	// temporary file is still synced before atomic rename; only persistence of
	// the renamed directory entry across sudden power loss is weaker there.
	if (process.platform === "win32") return;
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function exactFileIdentity(file: string): Promise<NativeExactFileIdentity> {
	const [bytes, stat, parent] = await Promise.all([
		fs.readFile(file),
		fs.lstat(file, { bigint: true }),
		fs.lstat(path.dirname(file), { bigint: true }),
	]);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
		throw new Error("Registry cache replacement requires a stable single-link regular file.");
	return {
		dev: stat.dev,
		ino: stat.ino,
		nlink: stat.nlink,
		parentDev: parent.dev,
		parentIno: parent.ino,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
		sha256: sha256(bytes),
	};
}

async function writeAtomicJson(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const serialized = `${JSON.stringify(value)}\n`;
	if (path.basename(file) === "state.json" && serializedJsonByteLength(value) > MODEL_PRESET_REGISTRY_MAX_STATE_BYTES)
		throw new Error("Registry cache state exceeds its durable size limit.");
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	const handle = await fs.open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(serialized, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		if (process.platform === "win32") {
			let destinationExists = true;
			try {
				await fs.lstat(file);
			} catch (error) {
				if (!isEnoent(error)) throw error;
				destinationExists = false;
			}
			if (destinationExists) {
				const [sourceIdentity, destinationIdentity] = await Promise.all([
					exactFileIdentity(temporary),
					exactFileIdentity(file),
				]);
				const replaced = exactReplacePathNative(temporary, file, sourceIdentity, destinationIdentity);
				if (!replaced.ok)
					throw new Error(`Native Windows registry cache replacement failed: ${replaced.code ?? "unknown"}.`);
			} else {
				await fs.rename(temporary, file);
			}
		} else await fs.rename(temporary, file);
		await syncDirectory(path.dirname(file));
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

function effectiveAgentDir(dependencies: ModelPresetRegistryDependencies): string {
	return dependencies.agentDir ?? getAgentDir();
}
function effectiveTrustedKeys(
	dependencies: ModelPresetRegistryDependencies,
	agentDir = effectiveAgentDir(dependencies),
) {
	return getModelPresetRegistryTestTrustedKeys(agentDir) ?? MODEL_PRESET_REGISTRY_TRUSTED_KEYS;
}
function effectiveManifestUrl(dependencies: ModelPresetRegistryDependencies): string {
	return dependencies.manifestUrl ?? process.env.GJC_MODEL_PRESET_REGISTRY_URL ?? DEFAULT_MODEL_PRESET_REGISTRY_URL;
}
function environmentDisabled(): boolean {
	return /^(?:1|true|yes|on)$/i.test(process.env.GJC_MODEL_PRESET_REGISTRY_DISABLED ?? "");
}
function assertHttpsUrl(raw: string, description: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${description} is invalid.`);
	}
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
		throw new Error(`${description} must use credential-free HTTPS.`);
	return url;
}
function assertRegistryUrl(url: URL, manifestUrl: URL, allowTestUrls: boolean): void {
	if (allowTestUrls || manifestUrl.href !== DEFAULT_MODEL_PRESET_REGISTRY_URL) {
		if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
			throw new Error("Registry content URL must use credential-free HTTPS.");
		if (url.origin !== manifestUrl.origin) throw new Error("Registry content URL changed origin.");
		return;
	}
	if (
		url.hostname !== "raw.githubusercontent.com" ||
		url.port ||
		url.search ||
		url.hash ||
		!url.pathname.startsWith(REGISTRY_RAW_PATH_PREFIX) ||
		url.origin !== manifestUrl.origin
	)
		throw new Error("Registry content URL is outside the approved immutable registry namespace.");
}
function descriptorUrl(descriptor: z.infer<typeof DescriptorSchema>, manifestUrl: URL, allowTestUrls: boolean): URL {
	const url = new URL(descriptor.path, manifestUrl);
	assertRegistryUrl(url, manifestUrl, allowTestUrls);
	return url;
}

function generationProfiles(generation: AcceptedGeneration): Map<string, ModelProfileDefinition> {
	const definitions = [...generation.retainedProfiles, ...generation.profiles.profiles];
	return new Map(
		definitions.map(profile => [
			profile.id,
			{
				name: profile.id,
				displayName: profile.displayName,
				providerGroup: profile.providerGroup,
				requiredProviders: [...profile.requiredProviders],
				alternativeProviderGroups: profile.alternativeProviderGroups?.map(group => [...group]),
				modelMapping: { ...profile.roleBindings } as Partial<Record<ModelProfileRole, string | string[]>>,
				source: "registry" as const,
			},
		]),
	);
}
function generationPresets(generation: AcceptedGeneration): Model<Api>[] {
	return [...generation.retainedPresets, ...generation.presets.presets].map(preset => ({ ...preset }) as Model<Api>);
}

function acceptedRegistryFromState(
	agentDir: string,
	dependencies: Omit<ModelPresetRegistryDependencies, "agentDir">,
	control: RegistryControl,
	state: RegistryState,
): AcceptedModelPresetRegistry {
	state = recoverStateForRead(state, effectiveTrustedKeys(dependencies, agentDir));
	const pinnedGeneration =
		control.pinnedRevision === undefined
			? undefined
			: state.history.find(item => item.manifest.signed.registryRevision === control.pinnedRevision);
	const staleControlPin =
		control.pinnedRevision !== undefined && (pinnedGeneration === undefined || pinnedGeneration.revoked === true);
	const revision = staleControlPin ? state.activeRevision : (control.pinnedRevision ?? state.activeRevision);
	const generation = state.history.find(item => item.manifest.signed.registryRevision === revision);
	if (revision !== undefined && !generation)
		throw new Error(`Registry selected revision ${revision} is missing from accepted history.`);
	if (!generation)
		return {
			profiles: new Map(),
			presets: [],
			dynamicProviders: [],
			retainedProfiles: [],
			retainedPresets: [],
			disabled: false,
			pinnedRevision: staleControlPin ? undefined : control.pinnedRevision,
		};
	const valid = validateGeneration(generation, effectiveTrustedKeys(dependencies, agentDir));
	return {
		profiles: generationProfiles(valid),
		presets: generationPresets(valid),
		dynamicProviders: [...new Set([...valid.retainedDynamicProviders, ...valid.profiles.dynamicProviders])],
		revision: valid.manifest.signed.registryRevision,
		revisionId: valid.manifest.signed.revision,
		manifestSha256: valid.manifestSha256,
		keyId: valid.manifest.signature.keyId,
		sourceRevision: valid.manifest.signed.provenance.sourceRevision,
		retainedProfiles: valid.retainedProfiles.map(profile => profile.id),
		retainedPresets: valid.retainedPresets.map(preset => `${preset.provider}/${preset.id}`),
		disabled: false,
		pinnedRevision: staleControlPin ? undefined : control.pinnedRevision,
	};
}

/**
 * Accepted-registry reads are pure over the on-disk state, backup, and control
 * files, and a single launch resolves the registry from several subsystems.
 * The memo keys on the content digest of those inputs, so any byte change from
 * any writer (refresh, rollback, pin, tampering) is re-verified from scratch
 * while an unchanged launch pays the verification cost once. Digesting the
 * inputs is bounded by their size cap and stays far below the signature,
 * schema, and canonical-form work it replaces.
 */
const acceptedRegistryReadCache = new Map<string, { fingerprint: string; value: AcceptedModelPresetRegistry }>();

function cloneAcceptedModelPresetRegistry(value: AcceptedModelPresetRegistry): AcceptedModelPresetRegistry {
	return {
		...value,
		profiles: new Map(
			[...value.profiles].map(([id, profile]) => [id, structuredClone(profile)] as [string, ModelProfileDefinition]),
		),
		presets: structuredClone(value.presets),
		dynamicProviders: [...value.dynamicProviders],
		retainedProfiles: [...value.retainedProfiles],
		retainedPresets: [...value.retainedPresets],
	};
}

function registryFileFingerprint(file: string): string {
	try {
		return sha256(fsSync.readFileSync(file));
	} catch {
		return "absent";
	}
}

function acceptedRegistryFingerprint(
	agentDir: string,
	dependencies: Omit<ModelPresetRegistryDependencies, "agentDir">,
): string {
	const paths = registryPaths(agentDir);
	return [
		refreshDependencyId(effectiveTrustedKeys(dependencies, agentDir) as object),
		...[paths.state, paths.backup, paths.control].map(registryFileFingerprint),
	].join("|");
}

async function registryFileFingerprintAsync(file: string): Promise<string> {
	try {
		return sha256(new Uint8Array(await Bun.file(file).arrayBuffer()));
	} catch {
		return "absent";
	}
}

async function acceptedRegistryFingerprintAsync(
	agentDir: string,
	dependencies: Omit<ModelPresetRegistryDependencies, "agentDir">,
): Promise<string> {
	const paths = registryPaths(agentDir);
	const files = await Promise.all(
		[paths.state, paths.backup, paths.control].map(file => registryFileFingerprintAsync(file)),
	);
	return [refreshDependencyId(effectiveTrustedKeys(dependencies, agentDir) as object), ...files].join("|");
}

/** Only the dependency-free startup read is memoized; injected dependencies always recompute. */
function acceptedRegistryReadIsCacheable(dependencies: Omit<ModelPresetRegistryDependencies, "agentDir">): boolean {
	return Object.keys(dependencies).length === 0;
}

export function loadAcceptedModelPresetRegistry(
	agentDir = getAgentDir(),
	dependencies: Omit<ModelPresetRegistryDependencies, "agentDir"> = {},
): AcceptedModelPresetRegistry {
	if (!acceptedRegistryReadIsCacheable(dependencies) || environmentDisabled())
		return loadAcceptedModelPresetRegistryUncached(agentDir, dependencies);
	const fingerprint = acceptedRegistryFingerprint(agentDir, dependencies);
	const cached = acceptedRegistryReadCache.get(agentDir);
	if (cached && cached.fingerprint === fingerprint) return cloneAcceptedModelPresetRegistry(cached.value);
	const value = loadAcceptedModelPresetRegistryUncached(agentDir, dependencies);
	const verifiedFingerprint = acceptedRegistryFingerprint(agentDir, dependencies);
	if (verifiedFingerprint !== fingerprint) return loadAcceptedModelPresetRegistryUncached(agentDir, dependencies);
	acceptedRegistryReadCache.set(agentDir, { fingerprint, value });
	return cloneAcceptedModelPresetRegistry(value);
}

function loadAcceptedModelPresetRegistryUncached(
	agentDir: string,
	dependencies: Omit<ModelPresetRegistryDependencies, "agentDir">,
): AcceptedModelPresetRegistry {
	if (environmentDisabled())
		return {
			profiles: new Map(),
			presets: [],
			dynamicProviders: [],
			retainedProfiles: [],
			retainedPresets: [],
			disabled: true,
		};
	let control: RegistryControl;
	try {
		control = loadControlSync(agentDir);
	} catch (error) {
		return {
			profiles: new Map(),
			presets: [],
			dynamicProviders: [],
			retainedProfiles: [],
			retainedPresets: [],
			error: safeError(error),
			disabled: environmentDisabled(),
		};
	}
	const disabled = control.disabled || environmentDisabled();
	if (disabled)
		return {
			profiles: new Map(),
			presets: [],
			dynamicProviders: [],
			retainedProfiles: [],
			retainedPresets: [],
			disabled: true,
			pinnedRevision: control.pinnedRevision,
		};
	try {
		const recovery = recoverStateCopiesSync(agentDir, effectiveTrustedKeys(dependencies, agentDir));
		return acceptedRegistryFromState(agentDir, dependencies, control, recovery.state);
	} catch (error) {
		return {
			profiles: new Map(),
			presets: [],
			dynamicProviders: [],
			retainedProfiles: [],
			retainedPresets: [],
			error: safeError(error),
			disabled: false,
			pinnedRevision: control.pinnedRevision,
		};
	}
}

/**
 * Async accepted-registry loader for validation paths that can await disk I/O.
 * It mirrors the synchronous loader's fail-closed result contract while using
 * Bun file reads for state/control payloads.
 */
export async function loadAcceptedModelPresetRegistryAsync(
	agentDir = getAgentDir(),
	dependencies: Omit<ModelPresetRegistryDependencies, "agentDir"> = {},
): Promise<AcceptedModelPresetRegistry> {
	if (!acceptedRegistryReadIsCacheable(dependencies) || environmentDisabled())
		return loadAcceptedModelPresetRegistryAsyncUncached(agentDir, dependencies);
	const fingerprint = await acceptedRegistryFingerprintAsync(agentDir, dependencies);
	const cached = acceptedRegistryReadCache.get(agentDir);
	if (cached && cached.fingerprint === fingerprint) return cloneAcceptedModelPresetRegistry(cached.value);
	const value = await loadAcceptedModelPresetRegistryAsyncUncached(agentDir, dependencies);
	const verifiedFingerprint = await acceptedRegistryFingerprintAsync(agentDir, dependencies);
	if (verifiedFingerprint !== fingerprint) return loadAcceptedModelPresetRegistryAsyncUncached(agentDir, dependencies);
	acceptedRegistryReadCache.set(agentDir, { fingerprint, value });
	return cloneAcceptedModelPresetRegistry(value);
}

async function loadAcceptedModelPresetRegistryAsyncUncached(
	agentDir: string,
	dependencies: Omit<ModelPresetRegistryDependencies, "agentDir">,
): Promise<AcceptedModelPresetRegistry> {
	if (environmentDisabled())
		return {
			profiles: new Map(),
			presets: [],
			dynamicProviders: [],
			retainedProfiles: [],
			retainedPresets: [],
			disabled: true,
		};
	let control: RegistryControl;
	try {
		control = await loadControlBun(agentDir);
	} catch (error) {
		return {
			profiles: new Map(),
			presets: [],
			dynamicProviders: [],
			retainedProfiles: [],
			retainedPresets: [],
			error: safeError(error),
			disabled: environmentDisabled(),
		};
	}
	const disabled = control.disabled || environmentDisabled();
	if (disabled)
		return {
			profiles: new Map(),
			presets: [],
			dynamicProviders: [],
			retainedProfiles: [],
			retainedPresets: [],
			disabled: true,
			pinnedRevision: control.pinnedRevision,
		};
	try {
		const recovery = recoverStateCopiesSync(agentDir, effectiveTrustedKeys(dependencies, agentDir));
		return acceptedRegistryFromState(agentDir, dependencies, control, recovery.state);
	} catch (error) {
		return {
			profiles: new Map(),
			presets: [],
			dynamicProviders: [],
			retainedProfiles: [],
			retainedPresets: [],
			error: safeError(error),
			disabled: false,
			pinnedRevision: control.pinnedRevision,
		};
	}
}

export function loadAcceptedModelPresetProfiles(
	agentDir = getAgentDir(),
	dependencies: Omit<ModelPresetRegistryDependencies, "agentDir"> = {},
): AcceptedModelPresetRegistry {
	return loadAcceptedModelPresetRegistry(agentDir, dependencies);
}

export function loadEffectiveModelProfiles(
	userProfiles: ModelsConfig["profiles"] | undefined,
	agentDir = getAgentDir(),
	dependencies: Omit<ModelPresetRegistryDependencies, "agentDir"> = {},
): Map<string, ModelProfileDefinition> {
	const accepted = loadAcceptedModelPresetRegistry(agentDir, dependencies);
	return mergeModelProfiles(userProfiles, accepted.profiles);
}

async function readBoundedResponse(response: Response, maxBytes: number, description: string): Promise<Uint8Array> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null && Number(declaredLength) > maxBytes)
		throw new Error(`${description} exceeds the byte limit.`);
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error(`${description} exceeds the byte limit.`);
		}
		chunks.push(value);
	}
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

async function boundedFetch(
	url: URL,
	maxBytes: number,
	dependencies: ModelPresetRegistryDependencies,
	headers: Record<string, string> = {},
): Promise<{ response: Response; bytes?: Uint8Array }> {
	assertHttpsUrl(url.href, "Registry URL");
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new Error("Registry request timed out.")),
		dependencies.timeoutMs ?? MODEL_PRESET_REGISTRY_FETCH_TIMEOUT_MS,
	);
	try {
		const response = await (dependencies.fetch ?? fetch)(url.href, {
			method: "GET",
			headers,
			redirect: "error",
			credentials: "omit",
			signal: controller.signal,
		});
		if (response.url && assertHttpsUrl(response.url, "Registry response URL").href !== url.href)
			throw new Error("Registry response URL changed unexpectedly.");
		if (response.status === 304) return { response };
		if (!response.ok) throw new Error(`Registry request failed with HTTP ${response.status}.`);
		return { response, bytes: await readBoundedResponse(response, maxBytes, descriptionForUrl(url)) };
	} finally {
		clearTimeout(timeout);
	}
}
function descriptionForUrl(url: URL): string {
	return `Registry ${path.posix.basename(url.pathname) || "response"}`;
}

interface RetainedRegistryEntries {
	retainedProfiles: ModelPresetRegistryProfiles["profiles"];
	retainedPresets: ModelPresetRegistryPresets["presets"];
	retainedDynamicProviders: string[];
}

interface RegistryStateCandidate {
	retained: RetainedRegistryEntries;
	nextState: RegistryState;
}

function retainRemoved(
	previous: AcceptedGeneration | undefined,
	profiles: ModelPresetRegistryProfiles,
	presets: ModelPresetRegistryPresets,
): RetainedRegistryEntries {
	if (!previous) return { retainedProfiles: [], retainedPresets: [], retainedDynamicProviders: [] };
	const nextProfiles = new Set(profiles.profiles.map(profile => profile.id));
	const previousProfilesById = new Map(
		[...previous.retainedProfiles, ...previous.profiles.profiles].map(profile => [profile.id, profile]),
	);
	const nextProfilesById = new Map(profiles.profiles.map(profile => [profile.id, profile]));
	const retainedProfiles = [...previousProfilesById.values()].filter(profile => !nextProfiles.has(profile.id));
	const previousPresetSelectors = new Set(
		[...previous.retainedPresets, ...previous.presets.presets].flatMap(preset => [
			`${preset.provider}/${preset.id}`,
			preset.id,
		]),
	);
	const retainedSelectors = new Set<string>();
	const retainedSelectorProviders = new Set<string>();
	const profilesWhosePreviousSelectorsMustRemain = [
		...retainedProfiles,
		...previous.profiles.profiles.filter(profile => {
			const replacement = nextProfilesById.get(profile.id);
			return (
				replacement !== undefined &&
				canonicalModelPresetRegistryJson(replacement.roleBindings) !==
					canonicalModelPresetRegistryJson(profile.roleBindings)
			);
		}),
	];
	for (const profile of profilesWhosePreviousSelectorsMustRemain) {
		for (const binding of Object.values(profile.roleBindings)) {
			for (const selector of Array.isArray(binding) ? binding : [binding]) {
				const identities = selectorIdentityCandidates(selector);
				const retentionIdentities =
					identities.length === 2 && previousPresetSelectors.has(identities[0]!)
						? [identities[0]!]
						: [identities[identities.length - 1]!];
				for (const identity of retentionIdentities) {
					retainedSelectors.add(identity);
					const slash = identity.indexOf("/");
					if (slash >= 0) retainedSelectorProviders.add(identity.slice(0, slash));
				}
			}
		}
	}
	for (const preset of previous.retainedPresets) retainedSelectors.add(`${preset.provider}/${preset.id}`);
	const nextPresets = new Set(presets.presets.map(preset => `${preset.provider}\u0000${preset.id}`));
	const previousPresetsByKey = new Map(
		[...previous.retainedPresets, ...previous.presets.presets].map(preset => [
			`${preset.provider}\u0000${preset.id}`,
			preset,
		]),
	);
	return {
		retainedProfiles,
		retainedDynamicProviders: [
			...new Set([...previous.retainedDynamicProviders, ...previous.profiles.dynamicProviders]),
		].filter(provider => !profiles.dynamicProviders.includes(provider) && retainedSelectorProviders.has(provider)),
		retainedPresets: [...previousPresetsByKey.entries()]
			.filter(([key, preset]) => {
				if (nextPresets.has(key)) return false;
				return retainedSelectors.has(`${preset.provider}/${preset.id}`) || retainedSelectors.has(preset.id);
			})
			.map(([, preset]) => preset),
	};
}

function validateStateGenerations(
	state: RegistryState,
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey>,
): void {
	const byRevision = new Map<number, AcceptedGeneration>();
	for (const generation of state.history) {
		const revision = generation.manifest.signed.registryRevision;
		if (byRevision.has(revision)) throw new Error(`Registry history contains duplicate revision ${revision}.`);
		byRevision.set(revision, generation);
	}
	const highestHistoryRevision = [...byRevision.keys()].reduce((highest, revision) => Math.max(highest, revision), 0);
	if (state.activeRevision !== undefined && !byRevision.has(state.activeRevision))
		throw new Error(`Registry selected revision ${state.activeRevision} is missing from accepted history.`);
	if (state.activeRevision !== undefined && byRevision.get(state.activeRevision)?.revoked)
		throw new Error(`Registry selected revision ${state.activeRevision} is revoked.`);
	if (state.highestSeenRevision === undefined) {
		if (highestHistoryRevision > 0 || state.highestSeenManifestSha256 !== undefined)
			throw new Error("Registry highest-seen manifest checkpoint is incomplete.");
	} else {
		if (state.highestSeenManifestSha256 === undefined)
			throw new Error("Registry highest-seen manifest checkpoint is incomplete.");
		if (state.highestSeenRevision < highestHistoryRevision)
			throw new Error("Registry highest-seen revision is older than accepted history.");
		const checkpoint = byRevision.get(state.highestSeenRevision);
		if (!checkpoint || checkpoint.manifestSha256 !== state.highestSeenManifestSha256)
			throw new Error("Registry highest-seen manifest checkpoint is not bound to accepted history.");
	}
	const validated = new Set<number>();
	const visiting = new Set<number>();
	const visit = (generation: AcceptedGeneration, ancestryDepth = 0): void => {
		if (ancestryDepth > MODEL_PRESET_REGISTRY_MAX_RETENTION_ANCESTRY)
			throw new Error("Registry retained provenance ancestry exceeds its bound.");
		const revision = generation.manifest.signed.registryRevision;
		if (validated.has(revision)) return;
		if (visiting.has(revision)) throw new Error("Registry retained provenance contains a cycle.");
		visiting.add(revision);
		validateGeneration(generation, trustedKeys, generation.revoked === true);
		if (generation.revoked && !trustedKeys.get(generation.manifest.signature.keyId)?.revokedAt)
			throw new Error(`Registry revoked generation key is not revoked: ${generation.manifest.signature.keyId}.`);
		const hasRetained =
			generation.retainedProfiles.length > 0 ||
			generation.retainedPresets.length > 0 ||
			generation.retainedDynamicProviders.length > 0;
		if (hasRetained !== (generation.retainedFromRevision !== undefined))
			throw new Error("Registry retained provenance binding is invalid.");
		if (generation.retainedFromRevision !== undefined) {
			const source = byRevision.get(generation.retainedFromRevision);
			if (!source) throw new Error("Registry retained provenance source is missing.");
			if (source.manifest.signed.registryRevision >= revision)
				throw new Error("Registry retained provenance source is not older than its consumer.");
			visit(source, ancestryDepth + 1);
			const expected = retainRemoved(source, generation.profiles, generation.presets);
			if (
				canonicalModelPresetRegistryJson(expected.retainedProfiles) !==
					canonicalModelPresetRegistryJson(generation.retainedProfiles) ||
				canonicalModelPresetRegistryJson(expected.retainedPresets) !==
					canonicalModelPresetRegistryJson(generation.retainedPresets) ||
				canonicalModelPresetRegistryJson(expected.retainedDynamicProviders) !==
					canonicalModelPresetRegistryJson(generation.retainedDynamicProviders)
			)
				throw new Error("Registry retained provenance content is invalid.");
		}
		visiting.delete(revision);
		validated.add(revision);
	};
	for (const generation of state.history) visit(generation);
}

function retainedAncestryDepth(generation: AcceptedGeneration | undefined, state: RegistryState): number {
	if (!generation) return 0;
	const byRevision = new Map(state.history.map(candidate => [candidate.manifest.signed.registryRevision, candidate]));
	let depth = 0;
	let current: AcceptedGeneration | undefined = generation;
	const seen = new Set<number>();
	while (current?.retainedFromRevision !== undefined) {
		if (seen.has(current.retainedFromRevision)) return MODEL_PRESET_REGISTRY_MAX_RETENTION_ANCESTRY + 1;
		seen.add(current.retainedFromRevision);
		depth++;
		current = byRevision.get(current.retainedFromRevision);
	}
	return depth;
}

function withoutRetainedEntries(generation: AcceptedGeneration): AcceptedGeneration {
	return {
		...generation,
		retainedProfiles: [],
		retainedPresets: [],
		retainedDynamicProviders: [],
		retainedFromRevision: undefined,
	};
}

function recoverLatestVerifiedGeneration(
	state: RegistryState,
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey>,
): AcceptedGeneration | undefined {
	let latest: AcceptedGeneration | undefined;
	for (const generation of state.history) {
		try {
			const verified = validateGeneration(generation, trustedKeys);
			if (!latest || verified.manifest.signed.registryRevision > latest.manifest.signed.registryRevision)
				latest = verified;
		} catch {
			// A recovery checkpoint must come from a complete, independently verified generation.
		}
	}
	return latest;
}

function recoverRevokedGenerations(
	state: RegistryState,
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey>,
): AcceptedGeneration[] {
	const generations = new Map<number, AcceptedGeneration>();
	for (const generation of state.history) {
		const key = trustedKeys.get(generation.manifest.signature.keyId);
		if (!key?.revokedAt) continue;
		try {
			const verified = validateGeneration(generation, trustedKeys, true);
			generations.set(verified.manifest.signed.registryRevision, { ...verified, revoked: true });
		} catch {
			// A revoked generation can be retained only when its signed content and bindings remain intact.
		}
	}
	return [...generations.values()].sort(
		(left, right) => right.manifest.signed.registryRevision - left.manifest.signed.registryRevision,
	);
}

function recoveryStateFromGeneration(
	generation: AcceptedGeneration | undefined,
	revokedHistory: readonly AcceptedGeneration[] = [],
	priorState?: RegistryState,
): RegistryState {
	const history = [...(generation ? [generation] : []), ...revokedHistory].sort(
		(left, right) => right.manifest.signed.registryRevision - left.manifest.signed.registryRevision,
	);
	const activeRevision = generation?.manifest.signed.registryRevision;
	const priorFloor = priorState?.highestSeenRevision;
	const priorFloorGeneration =
		priorFloor === undefined
			? undefined
			: history.find(
					item =>
						item.manifest.signed.registryRevision === priorFloor &&
						item.manifestSha256 === priorState?.highestSeenManifestSha256 &&
						item.revoked === true,
				);
	const floor =
		priorFloorGeneration && (priorFloor ?? 0) > (activeRevision ?? 0)
			? priorFloorGeneration
			: generation
				? { manifest: generation.manifest, manifestSha256: generation.manifestSha256 }
				: priorFloorGeneration;
	const boundedHistory = history.slice(0, MODEL_PRESET_REGISTRY_MAX_HISTORY);
	if (priorFloor !== undefined && !priorFloorGeneration && priorFloor > (activeRevision ?? 0)) {
		return {
			version: 1,
			activeRevision,
			highestSeenRevision: priorFloor,
			highestSeenManifestSha256: priorState?.highestSeenManifestSha256,
			history: boundedHistory,
		};
	}
	if (
		floor &&
		!boundedHistory.some(item => item.manifest.signed.registryRevision === floor.manifest.signed.registryRevision)
	)
		boundedHistory.push(
			history.find(item => item.manifest.signed.registryRevision === floor.manifest.signed.registryRevision)!,
		);
	if (!floor) return { version: 1, history: boundedHistory };
	return {
		version: 1,
		activeRevision,
		highestSeenRevision: floor.manifest.signed.registryRevision,
		highestSeenManifestSha256: floor.manifestSha256,
		history: boundedHistory,
	};
}

function recoverStateForRead(
	state: RegistryState,
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey>,
): RegistryState {
	try {
		validateStateGenerations(state, trustedKeys);
		return state;
	} catch (error) {
		const hasRevokedGeneration = state.history.some(
			generation => trustedKeys.get(generation.manifest.signature.keyId)?.revokedAt !== undefined,
		);
		if (!hasRevokedGeneration) throw error;
		const recovered = recoveryStateFromGeneration(
			recoverLatestVerifiedGeneration(state, trustedKeys),
			recoverRevokedGenerations(state, trustedKeys),
			state,
		);
		validateStateGenerations(recovered, trustedKeys);
		return recovered;
	}
}

function preserveRawStateFloor(state: RegistryState, copies: readonly ParsedRegistryState[]): RegistryState {
	const rawFloors = copies
		.map(copy => copy.state)
		.filter(
			(candidate): candidate is RegistryState =>
				candidate !== undefined && candidate.highestSeenRevision !== undefined,
		)
		.sort((left, right) => (right.highestSeenRevision ?? 0) - (left.highestSeenRevision ?? 0));
	const rawFloor = rawFloors[0];
	if (
		rawFloor?.highestSeenRevision !== undefined &&
		(rawFloor.highestSeenRevision > (state.highestSeenRevision ?? 0) || state.highestSeenRevision === undefined)
	)
		return {
			...state,
			highestSeenRevision: rawFloor.highestSeenRevision,
			highestSeenManifestSha256: rawFloor.highestSeenManifestSha256,
		};
	return state;
}

async function writeFailureDiagnostic(
	paths: { failure: string },
	error: unknown,
	now: Date,
	canWrite: () => boolean = () => true,
): Promise<void> {
	if (!canWrite()) return;
	await writeAtomicJson(paths.failure, {
		version: 1,
		lastCheckedAt: now.toISOString(),
		lastError: safeError(error),
	});
}

function readFailureDiagnostic(agentDir: string): string | undefined {
	try {
		const value = readJsonSync(registryPaths(agentDir).failure);
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const diagnostic = value as { version?: unknown; lastError?: unknown };
		if (diagnostic.version !== 1 || typeof diagnostic.lastError !== "string") return undefined;
		return safeError(diagnostic.lastError);
	} catch {
		return undefined;
	}
}

async function recordFailure(
	agentDir: string,
	error: unknown,
	now: Date,
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey>,
	canWrite: () => boolean = () => true,
): Promise<void> {
	if (!canWrite()) return;
	const paths = registryPaths(agentDir);
	const writeFailure = async (): Promise<void> => {
		await writeFailureDiagnostic(paths, error, now, canWrite);
	};
	await withFileLock(
		paths.transaction,
		async () => {
			if (!canWrite()) return;
			let control: RegistryControl = { version: 1, disabled: false };
			let controlIsValid = true;
			try {
				control = loadControlSync(agentDir);
			} catch {
				controlIsValid = false;
			}
			const copies = [readParsedStateSync(paths.state), readParsedStateSync(paths.backup)];
			if (!copies.some(copy => copy.present)) {
				await writeFailure();
				return;
			}
			let recovery: RegistryStateRecovery | undefined;
			try {
				recovery = recoverStateCopiesSync(agentDir, trustedKeys, {
					allowInvalidPrimaryFallback: true,
					allowUnreadablePrimaryFallback: true,
				});
			} catch {
				// Never replace a copy that could not be independently read. Keep the
				// failure diagnostic separate so a later refresh remains fail-closed.
				if (copies.some(copy => copy.error !== undefined)) {
					await writeFailure();
					return;
				}
				const backupEvidence = inspectStateEvidence(copies[1], trustedKeys);
				if (backupEvidence?.fullyVerified) {
					recovery = {
						state: backupEvidence.state,
						stateIsVerified: true,
						highestSeenRevision: backupEvidence.floor?.revision,
						highestSeenManifestSha256: backupEvidence.floor?.manifestSha256,
						hadInvalidCopy: true,
						firstRun: false,
					};
				}
			}
			if (!recovery) {
				const primaryEvidence = inspectStateEvidence(copies[0], trustedKeys);
				if (primaryEvidence && (!primaryEvidence.allGenerationsVerified || primaryEvidence.duplicateRevision)) {
					await writeFailure();
					return;
				}
			}
			const backupEvidence = inspectStateEvidence(copies[1], trustedKeys);
			if (recovery?.hadInvalidCopy && backupEvidence?.fullyVerified) {
				recovery = {
					...recovery,
					state: backupEvidence.state,
					highestSeenRevision: backupEvidence.floor?.revision,
					highestSeenManifestSha256: backupEvidence.floor?.manifestSha256,
				};
			}
			let state = recovery?.state ?? copies.find(copy => copy.state)?.state;
			if (!state) {
				await writeFailure();
				return;
			}
			if (recovery?.firstRun) {
				await writeFailure();
				return;
			}
			state = preserveRawStateFloor(state, copies);
			if (recovery?.hadInvalidCopy || !controlIsValid || !recovery) {
				// An unreadable control file cannot safely preserve a stale pin or disablement.
				if (canWrite())
					await writeAtomicJson(
						paths.control,
						controlIsValid ? { ...control, pinnedRevision: undefined } : { version: 1, disabled: false },
					);
			}
			const failedState = {
				...state,
				lastCheckedAt: now.toISOString(),
				lastError: safeError(error),
			};
			await writeRegistryState(paths, failedState, canWrite);
		},
		{ retries: 20, retryDelayMs: 50, staleMs: 30_000 },
	);
}

class RefreshCancelledError extends Error {
	constructor() {
		super("Model preset registry refresh was cancelled.");
		this.name = "RefreshCancelledError";
	}
}

function isRefreshCancelled(error: unknown): boolean {
	return error instanceof RefreshCancelledError;
}

interface RefreshFlightConsumer {
	cancelled: boolean;
}

interface RefreshFlight {
	promise: Promise<ModelPresetRegistryRefreshResult>;
	consumers: Set<RefreshFlightConsumer>;
}

const refreshSingleFlight = new Map<string, RefreshFlight>();
const registryChangeListeners = new Map<string, Set<() => void>>();
const refreshDependencyIds = new WeakMap<object, number>();
let nextRefreshDependencyId = 1;

function subscribeRegistryChanges(agentDir: string, listener: () => void): () => void {
	let listeners = registryChangeListeners.get(agentDir);
	if (!listeners) {
		listeners = new Set();
		registryChangeListeners.set(agentDir, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners?.delete(listener);
		if (listeners?.size === 0) registryChangeListeners.delete(agentDir);
	};
}

function notifyRegistryChanges(agentDir: string): void {
	for (const listener of registryChangeListeners.get(agentDir) ?? []) listener();
}

function refreshDependencyId(value: object): number {
	const existing = refreshDependencyIds.get(value);
	if (existing !== undefined) return existing;
	const id = nextRefreshDependencyId++;
	refreshDependencyIds.set(value, id);
	return id;
}

function refreshSingleFlightKey(dependencies: ModelPresetRegistryDependencies, agentDir: string): string {
	const trustedKeys = getModelPresetRegistryTestTrustedKeys(agentDir) ?? MODEL_PRESET_REGISTRY_TRUSTED_KEYS;
	return [
		agentDir,
		effectiveManifestUrl(dependencies),
		refreshDependencyId((dependencies.fetch ?? fetch) as object),
		refreshDependencyId(trustedKeys as object),
		dependencies.now ? refreshDependencyId(dependencies.now) : 0,
		modelPresetRegistryTestUrlsAllowed(agentDir) ? 1 : 0,
		dependencies.timeoutMs ?? "",
		dependencies.maxManifestBytes ?? "",
		dependencies.maxSnapshotBytes ?? "",
		dependencies.maxProfilesBytes ?? "",
		dependencies.maxPresetsBytes ?? "",
		dependencies.maxStateBytes ?? "",
		dependencies.knownManifestSha256 ?? "",
	].join("\u0000");
}

export async function refreshModelPresetRegistry(
	dependencies: ModelPresetRegistryDependencies = {},
): Promise<ModelPresetRegistryRefreshResult> {
	return getRefreshFlight(dependencies).promise;
}

function refreshCanWrite(flight: RefreshFlight): boolean {
	for (const consumer of flight.consumers) {
		if (!consumer.cancelled) return true;
	}
	return false;
}

function attachRefreshFlightConsumer(flight: RefreshFlight, consumer: RefreshFlightConsumer): void {
	flight.consumers.add(consumer);
	void flight.promise.then(
		() => flight.consumers.delete(consumer),
		() => flight.consumers.delete(consumer),
	);
}

function getRefreshFlight(
	dependencies: ModelPresetRegistryDependencies,
	consumer?: RefreshFlightConsumer,
): RefreshFlight {
	const agentDir = effectiveAgentDir(dependencies);
	const flightKey = refreshSingleFlightKey(dependencies, agentDir);
	const existing = refreshSingleFlight.get(flightKey);
	if (existing) {
		if (consumer) attachRefreshFlightConsumer(existing, consumer);
		return existing;
	}
	const flight: RefreshFlight = {
		promise: undefined as unknown as Promise<ModelPresetRegistryRefreshResult>,
		consumers: new Set<RefreshFlightConsumer>(),
	};
	if (consumer) flight.consumers.add(consumer);
	else flight.consumers.add({ cancelled: false });
	const promise = refreshModelPresetRegistryInner({ ...dependencies, agentDir }, () =>
		refreshCanWrite(flight),
	).finally(() => {
		if (refreshSingleFlight.get(flightKey) === flight) refreshSingleFlight.delete(flightKey);
		flight.consumers.clear();
	});
	flight.promise = promise;
	refreshSingleFlight.set(flightKey, flight);
	return flight;
}

async function refreshModelPresetRegistryInner(
	dependencies: ModelPresetRegistryDependencies & { agentDir: string },
	canWrite: () => boolean = () => true,
): Promise<ModelPresetRegistryRefreshResult> {
	const { agentDir } = dependencies;
	const paths = registryPaths(agentDir);
	const now = (dependencies.now ?? (() => new Date()))();
	const ensureWritable = (): void => {
		if (!canWrite()) throw new RefreshCancelledError();
	};
	try {
		return await withFileLock(
			paths.transaction,
			async () => {
				if (environmentDisabled()) return { status: "disabled", revision: undefined } as const;
				const allowTestUrls = modelPresetRegistryTestUrlsAllowed(agentDir);
				let control = loadControlSync(agentDir);
				if (control.disabled || environmentDisabled())
					return { status: "disabled", revision: control.pinnedRevision };
				const trustedKeys = effectiveTrustedKeys(dependencies);
				const stateRecovery = recoverStateCopiesSync(agentDir, trustedKeys, {
					allowInvalidPrimaryFallback: true,
					allowUnreadablePrimaryFallback: true,
				});
				const state = stateRecovery.state;
				const stateIsVerified = stateRecovery.stateIsVerified;
				const usableState: RegistryState = state;
				const controlPinnedGeneration =
					control.pinnedRevision === undefined
						? undefined
						: usableState.history.find(item => item.manifest.signed.registryRevision === control.pinnedRevision);
				const staleControlPin =
					control.pinnedRevision !== undefined &&
					(controlPinnedGeneration === undefined || controlPinnedGeneration.revoked === true);
				if (staleControlPin) {
					control = { ...control, pinnedRevision: undefined };
					ensureWritable();
					await writeAtomicJson(paths.control, control);
				}
				const effectivePinnedRevision =
					stateIsVerified && !stateRecovery.hadInvalidCopy ? control.pinnedRevision : undefined;
				const trustedHighestSeenRevision = stateRecovery.highestSeenRevision;
				const trustedHighestSeenManifestSha256 = stateRecovery.highestSeenManifestSha256;
				const latest = usableState.history.reduce<AcceptedGeneration | undefined>(
					(current, item) =>
						item.revoked ||
						(current && item.manifest.signed.registryRevision <= current.manifest.signed.registryRevision)
							? current
							: item,
					undefined,
				);
				const manifestUrl = assertHttpsUrl(effectiveManifestUrl(dependencies), "Registry manifest URL");
				assertRegistryUrl(manifestUrl, manifestUrl, allowTestUrls);
				const manifestResponse = await boundedFetch(
					manifestUrl,
					dependencies.maxManifestBytes ?? MODEL_PRESET_REGISTRY_MAX_MANIFEST_BYTES,
					dependencies,
					latest?.etag && latest.manifestUrl === manifestUrl.href ? { "If-None-Match": latest.etag } : {},
				);
				if (manifestResponse.response.status === 304) {
					const currentState = recoverStateCopiesSync(agentDir, effectiveTrustedKeys(dependencies, agentDir), {
						allowInvalidPrimaryFallback: true,
						allowUnreadablePrimaryFallback: true,
					}).state;
					const currentLatest = currentState.history.reduce<AcceptedGeneration | undefined>(
						(current, item) =>
							item.revoked ||
							(current && item.manifest.signed.registryRevision <= current.manifest.signed.registryRevision)
								? current
								: item,
						undefined,
					);
					if (!currentLatest) throw new Error("Registry returned 304 without a verified cached generation.");
					ensureWritable();
					await writeRegistryState(paths, {
						...currentState,
						lastCheckedAt: now.toISOString(),
						lastError: undefined,
					});
					if (
						!latest ||
						currentLatest.manifest.signed.registryRevision !== latest.manifest.signed.registryRevision ||
						currentLatest.manifestSha256 !== latest.manifestSha256 ||
						(dependencies.knownManifestSha256 !== undefined &&
							currentLatest.manifestSha256 !== dependencies.knownManifestSha256)
					)
						return {
							status: "updated",
							revision: currentLatest.manifest.signed.registryRevision,
							revisionId: currentLatest.manifest.signed.revision,
							manifestSha256: currentLatest.manifestSha256,
							retainedProfiles: currentLatest.retainedProfiles.map(profile => profile.id),
							retainedPresets: currentLatest.retainedPresets.map(preset => `${preset.provider}/${preset.id}`),
						};
					return { status: "not_modified", revision: currentLatest.manifest.signed.registryRevision };
				}
				const manifestBytes = manifestResponse.bytes ?? new Uint8Array();
				const manifest = parseCanonicalDocument(
					manifestBytes,
					"Registry manifest",
					ModelPresetRegistryManifestSchema,
				);
				verifyManifest(manifest, effectiveTrustedKeys(dependencies));
				assertManifestBindings(manifest);
				const manifestSha256 = sha256(manifestBytes);
				if (trustedHighestSeenRevision !== undefined) {
					if (manifest.signed.registryRevision < trustedHighestSeenRevision)
						throw new Error("Registry revision downgrade rejected.");
					if (
						manifest.signed.registryRevision === trustedHighestSeenRevision &&
						trustedHighestSeenManifestSha256 !== undefined &&
						manifestSha256 !== trustedHighestSeenManifestSha256
					)
						throw new Error("Registry revision equivocation rejected.");
				}
				const snapshotResponse = await boundedFetch(
					descriptorUrl(manifest.signed.snapshot, manifestUrl, allowTestUrls),
					dependencies.maxSnapshotBytes ?? MODEL_PRESET_REGISTRY_MAX_SNAPSHOT_BYTES,
					dependencies,
				);
				const snapshotBytes = snapshotResponse.bytes ?? new Uint8Array();
				assertContentDescriptor(snapshotBytes, manifest.signed.snapshot, "Registry snapshot");
				const snapshot = parseCanonicalDocument(
					snapshotBytes,
					"Registry snapshot",
					ModelPresetRegistrySnapshotSchema,
				);
				assertSnapshotBindings(manifest, snapshot);
				const profilesResponse = await boundedFetch(
					descriptorUrl(manifest.signed.contents.profiles, manifestUrl, allowTestUrls),
					dependencies.maxProfilesBytes ?? MODEL_PRESET_REGISTRY_MAX_PROFILES_BYTES,
					dependencies,
				);
				const profileBytes = profilesResponse.bytes ?? new Uint8Array();
				assertContentDescriptor(profileBytes, manifest.signed.contents.profiles, "Registry profiles");
				const profiles = parseCanonicalDocument(
					profileBytes,
					"Registry profiles",
					ModelPresetRegistryProfilesSchema,
				);
				if (
					profiles.revision !== manifest.signed.revision ||
					profiles.profiles.length !== manifest.signed.contents.profiles.count
				)
					throw new Error("Registry profile identity is invalid.");
				const presetsResponse = await boundedFetch(
					descriptorUrl(manifest.signed.contents.presets, manifestUrl, allowTestUrls),
					dependencies.maxPresetsBytes ?? MODEL_PRESET_REGISTRY_MAX_PRESETS_BYTES,
					dependencies,
				);
				const presetBytes = presetsResponse.bytes ?? new Uint8Array();
				assertContentDescriptor(presetBytes, manifest.signed.contents.presets, "Registry presets");
				const presets = parseCanonicalDocument(presetBytes, "Registry presets", ModelPresetRegistryPresetsSchema);
				if (
					presets.revision !== manifest.signed.revision ||
					presets.presets.length !== manifest.signed.contents.presets.count
				)
					throw new Error("Registry preset identity is invalid.");
				assertProfilePresetReferences(profiles, presets);
				let compactRetention =
					latest !== undefined &&
					manifest.signed.registryRevision > latest.manifest.signed.registryRevision &&
					retainedAncestryDepth(latest, usableState) >= MODEL_PRESET_REGISTRY_MAX_RETENTION_ANCESTRY;
				const latestRevision = latest?.manifest.signed.registryRevision;
				const buildCandidate = (compact: boolean): RegistryStateCandidate => {
					const latestIsSelected = latest !== undefined && effectivePinnedRevision === latestRevision;
					const retentionSource = compact && latest && !latestIsSelected ? withoutRetainedEntries(latest) : latest;
					const retentionSourceWasStripped = retentionSource !== latest;
					const retained = retainRemoved(retentionSource, profiles, presets);
					const hasRetained =
						retained.retainedProfiles.length > 0 ||
						retained.retainedPresets.length > 0 ||
						retained.retainedDynamicProviders.length > 0;
					const generation: AcceptedGeneration = {
						manifest,
						snapshot,
						profiles,
						presets,
						manifestSha256,
						acceptedAt: now.toISOString(),
						etag: manifestResponse.response.headers.get("etag") ?? undefined,
						manifestUrl: manifestUrl.href,
						manifestOrigin: manifestUrl.origin,
						...retained,
						retainedFromRevision: hasRetained
							? latestRevision === manifest.signed.registryRevision
								? latest?.retainedFromRevision
								: latestRevision
							: undefined,
					};
					const protectedRevisions = new Set(
						[effectivePinnedRevision, usableState.activeRevision, generation.retainedFromRevision].filter(
							(revision): revision is number => revision !== undefined,
						),
					);
					const historyByRevision = new Map(
						usableState.history.map(item => [item.manifest.signed.registryRevision, item]),
					);
					const selectedHistory: AcceptedGeneration[] = [];
					const pendingSelectedRevisions = [...protectedRevisions];
					const selectedRevisionSet = new Set<number>();
					for (let index = 0; index < pendingSelectedRevisions.length; index++) {
						const selectedRevision = pendingSelectedRevisions[index]!;
						if (selectedRevisionSet.has(selectedRevision)) continue;
						selectedRevisionSet.add(selectedRevision);
						const selectedGeneration = historyByRevision.get(selectedRevision);
						if (!selectedGeneration) continue;
						const sameAsRetentionSource =
							selectedGeneration.manifest.signed.registryRevision ===
							retentionSource?.manifest.signed.registryRevision;
						if (sameAsRetentionSource && retentionSourceWasStripped) continue;
						if (!sameAsRetentionSource) selectedHistory.push(selectedGeneration);
						if (selectedGeneration.retainedFromRevision !== undefined)
							pendingSelectedRevisions.push(selectedGeneration.retainedFromRevision);
					}
					const priorHistory = compact ? [retentionSource!, ...selectedHistory] : usableState.history;
					const historyCandidates = [
						generation,
						...priorHistory.filter(
							item => item.manifest.signed.registryRevision !== manifest.signed.registryRevision,
						),
					].sort((left, right) => right.manifest.signed.registryRevision - left.manifest.signed.registryRevision);
					const history = historyCandidates.slice(0, MODEL_PRESET_REGISTRY_MAX_HISTORY);
					const pendingProtectedRevisions = [...protectedRevisions];
					for (let index = 0; index < pendingProtectedRevisions.length; index++) {
						const protectedRevision = pendingProtectedRevisions[index]!;
						const protectedGeneration = historyCandidates.find(
							item => item.manifest.signed.registryRevision === protectedRevision,
						);
						if (
							protectedGeneration &&
							!history.some(item => item.manifest.signed.registryRevision === protectedRevision)
						)
							history.push(protectedGeneration);
						if (
							protectedGeneration?.retainedFromRevision !== undefined &&
							!protectedRevisions.has(protectedGeneration.retainedFromRevision)
						) {
							protectedRevisions.add(protectedGeneration.retainedFromRevision);
							pendingProtectedRevisions.push(protectedGeneration.retainedFromRevision);
						}
					}
					return {
						retained,
						nextState: {
							version: 1,
							activeRevision:
								effectivePinnedRevision ??
								(usableState.activeRevision !== undefined &&
								trustedHighestSeenRevision !== undefined &&
								usableState.activeRevision < trustedHighestSeenRevision
									? usableState.activeRevision
									: manifest.signed.registryRevision),
							highestSeenRevision: Math.max(trustedHighestSeenRevision ?? 0, manifest.signed.registryRevision),
							highestSeenManifestSha256: manifestSha256,
							history,
							lastCheckedAt: now.toISOString(),
							lastError: undefined,
						},
					};
				};
				const maxStateBytes = dependencies.maxStateBytes ?? MODEL_PRESET_REGISTRY_MAX_STATE_BYTES;
				let candidate = buildCandidate(compactRetention);
				validateStateGenerations(candidate.nextState, effectiveTrustedKeys(dependencies));
				if (
					serializedJsonByteLength(candidate.nextState) > maxStateBytes &&
					!compactRetention &&
					latest !== undefined &&
					(usableState.activeRevision === undefined || usableState.activeRevision === latestRevision)
				) {
					compactRetention = true;
					candidate = buildCandidate(true);
					validateStateGenerations(candidate.nextState, effectiveTrustedKeys(dependencies));
				}
				if (serializedJsonByteLength(candidate.nextState) > maxStateBytes)
					throw new Error("Registry cache state exceeds its durable size limit.");
				const { nextState, retained } = candidate;
				if (stateRecovery.hadInvalidCopy && control.pinnedRevision !== undefined) {
					ensureWritable();
					await writeAtomicJson(paths.control, { ...control, pinnedRevision: undefined });
				}
				ensureWritable();
				await writeRegistryState(paths, nextState, canWrite);
				return {
					status: "updated",
					revision: manifest.signed.registryRevision,
					revisionId: manifest.signed.revision,
					manifestSha256,
					retainedProfiles: retained.retainedProfiles.map(profile => profile.id),
					retainedPresets: retained.retainedPresets.map(preset => `${preset.provider}/${preset.id}`),
				};
			},
			{ retries: 20, retryDelayMs: 50, staleMs: 30_000 },
		);
	} catch (error) {
		if (isRefreshCancelled(error)) throw error;
		const redacted = new Error(safeError(error));
		if (canWrite())
			await recordFailure(agentDir, redacted, now, effectiveTrustedKeys(dependencies), canWrite).catch(
				() => undefined,
			);
		throw redacted;
	}
}

export async function setModelPresetRegistryDisabled(
	options: ModelPresetRegistryDependencies & { disabled: boolean },
): Promise<void> {
	const { disabled } = options;
	const agentDir = effectiveAgentDir(options);
	const paths = registryPaths(agentDir);
	await withFileLock(paths.transaction, async () => {
		const current = loadControlSync(agentDir);
		await writeAtomicJson(paths.control, { ...current, disabled });
	});
	notifyRegistryChanges(agentDir);
}

export async function setModelPresetRegistryPin(
	options: ModelPresetRegistryDependencies & { revision?: number },
): Promise<void> {
	const { revision } = options;
	const agentDir = effectiveAgentDir(options);
	const paths = registryPaths(agentDir);
	await withFileLock(paths.transaction, async () => {
		let state = recoverStateCopiesSync(agentDir, effectiveTrustedKeys(options)).state;
		if (revision === undefined) {
			const highest = state.history.reduce(
				(value, item) => (item.revoked ? value : Math.max(value, item.manifest.signed.registryRevision)),
				0,
			);
			state = { ...state, activeRevision: highest || undefined };
		}
		if (revision !== undefined) {
			const generation = state.history.find(item => item.manifest.signed.registryRevision === revision);
			if (!generation) throw new Error(`Cannot pin unaccepted registry revision ${revision}.`);
			if (generation.revoked) throw new Error(`Cannot pin revoked registry revision ${revision}.`);
		}
		const current = loadControlSync(agentDir);
		await writeRegistryState(paths, state);
		await writeAtomicJson(paths.control, { ...current, pinnedRevision: revision });
	});
	notifyRegistryChanges(agentDir);
}

export async function rollbackModelPresetRegistry(
	options: ModelPresetRegistryDependencies & { revision?: number },
): Promise<void> {
	const agentDir = effectiveAgentDir(options);
	const paths = registryPaths(agentDir);
	await withFileLock(paths.transaction, async () => {
		const state = recoverStateCopiesSync(agentDir, effectiveTrustedKeys(options)).state;
		const control = loadControlSync(agentDir);
		const pinnedGeneration =
			control.pinnedRevision === undefined
				? undefined
				: state.history.find(item => item.manifest.signed.registryRevision === control.pinnedRevision);
		const activeRevision = pinnedGeneration?.revoked
			? state.activeRevision
			: (control.pinnedRevision ?? state.activeRevision);
		const revision =
			options.revision ??
			state.history
				.filter(item => !item.revoked)
				.map(item => item.manifest.signed.registryRevision)
				.filter(candidate => activeRevision === undefined || candidate < activeRevision)
				.sort((left, right) => right - left)[0];
		if (revision === undefined) throw new Error("Registry accepted history has no previous revision.");
		const generation = state.history.find(item => item.manifest.signed.registryRevision === revision);
		if (!generation) throw new Error(`Registry revision ${revision} is not in accepted history.`);
		validateGeneration(generation, effectiveTrustedKeys(options));
		await writeRegistryState(paths, { ...state, activeRevision: revision, lastError: undefined });
		await writeAtomicJson(paths.control, { ...control, pinnedRevision: undefined });
	});
	notifyRegistryChanges(agentDir);
}

export function getModelPresetRegistryStatus(
	dependencies: ModelPresetRegistryDependencies = {},
): ModelPresetRegistryStatus {
	const agentDir = effectiveAgentDir(dependencies);
	if (environmentDisabled())
		return {
			contractVersion: MODEL_PRESET_REGISTRY_CONTRACT_VERSION,
			source: "embedded",
			cacheHealth: "empty",
			disabled: true,
			retainedProfiles: [],
			retainedPresets: [],
			historyRevisions: [],
			profileCount: 0,
			presetCount: 0,
		};
	let control: RegistryControl = { version: 1, disabled: false };
	let state: RegistryState = { version: 1, history: [] };
	let cacheHealth: ModelPresetRegistryStatus["cacheHealth"] = "empty";
	let loadError: string | undefined;
	let failureDiagnostic: string | undefined;
	try {
		control = loadControlSync(agentDir);
		state = recoverStateCopiesSync(agentDir, effectiveTrustedKeys(dependencies, agentDir)).state;
		cacheHealth = state.history.length > 0 ? "valid" : "empty";
		if (state.history.length === 0 && state.lastError === undefined)
			failureDiagnostic = readFailureDiagnostic(agentDir);
	} catch (error) {
		cacheHealth = "corrupt";
		state = { version: 1, history: [] };
		loadError = safeError(error);
	}
	const disabled = control.disabled || environmentDisabled();
	const pinnedGeneration =
		control.pinnedRevision === undefined
			? undefined
			: state.history.find(item => item.manifest.signed.registryRevision === control.pinnedRevision);
	const staleControlPin =
		control.pinnedRevision !== undefined && (pinnedGeneration === undefined || pinnedGeneration.revoked === true);
	const revision = staleControlPin ? state.activeRevision : (control.pinnedRevision ?? state.activeRevision);
	const generation = state.history.find(item => item.manifest.signed.registryRevision === revision);
	let valid: AcceptedGeneration | undefined;
	if (revision !== undefined && !generation) {
		cacheHealth = "corrupt";
		loadError = `Registry selected revision ${revision} is missing from accepted history.`;
	}
	if (generation && !disabled) {
		try {
			valid = validateGeneration(generation, effectiveTrustedKeys(dependencies, agentDir));
		} catch (error) {
			cacheHealth = "corrupt";
			loadError = safeError(error);
		}
	}
	return {
		contractVersion: MODEL_PRESET_REGISTRY_CONTRACT_VERSION,
		source: valid ? "registry" : "embedded",
		cacheHealth,
		activeRevision: valid?.manifest.signed.registryRevision,
		activeRevisionId: valid?.manifest.signed.revision,
		highestSeenRevision: state.highestSeenRevision,
		manifestSha256: valid?.manifestSha256,
		snapshotSha256: valid?.manifest.signed.snapshot.sha256,
		profilesSha256: valid?.manifest.signed.contents.profiles.sha256,
		presetsSha256: valid?.manifest.signed.contents.presets.sha256,
		keyId: valid?.manifest.signature.keyId,
		sourceRevision: valid?.manifest.signed.provenance.sourceRevision,
		acceptedAt: valid?.acceptedAt,
		publishedAt: valid?.manifest.signed.publishedAt,
		lastCheckedAt: state.lastCheckedAt,
		lastError: loadError ?? state.lastError ?? failureDiagnostic,
		disabled,
		pinnedRevision: staleControlPin ? undefined : control.pinnedRevision,
		retainedProfiles: valid?.retainedProfiles.map(profile => profile.id) ?? [],
		retainedPresets: valid?.retainedPresets.map(preset => `${preset.provider}/${preset.id}`) ?? [],
		historyRevisions: state.history
			.map(item => item.manifest.signed.registryRevision)
			.sort((left, right) => right - left),
		profileCount: valid ? valid.profiles.profiles.length + valid.retainedProfiles.length : 0,
		presetCount: valid ? valid.presets.presets.length + valid.retainedPresets.length : 0,
	};
}

export function refreshModelPresetRegistryInBackground(
	dependencies: ModelPresetRegistryDependencies = {},
	onAccepted?: () => void,
): () => Promise<void> {
	if (dependencies.automaticRefresh === false) return async () => {};
	const agentDir = effectiveAgentDir(dependencies);
	let status: ModelPresetRegistryStatus;
	try {
		status = getModelPresetRegistryStatus({ ...dependencies, agentDir });
	} catch {
		status = {
			contractVersion: MODEL_PRESET_REGISTRY_CONTRACT_VERSION,
			source: "embedded",
			cacheHealth: "corrupt",
			disabled: false,
			retainedProfiles: [],
			retainedPresets: [],
			historyRevisions: [],
			profileCount: 0,
			presetCount: 0,
		};
	}
	const lastChecked = status.lastCheckedAt ? Date.parse(status.lastCheckedAt) : 0;
	const now = (dependencies.now ?? (() => new Date()))().getTime();
	const refreshIntervalMs = dependencies.refreshIntervalMs ?? MODEL_PRESET_REGISTRY_REFRESH_INTERVAL_MS;
	const recentAge = Number.isFinite(lastChecked) ? Math.max(0, now - lastChecked) : Number.POSITIVE_INFINITY;
	const initialDelay = status.disabled
		? refreshIntervalMs
		: recentAge < refreshIntervalMs
			? refreshIntervalMs - recentAge
			: (dependencies.startupDelayMs ?? MODEL_PRESET_REGISTRY_STARTUP_DELAY_MS);
	let cancelled = false;
	let disposal: Promise<void> | undefined;
	const consumer: RefreshFlightConsumer = { cancelled: false };
	const pendingFlights = new Set<Promise<ModelPresetRegistryRefreshResult>>();
	let knownManifestSha256 = dependencies.knownManifestSha256 ?? status.manifestSha256;
	const publicationFingerprint = (current: ModelPresetRegistryStatus): string =>
		JSON.stringify({
			disabled: current.disabled,
			pinnedRevision: current.pinnedRevision,
			activeRevision: current.activeRevision,
			manifestSha256: current.manifestSha256,
			cacheHealth: current.cacheHealth,
		});
	let publishedFingerprint = publicationFingerprint(status);
	const publishCurrentStatus = (): void => {
		if (cancelled) return;
		try {
			const currentStatus = getModelPresetRegistryStatus({ ...dependencies, agentDir });
			const currentFingerprint = publicationFingerprint(currentStatus);
			if (currentFingerprint !== publishedFingerprint) {
				publishedFingerprint = currentFingerprint;
				try {
					onAccepted?.();
				} catch {
					// Consumer publication must not make a durable local control mutation fail.
				}
			}
		} catch {
			// The origin refresh below records bounded diagnostics; local publication remains best-effort.
		}
	};
	const unsubscribe = subscribeRegistryChanges(agentDir, () => queueMicrotask(publishCurrentStatus));
	let timer: Timer | undefined;
	const schedule = (delayMs: number): void => {
		if (cancelled) return;
		timer = setTimeout(() => {
			if (cancelled) return;
			publishCurrentStatus();
			const flight = getRefreshFlight({ ...dependencies, agentDir, knownManifestSha256 }, consumer);
			pendingFlights.add(flight.promise);
			void flight.promise
				.then(result => {
					if (result.status === "updated") knownManifestSha256 = result.manifestSha256;
					if (!cancelled) {
						let shouldPublish = false;
						try {
							const nextFingerprint = publicationFingerprint(
								getModelPresetRegistryStatus({ ...dependencies, agentDir }),
							);
							shouldPublish = nextFingerprint !== publishedFingerprint;
							publishedFingerprint = nextFingerprint;
						} catch {
							shouldPublish = result.status === "updated";
						}
						if (shouldPublish) onAccepted?.();
					}
				})
				.catch(() => undefined)
				.finally(() => {
					pendingFlights.delete(flight.promise);
					schedule(refreshIntervalMs);
				});
		}, delayMs);
		timer.unref?.();
	};
	schedule(initialDelay);
	return () => {
		if (disposal) return disposal;
		cancelled = true;
		consumer.cancelled = true;
		unsubscribe();
		if (timer) clearTimeout(timer);
		disposal = Promise.allSettled([...pendingFlights]).then(() => undefined);
		return disposal;
	};
}
