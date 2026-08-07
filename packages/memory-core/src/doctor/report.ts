import { createHash } from "node:crypto";

import type { ParsedMemoryDocument } from "../documents/document-parser";
import { type MemoryEnvironment, type MemoryScopeKind, validateMemoryEnvironment } from "../env";
import { invalidInput, MEMORY_EXIT_CODES, type MemoryResult } from "../errors";
import { type ParsedMemoryMap, parseMemoryMap } from "../maps/map-parser";
import { parseRoutes, type RouteConfig } from "../maps/route-resolver";
import { checkInitializedRoot } from "../policy/initialized";
import { redactSecrets } from "../policy/secret-scan";
import { admitAuditScope, enumerateAuditJournals } from "../resources/audit-admission";
import { readControlResource } from "../resources/read-control-resource";
import { resolveScopes } from "../scope/scope-resolver";
import { type JournalProgress, journalRelPathSet, type MemoryJournal } from "../storage/journal";

import { checkLifecycle } from "./lifecycle";
import { checkRetrieval } from "./retrieval";
import { checkSecurity } from "./security";
import { checkStructural } from "./structural";

export type DoctorSeverity = "info" | "warning" | "error";

export interface DoctorFinding {
	readonly code: string;
	readonly severity: DoctorSeverity;
	readonly relPath: string | null;
	readonly detail: string;
}

export interface DoctorResource {
	readonly relPath?: string;
	readonly content?: string;
	readonly digest?: string;
}

export type DoctorMapResource = DoctorResource & { readonly parsed?: ParsedMemoryMap };
export interface DoctorMapRoute {
	readonly uri: string;
	readonly aliases?: readonly string[];
}

export type DoctorRoutesResource = DoctorResource & { readonly parsed?: RouteConfig };

export interface DoctorMetadata {
	readonly schemaVersion?: string;
	readonly id?: string;
	readonly type?: string;
	readonly scope?: string;
	readonly authority?: string;
	readonly volatility?: string;
	readonly sensitivity?: string;
	readonly status?: string;
	readonly created?: string;
	readonly updated?: string;
	readonly aliases?: readonly string[];
	readonly supersedes?: readonly string[];
}

export interface DoctorDocument {
	readonly relPath: string;
	readonly uri?: string | null;
	/** Bodies are retained only for internal synthetic-context tests; on-disk admission leaves this null. */
	readonly content?: string | null;
	readonly digest?: string | null;
	readonly metadata?: DoctorMetadata;
	readonly parsed?: ParsedMemoryDocument;
	readonly parseError?: boolean;
	readonly headings?: readonly string[];
	readonly kind?: "file" | "directory" | "symlink";
}

export interface DoctorFile extends DoctorDocument {
	readonly kind?: "file" | "directory" | "symlink";
	readonly mode?: number | bigint;
	readonly size?: number | bigint;
	readonly binary?: boolean;
	readonly secretLines?: readonly number[];
	readonly privateMemory?: boolean;
}

export interface DoctorDirectory {
	readonly relPath: string;
	readonly kind?: "directory" | "symlink";
	readonly mode?: number | bigint;
	readonly size?: number | bigint;
}

export interface DoctorGeneratedIndex {
	readonly relPath: string;
	readonly digest: string;
	readonly expectedDigest: string;
}

export interface DoctorJournal {
	readonly relPath: string;
	readonly mutationId?: string;
	readonly journal?: MemoryJournal;
	readonly progress?: readonly JournalProgress[];
	readonly state?: "pending" | "recoverable" | "tampered" | "complete";
	readonly pending?: boolean;
	readonly recoverable?: boolean;
	readonly tampered?: boolean;
}

export interface DoctorContext {
	readonly mapRoutes?: readonly DoctorMapRoute[];
	readonly map?: DoctorMapResource;
	readonly mapContent?: string;
	readonly routes?: DoctorRoutesResource;
	readonly routesContent?: string;
	readonly routeConfig?: RouteConfig;
	readonly documents?: readonly DoctorDocument[];
	readonly files?: readonly DoctorFile[];
	readonly directories?: readonly DoctorDirectory[];
	readonly generatedIndexes?: readonly DoctorGeneratedIndex[];
	readonly maxBytes?: number;
	readonly journals?: readonly DoctorJournal[];
	readonly admissionFindings?: readonly DoctorFinding[];
}

export interface DoctorInput {
	readonly maxBytes?: number;
}

export interface DoctorResult {
	readonly schemaVersion: "gajae.memory.audit.v1";
	readonly healthy: boolean;
	readonly findings: readonly DoctorFinding[];
}

function policyDenied(reason: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination: "doctor-report",
			reason,
		},
	};
}

export function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

export function normalizeRelPath(value: string): string | null {
	if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\u0000")) return null;
	const normalized = value.normalize("NFC");
	if (normalized.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(normalized)) return null;
	const parts = normalized.split("/");
	for (const part of parts) {
		if (part.length === 0 || part === "." || part === ".." || /[\u0000-\u001f\u007f]/u.test(part)) return null;
		let decoded = part;
		for (let attempt = 0; attempt < 3 && decoded.includes("%"); attempt += 1) {
			try {
				decoded = decodeURIComponent(decoded);
			} catch {
				return null;
			}
		}
		if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return null;
	}
	return parts.join("/");
}

export function finding(code: string, severity: DoctorSeverity, relPath: string | null, detail: string): DoctorFinding {
	const safeCode = code.normalize("NFC");
	const safePath = relPath === null ? null : normalizeRelPath(relPath);
	const redacted = redactSecrets(detail);
	const redactedDetail = redacted.ok ? redacted.value : "[REDACTED]";
	const safeDetail = redactedDetail
		.normalize("NFC")
		.replace(/(?:^|\s)(?:\/|[A-Za-z]:[\\/])[^\s]*/gu, "$1[PATH]")
		.replace(/[\r\n\t]/gu, " ")
		.slice(0, 300);
	return Object.freeze({ code: safeCode, severity, relPath: safePath, detail: safeDetail });
}

export function compareFindings(left: DoctorFinding, right: DoctorFinding): number {
	const byCode = compareUtf8(left.code, right.code);
	if (byCode !== 0) return byCode;
	const leftPath = left.relPath ?? "";
	const rightPath = right.relPath ?? "";
	const byPath = compareUtf8(leftPath, rightPath);
	if (byPath !== 0) return byPath;
	return compareUtf8(left.detail, right.detail);
}

export function sortFindings(findings: readonly DoctorFinding[]): readonly DoctorFinding[] {
	const ordered = [...findings].sort(compareFindings);
	const unique: DoctorFinding[] = [];
	for (const item of ordered) {
		const prior = unique.at(-1);
		if (prior !== undefined && compareFindings(prior, item) === 0) continue;
		unique.push(item);
	}
	return Object.freeze(unique);
}

export function okFindings(findings: readonly DoctorFinding[]): MemoryResult<readonly DoctorFinding[]> {
	return { ok: true, value: sortFindings(findings) };
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDoctorFinding(value: unknown): value is DoctorFinding {
	if (!isRecord(value)) return false;
	return (
		typeof value.code === "string" &&
		(value.severity === "info" || value.severity === "warning" || value.severity === "error") &&
		(value.relPath === null || typeof value.relPath === "string") &&
		typeof value.detail === "string"
	);
}

function publicMapUri(uri: string): string {
	const match = /^memory:\/\/(global|project|session)\/(.+)$/u.exec(uri.normalize("NFC"));
	return match === null ? uri.normalize("NFC") : `${match[1]}://${match[2]}`;
}

function publicParsedMap(parsed: ParsedMemoryMap): ParsedMemoryMap {
	return Object.freeze({
		...parsed,
		routes: Object.freeze(parsed.routes.map(route => Object.freeze({ ...route, uri: publicMapUri(route.uri) }))),
	});
}

function mapResourceFromControl(environment: MemoryEnvironment): MemoryResult<DoctorMapResource | null> {
	const result = readControlResource(environment, "MEMORY.md");
	if (!result.ok) {
		if (result.error.code === "not-found") return { ok: true, value: null };
		return result;
	}
	const parsed = parseMemoryMap(result.value.content, result.value.relPath);
	return {
		ok: true,
		value: Object.freeze({
			relPath: result.value.relPath,
			content: result.value.content,
			digest: result.value.digest,
			parsed: parsed.ok ? publicParsedMap(parsed.value) : undefined,
		}),
	};
}

function routesResourceFromControl(environment: MemoryEnvironment): MemoryResult<DoctorRoutesResource | null> {
	const result = readControlResource(environment, "routes.yaml");
	if (!result.ok) {
		if (result.error.code === "not-found") return { ok: true, value: null };
		return result;
	}
	return {
		ok: true,
		value: Object.freeze({
			relPath: result.value.relPath,
			content: result.value.content,
			digest: result.value.digest,
		}),
	};
}

function scopePrefix(kind: MemoryScopeKind, projectKey: string | null, sessionId: string | null): string | null {
	if (kind === "global") return "global";
	if (kind === "project") return projectKey === null || projectKey.length === 0 ? null : `projects/${projectKey}`;
	return sessionId === null || sessionId.length === 0 ? null : `sessions/${sessionId}`;
}

function uriFor(
	kind: MemoryScopeKind,
	projectKey: string | null,
	sessionId: string | null,
	relPath: string,
): string | null {
	const normalizedPath = relPath.normalize("NFC");
	if (kind === "global") return `global://${normalizedPath}`;
	if (kind === "project") return projectKey === null ? null : `project://${projectKey}/${normalizedPath}`;
	return sessionId === null ? null : `session://${sessionId}/${normalizedPath}`;
}

async function discoverScope(
	environment: MemoryEnvironment,
	kind: MemoryScopeKind,
	root: string,
	prefix: string,
	projectKey: string | null,
	sessionId: string | null,
	maxBytes: number | undefined,
	files: DoctorFile[],
	directories: DoctorDirectory[],
	admissionFindings: DoctorFinding[],
): Promise<void> {
	const admitted = admitAuditScope(environment, { kind, root, maxBytes });
	if (!admitted.ok) {
		const resourceDenied =
			admitted.error.code === "policy-denied" && admitted.error.reason === "audit resource admission failed";
		admissionFindings.push(
			finding(
				resourceDenied ? "admission.resource-denied" : "admission.scope-denied",
				"error",
				prefix,
				resourceDenied
					? "a memory resource could not be safely admitted"
					: "a memory scope could not be safely admitted",
			),
		);
		return;
	}
	for (const entry of admitted.value) {
		const memoryPath = entry.relPath.length === 0 ? prefix : `${prefix}/${entry.relPath}`;
		if (entry.kind === "directory") {
			directories.push(
				Object.freeze({ relPath: memoryPath, kind: "directory", mode: entry.mode, size: entry.size }),
			);
			continue;
		}
		const uri =
			entry.kind === "file" && entry.relPath.toLowerCase().endsWith(".md")
				? uriFor(kind, projectKey, sessionId, entry.relPath)
				: null;
		files.push(
			Object.freeze({
				relPath: memoryPath,
				kind: entry.kind,
				uri,
				content: null,
				digest: entry.digest ?? null,
				metadata: entry.metadata,
				parseError: entry.parseError,
				headings: entry.headings,
				mode: entry.mode,
				size: entry.size,
				binary: entry.binary,
				secretLines: entry.secretLines,
				privateMemory: entry.privateMemory,
			}),
		);
	}
}

async function admitContext(
	environment: MemoryEnvironment,
	provided: DoctorContext,
): Promise<MemoryResult<DoctorContext>> {
	try {
		const admissionFindings = [...(provided.admissionFindings ?? [])]
			.filter(isDoctorFinding)
			.map(item => finding(item.code, item.severity, item.relPath, item.detail));
		let map = provided.map;
		if (map === undefined && provided.mapContent === undefined) {
			const admittedMap = mapResourceFromControl(environment);
			if (admittedMap.ok) {
				if (admittedMap.value !== null) map = admittedMap.value;
			} else {
				admissionFindings.push(
					finding("admission.control-denied", "error", "MEMORY.md", "the root MAP could not be safely admitted"),
				);
				map = Object.freeze({ relPath: "MEMORY.md", content: "" });
			}
		}
		let routes = provided.routes;
		if (routes === undefined && provided.routesContent === undefined) {
			const admittedRoutes = routesResourceFromControl(environment);
			if (admittedRoutes.ok) {
				if (admittedRoutes.value !== null) routes = admittedRoutes.value;
			} else {
				admissionFindings.push(
					finding(
						"admission.control-denied",
						"error",
						"routes.yaml",
						"the route control resource could not be safely admitted",
					),
				);
				routes = Object.freeze({ relPath: "routes.yaml", content: "" });
			}
		}
		let files = [...(provided.files ?? [])];
		const directories = [...(provided.directories ?? [])];
		if (provided.files === undefined && provided.documents === undefined) {
			const scopes = resolveScopes(environment);
			if (scopes.ok) {
				for (const scope of scopes.value.scopes) {
					if (!scope.available || scope.root === null) continue;
					const prefix = scopePrefix(scope.kind, scopes.value.project.encodedKey, scopes.value.sessionId);
					if (prefix === null) continue;
					await discoverScope(
						environment,
						scope.kind,
						scope.root,
						prefix,
						scopes.value.project.encodedKey,
						scopes.value.sessionId,
						provided.maxBytes,
						files,
						directories,
						admissionFindings,
					);
				}
			} else {
				admissionFindings.push(
					finding("admission.scope-denied", "error", null, "memory scope resolution was denied"),
				);
			}
		}
		if (provided.files === undefined && provided.documents !== undefined) {
			files = provided.documents.map(document => Object.freeze({ ...document, kind: document.kind ?? "file" }));
		}
		let journals = provided.journals;
		if (journals === undefined) {
			const admittedJournals = enumerateAuditJournals(environment);
			if (admittedJournals.ok) {
				journals = admittedJournals.value;
			} else {
				admissionFindings.push(
					finding(
						"admission.scope-denied",
						"error",
						".journal",
						"the recovery journal could not be safely admitted",
					),
				);
				journals = Object.freeze([]);
			}
		}
		const documents =
			provided.documents ??
			files
				.filter(file => file.kind === undefined || file.kind === "file")
				.filter(file => file.relPath.toLowerCase().endsWith(".md"));
		return {
			ok: true,
			value: Object.freeze({
				...provided,
				map: map === undefined ? undefined : Object.freeze(map),
				routes: routes === undefined ? undefined : Object.freeze(routes),
				files: Object.freeze(files),
				documents: Object.freeze(documents),
				directories: Object.freeze(directories),
				journals: Object.freeze(journals),
				admissionFindings: Object.freeze(admissionFindings),
			}),
		};
	} catch {
		return policyDenied("doctor resource admission failed closed");
	}
}

function digestOfDocument(document: DoctorDocument): string | null {
	if (typeof document.digest === "string" && /^[0-9a-f]{64}$/u.test(document.digest)) return document.digest;
	if (typeof document.content !== "string") return null;
	const normalized = document.content.replace(/\r\n?/gu, "\n").normalize("NFC");
	return createHash("sha256").update(Buffer.from(normalized, "utf8")).digest("hex");
}

export function documentDigest(document: DoctorDocument): string | null {
	return digestOfDocument(document);
}

/** Report an incomplete append-only recovery journal without performing recovery. */
export async function checkJournal(
	environment: MemoryEnvironment,
	context: DoctorContext | readonly DoctorJournal[],
): Promise<MemoryResult<readonly DoctorFinding[]>> {
	try {
		if (environment === null || typeof environment !== "object") return invalidInput("memory environment is invalid");
		const journals: readonly DoctorJournal[] = Array.isArray(context)
			? context
			: ((context as DoctorContext).journals ?? []);
		const findings: DoctorFinding[] = [];
		for (const journal of journals) {
			const fallbackPath = normalizeRelPath(journal.relPath) ?? null;
			const journalPaths =
				journal.journal === undefined || journal.journal.entries.length === 0
					? fallbackPath
					: journalRelPathSet(journal.journal.entries.map(entry => entry.relPath));
			const hasCommit = journal.progress?.some(progress => progress.kind === "commit") ?? false;
			const terminal =
				journal.state === "complete" ||
				(journal.state === undefined &&
					journal.tampered !== true &&
					journal.recoverable !== true &&
					journal.pending !== true &&
					journal.journal !== undefined &&
					journal.progress !== undefined &&
					hasCommit);
			const state =
				journal.tampered === true || journal.state === "tampered"
					? "tampered"
					: journal.recoverable === true || journal.state === "recoverable"
						? "recoverable"
						: terminal
							? null
							: "pending";
			if (state === null) continue;
			const code = `journal.${state}`;
			const severity: DoctorSeverity = state === "recoverable" ? "warning" : "error";
			const detail =
				state === "recoverable"
					? "recovery journal can be safely recovered"
					: state === "tampered"
						? "recovery journal failed closed after transaction state changed"
						: "recovery journal and progress pair is incomplete";
			findings.push(finding(code, severity, journalPaths, detail));
		}
		return okFindings(findings);
	} catch {
		return policyDenied("journal doctor checks failed closed");
	}
}

function parseDoctorInput(input: unknown): MemoryResult<DoctorInput> {
	try {
		if (input === undefined) return { ok: true, value: Object.freeze({}) };
		if (!isRecord(input)) return invalidInput("memory doctor input must be an object");
		if (Reflect.ownKeys(input).some(key => key !== "maxBytes")) {
			return invalidInput("memory doctor input contains unsupported fields");
		}
		if (!Object.hasOwn(input, "maxBytes") || input.maxBytes === undefined) {
			return { ok: true, value: Object.freeze({}) };
		}
		const maxBytes = input.maxBytes;
		if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
			return invalidInput("memory doctor maxBytes must be a positive safe integer");
		}
		return { ok: true, value: Object.freeze({ maxBytes }) };
	} catch {
		return invalidInput("memory doctor input is invalid");
	}
}

async function runDoctorInternal(
	environment: MemoryEnvironment,
	provided: DoctorContext,
): Promise<MemoryResult<DoctorResult>> {
	const admittedEnvironment = environment;
	if (admittedEnvironment === null || typeof admittedEnvironment !== "object")
		return invalidInput("memory environment is invalid");
	// Doctor is filesystem-gated like every other operation: before `init` there
	// is no store to audit, so report the typed not-initialized result instead of
	// claiming a healthy audit of a nonexistent root.
	const validatedEnvironment = validateMemoryEnvironment(admittedEnvironment);
	if (!validatedEnvironment.ok) return validatedEnvironment;
	const initialized = checkInitializedRoot(validatedEnvironment.value.memoryRoot);
	if (!initialized.ok) return initialized;
	const admitted = await admitContext(admittedEnvironment, provided);
	if (!admitted.ok) return admitted;
	const context = admitted.value;
	const findings: DoctorFinding[] = [];
	for (const family of [checkStructural, checkLifecycle, checkSecurity, checkRetrieval]) {
		const result = await family(admittedEnvironment, context);
		if (!result.ok) return result;
		findings.push(...result.value);
	}
	findings.push(...(context.admissionFindings ?? []));
	const journals = await checkJournal(admittedEnvironment, context);
	if (!journals.ok) return journals;
	findings.push(...journals.value);
	const ordered = sortFindings(findings);
	return {
		ok: true,
		value: Object.freeze({
			schemaVersion: "gajae.memory.audit.v1",
			healthy: !ordered.some(item => item.severity === "error"),
			findings: ordered,
		}),
	};
}

/** Compose all read-only doctor families into the versioned public audit payload. */
export async function runDoctor(
	environment: MemoryEnvironment,
	input?: DoctorInput,
): Promise<MemoryResult<DoctorResult>> {
	const checked = parseDoctorInput(input);
	if (!checked.ok) return checked;
	return runDoctorInternal(environment, { maxBytes: checked.value.maxBytes });
}

export { parseMemoryMap, parseRoutes };
