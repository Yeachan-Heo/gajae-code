import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type MemoryEnvironment,
	type MemoryError,
	type MemoryResult,
	type ResolveReadableResourceResult,
	resolveReadableResource,
	resolveReadableResourceSync,
} from "@gajae-code/memory-core";
import { getAgentDir, getMemoryRootDir, isEnoent, isEnotdir } from "@gajae-code/utils";

import { buildMemoryEnvironment, buildMemoryEnvironmentSync } from "../cli/memory/environment";
import type { Settings } from "../config/settings";
import { getMemoryRoot } from "../memories";
import { AgentRegistry } from "../registry/agent-registry";
import { parseInternalUrl } from "./parse";
import { validateRelativePath } from "./skill-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext } from "./types";

const MEMORY_SCOPES = ["global", "project", "session"] as const;
const LEGACY_MEMORY_NAMESPACE = "root";
const DEFAULT_MEMORY_FILE = "memory_summary.md";
const NOT_INITIALIZED_REMEDY = "Run `gjc memory init` to create an initialized memory root.";
type MemorySettings = Pick<Settings, "getAgentDir">;

interface MemorySessionSnapshot {
	readonly settings: MemorySettings;
	readonly cwd: string;
	readonly sessionId: string | null;
}

export interface MemoryProtocolErrorEnvelope {
	readonly schemaVersion: "gajae.memory.error.v1";
	readonly code: MemoryError["code"];
	readonly exitCode: number;
	readonly [key: string]: unknown;
}

/** Stable typed boundary error for memory-core failures without host paths. */
export class MemoryProtocolError extends Error {
	readonly code: MemoryError["code"];
	readonly exitCode: number;
	readonly memoryError: MemoryProtocolErrorEnvelope;

	constructor(error: MemoryError) {
		const envelope = sanitizeMemoryError(error);
		super(formatMemoryError(envelope));
		this.name = "MemoryProtocolError";
		this.code = error.code;
		this.exitCode = error.exitCode;
		this.memoryError = envelope;
	}
}

function sanitizeMemoryError(error: MemoryError): MemoryProtocolErrorEnvelope {
	const envelope: Record<string, unknown> = {
		schemaVersion: "gajae.memory.error.v1",
		code: error.code,
		exitCode: error.exitCode,
	};
	if (error.code === "invalid-input" || error.code === "scope-unresolved") {
		envelope.detail = error.detail;
	} else if (error.code === "not-found" || error.code === "stale-source") {
		envelope.uri = error.uri;
	} else if (error.code === "not-initialized") {
		envelope.remedy = error.remedy;
	} else if (error.code === "malformed-document" || error.code === "lock-conflict") {
		envelope.relPath = error.relPath;
		if (error.code === "malformed-document") envelope.detail = error.detail;
	} else if (error.code === "policy-denied") {
		envelope.destination = error.destination;
		envelope.reason = error.reason;
	} else if (error.code === "sensitivity-violation") {
		envelope.destination = error.destination;
		envelope.findings = error.findings.map(finding => ({
			kind: finding.kind,
			sensitivity: finding.sensitivity,
			line: finding.line,
			excerptRedacted: finding.excerptRedacted,
		}));
	} else if (error.code === "conflict-requires-confirmation") {
		envelope.conflicts = [];
	}
	return Object.freeze(envelope) as MemoryProtocolErrorEnvelope;
}

function formatMemoryError(error: MemoryProtocolErrorEnvelope): string {
	const detail =
		typeof error.detail === "string"
			? error.detail
			: typeof error.reason === "string"
				? error.reason
				: typeof error.remedy === "string"
					? error.remedy
					: typeof error.uri === "string"
						? `resource unavailable: ${error.uri}`
						: error.code;
	return `memory:// resolution failed (${error.code}): ${detail}`;
}
function mapContentType(contentType: string): InternalResource["contentType"] {
	switch (contentType) {
		case "text/markdown":
		case "application/json":
		case "text/plain":
			return contentType;
		default:
			return policyDenied("memory resource returned an unsupported content type");
	}
}

function fail(error: MemoryError): never {
	throw new MemoryProtocolError(error);
}

function invalidInput(detail: string): never {
	return fail({ code: "invalid-input", exitCode: 2, detail });
}

function policyDenied(reason: string): never {
	return fail({ code: "policy-denied", exitCode: 6, destination: "global-canonical", reason });
}

function scopeUnresolved(detail: string): never {
	return fail({ code: "scope-unresolved", exitCode: 4, detail });
}

function legacyMemoryRootsFromRegistry(): string[] {
	const roots: string[] = [];
	for (const ref of AgentRegistry.global().list()) {
		const session = ref.session;
		const sessionManager = session?.sessionManager;
		if (!sessionManager) continue;
		const agentDir = session.settings?.getAgentDir() ?? getAgentDir();
		const root = getMemoryRoot(agentDir, sessionManager.getCwd());
		if (root && !roots.includes(root)) roots.push(root);
	}
	return roots;
}

function ensureWithinLegacyRoot(targetPath: string, rootPath: string): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error("memory:// URL escapes memory root");
	}
}

function toLegacyMemoryValidationError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(message.replace("skill://", "memory://"));
}

function resolveLegacyMemoryUrlToPath(url: InternalUrl, memoryRoot: string): string {
	const namespace = url.rawHost || url.hostname;
	if (!namespace) {
		throw new Error("memory:// URL requires a namespace: memory://root");
	}
	if (namespace !== LEGACY_MEMORY_NAMESPACE) {
		throw new Error(`Unknown memory namespace: ${namespace}. Supported: ${LEGACY_MEMORY_NAMESPACE}`);
	}

	const rawPathname = url.rawPathname ?? url.pathname;
	const hasPath = rawPathname && rawPathname !== "/" && rawPathname !== "";
	if (!hasPath) {
		return path.resolve(memoryRoot, DEFAULT_MEMORY_FILE);
	}
	let relativePath: string;
	try {
		relativePath = decodeURIComponent(rawPathname.slice(1));
	} catch {
		throw new Error(`Invalid URL encoding in memory:// path: ${url.href}`);
	}

	try {
		validateRelativePath(relativePath);
	} catch (error) {
		throw toLegacyMemoryValidationError(error);
	}

	return path.resolve(memoryRoot, relativePath);
}

async function tryResolveLegacyInRoot(url: InternalUrl, memoryRoot: string): Promise<InternalResource | undefined> {
	const resolved = path.resolve(memoryRoot);
	let resolvedRoot: string;
	try {
		resolvedRoot = await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}

	const targetPath = resolveLegacyMemoryUrlToPath(url, resolvedRoot);
	ensureWithinLegacyRoot(targetPath, resolvedRoot);

	const parentDir = path.dirname(targetPath);
	try {
		const realParent = await fs.realpath(parentDir);
		ensureWithinLegacyRoot(realParent, resolvedRoot);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	let realTargetPath: string;
	try {
		realTargetPath = await fs.realpath(targetPath);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}

	ensureWithinLegacyRoot(realTargetPath, resolvedRoot);

	const stat = await fs.stat(realTargetPath);
	if (!stat.isFile()) {
		throw new Error(`memory:// URL must resolve to a file: ${url.href}`);
	}

	const content = await Bun.file(realTargetPath).text();
	const ext = path.extname(realTargetPath).toLowerCase();
	const contentType: InternalResource["contentType"] = ext === ".md" ? "text/markdown" : "text/plain";

	return {
		url: url.href,
		content,
		contentType,
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: realTargetPath,
		notes: [],
	};
}

async function resolveLegacyMemoryUrl(url: InternalUrl): Promise<InternalResource> {
	const roots = legacyMemoryRootsFromRegistry();
	if (roots.length === 0) {
		throw new Error(
			"Memory artifacts are not available for this project yet. Run a session with memories enabled first.",
		);
	}

	let anyExists = false;
	for (const root of roots) {
		try {
			await fs.stat(root);
			anyExists = true;
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		const result = await tryResolveLegacyInRoot(url, root);
		if (result) return result;
	}

	if (!anyExists) {
		throw new Error(
			"Memory artifacts are not available for this project yet. Run a session with memories enabled first.",
		);
	}

	throw new Error(`Memory file not found: ${url.href}`);
}

function resolveLegacyMemoryPathSyncInRoot(url: InternalUrl, root: string): string {
	const resolvedRoot = fsSync.realpathSync(path.resolve(root));
	const targetPath = resolveLegacyMemoryUrlToPath(url, resolvedRoot);
	ensureWithinLegacyRoot(targetPath, resolvedRoot);
	// The async route verifies the published path through realpath; the sync route
	// must fail closed the same way or a symlinked leaf escapes the legacy root.
	ensureWithinLegacyRoot(fsSync.realpathSync(path.dirname(targetPath)), resolvedRoot);
	try {
		ensureWithinLegacyRoot(fsSync.realpathSync(targetPath), resolvedRoot);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return targetPath;
}

function resolveLegacyMemoryUrlToPathSync(url: InternalUrl): string {
	const roots = legacyMemoryRootsFromRegistry();
	if (roots.length === 0) {
		throw new Error(
			"Memory artifacts are not available for this project yet. Run a session with memories enabled first.",
		);
	}
	for (const root of roots) {
		try {
			return resolveLegacyMemoryPathSyncInRoot(url, root);
		} catch {
			// Try the next root; some sessions may not have this namespace mounted.
		}
	}
	throw new Error(`Memory file not found: ${url.href}`);
}

function coreUriFromMemoryUrl(url: InternalUrl): string {
	const namespace = url.rawHost || url.hostname;
	if (!(MEMORY_SCOPES as readonly string[]).includes(namespace)) {
		return invalidInput(
			`memory:// namespace must be one of ${MEMORY_SCOPES.join(", ")} (got ${namespace || "(empty)"})`,
		);
	}
	const pathname = url.rawPathname ?? url.pathname;
	const relativePath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
	return `${namespace}://${relativePath}${url.search}${url.hash}`;
}

function sessionSnapshots(context?: ResolveContext): MemorySessionSnapshot[] {
	const snapshots: MemorySessionSnapshot[] = [];
	for (const ref of AgentRegistry.global().list()) {
		const session = ref.session;
		const sessionManager = session?.sessionManager;
		const settings = session?.settings;
		if (!session || !sessionManager || !settings || typeof settings.getAgentDir !== "function") continue;
		let cwd: string;
		let sessionId: string | null;
		try {
			cwd = sessionManager.getCwd();
			sessionId = sessionManager.getSessionId() || null;
		} catch {
			continue;
		}
		if (context?.cwd !== undefined && context.cwd !== cwd) continue;
		if (context?.settings !== undefined && context.settings !== settings) continue;
		snapshots.push({ settings, cwd, sessionId });
	}
	return snapshots;
}

function owningSession(context?: ResolveContext): MemorySessionSnapshot {
	const snapshots = sessionSnapshots(context);
	if (snapshots.length !== 1) {
		return scopeUnresolved(
			snapshots.length === 0
				? "memory URL has no owning registered session"
				: "memory URL has multiple owning registered sessions",
		);
	}
	return snapshots[0] as MemorySessionSnapshot;
}

function notInitializedMemoryRoot(memoryRoot: string): never {
	return fail({ code: "not-initialized", exitCode: 3, memoryRoot, remedy: NOT_INITIALIZED_REMEDY });
}

function memoryRootInspectionFailed(): never {
	return policyDenied("memory root could not be inspected");
}

async function ensureInitializedMemoryRoot(session: MemorySessionSnapshot): Promise<void> {
	const memoryRoot = getMemoryRootDir(session.settings.getAgentDir());
	let stat: fsSync.Stats;
	try {
		stat = await fs.lstat(memoryRoot);
	} catch (error) {
		if (isEnoent(error) || isEnotdir(error)) notInitializedMemoryRoot(memoryRoot);
		memoryRootInspectionFailed();
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) notInitializedMemoryRoot(memoryRoot);
}

function ensureInitializedMemoryRootSync(session: MemorySessionSnapshot): void {
	const memoryRoot = getMemoryRootDir(session.settings.getAgentDir());
	let stat: fsSync.Stats;
	try {
		stat = fsSync.lstatSync(memoryRoot);
	} catch (error) {
		if (isEnoent(error) || isEnotdir(error)) notInitializedMemoryRoot(memoryRoot);
		memoryRootInspectionFailed();
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) notInitializedMemoryRoot(memoryRoot);
}

function syncEnvironment(session: MemorySessionSnapshot): MemoryEnvironment {
	return buildMemoryEnvironmentSync({
		settings: session.settings,
		cwd: session.cwd,
		clock: () => new Date(0),
		session: { flagValue: session.sessionId ?? undefined },
	});
}

/** Resolve one canonical memory:// URL to its memory-core URI. */
export function toMemoryCoreUri(input: string | InternalUrl): string {
	const url = typeof input === "string" ? parseInternalUrl(input) : input;
	return coreUriFromMemoryUrl(url);
}

/** Synchronously resolve a canonical memory:// URL for OSC 8 hyperlinking. */
export function resolveMemoryUrlToPathSync(input: string): string {
	const url = parseInternalUrl(input);
	const namespace = url.rawHost || url.hostname;
	if (namespace === LEGACY_MEMORY_NAMESPACE) return resolveLegacyMemoryUrlToPathSync(url);
	const coreUri = coreUriFromMemoryUrl(url);
	const session = owningSession();
	ensureInitializedMemoryRootSync(session);
	let environment: MemoryEnvironment;
	try {
		environment = syncEnvironment(session);
	} catch {
		return policyDenied("memory repository context could not be resolved");
	}
	const result = resolveReadableResourceSync(environment, { uri: coreUri });

	if (!result.ok) return fail(result.error);
	return result.value.absolutePath;
}

/** Protocol adapter from the legacy internal URL router to public memory-core reads. */
export class MemoryProtocolHandler implements ProtocolHandler {
	readonly scheme = "memory";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const namespace = url.rawHost || url.hostname;
		if (namespace === LEGACY_MEMORY_NAMESPACE) return resolveLegacyMemoryUrl(url);
		const coreUri = coreUriFromMemoryUrl(url);
		const session = owningSession(context);
		await ensureInitializedMemoryRoot(session);
		let environment: MemoryEnvironment;
		try {
			environment = await buildMemoryEnvironment({
				settings: session.settings,
				cwd: session.cwd,
				clock: () => new Date(0),
				session: { flagValue: session.sessionId ?? undefined },
			});
		} catch {
			return policyDenied("memory repository context could not be resolved");
		}
		let result: MemoryResult<ResolveReadableResourceResult>;

		try {
			result = await resolveReadableResource(environment, { uri: coreUri });
		} catch {
			return policyDenied("memory resource resolution failed closed");
		}
		if (!result.ok) return fail(result.error);
		return {
			url: url.href,
			content: result.value.content,
			contentType: mapContentType(result.value.contentType),
			size: result.value.size,
			notes: [],
		};
	}
}
