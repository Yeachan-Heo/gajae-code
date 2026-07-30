import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@gajae-code/utils";
import packageMetadata from "../../../package.json" with { type: "json" };
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { planMigration } from "../../migrate/action-planner";
import { getAdapter } from "../../migrate/adapters";
import { executeActions } from "../../migrate/executor";
import { type AdapterResult, MIGRATE_SOURCES, type MigrateAction, type MigrateSource } from "../../migrate/types";
import { AuthStorage } from "../../session/auth-storage";
import { branch, status as gitStatus, head, repo } from "../../utils/git";
import type { HandlerResult, MethodHandler } from "./handlers";

type RecordValue = Record<string, unknown>;
type MigrationItemType =
	| "AGENTS_MD"
	| "CONFIG"
	| "SKILLS"
	| "PLUGINS"
	| "MCP_SERVER_CONFIG"
	| "SUBAGENTS"
	| "HOOKS"
	| "COMMANDS"
	| "MEMORY"
	| "SESSIONS";
type ImportSuccess = {
	itemType: MigrationItemType;
	cwd?: string | null;
	source?: string | null;
	target?: string | null;
};
type ImportFailure = {
	itemType: MigrationItemType;
	errorType?: string | null;
	subErrorType?: string | null;
	failureStage: string;
	message: string;
	cwd?: string | null;
	source?: string | null;
};
type ImportTypeResult = {
	itemType: MigrationItemType;
	successes: ImportSuccess[];
	failures: ImportFailure[];
};
type MigrationItem = {
	itemType: MigrationItemType;
	description: string;
	cwd: string | null;
	details: RecordValue | null;
};
type ParsedMigrationItem = MigrationItem & {
	source?: MigrateSource;
	names: string[];
};
type HistoryRecord = {
	importId: string;
	providerId: string | null;
	completedAtMs: number;
	successes: ImportSuccess[];
	failures: ImportFailure[];
};

const MIGRATION_ITEM_TYPES: readonly MigrationItemType[] = [
	"AGENTS_MD",
	"CONFIG",
	"SKILLS",
	"PLUGINS",
	"MCP_SERVER_CONFIG",
	"SUBAGENTS",
	"HOOKS",
	"COMMANDS",
	"MEMORY",
	"SESSIONS",
];
const SUPPORTED_IMPORT_TYPES = new Set<MigrationItemType>(["MCP_SERVER_CONFIG", "SKILLS"]);
const invalidParams = (): HandlerResult => ({ ok: false, errorKey: "invalidParams" });
const internalError = (): HandlerResult => ({ ok: false, errorKey: "internalError" });

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMigrationItemType(value: unknown): value is MigrationItemType {
	return typeof value === "string" && (MIGRATION_ITEM_TYPES as readonly string[]).includes(value);
}

function isMigrateSource(value: unknown): value is MigrateSource {
	return typeof value === "string" && (MIGRATE_SOURCES as readonly string[]).includes(value);
}

function resolveAgentDirectory(): string {
	const configured =
		process.env.GJC_AGENT_DIR ?? process.env.GJC_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? undefined;
	return path.resolve(configured ?? getAgentDir());
}

function resolveExternalHome(): string {
	return path.resolve(process.env.HOME ?? process.env.USERPROFILE ?? os.homedir());
}

function resolveWorkingDirectory(): string {
	try {
		return path.resolve(process.cwd());
	} catch {
		return path.resolve(os.tmpdir());
	}
}

function migrationSources(value: unknown): MigrateSource[] {
	return isMigrateSource(value) ? [value] : [...MIGRATE_SOURCES];
}

function migrationDetails(source: MigrateSource, itemType: MigrationItemType, name: string): RecordValue {
	return {
		commands: [],
		hooks: [],
		plugins: [],
		sessions: [],
		subagents: [],
		memory: [],
		mcpServers: itemType === "MCP_SERVER_CONFIG" ? [{ name }] : [],
		skills: itemType === "SKILLS" ? [{ name }] : [],
		// `source` is an additive field for GJC's own detect/import round-trip. The
		// pinned schema permits unknown fields and clients that do not send it still
		// import by the explicitly requested migrationSource (or all sources).
		source,
	};
}

function stringNames(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter(isRecord)
		.map(entry => entry.name)
		.filter((name): name is string => typeof name === "string" && name.length > 0)
		.map(name => (field === "skills" ? name : name));
}

function parseMigrationItem(value: unknown): ParsedMigrationItem | undefined {
	if (!isRecord(value) || !isMigrationItemType(value.itemType) || typeof value.description !== "string")
		return undefined;
	const cwd =
		value.cwd === undefined || value.cwd === null ? null : typeof value.cwd === "string" ? value.cwd : undefined;
	if (cwd === undefined) return undefined;
	const details =
		value.details === undefined || value.details === null
			? null
			: isRecord(value.details)
				? value.details
				: undefined;
	if (details === undefined) return undefined;
	const source = details && isMigrateSource(details.source) ? details.source : undefined;
	const names =
		details === null
			? []
			: value.itemType === "MCP_SERVER_CONFIG"
				? stringNames(details.mcpServers, "mcpServers")
				: value.itemType === "SKILLS"
					? stringNames(details.skills, "skills")
					: [];
	return { itemType: value.itemType, description: value.description, cwd, details, source, names };
}

function matchesMigrationItem(
	candidate: { source: MigrateSource; name: string },
	itemType: MigrationItemType,
	items: ParsedMigrationItem[],
): boolean {
	const candidates = items.filter(item => item.itemType === itemType);
	if (candidates.length === 0) return false;
	return candidates.some(item => {
		if (item.source && item.source !== candidate.source) return false;
		return item.names.length === 0 || item.names.includes(candidate.name);
	});
}

async function collectMigrationResults(sources: readonly MigrateSource[], homeDir: string): Promise<AdapterResult[]> {
	const results: AdapterResult[] = [];
	for (const source of sources) results.push(await getAdapter(source).collect({ homeDir }));
	return results;
}

function historyPath(): string {
	return path.join(resolveAgentDirectory(), "external-agent-config-import-history.json");
}

export function getExternalAgentImportHistoryPath(): string {
	return historyPath();
}

function validSuccess(value: unknown): value is ImportSuccess {
	if (!isRecord(value) || !isMigrationItemType(value.itemType)) return false;
	for (const key of ["cwd", "source", "target"] as const) {
		if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") return false;
	}
	return true;
}

function validFailure(value: unknown): value is ImportFailure {
	if (
		!isRecord(value) ||
		!isMigrationItemType(value.itemType) ||
		typeof value.failureStage !== "string" ||
		typeof value.message !== "string"
	)
		return false;
	for (const key of ["cwd", "source", "errorType", "subErrorType"] as const) {
		if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") return false;
	}
	return true;
}

function parseImportTypeResults(value: unknown): ImportTypeResult[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result: ImportTypeResult[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || !isMigrationItemType(entry.itemType)) return undefined;
		if (!Array.isArray(entry.successes) || !entry.successes.every(validSuccess)) return undefined;
		if (!Array.isArray(entry.failures) || !entry.failures.every(validFailure)) return undefined;
		result.push({
			itemType: entry.itemType,
			successes: entry.successes as ImportSuccess[],
			failures: entry.failures as ImportFailure[],
		});
	}
	return result;
}

async function readHistoryRecords(): Promise<HistoryRecord[]> {
	try {
		const raw = JSON.parse(await fs.readFile(historyPath(), "utf8")) as unknown;
		if (!Array.isArray(raw)) throw new Error("history file is not an array");
		if (
			!raw.every(
				entry =>
					isRecord(entry) &&
					typeof entry.importId === "string" &&
					(entry.providerId === null || typeof entry.providerId === "string") &&
					typeof entry.completedAtMs === "number" &&
					Number.isSafeInteger(entry.completedAtMs) &&
					Array.isArray(entry.successes) &&
					entry.successes.every(validSuccess) &&
					Array.isArray(entry.failures) &&
					entry.failures.every(validFailure),
			)
		)
			throw new Error("history file contains an invalid record");
		return raw as HistoryRecord[];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function writeHistoryRecord(record: HistoryRecord): Promise<void> {
	const filePath = historyPath();
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const records = await readHistoryRecords();
	records.push(record);
	const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporaryPath, JSON.stringify(records, null, 2), { encoding: "utf8", mode: 0o600 });
		await fs.rename(temporaryPath, filePath);
	} finally {
		await fs.rm(temporaryPath, { force: true });
	}
}

function emptyTypeResult(itemType: MigrationItemType): ImportTypeResult {
	return { itemType, successes: [], failures: [] };
}

function addImportSuccess(groups: Map<MigrationItemType, ImportTypeResult>, action: MigrateAction): void {
	const itemType: MigrationItemType | undefined =
		action.type === "mcp" ? "MCP_SERVER_CONFIG" : action.type === "skill" ? "SKILLS" : undefined;
	if (!itemType) return;
	const group = groups.get(itemType) ?? emptyTypeResult(itemType);
	group.successes.push({
		itemType,
		cwd: null,
		source: action.source,
		target: action.destination ?? null,
	});
	groups.set(itemType, group);
}

function addImportFailure(groups: Map<MigrationItemType, ImportTypeResult>, failure: ImportFailure): void {
	const group = groups.get(failure.itemType) ?? emptyTypeResult(failure.itemType);
	group.failures.push(failure);
	groups.set(failure.itemType, group);
}

function importGroupsFromActions(actions: readonly MigrateAction[]): ImportTypeResult[] {
	const groups = new Map<MigrationItemType, ImportTypeResult>();
	for (const action of actions) {
		if (action.type === "mcp" || action.type === "skill") {
			if (action.status === "imported" || action.status === "updated" || action.status === "skipped_exists") {
				addImportSuccess(groups, action);
			} else {
				const itemType: MigrationItemType = action.type === "mcp" ? "MCP_SERVER_CONFIG" : "SKILLS";
				addImportFailure(groups, {
					itemType,
					failureStage: "import",
					message: action.reason ?? `migration action ended with ${action.status}`,
					source: action.source,
					cwd: null,
				});
			}
		} else if (action.type === "source" && action.status.startsWith("failed")) {
			addImportFailure(groups, {
				itemType: "CONFIG",
				failureStage: "detection",
				message: action.reason ?? "external configuration could not be read",
				source: action.source,
				cwd: null,
			});
		}
	}
	return [...groups.values()];
}

function normalizeProviderId(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

async function recordHistory(
	importId: string,
	providerId: string | null,
	itemTypeResults: readonly ImportTypeResult[],
): Promise<void> {
	const successes = itemTypeResults.flatMap(result => result.successes);
	const failures = itemTypeResults.flatMap(result => result.failures);
	await writeHistoryRecord({ importId, providerId, completedAtMs: Date.now(), successes, failures });
}

async function inspectWorkspace(cwd: string): Promise<RecordValue> {
	try {
		const repository = await repo.root(cwd);
		if (!repository) {
			return {
				repoRoot: null,
				branch: null,
				head: null,
				clean: null,
				staged: null,
				unstaged: null,
				untracked: null,
			};
		}
		const [branchName, sha, summary] = await Promise.all([
			branch.current(cwd),
			head.sha(cwd),
			gitStatus.summary(cwd),
		]);
		return {
			repoRoot: repository,
			branch: branchName,
			head: sha,
			clean: summary ? summary.staged === 0 && summary.unstaged === 0 && summary.untracked === 0 : null,
			staged: summary?.staged ?? null,
			unstaged: summary?.unstaged ?? null,
			untracked: summary?.untracked ?? null,
		};
	} catch {
		return { repoRoot: null, branch: null, head: null, clean: null, staged: null, unstaged: null, untracked: null };
	}
}

async function inspectProviders(cwd: string, agentDir: string): Promise<RecordValue> {
	let authStorage: AuthStorage | undefined;
	try {
		await fs.mkdir(agentDir, { recursive: true });
		const settings = await Settings.loadForScope({ cwd, agentDir });
		void settings;
		authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
		const configured = [...new Set(registry.getAll().map(model => model.provider))].sort();
		const available = [...new Set(registry.getAvailable().map(model => model.provider))].sort();
		return {
			configured,
			available,
			credentials: authStorage.list().sort(),
		};
	} catch (error) {
		return {
			configured: null,
			available: null,
			credentials: null,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		authStorage?.close();
	}
}

async function nativeAvailability(): Promise<RecordValue> {
	try {
		const natives = await import("@gajae-code/natives");
		return {
			available: true,
			fuzzyFind: typeof natives.fuzzyFind === "function",
		};
	} catch (error) {
		return {
			available: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function environmentSnapshot(): Promise<RecordValue> {
	const cwd = resolveWorkingDirectory();
	const shellPath = process.platform === "win32" ? (process.env.ComSpec ?? "") : (process.env.SHELL ?? "");
	const [workspace, providers, nativeModules] = await Promise.all([
		inspectWorkspace(cwd),
		inspectProviders(cwd, resolveAgentDirectory()),
		nativeAvailability(),
	]);
	return {
		shell: { name: shellPath ? path.basename(shellPath) : "", path: shellPath },
		cwd: pathToFileURL(cwd).href,
		platform: {
			os: process.platform,
			family: os.type(),
			arch: process.arch,
			release: os.release(),
		},
		versions: {
			gjc: packageMetadata.version,
			node: process.versions.node,
			bun: process.versions.bun ?? null,
		},
		workspace,
		git: workspace,
		providers,
		nativeModules,
	};
}

function validEnvironmentParams(params: unknown): boolean {
	return isRecord(params) && typeof params.environmentId === "string" && params.environmentId.length > 0;
}

export const environmentInfoHandler: MethodHandler = async params => {
	if (!validEnvironmentParams(params)) return invalidParams();
	try {
		return { ok: true, result: await environmentSnapshot() };
	} catch {
		return internalError();
	}
};

export const environmentStatusHandler: MethodHandler = async params => {
	if (!validEnvironmentParams(params)) return invalidParams();
	try {
		const snapshot = await environmentSnapshot();
		return { ok: true, result: { status: "ready", ...snapshot } };
	} catch (error) {
		return {
			ok: true,
			result: { status: "unknown", error: error instanceof Error ? error.message : String(error) },
		};
	}
};

export const externalAgentConfigDetectHandler: MethodHandler = async params => {
	if (!isRecord(params) || typeof params.includeHome !== "boolean") return invalidParams();
	if (
		params.cwds !== undefined &&
		params.cwds !== null &&
		(!Array.isArray(params.cwds) || !params.cwds.every(cwd => typeof cwd === "string"))
	)
		return invalidParams();
	for (const key of ["maxSessionAgeDays", "maxSessions"] as const) {
		if (
			params[key] !== undefined &&
			params[key] !== null &&
			(typeof params[key] !== "number" || !Number.isFinite(params[key]) || params[key] < 0)
		)
			return invalidParams();
	}
	if (params.maxSessions !== undefined && params.maxSessions !== null && !Number.isSafeInteger(params.maxSessions))
		return invalidParams();
	if (
		(params.source !== undefined && params.source !== null && typeof params.source !== "string") ||
		(params.migrationSource !== undefined &&
			params.migrationSource !== null &&
			typeof params.migrationSource !== "string")
	)
		return invalidParams();
	if (!params.includeHome) return { ok: true, result: { items: [] } };
	try {
		const sources = migrationSources(params.migrationSource);
		const results = await collectMigrationResults(sources, resolveExternalHome());
		const items: MigrationItem[] = [];
		for (const result of results) {
			for (const candidate of result.mcpCandidates) {
				items.push({
					itemType: "MCP_SERVER_CONFIG",
					description: `${candidate.source} MCP server "${candidate.name}"`,
					cwd: null,
					details: migrationDetails(candidate.source, "MCP_SERVER_CONFIG", candidate.name),
				});
			}
			for (const candidate of result.skillCandidates) {
				items.push({
					itemType: "SKILLS",
					description: `${candidate.source} skill "${candidate.slug}"`,
					cwd: null,
					details: migrationDetails(candidate.source, "SKILLS", candidate.slug),
				});
			}
		}
		items.sort((left, right) => left.description.localeCompare(right.description));
		if (params.maxSessions !== undefined && params.maxSessions !== null && typeof params.maxSessions !== "number")
			return invalidParams();
		const limit = typeof params.maxSessions === "number" ? params.maxSessions : undefined;
		return { ok: true, result: { items: limit === undefined ? items : items.slice(0, limit) } };
	} catch {
		return internalError();
	}
};

export const externalAgentConfigImportHandler: MethodHandler = async params => {
	if (!isRecord(params) || !Array.isArray(params.migrationItems)) return invalidParams();
	if (
		(params.source !== undefined && params.source !== null && typeof params.source !== "string") ||
		(params.providerId !== undefined && params.providerId !== null && typeof params.providerId !== "string") ||
		(params.migrationSource !== undefined &&
			params.migrationSource !== null &&
			typeof params.migrationSource !== "string")
	)
		return invalidParams();
	const items: ParsedMigrationItem[] = [];
	for (const raw of params.migrationItems) {
		const parsed = parseMigrationItem(raw);
		if (!parsed) return invalidParams();
		items.push(parsed);
	}
	const importId = crypto.randomUUID();
	try {
		const groups = new Map<MigrationItemType, ImportTypeResult>();
		for (const item of items) {
			if (!SUPPORTED_IMPORT_TYPES.has(item.itemType)) {
				addImportFailure(groups, {
					itemType: item.itemType,
					failureStage: "planning",
					message: `GJC migration has no backing for ${item.itemType}`,
					cwd: item.cwd,
					source: item.source ?? null,
				});
			}
		}
		const supportedItems = items.filter(item => SUPPORTED_IMPORT_TYPES.has(item.itemType));
		if (supportedItems.length > 0) {
			const explicitSources = supportedItems.map(item => item.source).filter(isMigrateSource);
			const sources = isMigrateSource(params.migrationSource)
				? [params.migrationSource]
				: explicitSources.length > 0
					? [...new Set(explicitSources)]
					: [...MIGRATE_SOURCES];
			const collected = await collectMigrationResults(sources, resolveExternalHome());
			const filtered: AdapterResult[] = collected.map(result => ({
				...result,
				mcpCandidates: result.mcpCandidates.filter(candidate =>
					matchesMigrationItem(candidate, "MCP_SERVER_CONFIG", supportedItems),
				),
				skillCandidates: result.skillCandidates.filter(candidate =>
					// A skill candidate is identified by its slug; the MCP candidate uses `name`.
					matchesMigrationItem({ source: candidate.source, name: candidate.slug }, "SKILLS", supportedItems),
				),
			}));
			if (filtered.some(result => result.mcpCandidates.length > 0 || result.skillCandidates.length > 0)) {
				const agentDir = resolveAgentDirectory();
				await fs.mkdir(agentDir, { recursive: true });
				const planned = await planMigration({
					results: filtered,
					destinations: {
						mcpConfigPath: path.join(agentDir, "mcp.json"),
						skillsDir: path.join(agentDir, "skills"),
					},
					force: false,
				});
				for (const group of importGroupsFromActions(await executeActions(planned.actions))) {
					const existing = groups.get(group.itemType) ?? emptyTypeResult(group.itemType);
					existing.successes.push(...group.successes);
					existing.failures.push(...group.failures);
					groups.set(group.itemType, existing);
				}
			}
		}
		const itemTypeResults = [...groups.values()];
		await recordHistory(importId, normalizeProviderId(params.providerId), itemTypeResults);
		return { ok: true, result: { importId } };
	} catch {
		return internalError();
	}
};

export const externalAgentConfigImportReadHistoriesHandler: MethodHandler = async params => {
	if (params !== undefined && params !== null && (!isRecord(params) || Object.keys(params).length > 0))
		return invalidParams();
	try {
		return { ok: true, result: { data: await readHistoryRecords(), connectors: [] } };
	} catch {
		return internalError();
	}
};

export const externalAgentConfigImportRecordHistoryHandler: MethodHandler = async params => {
	if (!isRecord(params) || typeof params.providerId !== "string") return invalidParams();
	const itemTypeResults = parseImportTypeResults(params.itemTypeResults);
	if (!itemTypeResults) return invalidParams();
	const importId = crypto.randomUUID();
	try {
		await recordHistory(importId, params.providerId, itemTypeResults);
		return { ok: true, result: { importId } };
	} catch {
		return internalError();
	}
};

export const environmentAppHandlers: Record<string, MethodHandler> = {
	"environment/info": environmentInfoHandler,
	"environment/status": environmentStatusHandler,
	"externalAgentConfig/detect": externalAgentConfigDetectHandler,
	"externalAgentConfig/import": externalAgentConfigImportHandler,
	"externalAgentConfig/import/readHistories": externalAgentConfigImportReadHistoriesHandler,
	"externalAgentConfig/import/recordHistory": externalAgentConfigImportRecordHistoryHandler,
};
