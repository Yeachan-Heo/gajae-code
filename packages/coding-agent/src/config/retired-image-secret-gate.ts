import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDbPath, getConfigRootDir } from "@gajae-code/utils";
import { YAML } from "bun";
import { withFileLock } from "./file-lock";

const RETIRED_IMAGE_KEYS = new Set(["imagecustomkey", "imagecustomkeyenv"]);
const RETIRED_IMAGE_PATHS = new Set(["providers.imagecustomkey", "providers.imagecustomkeyenv"]);
const PROJECT_IMAGE_ROUTING_PATHS = new Set(["providers.image", "providers.imagemodel", "providers.imagecustomurl"]);
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const SQLITE_BUSY_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const MAX_BACKUP_NAME_LENGTH = 256;

type SettingsFileFormat = "json" | "yaml";
type SettingsFileOwnership = "owned" | "ingress";
export type RetiredImageSecretSource =
	| "global-config"
	| "global-legacy-json"
	| "global-ingress"
	| "project-config"
	| "project-ingress"
	| "legacy-db"
	| "repository-discovery";

type SettingsSourceKind = RetiredImageSecretSource;

interface SettingsSource {
	readonly path: string;
	readonly format: SettingsFileFormat;
	readonly ownership: SettingsFileOwnership;
	readonly kind: SettingsSourceKind;
	readonly project: boolean;
}

interface ParsedSettingsFile {
	readonly raw: string;
	readonly rawFingerprint: string;
	readonly semanticFingerprint: string;
	readonly value: Record<string, unknown>;
}

interface LegacyBlobRow {
	readonly id: string | number;
	readonly data: string;
}

interface LegacySettingsState {
	readonly hasRetired: boolean;
	readonly legacyBlobs: LegacyBlobRow[];
	readonly modernRows: Array<{ key: string; value: string }>;
	readonly tableName?: string;
	readonly keyColumn?: string;
	readonly valueColumn?: string;
	readonly idColumn?: string;
}

export interface RetiredImageSecretGateOptions {
	readonly cwd: string;
	readonly agentDir: string;
}

export interface RetiredImagePolicyOptions {
	readonly source: RetiredImageSecretSource;
	readonly project?: boolean;
}

export class RetiredImageSecretGateError extends Error {
	readonly code = "RETIRED_IMAGE_SECRET_GATE_BLOCKED";

	constructor(readonly source: SettingsSourceKind) {
		super(
			`Settings startup blocked by an unreadable, malformed, racing, or retired image credential source (${source}).`,
		);
		this.name = "RetiredImageSecretGateError";
	}
}

function blocked(source: SettingsSourceKind): never {
	throw new RetiredImageSecretGateError(source);
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function fingerprint(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map(key => `${JSON.stringify(key)}:${stableValue(object[key])}`)
		.join(",")}}`;
}

function semanticFingerprint(value: Record<string, unknown>): string {
	return fingerprint(stableValue(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObject(raw: string, format: SettingsFileFormat, source: SettingsSourceKind): Record<string, unknown> {
	if (format === "yaml" && raw.trim() === "") return {};
	let parsed: unknown;
	try {
		parsed = format === "json" ? JSON.parse(raw) : YAML.parse(raw);
	} catch {
		blocked(source);
	}
	if (!isRecord(parsed)) blocked(source);
	return parsed;
}

function normalizedPathSegments(path: string | readonly string[]): string[] {
	const segments: readonly string[] = typeof path === "string" ? path.split(".") : path;
	return segments.map((segment: string) => segment.toLowerCase());
}

export function isRetiredImageSecretPath(path: string | readonly string[]): boolean {
	const segments = normalizedPathSegments(path);
	if (segments.some(segment => RETIRED_IMAGE_KEYS.has(segment))) return true;
	const joined = segments.join(".");
	return [...RETIRED_IMAGE_PATHS].some(pathName => joined === pathName || joined.startsWith(`${pathName}.`));
}

function collectRetiredPaths(value: unknown, prefix: string[] = [], paths: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			collectRetiredPaths(value[index], [...prefix, String(index)], paths);
		}
		return paths;
	}
	if (!isRecord(value)) return paths;
	for (const [key, child] of Object.entries(value)) {
		const next = [...prefix, key];
		if (isRetiredImageSecretPath(next)) paths.push(next.join("."));
		collectRetiredPaths(child, next, paths);
	}
	return paths;
}

function collectProjectImageRoutingPaths(value: unknown, prefix: string[] = [], paths: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			collectProjectImageRoutingPaths(value[index], [...prefix, String(index)], paths);
		}
		return paths;
	}
	if (!isRecord(value)) return paths;
	for (const [key, child] of Object.entries(value)) {
		const next = [...prefix, key];
		const joined = normalizedPathSegments(next).join(".");
		if ([...PROJECT_IMAGE_ROUTING_PATHS].some(pathName => joined === pathName || joined.startsWith(`${pathName}.`))) {
			paths.push(next.join("."));
		}
		collectProjectImageRoutingPaths(child, next, paths);
	}
	return paths;
}

function isProjectCredentialReference(pathSegments: readonly string[]): boolean {
	if (pathSegments.length < 2 || pathSegments[0]?.toLowerCase() !== "providers") return false;
	const joined = normalizedPathSegments(pathSegments).join(".");
	if (isRetiredImageSecretPath(pathSegments)) return true;
	if (!joined.includes("image")) return false;
	return /(key|env|secret|token|credential|auth|handle|reference|ref)/i.test(joined);
}

function collectProjectCredentialPaths(value: unknown, prefix: string[] = [], paths: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			collectProjectCredentialPaths(value[index], [...prefix, String(index)], paths);
		}
		return paths;
	}
	if (!isRecord(value)) return paths;
	for (const [key, child] of Object.entries(value)) {
		const next = [...prefix, key];
		if (isProjectCredentialReference(next)) paths.push(next.join("."));
		collectProjectCredentialPaths(child, next, paths);
	}
	return paths;
}

export function validateRetiredImagePolicy(value: unknown, options: RetiredImagePolicyOptions): void {
	const retiredPaths = collectRetiredPaths(value);
	if (retiredPaths.length > 0) blocked(options.source);
	if (!options.project) return;
	if (collectProjectImageRoutingPaths(value).length > 0 || collectProjectCredentialPaths(value).length > 0) {
		blocked(options.source);
	}
}

function parseSettingsFile(raw: string, source: SettingsSource): ParsedSettingsFile {
	const value = parseObject(raw, source.format, source.kind);
	return {
		raw,
		rawFingerprint: fingerprint(raw),
		semanticFingerprint: semanticFingerprint(value),
		value,
	};
}

async function readRegularFile(source: SettingsSource): Promise<ParsedSettingsFile | null> {
	let stat: Stats;

	try {
		stat = await fs.lstat(source.path);
	} catch (error) {
		if (isMissing(error)) return null;
		blocked(source.kind);
	}
	if (!stat!.isFile() || stat!.isSymbolicLink()) blocked(source.kind);
	let raw: string;
	try {
		raw = await Bun.file(source.path).text();
	} catch {
		blocked(source.kind);
	}
	return parseSettingsFile(raw!, source);
}

function shouldIncludeBackup(name: string, baseName: string): boolean {
	if (name.length > MAX_BACKUP_NAME_LENGTH) return false;
	if (!name.toLowerCase().startsWith(baseName.toLowerCase())) return false;
	const suffix = name.slice(baseName.length);
	return (
		/^~\d*$/.test(suffix) ||
		/^\.(?:bak|backup|old|tmp|orig)(?:\.\d+)?$/i.test(suffix) ||
		/^\.\d{4}[-_.]?\d{2}[-_.]?\d{2}(?:[T_.-]?\d{2}[-_.]?\d{2}(?:[-_.]?\d{2})?)?$/.test(suffix) ||
		/^(?:[ ._-]+copy(?:[ ._-]+\d+)?|[ ._-]+orig(?:[ ._-]+\d+)?)$/i.test(suffix)
	);
}

async function siblingBackups(source: SettingsSource): Promise<SettingsSource[]> {
	let entries: Dirent[];

	try {
		entries = await fs.readdir(path.dirname(source.path), { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return [];
		blocked(source.kind);
	}
	const baseName = path.basename(source.path);
	const backups: SettingsSource[] = [];
	for (const entry of entries!) {
		if (!shouldIncludeBackup(entry.name, baseName)) continue;
		backups.push({ ...source, path: path.join(path.dirname(source.path), entry.name) });
	}
	return backups;
}

function removeRetiredKeys(value: unknown, prefix: string[] = []): boolean {
	let changed = false;
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const next = [...prefix, String(index)];
			if (isRetiredImageSecretPath(next)) {
				value.splice(index, 1);
				index--;
				changed = true;
				continue;
			}
			changed = removeRetiredKeys(value[index], next) || changed;
		}
		return changed;
	}
	if (!isRecord(value)) return false;
	for (const key of Object.keys(value)) {
		const next = [...prefix, key];
		if (isRetiredImageSecretPath(next)) {
			delete value[key];
			changed = true;
			continue;
		}
		changed = removeRetiredKeys(value[key], next) || changed;
	}
	return changed;
}

async function syncParentDirectory(directory: string): Promise<void> {
	try {
		const handle = await fs.open(directory, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {
		// Directory fsync is unavailable on some supported filesystems.
	}
}

async function writeAtomicText(filePath: string, text: string, mode: number): Promise<void> {
	const directory = path.dirname(filePath);
	const resolvedTargetPath = path.resolve(filePath);
	const temporaryToken = createHash("sha256")
		.update(`${resolvedTargetPath}:${process.pid}:${randomUUID()}`)
		.digest("hex")
		.slice(0, 16);
	const temporaryPath = path.join(directory, `.${temporaryToken}.tmp`);
	try {
		const handle = await fs.open(temporaryPath, "wx", mode & 0o777);
		try {
			await handle.writeFile(text, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporaryPath, filePath);
		await syncParentDirectory(directory);
	} finally {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

async function scrubJsonSource(source: SettingsSource, snapshot: ParsedSettingsFile): Promise<void> {
	let stat: Stats;

	try {
		stat = await fs.stat(source.path);
	} catch {
		blocked(source.kind);
	}
	try {
		await withFileLock(source.path, async () => {
			const currentRaw = await Bun.file(source.path).text();
			if (fingerprint(currentRaw) !== snapshot.rawFingerprint) blocked(source.kind);
			const current = parseSettingsFile(currentRaw, source);
			if (current.semanticFingerprint !== snapshot.semanticFingerprint) blocked(source.kind);
			if (source.project) validateRetiredImagePolicy(current.value, { source: source.kind, project: true });
			if (collectRetiredPaths(current.value).length === 0) return;
			removeRetiredKeys(current.value);
			await writeAtomicText(source.path, `${JSON.stringify(current.value, null, 2)}\n`, stat!.mode);
		});
	} catch (error) {
		if (error instanceof RetiredImageSecretGateError) throw error;
		blocked(source.kind);
	}
}

async function scrubYamlSource(source: SettingsSource, snapshot: ParsedSettingsFile): Promise<void> {
	let stat: Stats;
	try {
		stat = await fs.stat(source.path);
	} catch {
		blocked(source.kind);
	}
	try {
		await withFileLock(source.path, async () => {
			const currentRaw = await Bun.file(source.path).text();
			if (fingerprint(currentRaw) !== snapshot.rawFingerprint) blocked(source.kind);
			const current = parseSettingsFile(currentRaw, source);
			if (current.semanticFingerprint !== snapshot.semanticFingerprint) blocked(source.kind);
			if (source.project) validateRetiredImagePolicy(current.value, { source: source.kind, project: true });
			if (collectRetiredPaths(current.value).length === 0) return;
			removeRetiredKeys(current.value);
			await writeAtomicText(source.path, YAML.stringify(current.value), stat!.mode);
		});
	} catch (error) {
		if (error instanceof RetiredImageSecretGateError) throw error;
		blocked(source.kind);
	}
}

async function processSettingsSource(source: SettingsSource): Promise<void> {
	const snapshot = await readRegularFile(source);
	if (!snapshot) return;
	if (source.project) validateRetiredImagePolicy(snapshot.value, { source: source.kind, project: true });
	const retiredPaths = collectRetiredPaths(snapshot.value);
	if (retiredPaths.length === 0) return;
	if (source.ownership !== "owned" || source.project) blocked(source.kind);
	if (source.format === "json") await scrubJsonSource(source, snapshot);
	else await scrubYamlSource(source, snapshot);
	const proof = await readRegularFile(source);
	if (!proof) blocked(source.kind);
	validateRetiredImagePolicy(proof.value, { source: source.kind, project: source.project });
}

function addSource(sources: Map<string, SettingsSource>, source: SettingsSource): void {
	sources.set(path.resolve(source.path), { ...source, path: path.resolve(source.path) });
}

function addFilePair(
	sources: Map<string, SettingsSource>,
	basePath: string,
	ownership: SettingsFileOwnership,
	kind: SettingsSourceKind,
	project: boolean,
): void {
	addSource(sources, { path: `${basePath}/config.yml`, format: "yaml", ownership, kind, project });
	addSource(sources, { path: `${basePath}/settings.json`, format: "json", ownership, kind, project });
}

async function resolveProjectRoot(cwd: string): Promise<string | null> {
	let current = path.resolve(cwd);
	for (;;) {
		let entries: Dirent[];

		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch (error) {
			if (isMissing(error)) return null;
			blocked("repository-discovery");
		}
		if (entries!.some(entry => entry.name === ".git")) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function addProjectIngressSources(sources: Map<string, SettingsSource>, root: string): void {
	const projectBase = path.resolve(root);
	const add = (relativePath: string, format: SettingsFileFormat): void =>
		addSource(sources, {
			path: path.join(projectBase, relativePath),
			format,
			ownership: "ingress",
			kind: "project-ingress",
			project: true,
		});
	add(".gemini/settings.json", "json");
	add(".gemini/config.yml", "yaml");
	add(".claude/settings.json", "json");
	add(".claude/config.yml", "yaml");
	add(".cursor/settings.json", "json");
	add(".cursor/config.yml", "yaml");
	add(".opencode/opencode.json", "json");
	add(".opencode/config.yml", "yaml");
	add("opencode.json", "json");
}

function addUserIngressSources(sources: Map<string, SettingsSource>, home: string): void {
	const add = (relativePath: string, format: SettingsFileFormat): void =>
		addSource(sources, {
			path: path.join(home, relativePath),
			format,
			ownership: "ingress",
			kind: "global-ingress",
			project: false,
		});
	add(".gemini/settings.json", "json");
	add(".gemini/config.yml", "yaml");
	add(".cursor/settings.json", "json");
	add(".cursor/config.yml", "yaml");
	add(".config/opencode/opencode.json", "json");
}

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function findSettingsTable(database: Database): string | null {
	const rows = database
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) = 'settings' ORDER BY name")
		.all() as Array<{ name?: unknown }>;
	const names = rows.map(row => row.name).filter((name): name is string => typeof name === "string");
	if (names.length > 1) blocked("legacy-db");
	return names[0] ?? null;
}

function settingsTableColumns(database: Database, tableName: string): Array<{ name?: string }> {
	return database.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name?: string }>;
}

function verifyLegacySettings(database: Database): LegacySettingsState {
	const tableName = findSettingsTable(database);
	if (!tableName) return { hasRetired: false, legacyBlobs: [], modernRows: [] };
	const columns = settingsTableColumns(database, tableName);
	const byLower = new Map<string, string>();
	for (const column of columns) {
		if (typeof column.name !== "string") blocked("legacy-db");
		const lower = column.name.toLowerCase();
		if (byLower.has(lower)) blocked("legacy-db");
		byLower.set(lower, column.name);
	}
	const keyColumn = byLower.get("key");
	const valueColumn = byLower.get("value");
	const idColumn = byLower.get("id");
	const dataColumn = byLower.get("data");
	const table = quoteIdentifier(tableName);
	if (keyColumn && valueColumn) {
		const rows = database
			.prepare(
				`SELECT ${quoteIdentifier(keyColumn)} AS key, ${quoteIdentifier(valueColumn)} AS value FROM ${table} ORDER BY ${quoteIdentifier(keyColumn)} ASC`,
			)
			.all() as Array<{ key?: unknown; value?: unknown }>;
		const modernRows: Array<{ key: string; value: string }> = [];
		let hasRetired = false;
		for (const row of rows) {
			if (typeof row.key !== "string" || typeof row.value !== "string") blocked("legacy-db");
			const key = row.key;
			const value = row.value;
			try {
				const parsed = JSON.parse(value) as unknown;
				if (collectRetiredPaths(parsed).length > 0) hasRetired = true;
			} catch {
				blocked("legacy-db");
			}
			if (isRetiredImageSecretPath(key)) hasRetired = true;
			modernRows.push({ key, value });
		}
		return { hasRetired, legacyBlobs: [], modernRows, tableName, keyColumn, valueColumn };
	}
	if (idColumn && dataColumn && !keyColumn && !valueColumn) {
		const rows = database
			.prepare(
				`SELECT ${quoteIdentifier(idColumn)} AS id, ${quoteIdentifier(dataColumn)} AS data FROM ${table} ORDER BY ${quoteIdentifier(idColumn)} ASC`,
			)
			.all() as Array<{ id?: unknown; data?: unknown }>;
		const legacyBlobs: LegacyBlobRow[] = [];
		let hasRetired = false;
		for (const row of rows) {
			if (
				(typeof row.id !== "string" && typeof row.id !== "number") ||
				(typeof row.id === "number" && !Number.isFinite(row.id)) ||
				typeof row.data !== "string"
			) {
				blocked("legacy-db");
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.data);
			} catch {
				blocked("legacy-db");
			}
			if (!isRecord(parsed)) blocked("legacy-db");
			if (collectRetiredPaths(parsed).length > 0) hasRetired = true;
			legacyBlobs.push({ id: row.id, data: row.data });
		}
		return {
			hasRetired,
			legacyBlobs,
			modernRows: [],
			tableName,
			idColumn,
			valueColumn: dataColumn,
		};
	}
	blocked("legacy-db");
}

function scrubLegacySettings(database: Database, state: LegacySettingsState): void {
	if (!state.tableName) blocked("legacy-db");
	const table = quoteIdentifier(state.tableName);
	if (state.legacyBlobs.length > 0) {
		if (!state.idColumn || !state.valueColumn) blocked("legacy-db");
		const update = database.prepare(
			`UPDATE ${table} SET ${quoteIdentifier(state.valueColumn)} = ? WHERE ${quoteIdentifier(state.idColumn)} = ?`,
		);
		for (const row of state.legacyBlobs) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.data);
			} catch {
				blocked("legacy-db");
			}
			if (!isRecord(parsed)) blocked("legacy-db");
			if (removeRetiredKeys(parsed)) update.run(JSON.stringify(parsed), row.id);
		}
		return;
	}
	if (!state.keyColumn || !state.valueColumn) blocked("legacy-db");
	for (const row of state.modernRows) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.value);
		} catch {
			blocked("legacy-db");
		}
		if (isRetiredImageSecretPath(row.key)) {
			database.prepare(`DELETE FROM ${table} WHERE ${quoteIdentifier(state.keyColumn)} = ?`).run(row.key);
			continue;
		}
		if (removeRetiredKeys(parsed)) {
			database
				.prepare(
					`UPDATE ${table} SET ${quoteIdentifier(state.valueColumn)} = ? WHERE ${quoteIdentifier(state.keyColumn)} = ?`,
				)
				.run(JSON.stringify(parsed), row.key);
		}
	}
}

function verifyDatabaseClean(database: Database): void {
	const state = verifyLegacySettings(database);
	if (state.hasRetired) blocked("legacy-db");
}

function checkpointWal(database: Database): void {
	const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: unknown } | undefined;
	if (!result || typeof result.busy !== "number" || result.busy !== 0) blocked("legacy-db");
}

async function assertDatabaseSidecars(dbPath: string, mainExists: boolean, afterClose: boolean): Promise<void> {
	for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
		try {
			const stat = await fs.lstat(`${dbPath}${suffix}`);
			if (!stat.isFile() || stat.isSymbolicLink() || !mainExists) blocked("legacy-db");
			if (afterClose && suffix !== "-shm" && stat.size !== 0) blocked("legacy-db");
		} catch (error) {
			if (!isMissing(error)) blocked("legacy-db");
		}
	}
}

async function inspectLegacyDatabase(dbPath: string): Promise<void> {
	let database: Database | undefined;
	let began = false;
	try {
		database = new Database(dbPath, { create: false, strict: true });
		database.run("PRAGMA busy_timeout = 250");
		database.run("PRAGMA secure_delete = ON");
		const secureDelete = database.prepare("PRAGMA secure_delete").get() as
			| { secure_delete?: unknown }
			| number
			| undefined;
		const secureDeleteValue = typeof secureDelete === "number" ? secureDelete : secureDelete?.secure_delete;
		if (!(secureDeleteValue === 1 || String(secureDeleteValue).toLowerCase() === "on")) blocked("legacy-db");
		let lastError: unknown;
		for (const delay of [0, ...SQLITE_BUSY_RETRY_DELAYS_MS]) {
			if (delay > 0) await Bun.sleep(delay);
			try {
				database.run("BEGIN IMMEDIATE");
				began = true;
				break;
			} catch (error) {
				lastError = error;
				if (
					!String((error as { code?: unknown }).code ?? error)
						.toUpperCase()
						.includes("BUSY")
				)
					break;
			}
		}
		if (!began) {
			void lastError;
			blocked("legacy-db");
		}
		const initial = verifyLegacySettings(database);
		if (initial.hasRetired) scrubLegacySettings(database, initial);
		database.run("COMMIT");
		began = false;
		checkpointWal(database);
		database.run("VACUUM");
		checkpointWal(database);
		verifyDatabaseClean(database);
	} catch (error) {
		if (began) {
			try {
				database?.run("ROLLBACK");
			} catch {
				// Preserve the fail-closed gate error below.
			}
		}
		if (error instanceof RetiredImageSecretGateError) throw error;
		blocked("legacy-db");
	} finally {
		try {
			database?.close();
		} catch {
			blocked("legacy-db");
		}
	}
	let proof: Database | undefined;
	try {
		proof = new Database(dbPath, { readonly: true, strict: true });
		verifyDatabaseClean(proof);
	} catch (error) {
		if (error instanceof RetiredImageSecretGateError) throw error;
		blocked("legacy-db");
	} finally {
		try {
			proof?.close();
		} catch {
			blocked("legacy-db");
		}
	}
}

async function inspectLegacyDatabaseCandidate(dbPath: string): Promise<boolean> {
	let mainExists = false;
	try {
		const stat = await fs.lstat(dbPath);
		if (!stat.isFile() || stat.isSymbolicLink()) blocked("legacy-db");
		mainExists = true;
	} catch (error) {
		if (!isMissing(error)) blocked("legacy-db");
	}
	await assertDatabaseSidecars(dbPath, mainExists, false);
	if (!mainExists) return false;
	await inspectLegacyDatabase(dbPath);
	await assertDatabaseSidecars(dbPath, true, true);
	return true;
}

async function inspectLegacyDatabaseSource(agentDir: string): Promise<void> {
	const dbPath = path.resolve(getAgentDbPath(agentDir));
	const mainExists = await inspectLegacyDatabaseCandidate(dbPath);
	let entries: Dirent[];
	try {
		entries = await fs.readdir(path.dirname(dbPath), { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return;
		blocked("legacy-db");
	}
	for (const entry of entries!) {
		if (!shouldIncludeBackup(entry.name, path.basename(dbPath))) continue;
		const candidatePath = path.join(path.dirname(dbPath), entry.name);
		if (candidatePath === dbPath) continue;
		await inspectLegacyDatabaseCandidate(candidatePath);
	}
	if (!mainExists) return;
}

export async function runRetiredImageSecretGate(options: RetiredImageSecretGateOptions): Promise<void> {
	const cwd = path.resolve(options.cwd);
	const agentDir = path.resolve(options.agentDir);
	const home = path.resolve(os.homedir());
	const configRoot = path.resolve(getConfigRootDir());
	const sources = new Map<string, SettingsSource>();

	addSource(sources, {
		path: path.join(agentDir, "config.yml"),
		format: "yaml",
		ownership: "owned",
		kind: "global-config",
		project: false,
	});
	addSource(sources, {
		path: path.join(agentDir, "settings.json"),
		format: "json",
		ownership: "owned",
		kind: "global-legacy-json",
		project: false,
	});
	addSource(sources, {
		path: path.join(configRoot, "settings.json"),
		format: "json",
		ownership: "owned",
		kind: "global-legacy-json",
		project: false,
	});
	addUserIngressSources(sources, home);

	const projectRoot = await resolveProjectRoot(cwd);
	const projectRoots = [
		...new Set([cwd, projectRoot].filter((root): root is string => root !== null).map(value => path.resolve(value))),
	];
	for (const root of projectRoots) {
		addFilePair(sources, path.join(root, ".gjc"), "owned", "project-config", true);
		addProjectIngressSources(sources, root);
	}

	for (const source of sources.values()) {
		await processSettingsSource(source);
		for (const backup of await siblingBackups(source)) await processSettingsSource(backup);
	}
	await inspectLegacyDatabaseSource(agentDir);
}
