import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	AuthCredential,
	AuthCredentialIfAbsentReason,
	AuthCredentialIfAbsentSnapshotResult,
	AuthStorage,
} from "@gajae-code/ai";
import { getAgentDir, logger, VERSION } from "@gajae-code/utils";
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

export type CredentialAutoImportSourceLabel = "claude-code-file" | "claude-code-keychain" | "codex-file";
export type CredentialAutoImportTrigger = "startup" | "bare-login" | "setup-cli";

const CREDENTIAL_AUTO_IMPORT_STATE_FILENAME = "credential-auto-import-state.json";

interface CredentialAutoImportStateFile {
	lastImportVersion?: unknown;
}

export function getCredentialAutoImportStatePath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, CREDENTIAL_AUTO_IMPORT_STATE_FILENAME);
}

export async function readCredentialImportMarker(agentDir?: string): Promise<string | undefined> {
	try {
		const raw = await fs.readFile(getCredentialAutoImportStatePath(agentDir), "utf-8");
		const parsed = JSON.parse(raw) as CredentialAutoImportStateFile;
		return typeof parsed.lastImportVersion === "string" ? parsed.lastImportVersion : undefined;
	} catch {
		return undefined;
	}
}

export async function writeCredentialImportMarker(version: string, agentDir?: string): Promise<boolean> {
	try {
		const statePath = getCredentialAutoImportStatePath(agentDir);
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(statePath, `${JSON.stringify({ lastImportVersion: version })}\n`);
		return true;
	} catch (error: unknown) {
		logger.warn("Failed to persist credential auto-import state", { error });
		return false;
	}
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

export interface CredentialImportMarkerStore {
	read: () => Promise<string | undefined> | string | undefined;
	write: (version: string) => Promise<boolean> | boolean;
}

export interface StartupCredentialAutoImportOptions {
	authStorage: CredentialAutoImportOptions["authStorage"];
	modelRegistry: Pick<ModelRegistry, "refresh">;
	discover?: CredentialAutoImportOptions["discover"];
	version?: string;
	agentDir?: string;
	markerStore?: CredentialImportMarkerStore;
}

export async function runStartupCredentialAutoImportIfNeeded({
	authStorage: activeAuthStorage,
	modelRegistry: activeModelRegistry,
	discover,
	version = VERSION,
	agentDir,
	markerStore,
}: StartupCredentialAutoImportOptions): Promise<string | undefined> {
	const store = markerStore ?? {
		read: () => readCredentialImportMarker(agentDir),
		write: (nextVersion: string) => writeCredentialImportMarker(nextVersion, agentDir),
	};
	const lastVersion = await store.read();
	if (lastVersion === version) {
		// Steady state: user already completed this version's auto-import gate. Skip all file/Keychain reads.
		return undefined;
	}

	const result = await runExternalCredentialAutoImport({
		authStorage: activeAuthStorage,
		discover,
		trigger: "startup",
	});
	if (!result.discovered) {
		return undefined;
	}

	const candidates = filterAutoImportOAuthCredentials(result.discovery?.importable ?? []);
	if (candidates.length > 0 && result.imported.length === 0 && result.skipped.length === 0) {
		return undefined;
	}
	await store.write(version);

	if (result.imported.length > 0) {
		await activeModelRegistry.refresh("offline");
	}
	return buildCredentialAutoImportNotice(result);
}
