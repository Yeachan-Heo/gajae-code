/**
 * Single source of precedence for the four workflow settings surfaces.
 *
 * Every workflow runtime (ralplan, ultragoal, deep-interview) reads its
 * settings through {@link resolveWorkflowSetting}; no runtime hand-rolls file
 * discovery, YAML/JSON parsing, or key extraction. The precedence is fixed:
 *
 *   1. project `.gjc/config.yml`
 *   2. project `.gjc/settings.json`
 *   3. user `<agentDir>/config.yml` (default `~/.gjc/agent/config.yml`)
 *   4. user `<configRoot>/settings.json` (legacy, deprecated last resort)
 *   5. built-in default
 *
 * Project configuration always beats user configuration, and modern YAML beats
 * legacy JSON. Both flat dotted keys (`gjc.ralplan.maxIterations`) and nested
 * shapes (`gjc: { ralplan: { maxIterations } }`) are accepted; flat wins when
 * both occur in one document.
 *
 * This module must stay pure and acyclic: it imports only path helpers and the
 * pure `gjcRoot`/`dirs` utilities, never `Settings`, discovery/capability
 * loaders, or workflow runtimes. All config/agent paths are constructed inside
 * each resolver call (never at module scope) because `dirs.ts` caches directory
 * resolution at module load.
 */

import { createHash } from "node:crypto";
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
import { gjcRoot } from "./session-layout";

export type WorkflowSettingKey =
	| "gjc.deepInterview.ambiguityThreshold"
	| "gjc.ralplan.autoHandoff"
	| "gjc.ralplan.maxIterations"
	| "gjc.ralplan.maxReviewPassesPerLane"
	| "gjc.ultragoal.nudgeBudget";

export type WorkflowSettingLayer = "project-config" | "project-settings" | "agent-config" | "config-root-settings";

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

const LAYER_CANDIDATES: ReadonlyArray<{
	layer: WorkflowSettingLayer;
	format: "yaml" | "json";
	buildPath: (cwd: string) => string;
}> = [
	{ layer: "project-config", format: "yaml", buildPath: cwd => path.resolve(gjcRoot(cwd), "config.yml") },
	{ layer: "project-settings", format: "json", buildPath: cwd => path.resolve(gjcRoot(cwd), "settings.json") },
	{ layer: "agent-config", format: "yaml", buildPath: () => path.resolve(getAgentDir(), "config.yml") },
	{
		layer: "config-root-settings",
		format: "json",
		buildPath: () => path.resolve(getConfigRootDir(), "settings.json"),
	},
];

/** Must match settings.ts WORKFLOW_MIGRATION_MARKER_VERSION. */
const WORKFLOW_MIGRATION_MARKER_VERSION = 1;
/** Must match settings.ts CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS. */
const WORKFLOW_MIGRATION_KEYS: readonly string[] = [
	"gjc.deepInterview.ambiguityThreshold",
	"gjc.ralplan.autoHandoff",
	"gjc.ralplan.maxIterations",
	"gjc.ralplan.maxReviewPassesPerLane",
	"gjc.ultragoal.nudgeBudget",
];

/**
 * True when the one-time config-root migration has completed AND the source is
 * still the migrated file: the `<source>.migrated` marker passes the same
 * version/shape checks as the migration's own reader, has status "complete",
 * points at the same path, and the current source bytes still match the
 * marker's sourceSha256. A completed migration deactivates the legacy source
 * (removing a migrated target key returns to the default, not the legacy
 * value), but a later edit or recreate of settings.json changes the bytes and
 * REACTIVATES the documented legacy fallback. Malformed, version-mismatched,
 * path-mismatched, source-mismatched, or target-profile-mismatched markers do
 * not deactivate: the migration only copied values into the DEFAULT agent
 * config, so a custom agentDir profile that never received the migrated value
 * keeps the legacy fallback active.
 */
async function isConfigRootMigrationComplete(sourcePath: string): Promise<boolean> {
	const markerPath = `${sourcePath}.migrated`;
	let raw: string;
	try {
		raw = await Bun.file(markerPath).text();
	} catch (error) {
		// Only ENOENT means no marker; a transient EACCES/EIO read failure
		// must propagate so a valid marker is never treated as absent.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	try {
		let marker: Record<string, unknown>;
		try {
			marker = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			// Malformed marker contents are invalid ownership evidence; treat as
			// no marker (only actual read failures propagate above).
			return false;
		}
		if (
			marker.version !== WORKFLOW_MIGRATION_MARKER_VERSION ||
			marker.status !== "complete" ||
			typeof marker.sourcePath !== "string" ||
			path.resolve(marker.sourcePath) !== path.resolve(sourcePath) ||
			typeof marker.backupPath !== "string" ||
			path.resolve(marker.backupPath) !== path.resolve(`${sourcePath}.bak`) ||
			typeof marker.targetPath !== "string" ||
			path.resolve(marker.targetPath) !== path.resolve(getAgentDir(), "config.yml") ||
			typeof marker.sourceSha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(marker.sourceSha256) ||
			typeof marker.startedAt !== "string" ||
			Number.isNaN(Date.parse(marker.startedAt)) ||
			typeof marker.completedAt !== "string" ||
			Number.isNaN(Date.parse(marker.completedAt)) ||
			!Array.isArray(marker.migratedKeys) ||
			!marker.migratedKeys.every(key => typeof key === "string" && WORKFLOW_MIGRATION_KEYS.includes(key))
		) {
			return false;
		}
		// A symlinked agent dir REPOINTED after migration changes the canonical
		// target identity. The marker stores the canonical agent dir at migration
		// time; compare the CURRENT canonical dir against it (comparing two
		// current resolutions alone cannot detect a repoint).
		if (typeof marker.canonicalTargetDir === "string") {
			const currentCanonicalAgentDir = await fs.realpath(getAgentDir()).catch(() => getAgentDir());
			if (marker.canonicalTargetDir !== currentCanonicalAgentDir) {
				return false;
			}
		}
		// A same-pathname profile REPLACEMENT (deleted + recreated) changes the
		// target config.yml's dev:ino; the marker records the identity at
		// migration time.
		if (typeof marker.canonicalTargetIdentity === "string") {
			const currentTargetIdentity = await fs.stat(getAgentDir()).catch(() => null);
			if (
				!currentTargetIdentity ||
				`${currentTargetIdentity.dev}:${currentTargetIdentity.ino}` !== marker.canonicalTargetIdentity
			) {
				return false;
			}
		}
		try {
			// Hash the raw source bytes (Bun.file contract; matches the
			// migration's raw-Buffer hash).
			const sourceRaw = await Bun.file(sourcePath).arrayBuffer();
			return createHash("sha256").update(Buffer.from(sourceRaw)).digest("hex") === marker.sourceSha256;
		} catch {
			return false;
		}
	} catch {
		return false;
	}
}

/**
 * Matches Settings.#coerceWorkflowScalar: the migration writes quoted numerics
 * as numbers into config.yml, so the ownership comparison must coerce the
 * backup's raw JSON value before comparing against the agent-config value.
 * Only autoHandoff is a string key among the migrated workflow settings.
 */
function coerceWorkflowScalar(key: WorkflowSettingKey, value: unknown): unknown {
	if (
		key !== "gjc.ralplan.autoHandoff" &&
		typeof value === "string" &&
		value.trim() !== "" &&
		Number.isFinite(Number(value))
	) {
		return Number(value);
	}
	return value;
}
/**
 * When a completed migration's legacy source was EDITED or DELETED afterwards
 * (the marker hash no longer matches), the agent-config layer still holds the
 * migration-written value for the marker's keys. Direct workflow commands
 * (`gjc ralplan`/`deep-interview`/`ultragoal`) invoke the runtime without
 * running Settings' reconcile, so the resolver must disregard those
 * migration-owned agent values - otherwise the edited legacy value is shadowed
 * and an invalid strict edit cannot exit 2.
 *
 * Returns the owned keys whose CURRENT agent-config value still matches the
 * migration's write (the backup copy), or null when there is no stale
 * DEFAULT-profile complete marker. A key whose agent value the user edited
 * after migration is NOT owned (it is a genuine override). The marker's
 * targetPath must be the current agent config: a custom agentDir profile that
 * never received the migration is never suppressed.
 */
async function getStaleMigrationOwnedKeys(sourcePath: string): Promise<ReadonlySet<WorkflowSettingKey> | null> {
	const markerPath = `${sourcePath}.migrated`;
	let raw: string;
	try {
		raw = await Bun.file(markerPath).text();
	} catch (error) {
		// Only ENOENT means no marker; a transient EACCES/EIO read failure
		// must propagate so a valid marker is never treated as absent.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		let marker: Record<string, unknown>;
		try {
			marker = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			// Malformed marker contents are invalid ownership evidence (direct
			// commands do not run the Settings quarantine path); treat as no
			// marker - only actual read failures propagate (above).
			return null;
		}
		if (
			marker.version !== WORKFLOW_MIGRATION_MARKER_VERSION ||
			(marker.status !== "complete" && marker.status !== "pending") ||
			typeof marker.sourcePath !== "string" ||
			path.resolve(marker.sourcePath) !== path.resolve(sourcePath) ||
			typeof marker.backupPath !== "string" ||
			path.resolve(marker.backupPath) !== path.resolve(`${sourcePath}.bak`) ||
			typeof marker.targetPath !== "string" ||
			path.resolve(marker.targetPath) !== path.resolve(getAgentDir(), "config.yml") ||
			typeof marker.sourceSha256 !== "string" ||
			!Array.isArray(marker.migratedKeys)
		) {
			return null;
		}
		// A same-pathname profile REPLACEMENT changes the target config.yml's
		// dev:ino; the marker records the identity at migration time.
		if (typeof marker.canonicalTargetIdentity === "string") {
			const currentTargetIdentity = await fs.stat(getAgentDir()).catch(() => null);
			if (
				!currentTargetIdentity ||
				`${currentTargetIdentity.dev}:${currentTargetIdentity.ino}` !== marker.canonicalTargetIdentity
			) {
				return null;
			}
		}
		// A symlinked agent dir repointed after migration changes the canonical
		// target identity: the marker must have been created for the CURRENT
		// canonical agent dir, or the new profile never received the migration.
		if (typeof marker.canonicalTargetDir === "string") {
			const currentCanonicalAgentDir = await fs.realpath(getAgentDir()).catch(() => getAgentDir());
			if (marker.canonicalTargetDir !== currentCanonicalAgentDir) {
				return null;
			}
		}
		let sourceRaw: string | null = null;
		try {
			sourceRaw = await Bun.file(sourcePath).text();
		} catch (error) {
			// Only ENOENT means a deleted source; a transient EACCES/EIO read
			// failure must propagate so the migration-owned agent value never
			// silently wins over the strict error or a lower-layer default.
			if (!isEnoent(error)) throw error;
			// Deleted source: the migration treats deletion as a request to drop
			// the copied values, so all migration-owned agent values are stale.
		}
		// A completed migration whose source matches is fully done. A PENDING
		// reconcile marker (priorSourceSha256) recorded the edited source hash
		// BEFORE repairing the target: the agent config still holds the OLD
		// migration value, so the stale-owned keys must still be computed from
		// the prior backup, not treated as completed.
		if (
			sourceRaw !== null &&
			createHash("sha256").update(sourceRaw).digest("hex") === marker.sourceSha256 &&
			marker.priorSourceSha256 === undefined
		) {
			return null;
		}
		let backupRaw: string;
		try {
			// The backup must hash to the marker's sourceSha256 (completed) OR to
			// priorSourceSha256 (a pending reconcile before its refresh): an
			// altered backup is not evidence of what the migration wrote.
			const backupBytes = await Bun.file(marker.backupPath).arrayBuffer();
			const backupHash = createHash("sha256").update(Buffer.from(backupBytes)).digest("hex");
			if (backupHash !== marker.sourceSha256 && backupHash !== marker.priorSourceSha256) {
				return null;
			}
			// Parse the SAME bytes that were verified (a second read could observe
			// a different revision if the file changed between the two reads).
			backupRaw = Buffer.from(backupBytes).toString("utf8");
		} catch {
			return null;
		}
		const backupDoc = JSON.parse(backupRaw) as unknown;
		let agentRaw: string;
		try {
			agentRaw = await Bun.file(path.resolve(getAgentDir(), "config.yml")).text();
		} catch {
			return null;
		}
		// A malformed agent config.yml cannot evidence migration ownership: a
		// syntax error must not escape through the outer catch (which only
		// propagates transient read failures) and crash tolerant resolution.
		// Defer to the regular layer parser, which reports an invalid
		// diagnostic and continues to the legacy layer/default.
		let agentDoc: unknown;
		try {
			agentDoc = YAML.parse(agentRaw);
		} catch {
			return null;
		}
		const owned = new Set<WorkflowSettingKey>();
		for (const key of marker.migratedKeys) {
			if (typeof key !== "string" || !WORKFLOW_MIGRATION_KEYS.includes(key)) continue;
			const migrated = extractWorkflowSetting(backupDoc, key as WorkflowSettingKey);
			const agentValue = extractWorkflowSetting(agentDoc, key as WorkflowSettingKey, { flat: false });
			// Only treat the agent value as migration-owned while it still matches
			// the migration's write (the backup): a value the user edited after
			// migration is a genuine override and must win.
			const repairHashes = marker.repairValueHashes as Record<string, string> | undefined;
			if (
				agentValue.present &&
				((migrated.present &&
					agentValue.value === coerceWorkflowScalar(key as WorkflowSettingKey, migrated.value)) ||
					// A reconcile that COMMITTED its repairs left the recorded
					// repair values in the agent config: honor them even when the
					// backup is not yet refreshed. A mere change from the
					// pre-repair state is NOT proof (a coincidental user value
					// could match).
					(marker.repairsApplied === true &&
						repairHashes?.[key as string] !== undefined &&
						createHash("sha256").update(JSON.stringify(agentValue.value)).digest("hex") ===
							repairHashes?.[key as string]))
			) {
				owned.add(key as WorkflowSettingKey);
			}
		}
		return owned;
	} catch (error) {
		// Only ENOENT (a missing marker/backup/source) means no stale ownership;
		// a transient EACCES/EIO read failure must propagate so the
		// migration-owned agent value is never treated as a genuine override.
		if (!isEnoent(error)) throw error;
		return null;
	}
}

/**
 * Extract a workflow key from a parsed settings document. Flat dotted keys are
 * honored only for legacy JSON settings files (settings.json) - config.yml uses
 * the nested (schema) form, so the public Settings/config CLI path (which
 * addresses nested paths) can manage every effective override. Flat keys are
 * checked before the nested `gjc: { ... }` shape (flat wins); an explicitly
 * present `undefined` value counts as present.
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
 * Resolve a workflow setting across the fixed five-layer precedence. Returns the
 * first valid configured value, otherwise {@link options.defaultValue} with
 * `source: "default"`. Diagnostics are retained for unit tests and optional
 * logging; runtime public wrappers expose their existing compact result shapes.
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
	// Stale migration ownership is relevant only when considering the
	// agent-config layer; compute it lazily there so a transient marker read
	// failure cannot block higher-precedence project configuration.
	let staleMigrationOwnedKeys: ReadonlySet<WorkflowSettingKey> | null | undefined;

	for (const candidate of LAYER_CANDIDATES) {
		const candidatePath = candidate.buildPath(cwd);
		// Direct workflow commands never run Settings' reconcile: when the
		// config-root legacy source was edited after a completed migration, the
		// agent-config layer still holds the stale migration-written value for
		// the marker's keys - disregard it so the edited legacy value is
		// effective (an invalid strict edit must exit 2).
		if (candidate.layer === "agent-config") {
			if (staleMigrationOwnedKeys === undefined) {
				staleMigrationOwnedKeys = await getStaleMigrationOwnedKeys(
					path.resolve(getConfigRootDir(), "settings.json"),
				);
			}
			if (staleMigrationOwnedKeys?.has(key)) {
				continue;
			}
		}
		// A completed one-time migration deactivates the legacy config-root
		// source: never fall back to its stale values (removing a migrated
		// target key returns to the default, not the legacy value).
		if (candidate.layer === "config-root-settings" && (await isConfigRootMigrationComplete(candidatePath))) {
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
		// Only a genuinely EMPTY file is "no explicit settings" - and empty
		// content is valid YAML (an empty document) but INVALID JSON, so an
		// empty settings.json must fall through to JSON.parse and strict ralplan
		// fails closed (exit 2) on the malformed explicit layer. The literal
		// text `undefined` likewise falls through to JSON.parse.
		if (trimmed === "" && candidate.format !== "json") {
			diagnostics.push({
				layer: candidate.layer,
				path: candidatePath,
				format: candidate.format,
				status: "empty-document",
			});
			continue;
		}

		let parsed: unknown;
		try {
			parsed = candidate.format === "yaml" ? YAML.parse(raw) : JSON.parse(raw);
		} catch {
			// Stable, caller-agnostic reason; the underlying parse detail is not
			// part of the runtime error contract.
			const diagnostic = invalid(
				candidate.layer,
				candidatePath,
				candidate.format,
				"syntax",
				candidate.format === "json" ? "malformed JSON" : "malformed YAML",
			);
			if (invalidPolicy === "throw") throw new WorkflowSettingError(diagnostic);
			diagnostics.push(diagnostic);
			continue;
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

	return { value: options.defaultValue, source: "default", diagnostics };
}
