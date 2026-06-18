import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { YAML } from "bun";

export type ExternalRootSurveyDepth = "inventory" | "config" | "deep";
export type ExternalRootSurveyAnchor = "home" | "claude" | "codex" | "gemini" | "hermes";

export type ProviderAnchor = Exclude<ExternalRootSurveyAnchor, "home">;
type SurveyMode = "explicit-survey";
type ConfigKind = "json" | "toml" | "yaml" | "markdown";

export interface ExternalRootSurveyFlags {
	depth?: string;
	anchor?: string[];
	maxBytes?: string;
	maxEntries?: string;
	timeoutMs?: string;
	sampleLimit?: string;
	report?: boolean;
	home?: string;
}

interface ExternalRootSurveyCaps {
	maxBytes: number;
	maxEntries: number;
	timeoutMs: number;
	sampleLimit: number;
}

interface ExternalRootSurveyObservation {
	mode: SurveyMode;
	depth: ExternalRootSurveyDepth;
	anchor: ExternalRootSurveyAnchor;
	kind: string;
	path: string;
	data: Record<string, unknown>;
}

interface ExternalRootSurveyNotice {
	mode: SurveyMode;
	depth: ExternalRootSurveyDepth;
	anchor?: ExternalRootSurveyAnchor;
	path?: string;
	reason: string;
	cap?: number;
}

export interface ExternalRootSurveyResult {
	ok: boolean;
	mode: SurveyMode;
	depth: ExternalRootSurveyDepth;
	anchors: ExternalRootSurveyAnchor[];
	home: string;
	caps: ExternalRootSurveyCaps;
	observations: ExternalRootSurveyObservation[];
	skipped: ExternalRootSurveyNotice[];
	warnings: ExternalRootSurveyNotice[];
	counters: Record<string, number>;
	catalog: ExternalRootSurveyCatalog;
	elapsed_ms: number;
}

export type ExternalRootSurveyTreatment = "absorb" | "wrap_catalog" | "optional_template" | "role_guidance" | "exclude";
export type ExternalRootSurveySensitivity = "low" | "medium" | "high" | "blocked";
export type ExternalRootSurveyCatalogStatus = "candidate" | "cataloged" | "excluded";

export interface ExternalRootSurveyCatalogCandidate {
	source_family: ProviderAnchor | "cross-source";
	asset_name: string;
	source_path_kind: string;
	sensitivity: ExternalRootSurveySensitivity;
	target_surface: string;
	treatment: ExternalRootSurveyTreatment;
	summary: string;
	excluded_raw_material: string[];
	required_reviews: string[];
	tests: string[];
	status: ExternalRootSurveyCatalogStatus;
	evidence_paths: string[];
}

export interface ExternalRootSurveyCatalogExclusion {
	source_family: ProviderAnchor | "cross-source";
	path: string;
	excluded_kind: string;
	reason: string;
	sensitivity: ExternalRootSurveySensitivity;
}

export interface ExternalRootSurveyCatalog {
	candidates: ExternalRootSurveyCatalogCandidate[];
	exclusions: ExternalRootSurveyCatalogExclusion[];
	summary: {
		candidates_detected: number;
		candidates_cataloged: number;
		assets_absorbed: number;
		assets_wrapped: number;
		assets_excluded: number;
		redactions_applied: number;
		by_source_family: Record<string, number>;
		by_treatment: Record<string, number>;
		by_sensitivity: Record<string, number>;
		by_target_surface: Record<string, number>;
	};
}

interface ProviderDefinition {
	rootName: string;
	inventoryFiles: readonly string[];
	inventoryDirs: readonly string[];
	configFiles: readonly string[];
	sqliteFiles: readonly string[];
	logDirs: readonly string[];
	skillDirs: readonly string[];
	hookConfigFiles: readonly string[];
}

const PROVIDER_ANCHORS: readonly ProviderAnchor[] = ["claude", "codex", "gemini", "hermes"];
const ALL_ANCHORS: readonly ExternalRootSurveyAnchor[] = ["home", ...PROVIDER_ANCHORS];

const DEPTH_DEFAULT_CAPS: Record<ExternalRootSurveyDepth, ExternalRootSurveyCaps> = {
	inventory: { maxBytes: 0, maxEntries: 128, timeoutMs: 3000, sampleLimit: 0 },
	config: { maxBytes: 256 * 1024, maxEntries: 128, timeoutMs: 5000, sampleLimit: 0 },
	deep: { maxBytes: 1024 * 1024, maxEntries: 256, timeoutMs: 10_000, sampleLimit: 0 },
};
const HARD_CAPS: ExternalRootSurveyCaps = {
	maxBytes: 8 * 1024 * 1024,
	maxEntries: 1000,
	timeoutMs: 30_000,
	sampleLimit: 10,
};


const DEFINITIONS: Record<ProviderAnchor, ProviderDefinition> = {
	claude: {
		rootName: ".claude",
		inventoryFiles: ["../.claude.json", "settings.json", "history.jsonl"],
		inventoryDirs: ["hooks", "plugins", "sessions", "skills", "commands", "projects"],
		configFiles: ["../.claude.json", "settings.json", "settings.local.json", "CLAUDE.md"],
		sqliteFiles: [],
		logDirs: ["logs"],
		skillDirs: ["skills", "commands"],
		hookConfigFiles: ["../.claude.json", "settings.json", "settings.local.json"],
	},
	codex: {
		rootName: ".codex",
		inventoryFiles: ["config.toml", "auth.json", ".codex-global-state.json", "logs_2.sqlite", "state_5.sqlite", "memories_1.sqlite", "goals_1.sqlite"],
		inventoryDirs: ["skills", "prompts", "agents", "memories", "shell_snapshots", "log", "archived_sessions", "sqlite"],
		configFiles: ["config.toml", "AGENTS.md", "auth.json"],
		sqliteFiles: ["logs_2.sqlite", "state_5.sqlite", "memories_1.sqlite", "goals_1.sqlite", "sqlite/logs_2.sqlite", "sqlite/state_5.sqlite", "sqlite/memories_1.sqlite", "sqlite/goals_1.sqlite"],
		logDirs: ["log"],
		skillDirs: ["skills", "prompts", "agents"],
		hookConfigFiles: ["config.toml"],
	},
	gemini: {
		rootName: ".gemini",
		inventoryFiles: ["GEMINI.md", "settings.json", "projects.json"],
		inventoryDirs: ["config", "antigravity", "antigravity-ide", "history", "antigravity-browser-profile", "extensions"],
		configFiles: ["GEMINI.md", "settings.json", "projects.json", "config/config.json"],
		sqliteFiles: ["peer.db"],
		logDirs: ["logs"],
		skillDirs: ["extensions", "antigravity/brain"],
		hookConfigFiles: ["settings.json"],
	},
	hermes: {
		rootName: ".hermes",
		inventoryFiles: ["config.yaml", "SOUL.md", "state.db", "state.db-wal", "state.db-shm"],
		inventoryDirs: ["skills", "cache", "hermes-agent", "logs", "sessions", "state"],
		configFiles: ["config.yaml", "SOUL.md"],
		sqliteFiles: ["state.db"],
		logDirs: ["logs"],
		skillDirs: ["skills", "hermes-agent"],
		hookConfigFiles: ["config.yaml"],
	},
};

const SECRET_KEY_PATTERN = /(api[_-]?key|secret|token|password|passwd|credential|private|bearer|authorization|auth|cookie|session|oauth)/i;
const SECRET_KEY_VALUE_PATTERN = /\b(api[_-]?key|secret|token|password|passwd|credential|private[_-]?key|bearer|authorization|auth|cookie|session|oauth)\b\s*[:=]\s*['"]?[^'"\s,;}]+/gi;
const SECRET_VALUE_REDACTION_PATTERN = /(sk-[A-Za-z0-9_-]{12,}|ya29\.[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+|Bearer\s+\S+|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,})/g;
const SECRET_VALUE_TEST_PATTERN = /(sk-[A-Za-z0-9_-]{12,}|ya29\.[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+|Bearer\s+\S+|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,})/;
const SUSPICIOUS_IDENTIFIER_PATTERN = /^[A-Za-z0-9_\-./+=]{48,}$/;
const LOG_FILE_PATTERN = /\.(?:log|out|err|txt|ndjson|jsonl)$/i;
const MARKDOWN_FILE_PATTERN = /\.(?:md|mdx)$/i;

export async function runExternalRootSurvey(flags: ExternalRootSurveyFlags): Promise<ExternalRootSurveyResult> {
	const started = Date.now();
	const depth = parseDepth(flags.depth);
	const caps = parseCaps(flags, depth);
	const home = path.resolve(expandHome(flags.home?.trim() || os.homedir()));
	const requestedAnchors = parseAnchors(flags.anchor);
	const effectiveAnchors = resolveAnchors(depth, requestedAnchors);
	const result: ExternalRootSurveyResult = {
		ok: true,
		mode: "explicit-survey",
		depth,
		anchors: effectiveAnchors,
		home,
		caps,
		observations: [],
		skipped: [],
		warnings: [],
		counters: {},
		catalog: createEmptyAbsorptionCatalog(),
		elapsed_ms: 0,
	};
	const deadline = started + caps.timeoutMs;

	try {
		if (depth === "inventory") await runInventorySurvey(home, effectiveAnchors, result, deadline);
		else if (depth === "config") await runConfigSurvey(home, effectiveAnchors, result, deadline);
		else await runDeepSurvey(home, effectiveAnchors, result, deadline);
	} catch (error) {
		result.ok = false;
		addWarning(result, { reason: sanitizeError(error) });
	} finally {
		result.catalog = buildAbsorptionCatalog(result);
		result.elapsed_ms = Date.now() - started;
	}

	return result;
}

export function formatExternalRootSurveyResult(result: ExternalRootSurveyResult): string {
	const lines = [
		`External root survey: ${result.ok ? "ok" : "failed"}`,
		`mode=${result.mode} depth=${result.depth} anchors=${result.anchors.join(",")} elapsed_ms=${result.elapsed_ms}`,
		`observations=${result.observations.length} skipped=${result.skipped.length} warnings=${result.warnings.length}`,
		`catalog_candidates=${result.catalog.summary.candidates_detected} catalog_exclusions=${result.catalog.summary.assets_excluded}`,
	];
	for (const observation of result.observations.slice(0, 20)) {
		lines.push(`- [${observation.anchor}] ${observation.kind}: ${observation.path}`);
	}
	if (result.observations.length > 20) lines.push(`- ... ${result.observations.length - 20} more observations`);
	return lines.join("\n");
}

export function formatExternalRootSurveyCatalogReport(result: ExternalRootSurveyResult): string {
	const lines = [
		"External root absorption catalog",
		`mode=${result.mode} depth=${result.depth} anchors=${result.anchors.join(",")} elapsed_ms=${result.elapsed_ms}`,
		`candidates=${result.catalog.summary.candidates_detected} exclusions=${result.catalog.summary.assets_excluded} redactions=${result.catalog.summary.redactions_applied}`,
		"",
		"Candidates:",
	];
	if (result.catalog.candidates.length === 0) {
		lines.push("- none detected from the capped survey sample");
	} else {
		for (const candidate of result.catalog.candidates) {
			lines.push(
				`- [${candidate.source_family}] ${candidate.asset_name} -> ${candidate.target_surface} (${candidate.treatment}, ${candidate.sensitivity})`,
				`  summary: ${candidate.summary}`,
				`  excluded: ${candidate.excluded_raw_material.join(", ")}`,
			);
		}
	}
	lines.push("", "Exclusions:");
	if (result.catalog.exclusions.length === 0) {
		lines.push("- none");
	} else {
		for (const exclusion of result.catalog.exclusions.slice(0, 40)) {
			lines.push(`- [${exclusion.source_family}] ${exclusion.path}: ${exclusion.excluded_kind} (${exclusion.reason})`);
		}
		if (result.catalog.exclusions.length > 40) lines.push(`- ... ${result.catalog.exclusions.length - 40} more exclusions`);
	}
	lines.push("", "Summary by treatment:");
	for (const [treatment, count] of Object.entries(result.catalog.summary.by_treatment)) {
		lines.push(`- ${treatment}: ${count}`);
	}
	return lines.join("\n");
}

async function runInventorySurvey(
	home: string,
	anchors: readonly ExternalRootSurveyAnchor[],
	result: ExternalRootSurveyResult,
	deadline: number,
): Promise<void> {
	for (const anchor of anchors) {
		ensureWithinDeadline(deadline);
		if (anchor === "home") {
			await observeExactPath(home, "home", home, "home_root", result, deadline);
			for (const entry of [".claude", ".claude.json", ".codex", ".gemini", ".hermes"]) {
				await observeExactPath(home, "home", path.join(home, entry), "home_named_anchor", result, deadline);
			}
			continue;
		}
		await observeProviderInventory(home, anchor, result, deadline);
	}
}

async function runConfigSurvey(
	home: string,
	anchors: readonly ExternalRootSurveyAnchor[],
	result: ExternalRootSurveyResult,
	deadline: number,
): Promise<void> {
	for (const anchor of providerAnchorsOnly(anchors)) {
		ensureWithinDeadline(deadline);
		await observeProviderInventory(home, anchor, result, deadline);
		for (const relativePath of DEFINITIONS[anchor].configFiles) {
			await observeConfigFile(home, anchor, relativePath, result, deadline, false);
		}
	}
}

async function runDeepSurvey(
	home: string,
	anchors: readonly ExternalRootSurveyAnchor[],
	result: ExternalRootSurveyResult,
	deadline: number,
): Promise<void> {
	for (const anchor of providerAnchorsOnly(anchors)) {
		ensureWithinDeadline(deadline);
		await observeProviderInventory(home, anchor, result, deadline);
		const definition = DEFINITIONS[anchor];
		for (const relativePath of definition.configFiles) {
			await observeConfigFile(home, anchor, relativePath, result, deadline, true);
		}
		for (const relativePath of definition.sqliteFiles) {
			await observeSqlite(home, anchor, relativePath, result, deadline);
		}
		for (const relativePath of definition.logDirs) {
			await observeLogSummaries(home, anchor, relativePath, result, deadline);
		}
		for (const relativePath of definition.skillDirs) {
			await observeSkillInventory(home, anchor, relativePath, result, deadline);
		}
	}
}

async function observeProviderInventory(
	home: string,
	anchor: ProviderAnchor,
	result: ExternalRootSurveyResult,
	deadline: number,
): Promise<void> {
	const definition = DEFINITIONS[anchor];
	const root = rootFor(home, anchor);
	await observeExactPath(home, anchor, root, "anchor_root", result, deadline);
	for (const relativePath of definition.inventoryFiles) {
		await observeExactPath(home, anchor, anchorPath(home, anchor, relativePath), "allowlisted_file", result, deadline);
	}
	for (const relativePath of definition.inventoryDirs) {
		await observeExactPath(home, anchor, anchorPath(home, anchor, relativePath), "allowlisted_directory", result, deadline);
	}
}

async function observeExactPath(
	home: string,
	anchor: ExternalRootSurveyAnchor,
	fullPath: string,
	kind: string,
	result: ExternalRootSurveyResult,
	deadline: number,
): Promise<void> {
	ensureWithinDeadline(deadline);
	increment(result, "stat_calls");
	const stat = await safeStat(fullPath);
	if (!stat) {
		addSkip(result, { anchor, path: displayPath(home, fullPath), reason: "missing" });
		return;
	}
	const data = statSummary(stat);
	if (stat.isDirectory()) {
		try {
			const counts = await shallowDirectoryCounts(fullPath, result.caps.maxEntries, result, deadline);
			Object.assign(data, counts);
		} catch (error) {
			addWarning(result, { anchor, path: displayPath(home, fullPath), reason: `directory_count_failed:${sanitizeError(error)}` });
		}
	}
	addObservation(result, { anchor, kind, path: displayPath(home, fullPath), data });
}

async function observeConfigFile(
	home: string,
	anchor: ProviderAnchor,
	relativePath: string,
	result: ExternalRootSurveyResult,
	deadline: number,
	includeHookInventory: boolean,
): Promise<void> {
	ensureWithinDeadline(deadline);
	const fullPath = anchorPath(home, anchor, relativePath);
	increment(result, "stat_calls");
	const stat = await safeStat(fullPath);
	if (!stat) {
		addSkip(result, { anchor, path: displayPath(home, fullPath), reason: "missing" });
		return;
	}
	if (!stat.isFile()) {
		addSkip(result, { anchor, path: displayPath(home, fullPath), reason: "not_file" });
		return;
	}
	const content = await readCappedText(home, anchor, fullPath, result, stat.size);
	if (!content) return;
	const kind = configKind(fullPath);
	const data = summarizeConfig(content.text, kind, summaryLimit(result.caps));
	Object.assign(data, {
		size: stat.size,
		bytes_read: content.bytesRead,
		truncated: content.truncated,
	});
	addObservation(result, { anchor, kind: `config_${kind}`, path: displayPath(home, fullPath), data });
	if (includeHookInventory && DEFINITIONS[anchor].hookConfigFiles.includes(relativePath)) {
		summarizeHookCommands(home, anchor, fullPath, kind, content.text, result);
	}
}

async function observeSqlite(
	home: string,
	anchor: ProviderAnchor,
	relativePath: string,
	result: ExternalRootSurveyResult,
	deadline: number,
): Promise<void> {
	ensureWithinDeadline(deadline);
	const fullPath = anchorPath(home, anchor, relativePath);
	increment(result, "stat_calls");
	const stat = await safeStat(fullPath);
	if (!stat) {
		addSkip(result, { anchor, path: displayPath(home, fullPath), reason: "missing" });
		return;
	}
	if (!stat.isFile()) {
		addSkip(result, { anchor, path: displayPath(home, fullPath), reason: "not_file" });
		return;
	}
	let db: Database | undefined;
	try {
		increment(result, "sqlite_open_attempts");
		db = new Database(fullPath, { readonly: true, strict: true });
		db.run("PRAGMA query_only = ON");
		db.run(`PRAGMA busy_timeout = ${Math.min(result.caps.timeoutMs, 3000)}`);
		const pageCount = scalarPragmaNumber(db, "page_count");
		const pageSize = scalarPragmaNumber(db, "page_size");
		const tableRows = db
			.prepare<{ name: string; sql: string | null }, [number]>(
				"SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE LIMIT ?",
			)
			.all(result.caps.maxEntries);
		const tables = [];
		for (const table of tableRows) {
			ensureWithinDeadline(deadline);
			const columns = db
				.prepare<{ name: string; type: string }, []>(`PRAGMA table_info(${quoteSqliteIdentifier(table.name)})`)
				.all()
				.map(column => ({ name: safeIdentifier(column.name), type: safeIdentifier(column.type || "unknown") }));
			let rowCount: number | undefined;
			let rowCountSkippedReason: string | undefined;
			if (stat.size <= result.caps.maxBytes) {
				try {
					const row = db.prepare<{ count: number }, []>(`SELECT count(*) AS count FROM ${quoteSqliteIdentifier(table.name)}`).get();
					rowCount = row?.count;
				} catch {
					rowCountSkippedReason = "count_failed";
				}
			} else {
				rowCountSkippedReason = "database_exceeds_max_bytes_for_counts";
			}
			tables.push({
				name: safeIdentifier(table.name),
				column_count: columns.length,
				columns: columns.slice(0, summaryLimit(result.caps)),
				...(rowCount !== undefined ? { row_count: rowCount } : { row_count_skipped: rowCountSkippedReason }),
			});
		}
		addObservation(result, {
			anchor,
			kind: "sqlite_schema",
			path: displayPath(home, fullPath),
			data: {
				size: stat.size,
				page_count: pageCount,
				page_size: pageSize,
				table_count_sampled: tables.length,
				tables,
				truncated: tableRows.length >= result.caps.maxEntries,
				row_samples: 0,
			},
		});
	} catch (error) {
		addWarning(result, { anchor, path: displayPath(home, fullPath), reason: `sqlite_read_failed:${sanitizeError(error)}` });
	} finally {
		db?.close();
	}
}

async function observeLogSummaries(
	home: string,
	anchor: ProviderAnchor,
	relativePath: string,
	result: ExternalRootSurveyResult,
	deadline: number,
): Promise<void> {
	ensureWithinDeadline(deadline);
	const dir = anchorPath(home, anchor, relativePath);
	const entries = await safeReadDir(dir);
	increment(result, "list_calls");
	if (!entries) {
		addSkip(result, { anchor, path: displayPath(home, dir), reason: "missing" });
		return;
	}
	const summaries = [];
	for (const entry of entries.slice(0, result.caps.maxEntries)) {
		ensureWithinDeadline(deadline);
		if (!entry.isFile() || !LOG_FILE_PATTERN.test(entry.name)) continue;
		const fullPath = path.join(dir, entry.name);
		increment(result, "stat_calls");
		const stat = await safeStat(fullPath);
		if (!stat?.isFile()) continue;
		const content = await readCappedText(home, anchor, fullPath, result, stat.size, Math.min(result.caps.maxBytes, 256 * 1024));
		if (!content) continue;
		summaries.push({
			name: safeIdentifier(entry.name),
			size: stat.size,
			bytes_read: content.bytesRead,
			truncated: content.truncated,
			...summarizeLogContent(content.text, result.caps),
		});
		if (summaries.length >= summaryLimit(result.caps)) break;
	}
	addObservation(result, {
		anchor,
		kind: "log_summary",
		path: displayPath(home, dir),
		data: { files: summaries, truncated: entries.length > result.caps.maxEntries || summaries.length >= summaryLimit(result.caps) },
	});
}

async function observeSkillInventory(
	home: string,
	anchor: ProviderAnchor,
	relativePath: string,
	result: ExternalRootSurveyResult,
	deadline: number,
): Promise<void> {
	ensureWithinDeadline(deadline);
	const dir = anchorPath(home, anchor, relativePath);
	const entries = await safeReadDir(dir);
	increment(result, "list_calls");
	if (!entries) {
		addSkip(result, { anchor, path: displayPath(home, dir), reason: "missing" });
		return;
	}
	const items = [];
	for (const entry of entries.slice(0, result.caps.maxEntries)) {
		ensureWithinDeadline(deadline);
		const candidate = skillCandidatePath(dir, entry);
		if (!candidate) continue;
		increment(result, "stat_calls");
		const stat = await safeStat(candidate);
		if (!stat?.isFile()) continue;
		const content = await readCappedText(home, anchor, candidate, result, stat.size);
		if (!content) continue;
		const summary = summarizeMarkdown(content.text, summaryLimit(result.caps));
		items.push({
			name: safeIdentifier(entry.name),
			path: displayPath(home, candidate),
			size: stat.size,
			bytes_read: content.bytesRead,
			truncated: content.truncated,
			...summary,
		});
		if (items.length >= summaryLimit(result.caps)) break;
	}
	addObservation(result, {
		anchor,
		kind: "skill_frontmatter_inventory",
		path: displayPath(home, dir),
		data: { items, truncated: entries.length > result.caps.maxEntries || items.length >= summaryLimit(result.caps) },
	});
}

function createEmptyAbsorptionCatalog(): ExternalRootSurveyCatalog {
	return {
		candidates: [],
		exclusions: [],
		summary: summarizeAbsorptionCatalog([], [], 0),
	};
}

function buildAbsorptionCatalog(result: ExternalRootSurveyResult): ExternalRootSurveyCatalog {
	const candidates = buildAbsorptionCandidates(result);
	const exclusions = buildAbsorptionExclusions(result);
	const redactionsApplied = countRedactionMarkers(result);
	return {
		candidates,
		exclusions,
		summary: summarizeAbsorptionCatalog(candidates, exclusions, redactionsApplied),
	};
}

function buildAbsorptionCandidates(result: ExternalRootSurveyResult): ExternalRootSurveyCatalogCandidate[] {
	const candidates: ExternalRootSurveyCatalogCandidate[] = [];
	const seen = new Set<string>();

	for (const observation of result.observations) {
		if (observation.anchor === "home" || observation.kind !== "skill_frontmatter_inventory") continue;
		const items = observation.data.items;
		if (!Array.isArray(items)) continue;

		for (const item of items) {
			if (!item || typeof item !== "object") continue;
			const record = item as Record<string, unknown>;
			const assetName = candidateAssetName(record);
			const evidencePath = typeof record.path === "string" ? record.path : observation.path;
			const key = `${observation.anchor}\0${evidencePath}\0${assetName}`;
			if (seen.has(key)) continue;
			seen.add(key);

			candidates.push({
				source_family: observation.anchor,
				asset_name: assetName,
				source_path_kind: inferCandidatePathKind(observation.path, evidencePath),
				sensitivity: inferCandidateSensitivity(observation.path, evidencePath),
				target_surface: "reviewed optional catalog entry",
				treatment: "wrap_catalog",
				summary: candidateSummary(record),
				excluded_raw_material: [
					"raw prompt/body text",
					"session transcripts",
					"logs and SQLite rows",
					"credentials, env values, headers, and hook command bodies",
				],
				required_reviews: ["maintainer", "privacy/security"],
				tests: ["synthetic fixture classification", "negative leakage check", "disabled-by-default behavior"],
				status: "candidate",
				evidence_paths: [evidencePath],
			});
		}
	}

	return candidates;
}

function candidateAssetName(record: Record<string, unknown>): string {
	for (const key of ["declared_name", "name"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return safeIdentifier(value);
	}
	return "unnamed-external-asset";
}

function candidateSummary(record: Record<string, unknown>): string {
	const description = record.declared_description;
	if (typeof description === "string" && description.trim()) return safeText(description, 240);
	return "External asset discovered through capped frontmatter/heading inventory; review before reuse.";
}

function inferCandidatePathKind(observationPath: string, evidencePath: string): string {
	const combined = `${observationPath}/${evidencePath}`.toLowerCase();
	if (combined.includes("agent")) return "agent";
	if (combined.includes("prompt")) return "prompt";
	if (combined.includes("extension")) return "extension";
	if (combined.includes("brain")) return "brain-overlay";
	if (combined.includes("command")) return "command";
	return "skill";
}

function inferCandidateSensitivity(observationPath: string, evidencePath: string): ExternalRootSurveySensitivity {
	const combined = `${observationPath}/${evidencePath}`.toLowerCase();
	if (combined.includes("brain") || combined.includes("agent") || combined.includes("prompt")) return "high";
	return "medium";
}

function buildAbsorptionExclusions(result: ExternalRootSurveyResult): ExternalRootSurveyCatalogExclusion[] {
	const exclusions: ExternalRootSurveyCatalogExclusion[] = [];
	const seen = new Set<string>();

	for (const observation of result.observations) {
		if (observation.anchor === "home") continue;
		const excludedKind = classifyExcludedMaterial(observation.path, observation.kind);
		if (!excludedKind) continue;
		addAbsorptionExclusion(exclusions, seen, {
			source_family: observation.anchor,
			path: observation.path,
			excluded_kind: excludedKind,
			reason: exclusionReason(excludedKind),
			sensitivity: exclusionSensitivity(excludedKind),
		});
	}

	for (const notice of [...result.skipped, ...result.warnings]) {
		if (!notice.anchor || notice.anchor === "home" || !notice.path) continue;
		const excludedKind = classifyExcludedMaterial(notice.path, notice.reason);
		if (!excludedKind) continue;
		addAbsorptionExclusion(exclusions, seen, {
			source_family: notice.anchor,
			path: notice.path,
			excluded_kind: excludedKind,
			reason: exclusionReason(excludedKind),
			sensitivity: exclusionSensitivity(excludedKind),
		});
	}

	return exclusions;
}

function addAbsorptionExclusion(
	exclusions: ExternalRootSurveyCatalogExclusion[],
	seen: Set<string>,
	exclusion: ExternalRootSurveyCatalogExclusion,
): void {
	const key = `${exclusion.source_family}\0${exclusion.path}\0${exclusion.excluded_kind}`;
	if (seen.has(key)) return;
	seen.add(key);
	exclusions.push(exclusion);
}

function classifyExcludedMaterial(pathValue: string, kind: string): string | undefined {
	const lowerPath = pathValue.toLowerCase();
	const lowerKind = kind.toLowerCase();
	if (lowerKind.includes("hook_command") || lowerPath.includes("hook")) return "raw_hook_commands";
	if (lowerPath.includes("auth") || lowerPath.includes("credential")) return "credentials";
	if (lowerPath.includes("browser") || lowerPath.includes("profile")) return "browser_profile_history";
	if (lowerPath.includes("session")) return "raw_session_transcripts";
	if (lowerPath.includes("history") || lowerPath.endsWith(".jsonl") || lowerPath.endsWith(".ndjson")) return "raw_session_history";
	if (lowerKind.includes("sqlite") || /\.(sqlite|sqlite3|db|db3)(?:$|-wal$|-shm$)/i.test(lowerPath)) return "sqlite_rows";
	if (lowerKind.includes("log") || lowerPath.includes("/log") || /\.(log|out|err)$/i.test(lowerPath)) return "raw_logs";
	if (lowerPath.includes("claude.md") || lowerPath.includes("agents.md") || lowerPath.includes("gemini.md") || lowerPath.includes("soul.md")) {
		return "complete_external_prompts";
	}
	return undefined;
}

function exclusionReason(excludedKind: string): string {
	switch (excludedKind) {
		case "raw_hook_commands":
			return "report command hash/category only; never import command body";
		case "credentials":
			return "credential material is out of scope for context/catalog import";
		case "browser_profile_history":
			return "browser profiles and history can contain private browsing state";
		case "raw_session_transcripts":
		case "raw_session_history":
			return "session/history text can contain private transcript data";
		case "sqlite_rows":
			return "SQLite schemas/counts may be inspected, but rows are not catalog material";
		case "raw_logs":
			return "logs are summarized by severity/fingerprint only";
		case "complete_external_prompts":
			return "extract reusable patterns only; do not import whole external prompts";
		default:
			return "excluded from automatic GJC context";
	}
}

function exclusionSensitivity(excludedKind: string): ExternalRootSurveySensitivity {
	if (excludedKind === "complete_external_prompts") return "high";
	if (excludedKind === "raw_logs" || excludedKind === "sqlite_rows") return "high";
	return "blocked";
}

function summarizeAbsorptionCatalog(
	candidates: readonly ExternalRootSurveyCatalogCandidate[],
	exclusions: readonly ExternalRootSurveyCatalogExclusion[],
	redactionsApplied: number,
): ExternalRootSurveyCatalog["summary"] {
	const bySourceFamily: Record<string, number> = {};
	const byTreatment: Record<string, number> = {};
	const bySensitivity: Record<string, number> = {};
	const byTargetSurface: Record<string, number> = {};

	for (const candidate of candidates) {
		incrementCount(bySourceFamily, candidate.source_family);
		incrementCount(byTreatment, candidate.treatment);
		incrementCount(bySensitivity, candidate.sensitivity);
		incrementCount(byTargetSurface, candidate.target_surface);
	}
	for (const exclusion of exclusions) {
		incrementCount(bySourceFamily, exclusion.source_family);
		incrementCount(bySensitivity, exclusion.sensitivity);
	}

	return {
		candidates_detected: candidates.length,
		candidates_cataloged: candidates.length,
		assets_absorbed: candidates.filter(candidate => candidate.treatment === "absorb" || candidate.treatment === "role_guidance").length,
		assets_wrapped: candidates.filter(candidate => candidate.treatment === "wrap_catalog" || candidate.treatment === "optional_template").length,
		assets_excluded: exclusions.length,
		redactions_applied: redactionsApplied,
		by_source_family: bySourceFamily,
		by_treatment: byTreatment,
		by_sensitivity: bySensitivity,
		by_target_surface: byTargetSurface,
	};
}

function incrementCount(target: Record<string, number>, key: string): void {
	target[key] = (target[key] ?? 0) + 1;
}

function countRedactionMarkers(result: ExternalRootSurveyResult): number {
	const text = JSON.stringify({ observations: result.observations, skipped: result.skipped, warnings: result.warnings });
	return (text.match(/redacted|\[REDACTED\]|secret_like|command_like|sha256_16/g) ?? []).length;
}
function parseDepth(value: string | undefined): ExternalRootSurveyDepth {
	const normalized = (value || "inventory").trim().toLowerCase();
	if (normalized === "inventory" || normalized === "config" || normalized === "deep") return normalized;
	throw new Error("--depth must be inventory, config, or deep.");
}

function parseAnchors(values: string[] | undefined): ExternalRootSurveyAnchor[] {
	const raw = values && values.length > 0 ? values : ["home"];
	const parts = raw.flatMap(value => value.split(",")).map(value => value.trim().toLowerCase()).filter(Boolean);
	if (parts.length === 0) return ["home"];
	const anchors: ExternalRootSurveyAnchor[] = [];
	for (const part of parts) {
		if (!ALL_ANCHORS.includes(part as ExternalRootSurveyAnchor)) throw new Error(`Unknown --anchor value: ${part}`);
		const anchor = part as ExternalRootSurveyAnchor;
		if (!anchors.includes(anchor)) anchors.push(anchor);
	}
	return anchors;
}

function resolveAnchors(depth: ExternalRootSurveyDepth, anchors: readonly ExternalRootSurveyAnchor[]): ExternalRootSurveyAnchor[] {
	if (depth === "inventory") return [...anchors];
	const providers = anchors.filter((anchor): anchor is ProviderAnchor => anchor !== "home");
	if (depth === "config") return anchors.includes("home") ? dedupeAnchors([...providers, ...PROVIDER_ANCHORS]) : providers;
	if (providers.length === 0) throw new Error("--depth deep requires an explicit provider anchor; --anchor home is not allowed by itself.");
	return providers;
}

function parseCaps(flags: ExternalRootSurveyFlags, depth: ExternalRootSurveyDepth): ExternalRootSurveyCaps {
	const defaults = DEPTH_DEFAULT_CAPS[depth];
	const caps = {
		maxBytes: parseNonNegativeInt(flags.maxBytes, defaults.maxBytes, "--max-bytes"),
		maxEntries: parsePositiveInt(flags.maxEntries, defaults.maxEntries, "--max-entries"),
		timeoutMs: parsePositiveInt(flags.timeoutMs, defaults.timeoutMs, "--timeout-ms"),
		sampleLimit: parseNonNegativeInt(flags.sampleLimit, defaults.sampleLimit, "--sample-limit"),
	};
	if (caps.maxBytes > HARD_CAPS.maxBytes) throw new Error(`--max-bytes must be <= ${HARD_CAPS.maxBytes}.`);
	if (caps.maxEntries > HARD_CAPS.maxEntries) throw new Error(`--max-entries must be <= ${HARD_CAPS.maxEntries}.`);
	if (caps.timeoutMs > HARD_CAPS.timeoutMs) throw new Error(`--timeout-ms must be <= ${HARD_CAPS.timeoutMs}.`);
	if (caps.sampleLimit > HARD_CAPS.sampleLimit) throw new Error(`--sample-limit must be between 0 and ${HARD_CAPS.sampleLimit}.`);
	return caps;
}

function parsePositiveInt(value: string | undefined, fallback: number, flagName: string): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flagName} must be a positive integer.`);
	return parsed;
}

function parseNonNegativeInt(value: string | undefined, fallback: number, flagName: string): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${flagName} must be a non-negative integer.`);
	return parsed;
}

function dedupeAnchors(values: readonly ExternalRootSurveyAnchor[]): ExternalRootSurveyAnchor[] {
	const out: ExternalRootSurveyAnchor[] = [];
	for (const value of values) if (!out.includes(value)) out.push(value);
	return out;
}

function providerAnchorsOnly(anchors: readonly ExternalRootSurveyAnchor[]): ProviderAnchor[] {
	return anchors.filter((anchor): anchor is ProviderAnchor => anchor !== "home");
}

function rootFor(home: string, anchor: ProviderAnchor): string {
	return path.join(home, DEFINITIONS[anchor].rootName);
}

function anchorPath(home: string, anchor: ProviderAnchor, relativePath: string): string {
	return path.normalize(path.join(rootFor(home, anchor), relativePath));
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

async function shallowDirectoryCounts(
	dir: string,
	maxEntries: number,
	result: ExternalRootSurveyResult,
	deadline: number,
): Promise<Record<string, unknown>> {
	increment(result, "list_calls");
	const entries = await fs.readdir(dir, { withFileTypes: true });
	let directories = 0;
	let files = 0;
	let other = 0;
	const extensions: Record<string, number> = {};
	for (const entry of entries.slice(0, maxEntries)) {
		ensureWithinDeadline(deadline);
		if (entry.isDirectory()) directories += 1;
		else if (entry.isFile()) {
			files += 1;
			const ext = path.extname(entry.name).toLowerCase() || "[none]";
			extensions[ext] = (extensions[ext] ?? 0) + 1;
		} else other += 1;
	}
	return {
		entries_total: entries.length,
		entries_sampled: Math.min(entries.length, maxEntries),
		directories,
		files,
		other,
		extensions,
		truncated: entries.length > maxEntries,
	};
}

function statSummary(stat: Stats): Record<string, unknown> {
	return {
		exists: true,
		type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
		size: stat.size,
		mtime_ms: stat.mtimeMs,
	};
}

function configKind(filePath: string): ConfigKind {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".json") return "json";
	if (extension === ".toml") return "toml";
	if (extension === ".yaml" || extension === ".yml") return "yaml";
	return "markdown";
}

function summarizeConfig(content: string, kind: ConfigKind, limit: number): Record<string, unknown> {
	if (kind === "markdown") return summarizeMarkdown(content, limit);
	try {
		const parsed = parseConfig(content, kind);
		return { parse_ok: true, schema: summarizeValue(parsed, limit), ...extractKnownConfigSummary(parsed, limit) };
	} catch (error) {
		return { parse_ok: false, error: `parse_failed:${error instanceof Error ? error.constructor.name : "UnknownError"}` };
	}
}

function parseConfig(content: string, kind: ConfigKind): unknown {
	if (kind === "json") return JSON.parse(content);
	if (kind === "toml") return Bun.TOML.parse(content);
	if (kind === "yaml") return YAML.parse(content);
	return content;
}

function summarizeValue(value: unknown, limit: number): unknown {
	if (Array.isArray(value)) {
		return { type: "array", length: value.length, items: value.slice(0, limit).map(item => summarizeValue(item, limit)), truncated: value.length > limit };
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		const fields: Record<string, unknown> = {};
		for (const key of keys.slice(0, limit)) fields[safeIdentifier(key)] = summarizeField(key, record[key], limit);
		return { type: "object", key_count: keys.length, fields, truncated: keys.length > limit };
	}
	if (typeof value === "string") return { type: "string", length: value.length, secret_like: looksSecretLike(value) };
	if (typeof value === "number") return { type: "number" };
	if (typeof value === "boolean") return { type: "boolean" };
	if (value === null) return { type: "null" };
	return { type: typeof value };
}

function summarizeField(key: string, value: unknown, limit: number): unknown {
	if (SECRET_KEY_PATTERN.test(key)) return { type: Array.isArray(value) ? "array" : typeof value, redacted: true };
	if (/command|cmd|script|hook|args?/i.test(key) && typeof value === "string") {
		return { type: "string", command_like: true, sha256_16: hashText(value).slice(0, 16), category: categorizeCommand(value), length: value.length };
	}
	return summarizeValue(value, limit);
}

function extractKnownConfigSummary(value: unknown, limit: number): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const record = value as Record<string, unknown>;
	const summary: Record<string, unknown> = {};
	for (const key of ["mcpServers", "mcp_servers", "plugins", "hooks", "projects", "profiles"]) {
		const nested = record[key];
		if (nested && typeof nested === "object" && !Array.isArray(nested)) {
			const names = Object.keys(nested as Record<string, unknown>);
			summary[safeIdentifier(key)] = { count: names.length, names: names.slice(0, limit).map(safeIdentifier), truncated: names.length > limit };
		}
	}
	return summary;
}

function summarizeMarkdown(content: string, limit: number): Record<string, unknown> {
	const frontmatter = extractFrontmatter(content);
	const headings = content.match(/^#{1,6}\s+.+$/gm) ?? [];
	const summary: Record<string, unknown> = {
		frontmatter_keys: frontmatter ? Object.keys(frontmatter).slice(0, limit).map(safeIdentifier) : [],
		heading_count: headings.length,
		heading_levels: headings.slice(0, limit).map(heading => heading.match(/^#+/)?.[0].length ?? 0),
	};
	if (frontmatter) {
		const declaredName = frontmatter.name;
		const declaredDescription = frontmatter.description;
		if (typeof declaredName === "string") summary.declared_name = safeText(declaredName, 120);
		if (typeof declaredDescription === "string") summary.declared_description = safeText(declaredDescription, 200);
	}
	return summary;
}

function extractFrontmatter(content: string): Record<string, unknown> | undefined {
	if (!content.startsWith("---\n")) return undefined;
	const end = content.indexOf("\n---", 4);
	if (end === -1) return undefined;
	try {
		const parsed = YAML.parse(content.slice(4, end));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {}
	return undefined;
}

function summarizeHookCommands(
	home: string,
	anchor: ProviderAnchor,
	fullPath: string,
	kind: ConfigKind,
	content: string,
	result: ExternalRootSurveyResult,
): void {
	if (kind === "markdown") return;
	let parsed: unknown;
	try {
		parsed = parseConfig(content, kind);
	} catch {
		return;
	}
	const commands: string[] = [];
	collectHookCommands(parsed, commands, summaryLimit(result.caps));
	if (commands.length === 0) return;
	addObservation(result, {
		anchor,
		kind: "hook_command_hashes",
		path: displayPath(home, fullPath),
		data: {
			commands: commands.slice(0, summaryLimit(result.caps)).map(command => ({
				sha256_16: hashText(command).slice(0, 16),
				category: categorizeCommand(command),
				length: command.length,
			})),
			truncated: commands.length > summaryLimit(result.caps),
		},
	});
}

function collectHookCommands(value: unknown, commands: string[], limit: number): void {
	if (commands.length >= limit) return;
	if (Array.isArray(value)) {
		for (const item of value) collectHookCommands(item, commands, limit);
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		if (commands.length >= limit) return;
		if (/command|cmd|script|hook/i.test(key) && typeof nested === "string") commands.push(nested);
		else collectHookCommands(nested, commands, limit);
	}
}

function categorizeCommand(command: string): string {
	const trimmed = command.trim();
	if (/\b(node|bun|npm|pnpm|yarn|npx)\b/.test(trimmed)) return "javascript";
	if (/\b(python|python3|uv|uvx)\b/.test(trimmed)) return "python";
	if (/\b(sh|bash|zsh|fish)\b/.test(trimmed)) return "shell";
	if (/\b(curl|wget|http)\b/.test(trimmed)) return "network";
	if (/\bgit\b/.test(trimmed)) return "git";
	if (/\bgjc\b/.test(trimmed)) return "gjc";
	return "other";
}

function summarizeLogContent(content: string, caps: ExternalRootSurveyCaps): Record<string, unknown> {
	const severityCounts: Record<string, number> = {};
	const fingerprints: Record<string, number> = {};
	const lines = content.split(/\r?\n/).slice(0, caps.maxEntries);
	for (const line of lines) {
		const severity = classifyLogSeverity(line);
		severityCounts[severity] = (severityCounts[severity] ?? 0) + 1;
		if (severity !== "other") {
			const fingerprint = hashText(redactText(line).replace(/\d+/g, "#")).slice(0, 16);
			fingerprints[fingerprint] = (fingerprints[fingerprint] ?? 0) + 1;
		}
	}
	return {
		line_count_sample: lines.length,
		severity_counts: severityCounts,
		fingerprints: Object.entries(fingerprints)
			.sort((left, right) => right[1] - left[1])
			.slice(0, summaryLimit(caps))
			.map(([sha256_16, count]) => ({ sha256_16, count })),
	};
}

function classifyLogSeverity(line: string): string {
	if (/\b(error|fatal|panic|exception|traceback)\b/i.test(line)) return "error";
	if (/\b(warn|warning)\b/i.test(line)) return "warn";
	if (/\b(info|notice)\b/i.test(line)) return "info";
	if (/\b(debug|trace)\b/i.test(line)) return "debug";
	return "other";
}

function skillCandidatePath(dir: string, entry: Dirent): string | undefined {
	if (entry.isDirectory()) return path.join(dir, entry.name, "SKILL.md");
	if (entry.isFile() && MARKDOWN_FILE_PATTERN.test(entry.name)) return path.join(dir, entry.name);
	return undefined;
}

async function readCappedText(
	home: string,
	anchor: ExternalRootSurveyAnchor,
	filePath: string,
	result: ExternalRootSurveyResult,
	size: number,
	overrideMaxBytes?: number,
): Promise<{ text: string; bytesRead: number; truncated: boolean } | undefined> {
	const maxBytes = overrideMaxBytes ?? result.caps.maxBytes;
	if (maxBytes <= 0) {
		addSkip(result, { anchor, path: displayPath(home, filePath), reason: "content_read_disabled", cap: maxBytes });
		return undefined;
	}
	increment(result, "content_read_attempts");
	if (size > maxBytes) increment(result, "over_cap_reads");
	const bytes = await Bun.file(filePath).slice(0, maxBytes).arrayBuffer();
	const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	return { text, bytesRead: bytes.byteLength, truncated: size > maxBytes };
}

async function safeStat(filePath: string): Promise<Stats | undefined> {
	try {
		return await fs.stat(filePath);
	} catch (error) {
		if (isUnavailable(error)) return undefined;
		throw error;
	}
}

async function safeReadDir(dir: string): Promise<Dirent[] | undefined> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isUnavailable(error)) return undefined;
		throw error;
	}
}

function isUnavailable(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) return false;
	return error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES" || error.code === "EPERM";
}

function displayPath(home: string, filePath: string): string {
	const relative = path.relative(home, filePath);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return path.posix.join("~", relative.split(path.sep).join("/"));
	if (!relative) return "~";
	return filePath;
}

function addObservation(
	result: ExternalRootSurveyResult,
	observation: Omit<ExternalRootSurveyObservation, "mode" | "depth">,
): void {
	result.observations.push({ mode: result.mode, depth: result.depth, ...observation });
	increment(result, "observations");
}

function addSkip(result: ExternalRootSurveyResult, notice: Omit<ExternalRootSurveyNotice, "mode" | "depth">): void {
	result.skipped.push({ mode: result.mode, depth: result.depth, ...notice });
	increment(result, "skipped");
}

function addWarning(result: ExternalRootSurveyResult, notice: Omit<ExternalRootSurveyNotice, "mode" | "depth">): void {
	result.warnings.push({ mode: result.mode, depth: result.depth, ...notice });
	increment(result, "warnings");
}

function ensureWithinDeadline(deadline: number): void {
	if (Date.now() > deadline) throw new Error("external_root_survey_timeout");
}

function scalarPragmaNumber(db: Database, pragma: "page_count" | "page_size"): number | undefined {
	try {
		const row = db.prepare<Record<string, number>, []>(`PRAGMA ${pragma}`).get();
		const value = row?.[pragma];
		return typeof value === "number" ? value : undefined;
	} catch {
		return undefined;
	}
}

function quoteSqliteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function safeIdentifier(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "[empty]";
	if (SECRET_KEY_PATTERN.test(trimmed) || SUSPICIOUS_IDENTIFIER_PATTERN.test(trimmed)) return `redacted:${hashText(trimmed).slice(0, 12)}`;
	return safeText(trimmed, 160);
}

function safeText(value: string, maxLength: number): string {
	const redacted = redactText(value).replace(/[\r\n\t]+/g, " ").trim();
	return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}

function redactText(value: string): string {
	return value
		.replace(SECRET_KEY_VALUE_PATTERN, (_match, key: string) => `${key}=[REDACTED]`)
		.replace(SECRET_VALUE_REDACTION_PATTERN, "[REDACTED]");
}

function looksSecretLike(value: string): boolean {
	return SECRET_VALUE_TEST_PATTERN.test(value) || SUSPICIOUS_IDENTIFIER_PATTERN.test(value);
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function summaryLimit(caps: ExternalRootSurveyCaps): number {
	return caps.sampleLimit > 0 ? caps.sampleLimit : Math.min(32, Math.max(1, caps.maxEntries));
}

function increment(result: ExternalRootSurveyResult, key: string): void {
	result.counters[key] = (result.counters[key] ?? 0) + 1;
}

function sanitizeError(error: unknown): string {
	if (!(error instanceof Error)) return "UnknownError";
	return error.constructor.name || "Error";
}
