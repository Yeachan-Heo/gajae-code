/**
 * Single source of precedence for the workflow settings surfaces.
 *
 * Every workflow runtime (ralplan, ultragoal, deep-interview) reads its
 * settings through {@link resolveWorkflowSetting}; no runtime hand-rolls file
 * discovery, YAML/JSON parsing, or key extraction. The precedence is fixed:
 *
 *   1. project `.gjc/config.yml`
 *   2. user `<agentDir>/config.yml` (default `~/.gjc/agent/config.yml`)
 *   3. built-in default
 *
 * Project configuration always beats user configuration, and `config.yml` is
 * the primary settings surface: the legacy `settings.json` files (project and
 * config-root) are retired, their workflow values migrated into `config.yml` by
 * Settings once. The retained legacy source still applies while the migration
 * has NOT durably recorded ownership/completion for its key: the project source
 * until the per-key migrated-keys marker records the key, the config-root
 * source until the migration retires it. A completed migration owns the value
 * (a later `gjc config unset` sticks), so an owned key is never resurrected;
 * the project legacy sits above the agent config.yml, the config-root legacy
 * below it. Settings therefore writes exactly what the runtimes read: `gjc
 * config set gjc.ralplan.maxIterations 7` is honored by ralplan.
 *
 * `config.yml` uses the nested schema form (`gjc: { ralplan: { maxIterations } }`);
 * flat dotted keys are honored only while parsing a legacy `settings.json`
 * during migration (see Settings) or the retained-legacy fallback layer.
 *
 * This module must stay pure and acyclic: it imports only path helpers and the
 * pure `session-layout`/`dirs` utilities, never `Settings`, discovery/capability
 * loaders, or workflow runtimes. All config/agent paths are constructed inside
 * each resolver call (never at module scope) because `dirs.ts` caches directory
 * resolution at module load.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	getAgentDir,
	getConfigRootDir,
	isEnoent,
	resolveEquivalentPath,
	standardizeMacOSPath,
} from "@gajae-code/utils";
import { YAML } from "bun";
import { projectConfigRoot, projectSharedStateRoot } from "./session-layout";

export type WorkflowSettingKey =
	| "gjc.deepInterview.ambiguityThreshold"
	| "gjc.ralplan.autoHandoff"
	| "gjc.ralplan.maxIterations"
	| "gjc.ralplan.maxReviewPassesPerLane"
	| "gjc.ultragoal.nudgeBudget";

export type WorkflowSettingLayer = "project-config" | "agent-config";

export type WorkflowSettingParseResult<T> = { kind: "valid"; value: T } | { kind: "invalid"; reason: string };

export type WorkflowSettingDiagnosticStatus = "missing-file" | "empty-document" | "missing-key" | "invalid" | "valid";

export interface WorkflowSettingDiagnostic {
	layer: WorkflowSettingLayer;
	/** Lexical absolute candidate; missing paths stay actionable. */
	path: string;
	format: "yaml" | "json";
	status: WorkflowSettingDiagnosticStatus;
	classification?: "read" | "syntax" | "shape" | "value";
	reason?: string;
}

export interface ResolveWorkflowSettingOptions<T> {
	defaultValue: T;
	parse: (value: unknown) => WorkflowSettingParseResult<T>;
	/** Omitted means "continue"; ralplan passes "throw" explicitly. */
	invalidPolicy?: "throw" | "continue";
	/**
	 * The session's effective agent directory. Defaults to the process-global
	 * `getAgentDir()`; an SDK embedder that created the session with
	 * `createAgentSession({ agentDir })` must pass that directory here so the
	 * agent-config layer matches the profile `Settings.init` loaded and
	 * migrated, instead of inheriting an unrelated default-profile value.
	 */
	agentDir?: string;
}

export interface WorkflowSettingResolution<T> {
	value: T;
	/** Canonical realpath for a winning existing file, or "default". */
	source: string;
	diagnostics: readonly WorkflowSettingDiagnostic[];
}

export type WorkflowSettingInvalidClassification = "read" | "syntax" | "shape" | "value";

/** Raised under the strict ("throw") invalid policy; stable properties for callers. */
export class WorkflowSettingError extends Error {
	readonly diagnostic: WorkflowSettingDiagnostic;
	readonly path: string;
	readonly layer: WorkflowSettingLayer;
	readonly classification: WorkflowSettingInvalidClassification;
	readonly reason: string;

	constructor(
		diagnostic: WorkflowSettingDiagnostic & {
			classification: WorkflowSettingInvalidClassification;
			reason: string;
		},
	) {
		super(`invalid workflow setting at ${diagnostic.path}: ${diagnostic.reason}`);
		this.name = "WorkflowSettingError";
		this.diagnostic = diagnostic;
		this.path = diagnostic.path;
		this.layer = diagnostic.layer;
		this.classification = diagnostic.classification;
		this.reason = diagnostic.reason;
	}
}

type ResolverCandidate = {
	layer: WorkflowSettingLayer;
	format: "yaml" | "json";
	buildPath: (cwd: string) => string;
	/** Optional per-key guard consulted before a legacy fallback value is used. */
	migrationOwned?: (key: WorkflowSettingKey) => Promise<boolean>;
};

const LAYER_CANDIDATES: ReadonlyArray<ResolverCandidate> = [
	{ layer: "project-config", format: "yaml", buildPath: cwd => path.resolve(projectConfigRoot(cwd), "config.yml") },
];

/**
 * The project migration's per-key ownership marker (`$GJC_STATE_DIR/state/
 * settings.json.migrated-keys`): a key recorded there was migrated into project
 * config.yml and is owned by that surface. Deleting config.yml afterwards must
 * NOT resurrect the retained legacy value (the removal sticks), so the legacy
 * fallback layer is suppressed for marked keys. A missing or malformed marker
 * reads as no ownership.
 */
async function projectKeyMigrated(cwd: string, key: WorkflowSettingKey, agentDir?: string): Promise<boolean> {
	let raw: string;
	try {
		raw = await Bun.file(path.join(projectSharedStateRoot(cwd, agentDir), "settings.json.migrated-keys")).text();
	} catch (error) {
		// Only a MISSING marker reads as no ownership. A non-ENOENT read
		// failure (EACCES, transient I/O) must fail closed: reporting unowned
		// would let the resolver reactivate a stale retained value after the
		// key was unset from project config.yml (an invalid strict value could
		// make ralplan exit 2 again).
		if (isEnoent(error)) return false;
		throw error;
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) && parsed.includes(key);
	} catch {
		return false;
	}
}

/**
 * True when two paths refer to the SAME physical file (lexical path identity
 * first, then dev/ino for symlink/hardlink aliases) - mirrors the migration's
 * `#configRootCollidesWithProjectSource` so the resolver's aliasing guard never
 * disagrees with it.
 */
async function filesAreSamePhysicalFile(a: string, b: string): Promise<boolean> {
	if (path.resolve(a) === path.resolve(b)) return true;
	const [statA, statB] = await Promise.all([fs.stat(a).catch(() => null), fs.stat(b).catch(() => null)]);
	return !!statA && !!statB && statA.dev === statB.dev && statA.ino === statB.ino;
}

/**
 * True when a legacy migration source still exists on disk. The retained source
 * keeps the legacy fallback candidate eligible: the migration is incomplete
 * until ownership is durably recorded (the project per-key migrated-keys
 * marker, or the config-root source's retirement on completion), and an
 * incomplete migration must not silently drop the previously effective
 * override - including when the migration target is PRESENT but could not be
 * published to (e.g. an unwritable project `.gjc` or config root). The per-key
 * ownership marker consulted per candidate suppresses a key the migration DID
 * complete for, so a deliberate `gjc config unset` still sticks.
 */
async function legacySourceExists(sourcePath: string): Promise<boolean> {
	try {
		await fs.stat(sourcePath);
		return true;
	} catch (error) {
		// Only ENOENT means absence. A non-ENOENT failure (EACCES, transient
		// I/O) RETAINS the candidate: the normal read-error policy then
		// surfaces the unreadable explicit settings source (strict ralplan
		// callers exit 2) instead of silently treating it as absence.
		if (isEnoent(error)) return false;
		return true;
	}
}

/**
 * Extract a workflow key from a parsed settings document. Flat dotted keys are
 * honored only while parsing a legacy `settings.json` during migration (see
 * Settings) - `config.yml` uses the nested (schema) form, so the public
 * Settings/config CLI path (which addresses nested paths) can manage every
 * effective override. Flat keys are checked before the nested `gjc: { ... }`
 * shape (flat wins); an explicitly present `undefined` value counts as present.
 */
export function extractWorkflowSetting(
	document: unknown,
	key: WorkflowSettingKey,
	options: { flat?: boolean } = {},
): { present: boolean; value: unknown; malformedParent?: boolean } {
	if (!document || typeof document !== "object" || Array.isArray(document)) {
		return { present: false, value: undefined };
	}
	const settings = document as Record<string, unknown>;
	if (options.flat !== false && Object.hasOwn(settings, key)) return { present: true, value: settings[key] };

	const segments = key.split(".");
	if (segments.length < 2 || segments[0] !== "gjc") return { present: false, value: undefined };
	// A PRESENT but non-mapping `gjc` (or any intermediate segment) is a
	// malformed parent, not a missing key: strict callers must surface it as an
	// invalid shape instead of silently continuing to a lower layer/default.
	const hasGjc = Object.hasOwn(settings, "gjc");
	const gjc = settings.gjc;
	if (gjc === null || typeof gjc !== "object" || Array.isArray(gjc)) {
		return hasGjc
			? { present: false, value: undefined, malformedParent: true }
			: { present: false, value: undefined };
	}
	let current: unknown = gjc;
	for (let index = 1; index < segments.length; index++) {
		const record = current as Record<string, unknown>;
		if (!Object.hasOwn(record, segments[index]!)) return { present: false, value: undefined };
		const next = record[segments[index]!];
		if (index < segments.length - 1 && (next === null || typeof next !== "object" || Array.isArray(next))) {
			return { present: false, value: undefined, malformedParent: true };
		}
		current = next;
	}
	return { present: true, value: current };
}

/**
 * Strict-invalid retention evidence files, written by the config-root and
 * project migrations when they abort on an invalid STRICT ralplan legacy value
 * (see Settings). The retained legacy sources are never read by this resolver,
 * so the evidence is the only way the invalid value stays visible to strict
 * callers. A project evidence slot sits at the project layer's precedence, an
 * agent (config-root) evidence slot at the agent layer's.
 */
const STRICT_INVALID_EVIDENCE_FILENAME = "settings.json.strict-invalid";

async function readRetainedStrictEvidence(
	evidencePath: string,
	key: WorkflowSettingKey,
): Promise<{ value?: unknown; source: string; malformed: boolean } | null> {
	let raw: string;
	try {
		raw = await Bun.file(evidencePath).text();
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as {
			version?: unknown;
			malformed?: unknown;
			key?: unknown;
			value?: unknown;
			keys?: unknown;
			source?: unknown;
		};
		const source = typeof parsed.source === "string" ? parsed.source : evidencePath;
		// A malformed-source marker applies to every strict key: the file cannot
		// be parsed, so no key can be trusted.
		if (parsed.malformed === true) return { source, malformed: true };
		if (parsed.version === 2 && Array.isArray(parsed.keys)) {
			for (const rawEntry of parsed.keys) {
				if (!rawEntry || typeof rawEntry !== "object") continue;
				const entry = rawEntry as { key?: unknown; value?: unknown };
				if (entry.key === key) return { value: entry.value, source, malformed: false };
			}
			return null;
		}
		// v1 single-key compatibility.
		if (parsed.key === key) return { value: parsed.value, source, malformed: false };
		return null;
	} catch {
		return null;
	}
}

/**
 * Resolve a workflow setting across the fixed three-layer precedence (project
 * `.gjc/config.yml`, then user `<agentDir>/config.yml`, then the built-in
 * default). Returns the first valid configured value, otherwise
 * {@link options.defaultValue} with `source: "default"`. Diagnostics are
 * retained for unit tests and optional logging; runtime public wrappers expose
 * their existing compact result shapes.
 */
export async function resolveWorkflowSetting<T>(
	cwd: string,
	key: WorkflowSettingKey,
	options: ResolveWorkflowSettingOptions<T>,
): Promise<WorkflowSettingResolution<T>> {
	const invalidPolicy = options.invalidPolicy ?? "continue";
	const diagnostics: WorkflowSettingDiagnostic[] = [];

	const invalid = (
		layer: WorkflowSettingLayer,
		candidatePath: string,
		format: "yaml" | "json",
		classification: WorkflowSettingInvalidClassification,
		reason: string,
	): WorkflowSettingDiagnostic & { classification: WorkflowSettingInvalidClassification; reason: string } => ({
		layer,
		path: candidatePath,
		format,
		status: "invalid",
		classification,
		reason,
	});
	// Legacy fallback layers: while the migration has NOT durably recorded
	// ownership/completion for a key, the retained legacy settings.json still
	// holds the previously effective override - whether its config.yml target is
	// absent (the migration could not publish), future-schema (read-only, skipped
	// by the migration), or PRESENT but non-publishable (an unwritable project
	// `.gjc` or config root rejected the write, so the source was retained). A
	// completed migration owns the value instead: the project per-key
	// migrated-keys marker suppresses an owned key (a later `gjc config unset`
	// sticks), and the config-root source is retired on completion. The project
	// legacy sits above the agent config.yml (it was the previously effective
	// project override); the config-root legacy sits below it (the agent
	// config.yml is the current machine-global surface).
	const projectSettingsJson = path.resolve(projectConfigRoot(cwd), "settings.json");
	const agentSettingsJson = path.resolve(getConfigRootDir(), "settings.json");
	const legacyCandidates: ResolverCandidate[] = [];
	if (await legacySourceExists(projectSettingsJson)) {
		legacyCandidates.push({
			layer: "project-config",
			format: "json",
			buildPath: () => projectSettingsJson,
			// A key already migrated into config.yml is owned by that surface:
			// deleting the file afterwards must not resurrect the retained value.
			migrationOwned: key => projectKeyMigrated(cwd, key, options.agentDir),
		});
	}
	// When the config-root source ALIASES the project source (GJC run from the
	// config root itself, or a symlink/hardlink to it), a project-owned key must
	// not resurrect through the agent slot either after `gjc config unset`
	// removed it from config.yml.
	const configRootAliasesProject = await filesAreSamePhysicalFile(projectSettingsJson, agentSettingsJson);
	// The machine-global config-root legacy belongs ONLY to the environment-
	// selected global agent profile: an isolated SDK/tenant profile
	// (`options.agentDir` differing from `getAgentDir()`) must not inherit the
	// host's legacy override - the migration deliberately refuses to consume
	// the machine-global source for custom scopes, so it stays present and
	// would defeat profile isolation if applied here.
	const agentLayerIsGlobal =
		options.agentDir === undefined || path.resolve(options.agentDir) === path.resolve(getAgentDir());
	if (agentLayerIsGlobal && (await legacySourceExists(agentSettingsJson))) {
		legacyCandidates.push({
			layer: "agent-config",
			format: "json",
			buildPath: () => agentSettingsJson,
			...(configRootAliasesProject
				? { migrationOwned: (key: WorkflowSettingKey) => projectKeyMigrated(cwd, key, options.agentDir) }
				: {}),
		});
	}
	// The session's effective agent directory (SDK sessions pass their
	// `createAgentSession({ agentDir })` profile); the process-global
	// `getAgentDir()` is the default for CLI flows.
	const agentCandidate: ResolverCandidate = {
		layer: "agent-config",
		format: "yaml",
		buildPath: () => path.resolve(options.agentDir ?? getAgentDir(), "config.yml"),
	};
	const candidates = [
		LAYER_CANDIDATES[0]!,
		...legacyCandidates.filter(candidate => candidate.layer === "project-config"),
		agentCandidate,
		...legacyCandidates.filter(candidate => candidate.layer === "agent-config"),
	];
	for (const candidate of candidates) {
		// The project layer exhausted its candidates without producing a value
		// (the project config.yml yielded nothing): before consulting the agent
		// layer, a retained-invalid PROJECT legacy value must fail loudly instead
		// of silently deferring to the agent/default - but a valid project
		// config.yml value already returned above, so it still wins. An OWNED
		// project key (deliberately unset) is exempt: its strict error is
		// irrelevant and must not exit 2.
		if (
			candidate.layer === "agent-config" &&
			invalidPolicy === "throw" &&
			!(await projectKeyMigrated(cwd, key, options.agentDir))
		) {
			const retained = await readRetainedStrictEvidence(
				path.join(projectSharedStateRoot(cwd, options.agentDir), STRICT_INVALID_EVIDENCE_FILENAME),
				key,
			);
			if (retained) {
				throw new WorkflowSettingError({
					layer: "project-config",
					path: retained.source,
					format: "json",
					status: "invalid",
					classification: retained.malformed ? "syntax" : "value",
					reason: retained.malformed
						? `retained malformed project .gjc/settings.json; repair or remove the source and reload`
						: `retained invalid ${key} value from the retired project .gjc/settings.json; repair or remove the source and reload`,
				});
			}
		}
		const candidatePath = candidate.buildPath(cwd);

		// A key the migration already owns is not eligible for the retained
		// legacy fallback: consult the per-key ownership marker BEFORE reading or
		// parsing the candidate, so a deliberately unset owned key falls through
		// to the lower layer/default even when the retained source is malformed
		// (a stale global malformed marker or the pre-ownership JSON parse must
		// not exit 2 for a key config.yml owns).
		if (candidate.migrationOwned && (await candidate.migrationOwned(key))) {
			diagnostics.push({
				layer: candidate.layer,
				path: candidatePath,
				format: candidate.format,
				status: "missing-key",
			});
			continue;
		}

		let raw: string;
		try {
			raw = await Bun.file(candidatePath).text();
		} catch (error) {
			if (isEnoent(error)) {
				diagnostics.push({
					layer: candidate.layer,
					path: candidatePath,
					format: candidate.format,
					status: "missing-file",
				});
				continue;
			}
			const reason = error instanceof Error ? error.message : String(error);
			const diagnostic = invalid(candidate.layer, candidatePath, candidate.format, "read", reason);
			if (invalidPolicy === "throw") throw new WorkflowSettingError(diagnostic);
			diagnostics.push(diagnostic);
			continue;
		}

		const trimmed = raw.trim();
		// Only a genuinely EMPTY config.yml is "no explicit settings" (an empty
		// YAML document). The literal text `undefined` is a parse error below.
		if (trimmed === "") {
			diagnostics.push({
				layer: candidate.layer,
				path: candidatePath,
				format: candidate.format,
				status: "empty-document",
			});
			continue;
		}

		let parsed: unknown;
		if (candidate.format === "json") {
			// A retained legacy settings.json must be parsed as JSON (its file
			// contract) - JSON-invalid but YAML-valid content (unquoted keys,
			// comments) must not supply a workflow value, and a strict caller must
			// fail closed instead of bypassing the malformed-source evidence.
			try {
				parsed = JSON.parse(raw);
			} catch {
				const diagnostic = invalid(candidate.layer, candidatePath, candidate.format, "syntax", "malformed JSON");
				if (invalidPolicy === "throw") throw new WorkflowSettingError(diagnostic);
				diagnostics.push(diagnostic);
				continue;
			}
		} else {
			try {
				parsed = YAML.parse(raw);
			} catch {
				// Stable, caller-agnostic reason; the underlying parse detail is not
				// part of the runtime error contract.
				const diagnostic = invalid(candidate.layer, candidatePath, candidate.format, "syntax", "malformed YAML");
				if (invalidPolicy === "throw") throw new WorkflowSettingError(diagnostic);
				diagnostics.push(diagnostic);
				continue;
			}
		}

		// Only an EMPTY document (no content) is "no explicit settings": a
		// parsed YAML/JSON `null` root is malformed per Settings.#loadYaml
		// (which keeps the config read-only until repaired), so the strict
		// contract must fail closed on it instead of continuing to defaults.
		if (parsed === undefined) {
			diagnostics.push({
				layer: candidate.layer,
				path: candidatePath,
				format: candidate.format,
				status: "empty-document",
			});
			continue;
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			const diagnostic = invalid(
				candidate.layer,
				candidatePath,
				candidate.format,
				"shape",
				`expected a settings mapping, got ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed}`,
			);
			if (invalidPolicy === "throw") throw new WorkflowSettingError(diagnostic);
			diagnostics.push(diagnostic);
			continue;
		}

		// config.yml uses the nested schema form; flat dotted keys belong only to
		// legacy settings.json parsing (during migration, or the retained-legacy
		// fallback layer while a migration target is absent).
		const extracted = extractWorkflowSetting(parsed, key, { flat: candidate.format === "json" });
		if (extracted.malformedParent) {
			// A present non-mapping parent (e.g. `gjc: "invalid"` or
			// `gjc: { ralplan: [] }`) is a malformed explicit layer: strict
			// ralplan fails closed (exit 2) instead of silently treating the key
			// as missing and falling to a lower layer/default.
			const diagnostic = invalid(
				candidate.layer,
				candidatePath,
				candidate.format,
				"shape",
				`expected a settings mapping for ${key}, got a non-mapping parent`,
			);
			if (invalidPolicy === "throw") throw new WorkflowSettingError(diagnostic);
			diagnostics.push(diagnostic);
			continue;
		}
		if (!extracted.present) {
			diagnostics.push({
				layer: candidate.layer,
				path: candidatePath,
				format: candidate.format,
				status: "missing-key",
			});
			continue;
		}

		// Mirror Settings' schema scalar coercion before the workflow parser: a
		// quoted numeric string for a number workflow key (e.g.
		// `gjc.ralplan.maxIterations: "7"`) is coerced to a number, exactly as
		// reconcileSettingsSchema treats number settings. Enum workflow keys
		// never carry numeric strings, so the coercion is a no-op there.
		const coercedValue =
			typeof extracted.value === "string" &&
			extracted.value.trim() !== "" &&
			Number.isFinite(Number(extracted.value))
				? Number(extracted.value)
				: extracted.value;
		const parsedValue = options.parse(coercedValue);
		if (parsedValue.kind === "valid") {
			return {
				value: parsedValue.value,
				source: standardizeMacOSPath(resolveEquivalentPath(candidatePath)),
				diagnostics,
			};
		}

		const diagnostic = invalid(candidate.layer, candidatePath, candidate.format, "value", parsedValue.reason);
		if (invalidPolicy === "throw") throw new WorkflowSettingError(diagnostic);
		diagnostics.push(diagnostic);
	}

	// Both config.yml layers produced no value. A config-root migration that
	// retained an invalid STRICT ralplan legacy value (so `gjc ralplan` can
	// still fail loudly) persists agent-layer evidence; strict callers surface
	// it here - after the project layer had its chance to win - instead of
	// silently falling back to the default. Tolerant callers never abort on
	// invalid values, so the evidence only ever records ralplan keys. Like the
	// legacy candidate, the machine-global evidence applies only to the
	// environment-selected global profile: an isolated SDK/tenant profile must
	// fall through to its own defaults instead of inheriting the host's
	// retained failure.
	if (invalidPolicy === "throw" && agentLayerIsGlobal) {
		const retained = await readRetainedStrictEvidence(
			path.resolve(getConfigRootDir(), STRICT_INVALID_EVIDENCE_FILENAME),
			key,
		);
		if (retained) {
			throw new WorkflowSettingError({
				layer: "agent-config",
				path: retained.source,
				format: "json",
				status: "invalid",
				classification: retained.malformed ? "syntax" : "value",
				reason: retained.malformed
					? `retained malformed config-root settings.json; repair or remove the source and reload`
					: `retained invalid ${key} value from the retired config-root settings.json; repair or remove the source and reload`,
			});
		}
	}

	return { value: options.defaultValue, source: "default", diagnostics };
}
