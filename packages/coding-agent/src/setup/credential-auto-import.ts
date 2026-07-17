import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	AuthCredential,
	AuthCredentialIfAbsentReason,
	AuthCredentialIfAbsentSnapshotResult,
	AuthStorage,
} from "@gajae-code/ai";
import { getAgentDir, logger, VERSION } from "@gajae-code/utils";
import { withFileLock } from "../config/file-lock";
import type { ModelRegistry } from "../config/model-registry";
import {
	type CredentialDiscoveryResult,
	type CredentialOrigin,
	type DiscoveryOptions,
	discoverExternalCredentials,
	EXTERNAL_PROVIDER_LABELS,
	type ExternalProvider,
	filterAutoImportOAuthCredentials,
	formatCredentialSummary,
	type ImportableCredential,
} from "./credential-import";

export const CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING =
	"Refreshing in gjc may log out the Claude/Codex CLI because OAuth refresh tokens can rotate.";
export const CREDENTIAL_AUTO_IMPORT_PERSISTENCE_WARNING =
	"Credential import preference could not be saved; external credentials may be offered again.";
export const CREDENTIAL_AUTO_IMPORT_REFRESH_WARNING =
	"Imported credentials were saved, but provider availability could not be refreshed.";
export const CREDENTIAL_AUTO_IMPORT_DISCOVERY_WARNING =
	"External credential discovery could not be completed. Use /provider to import credentials manually.";
export const CREDENTIAL_AUTO_IMPORT_RETRY_WARNING =
	"Some external credentials could not be imported. Use /provider to retry.";

export const CREDENTIAL_AUTO_IMPORT_STATE_UNREADABLE_WARNING =
	"Credential import preference could not be read. External credential discovery was skipped; use /provider to import credentials manually.";

export type CredentialAutoImportSourceLabel = "claude-code-file" | "claude-code-keychain" | "codex-file";
export type CredentialAutoImportTrigger = "startup" | "bare-login" | "setup-cli";
export type InitialImportResolution = "accepted" | "declined";
export type CredentialAutoImportStateProblem =
	| "invalid-initial-import-resolution"
	| "invalid-last-import-version"
	| "malformed-json"
	| "malformed-root";

const CREDENTIAL_AUTO_IMPORT_STATE_FILENAME = "credential-auto-import-state.json";
const VERSION_MARKER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface CredentialAutoImportStateFile {
	lastImportVersion?: string;
	initialImportResolution?: InitialImportResolution;
}

export interface CredentialAutoImportStateReadResult {
	state: CredentialAutoImportStateFile;
	problems: CredentialAutoImportStateProblem[];
	unreadable: boolean;
}

export interface CredentialAutoImportStateMutation {
	lastImportVersion?: string;
	initialImportResolution?: InitialImportResolution;
}

export interface CredentialAutoImportStateStore {
	read: () => Promise<CredentialAutoImportStateReadResult>;
	write: (mutation: CredentialAutoImportStateMutation) => Promise<boolean>;
}

export interface CredentialAutoImportStateStoreDependencies {
	withFileLock?: <T>(filePath: string, transaction: () => Promise<T>) => Promise<T>;
	rename?: (oldPath: string, newPath: string) => Promise<void>;
}

export function getCredentialAutoImportStatePath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, CREDENTIAL_AUTO_IMPORT_STATE_FILENAME);
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isValidVersionMarker(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.trim() === value &&
		value.length <= 128 &&
		VERSION_MARKER_PATTERN.test(value)
	);
}

function isInitialImportResolution(value: unknown): value is InitialImportResolution {
	return value === "accepted" || value === "declined";
}

function projectCredentialAutoImportState(value: unknown): CredentialAutoImportStateReadResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { state: {}, problems: ["malformed-root"], unreadable: false };
	}

	const record = value as Record<string, unknown>;
	const state: CredentialAutoImportStateFile = {};
	const problems: CredentialAutoImportStateProblem[] = [];
	if (Object.hasOwn(record, "initialImportResolution")) {
		if (isInitialImportResolution(record.initialImportResolution)) {
			state.initialImportResolution = record.initialImportResolution;
		} else {
			problems.push("invalid-initial-import-resolution");
		}
	}
	if (Object.hasOwn(record, "lastImportVersion")) {
		if (isValidVersionMarker(record.lastImportVersion)) {
			state.lastImportVersion = record.lastImportVersion;
		} else {
			problems.push("invalid-last-import-version");
		}
	}
	return { state, problems, unreadable: false };
}

async function readCredentialAutoImportStateAtPath(statePath: string): Promise<CredentialAutoImportStateReadResult> {
	try {
		const raw = await fs.readFile(statePath, "utf-8");
		try {
			return projectCredentialAutoImportState(JSON.parse(raw) as unknown);
		} catch {
			return { state: {}, problems: ["malformed-json"], unreadable: false };
		}
	} catch (error: unknown) {
		if (isEnoent(error)) return { state: {}, problems: [], unreadable: false };
		return { state: {}, problems: [], unreadable: true };
	}
}

function serializeCredentialAutoImportState(state: CredentialAutoImportStateFile): string {
	const serialized: CredentialAutoImportStateFile = {};
	if (isValidVersionMarker(state.lastImportVersion)) serialized.lastImportVersion = state.lastImportVersion;
	if (isInitialImportResolution(state.initialImportResolution)) {
		serialized.initialImportResolution = state.initialImportResolution;
	}
	return `${JSON.stringify(serialized)}\n`;
}

async function writeCredentialAutoImportStateAtomic(
	statePath: string,
	state: CredentialAutoImportStateFile,
	rename: (oldPath: string, newPath: string) => Promise<void> = fs.rename,
): Promise<void> {
	const temporaryPath = `${statePath}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
	try {
		const handle = await fs.open(temporaryPath, "wx", 0o600);
		try {
			await handle.writeFile(serializeCredentialAutoImportState(state));
		} finally {
			await handle.close();
		}
		await rename(temporaryPath, statePath);
	} catch (error: unknown) {
		await fs.rm(temporaryPath, { force: true }).catch(() => {});
		throw error;
	}
}

export function createCredentialAutoImportStateStore(
	agentDir: string = getAgentDir(),
	dependencies: CredentialAutoImportStateStoreDependencies = {},
): CredentialAutoImportStateStore {
	const statePath = getCredentialAutoImportStatePath(agentDir);
	const lock = dependencies.withFileLock ?? withFileLock;
	const rename = dependencies.rename ?? fs.rename;
	return {
		read: () => readCredentialAutoImportStateAtPath(statePath),
		write: async mutation => {
			if (
				(mutation.lastImportVersion !== undefined && !isValidVersionMarker(mutation.lastImportVersion)) ||
				(mutation.initialImportResolution !== undefined &&
					!isInitialImportResolution(mutation.initialImportResolution))
			) {
				return false;
			}
			try {
				await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
				await lock(statePath, async () => {
					const current = await readCredentialAutoImportStateAtPath(statePath);
					if (current.unreadable) throw new Error("Credential auto-import state became unreadable");
					const next: CredentialAutoImportStateFile = { ...current.state };
					if (mutation.lastImportVersion !== undefined) next.lastImportVersion = mutation.lastImportVersion;
					if (next.initialImportResolution === undefined && mutation.initialImportResolution !== undefined) {
						next.initialImportResolution = mutation.initialImportResolution;
					}
					await writeCredentialAutoImportStateAtomic(statePath, next, rename);
				});
				return true;
			} catch {
				logger.warn("Credential auto-import state persistence failed", { classification: "state-write-failed" });
				return false;
			}
		},
	};
}

export async function readCredentialAutoImportState(agentDir?: string): Promise<CredentialAutoImportStateReadResult> {
	return createCredentialAutoImportStateStore(agentDir).read();
}

export function isCredentialAutoImportStateResolvedForVersion(
	state: CredentialAutoImportStateFile,
	version: string,
): boolean {
	return (
		state.initialImportResolution === "declined" ||
		(state.initialImportResolution === "accepted" && state.lastImportVersion === undefined) ||
		(state.lastImportVersion !== undefined && state.lastImportVersion === version)
	);
}

export async function readCredentialImportMarker(agentDir?: string): Promise<string | undefined> {
	return (await readCredentialAutoImportState(agentDir)).state.lastImportVersion;
}

export async function writeCredentialImportMarker(version: string, agentDir?: string): Promise<boolean> {
	return createCredentialAutoImportStateStore(agentDir).write({ lastImportVersion: version });
}

export enum CredentialAutoImportFailureClass {
	DiscoveryUnavailable = "discovery-unavailable",
	SourceUnreadable = "source-unreadable",
	SourceMalformed = "source-malformed",
	KeychainDenied = "keychain-denied",
	WriteInvalid = "write-invalid",
	WriteConflict = "write-conflict",
	BrokerUnavailable = "broker-unavailable",
	BrokerUnsupported = "broker-unsupported",
	Unknown = "unknown",
}

export interface CredentialAutoImportSkipped {
	credential: ImportableCredential;
	reason: AuthCredentialIfAbsentReason;
	entries: AuthCredentialIfAbsentSnapshotResult["entries"];
}

export interface CredentialAutoImportFailure {
	credential?: ImportableCredential;
	origin?: CredentialOrigin;
	source?: string;
	failureClass: CredentialAutoImportFailureClass;
}

export interface CredentialAutoImportResult {
	imported: ImportableCredential[];
	skipped: CredentialAutoImportSkipped[];
	failures: CredentialAutoImportFailure[];
	discovered: boolean;
	discovery?: CredentialDiscoveryResult;
	globalDiscoveryFailure?: CredentialAutoImportFailure;
}

const CREDENTIAL_AUTO_IMPORT_PROMPT_PROVIDERS: readonly ExternalProvider[] = ["anthropic", "openai-codex"];
const CREDENTIAL_AUTO_IMPORT_PROMPT_ORIGINS: readonly CredentialOrigin[] = [
	"claude-code-file",
	"claude-code-keychain",
	"codex-file",
];
const CREDENTIAL_AUTO_IMPORT_ORIGIN_LABELS: Record<CredentialOrigin, string> = {
	"claude-code-file": "Claude Code file",
	"claude-code-keychain": "Claude Code Keychain",
	"codex-file": "Codex CLI file",
};
const CREDENTIAL_AUTO_IMPORT_FAILURE_CLASSES = new Set(Object.values(CredentialAutoImportFailureClass));

export function formatCredentialAutoImportCandidateLabel(
	candidate: Pick<ImportableCredential, "provider" | "origin">,
): string {
	const provider = CREDENTIAL_AUTO_IMPORT_PROMPT_PROVIDERS.includes(candidate.provider)
		? EXTERNAL_PROVIDER_LABELS[candidate.provider]
		: undefined;
	const origin = CREDENTIAL_AUTO_IMPORT_PROMPT_ORIGINS.includes(candidate.origin)
		? CREDENTIAL_AUTO_IMPORT_ORIGIN_LABELS[candidate.origin]
		: undefined;
	return provider && origin ? `${provider} · ${origin}` : "External OAuth credential";
}

export function formatCredentialAutoImportPrompt(
	candidates: readonly Pick<ImportableCredential, "provider" | "origin">[],
): string {
	const lines: string[] = [];
	for (const provider of CREDENTIAL_AUTO_IMPORT_PROMPT_PROVIDERS) {
		for (const origin of CREDENTIAL_AUTO_IMPORT_PROMPT_ORIGINS) {
			const count = candidates.filter(
				candidate => candidate.provider === provider && candidate.origin === origin,
			).length;
			if (count > 0)
				lines.push(
					`${EXTERNAL_PROVIDER_LABELS[provider]} · ${CREDENTIAL_AUTO_IMPORT_ORIGIN_LABELS[origin]}: ${count}`,
				);
		}
	}
	return `External OAuth credentials found: ${candidates.length}\n${lines.join("\n")}`;
}

export function logCredentialAutoImportFailures(
	trigger: CredentialAutoImportTrigger,
	failures: readonly Pick<CredentialAutoImportFailure, "failureClass">[],
): void {
	const failureCounts: Partial<Record<CredentialAutoImportFailureClass, number>> = {};
	for (const failure of failures) {
		if (!CREDENTIAL_AUTO_IMPORT_FAILURE_CLASSES.has(failure.failureClass)) continue;
		failureCounts[failure.failureClass] = (failureCounts[failure.failureClass] ?? 0) + 1;
	}
	if (Object.keys(failureCounts).length > 0) {
		logger.warn("Credential auto-import completed with failures", { trigger, failureCounts });
	}
}

export type CredentialAutoImportAuthStorage = Pick<AuthStorage, "importCredentialIfAbsent">;

export interface CredentialAutoImportOptions {
	authStorage: CredentialAutoImportAuthStorage;
	discover?: (options?: DiscoveryOptions) => Promise<CredentialDiscoveryResult>;
	discoveryOptions?: DiscoveryOptions;
	trigger: CredentialAutoImportTrigger;
	sourceLabel?: CredentialAutoImportSourceLabel;
}

function classifyDiscoverySkip(reason: string, origin: CredentialOrigin): CredentialAutoImportFailureClass {
	const lower = reason.toLowerCase();
	if (
		origin === "claude-code-keychain" &&
		(lower.includes("eacces") || lower.includes("eperm") || lower.includes("denied"))
	) {
		return CredentialAutoImportFailureClass.KeychainDenied;
	}
	if (lower.includes("malformed")) return CredentialAutoImportFailureClass.SourceMalformed;
	if (lower.includes("unreadable")) return CredentialAutoImportFailureClass.SourceUnreadable;
	return CredentialAutoImportFailureClass.Unknown;
}

function classifyWriteFailure(error: unknown): CredentialAutoImportFailureClass {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	if (message.includes("invalid")) return CredentialAutoImportFailureClass.WriteInvalid;
	if (message.includes("conflict") || message.includes("constraint"))
		return CredentialAutoImportFailureClass.WriteConflict;
	if (
		message.includes("broker") &&
		(message.includes("unsupported") || message.includes("404") || message.includes("501"))
	) {
		return CredentialAutoImportFailureClass.BrokerUnsupported;
	}
	if (message.includes("broker") || message.includes("fetch") || message.includes("network")) {
		return CredentialAutoImportFailureClass.BrokerUnavailable;
	}
	return CredentialAutoImportFailureClass.Unknown;
}

export async function runExternalCredentialAutoImport({
	authStorage,
	discover = discoverExternalCredentials,
	discoveryOptions,
}: CredentialAutoImportOptions): Promise<CredentialAutoImportResult> {
	let discovery: CredentialDiscoveryResult;
	try {
		discovery = await discover(discoveryOptions);
	} catch {
		const globalDiscoveryFailure = { failureClass: CredentialAutoImportFailureClass.DiscoveryUnavailable };
		return {
			imported: [],
			skipped: [],
			failures: [globalDiscoveryFailure],
			discovered: false,
			globalDiscoveryFailure,
		};
	}

	const candidates = filterAutoImportOAuthCredentials(discovery.importable);
	const failures: CredentialAutoImportFailure[] = discovery.skipped.map(skip => ({
		origin: skip.origin,
		source: skip.source,
		failureClass: classifyDiscoverySkip(skip.reason, skip.origin),
	}));
	const imported: ImportableCredential[] = [];
	const skipped: CredentialAutoImportSkipped[] = [];
	const importIfAbsent = authStorage.importCredentialIfAbsent;

	for (const credential of candidates) {
		try {
			const outcome = await importIfAbsent.call(
				authStorage,
				credential.provider,
				credential.credential as AuthCredential,
			);
			if (outcome.inserted === true) {
				imported.push(credential);
			} else {
				skipped.push({ credential, reason: outcome.reason, entries: outcome.entries });
			}
		} catch (error) {
			failures.push({ credential, failureClass: classifyWriteFailure(error) });
		}
	}

	return { imported, skipped, failures, discovered: true, discovery };
}

export function buildCredentialAutoImportNotice(
	result: Pick<CredentialAutoImportResult, "imported">,
): string | undefined {
	if (result.imported.length === 0) return undefined;
	const providers = [
		...new Set(result.imported.map(c => EXTERNAL_PROVIDER_LABELS[c.provider as ExternalProvider] ?? c.provider)),
	];
	const success = `Imported ${result.imported.length} external OAuth credential(s) into gjc: ${providers.join(", ")}.`;
	return `${success}\n${CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING}`;
}

export function formatCredentialAutoImportResult(result: CredentialAutoImportResult): string[] {
	const lines: string[] = [];
	for (const credential of result.imported) lines.push(`imported ${formatCredentialSummary(credential)}`);
	for (const skip of result.skipped) lines.push(`skipped ${skip.credential.source}: ${skip.reason}`);
	for (const failure of result.failures) {
		const label = failure.credential?.source ?? failure.source ?? "external credential discovery";
		lines.push(`failed ${label}: ${failure.failureClass}`);
	}
	return lines;
}

export interface StartupCredentialAutoImportOptions {
	authStorage: CredentialAutoImportOptions["authStorage"];
	modelRegistry: Pick<ModelRegistry, "refresh">;
	discover?: CredentialAutoImportOptions["discover"];
	version?: string;
	agentDir?: string;
	stateStore?: CredentialAutoImportStateStore;
}

function appendNoticeLine(notice: string | undefined, line: string): string {
	return notice ? `${notice}\n${line}` : line;
}

async function readStateSafely(store: CredentialAutoImportStateStore): Promise<CredentialAutoImportStateReadResult> {
	try {
		return await store.read();
	} catch {
		logger.warn("Credential auto-import state read failed", { classification: "state-read-failed" });
		return { state: {}, problems: [], unreadable: true };
	}
}

async function writeStateSafely(
	store: CredentialAutoImportStateStore,
	mutation: CredentialAutoImportStateMutation,
): Promise<boolean> {
	try {
		return await store.write(mutation);
	} catch {
		logger.warn("Credential auto-import state persistence failed", { classification: "state-write-failed" });
		return false;
	}
}

export async function runStartupCredentialAutoImportIfNeeded({
	authStorage: activeAuthStorage,
	modelRegistry: activeModelRegistry,
	discover,
	version = VERSION,
	agentDir,
	stateStore,
}: StartupCredentialAutoImportOptions): Promise<string | undefined> {
	const store = stateStore ?? createCredentialAutoImportStateStore(agentDir);
	const stateRead = await readStateSafely(store);
	if (stateRead.unreadable) {
		logger.warn("Credential auto-import state unavailable", { classification: "state-unreadable" });
		return undefined;
	}
	if (isCredentialAutoImportStateResolvedForVersion(stateRead.state, version)) return undefined;

	const result = await runExternalCredentialAutoImport({
		authStorage: activeAuthStorage,
		discover,
		trigger: "startup",
	});
	if (!result.discovered) {
		logCredentialAutoImportFailures("startup", result.failures);
		return undefined;
	}

	const candidates = filterAutoImportOAuthCredentials(result.discovery?.importable ?? []);
	const handledCandidates = result.imported.length + result.skipped.length > 0;
	if (result.failures.length > 0) logCredentialAutoImportFailures("startup", result.failures);
	let persisted = true;
	if (handledCandidates) {
		persisted = await writeStateSafely(store, {
			lastImportVersion: version,
			initialImportResolution: "accepted",
		});
	} else if (candidates.length === 0 && result.failures.length === 0) {
		persisted = await writeStateSafely(store, { lastImportVersion: version });
	}

	let notice = buildCredentialAutoImportNotice(result);
	if (!persisted) notice = appendNoticeLine(notice, CREDENTIAL_AUTO_IMPORT_PERSISTENCE_WARNING);
	if (result.imported.length > 0) {
		try {
			await activeModelRegistry.refresh("offline");
		} catch {
			logger.warn("Credential auto-import refresh failed", { classification: "refresh-failed" });
			notice = appendNoticeLine(notice, CREDENTIAL_AUTO_IMPORT_REFRESH_WARNING);
		}
	}
	return notice;
}
