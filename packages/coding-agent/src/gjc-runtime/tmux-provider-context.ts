import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	captureManagedFileNoFollow,
	type ManagedFileSnapshot,
	prepareManagedDirectoryRoot,
	publishManagedFileNoReplaceSync,
} from "../session/internal/managed-session-storage";
import {
	type PsmuxSpawnRunner,
	type ResolvedTmuxBinary,
	resolveGjcTmuxBinary,
	resolveGjcTmuxExecutableIdentity,
	resolveGjcTmuxExecutablePath,
} from "./psmux-detect";
import { isCanonicalUtcTimestamp, lifecyclePaths } from "./tmux-owner-isolation";

const AUTHORITY_SCHEMA_VERSION = 2;
const MAX_AUTHORITY_BYTES = 4096;

let authorityPlatformForTests: NodeJS.Platform | null = null;

function authorityPlatform(): NodeJS.Platform {
	return authorityPlatformForTests ?? process.platform;
}

/** @internal Test-only seam for hermetic Windows authority storage tests. */
/**
 * The platform that governs psmux authority decisions, honoring the test
 * override. Every authority gate must read this rather than `process.platform`,
 * or a pinned test platform is silently ignored on non-Windows hosts.
 */
export function gjcTmuxAuthorityPlatform(): NodeJS.Platform {
	return authorityPlatform();
}
export function __setTmuxProviderAuthorityPlatformForTests(platform: NodeJS.Platform | null): void {
	authorityPlatformForTests = platform;
}

function requireWindowsAuthorityPlatform(): void {
	if (authorityPlatform() !== "win32") throw new Error("gjc_tmux_provider_authority_windows_required");
}
export type TmuxProviderKind = "native-tmux" | "windows-psmux";

/** A structured tmux provider. Native tmux intentionally has no prefix. */
export interface ProviderContext {
	readonly kind: TmuxProviderKind;
	readonly command: string;
	readonly commandPrefix: readonly string[];
	readonly namespace: string | null;
	readonly executableIdentity: string | null;
	readonly binary: ResolvedTmuxBinary;
	readonly platform: NodeJS.Platform;
}

/** Durable authority binding for one owner generation. */
export interface ProviderAuthority extends ProviderContext {
	readonly stateDir: string;
	readonly sessionId: string;
	readonly generation: string;
}

type ProviderRecord = {
	schema_version: 2;
	kind: "windows-psmux";
	platform: "win32";
	session_id: string;
	owner_generation: string;
	namespace: string;
	target_syntax: "-L";
	executable_path: string;
	executable_identity: string;
};

function rejectUnsafeToken(value: string, name: string): string {
	const trimmed = value.trim();
	if (!trimmed || /[\0\r\n]|\s/.test(trimmed) || /[;&|`$<>]/.test(trimmed))
		throw new Error(`gjc_tmux_provider_invalid_${name}`);
	return trimmed;
}

function requireSafePathComponent(value: string, name: string): string {
	const trimmed = value.trim();
	if (trimmed === "." || trimmed === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed))
		throw new Error(`gjc_tmux_provider_invalid_${name}`);
	return trimmed;
}

function randomNamespace(): string {
	return `gjc-${crypto.randomBytes(16).toString("hex")}`;
}

/** Resolve a structured provider. Native tmux remains byte-for-byte argv compatible. */
export function resolveGjcTmuxProviderContext(
	options: {
		env?: NodeJS.ProcessEnv;
		platform?: NodeJS.Platform;
		runner?: PsmuxSpawnRunner;
		binary?: ResolvedTmuxBinary;
	} = {},
): ProviderContext {
	// Route through the authority-platform accessor so a test pin propagates to
	// every platform decision in this module. Three separate sources previously
	// read process.platform directly, so a pinned win32 test still took POSIX
	// branches; production is unchanged because the accessor defaults to
	// process.platform when unpinned.
	const platform = options.platform ?? gjcTmuxAuthorityPlatform();
	const binary = options.binary ?? resolveGjcTmuxBinary(options);
	const selectedCommand = rejectUnsafeToken(binary.command, "command");
	if (binary.isPsmux && platform !== "win32")
		throw new Error("gjc_tmux_provider_ambiguous: selected psmux command requires Windows");
	if (!binary.isPsmux) {
		return Object.freeze({
			kind: "native-tmux",
			command: selectedCommand,
			commandPrefix: Object.freeze([]),
			namespace: null,
			executableIdentity: null,
			binary,
			platform,
		});
	}
	const resolved = resolveGjcTmuxExecutablePath(selectedCommand);
	if (!resolved || !(path.win32.isAbsolute(resolved) || path.isAbsolute(resolved)))
		throw new Error("gjc_tmux_provider_ambiguous: selected Windows psmux command is not an absolute executable");
	const identity = resolveGjcTmuxExecutableIdentity(resolved);
	if (!identity)
		throw new Error("gjc_tmux_provider_ambiguous: selected Windows psmux executable identity is unavailable");
	const namespace = randomNamespace();
	return Object.freeze({
		kind: "windows-psmux",
		command: resolved,
		commandPrefix: Object.freeze(["-L", namespace]),
		namespace,
		executableIdentity: identity,
		binary,
		platform,
	});
}

export function buildTmuxProviderCommand(
	context: ProviderContext,
	command: string,
	args: readonly string[] = [],
): string[] {
	if (!/^[a-z][a-z-]*$/i.test(command) || args.some(arg => typeof arg !== "string" || arg.includes("\0")))
		throw new Error("gjc_tmux_provider_invalid_command");
	return [...context.commandPrefix, command, ...args];
}

function rootFor(authority: Pick<ProviderAuthority, "stateDir" | "sessionId" | "generation">): string {
	return lifecyclePaths(authority.stateDir, authority.sessionId, authority.generation).root;
}

function authorityName(generation: string): string {
	return `provider-authority-${encodeURIComponent(generation)}.json`;
}

function assertCurrentGeneration(root: string, sessionId: string, generation: string): void {
	const snapshot = captureManagedFileNoFollow(path.join(root, "generation.json"));
	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(snapshot.bytes));
	} catch {
		throw new Error("gjc_tmux_provider_authority_generation_unavailable");
	}
	const record = payload as Record<string, unknown>;
	const publishedAt = record.published_at;
	if (
		!payload ||
		typeof payload !== "object" ||
		Array.isArray(payload) ||
		Object.keys(record).sort().join(",") !== "generation,published_at,schema_version,session_id" ||
		record.schema_version !== 1 ||
		record.session_id !== sessionId ||
		record.generation !== generation ||
		!isCanonicalUtcTimestamp(publishedAt)
	)
		throw new Error("gjc_tmux_provider_authority_generation_mismatch");
}
/** Returns whether an owner generation has a persisted Windows psmux authority. */
export function hasGjcTmuxProviderAuthoritySync(input: {
	stateDir: string;
	sessionId: string;
	generation: string;
}): boolean {
	if (authorityPlatform() !== "win32") return false;
	const stateDir = path.resolve(input.stateDir);
	const sessionId = requireSafePathComponent(input.sessionId, "session_id");
	const generation = requireSafePathComponent(input.generation, "generation");
	const root = rootFor({ stateDir, sessionId, generation });
	const generationFile = path.join(root, "generation.json");
	const authorityFile = path.join(root, authorityName(generation));
	try {
		fs.lstatSync(root);
		fs.lstatSync(generationFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	requireWindowsAuthorityPlatform();
	assertCurrentGeneration(root, sessionId, generation);
	try {
		fs.lstatSync(authorityFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	readGjcTmuxProviderAuthoritySync({ stateDir, sessionId, generation });
	return true;
}

function readWindowsAuthority(
	root: string,
	generation: string,
): {
	record: ProviderRecord;
	identity: ManagedFileSnapshot["identity"];
} {
	const snapshot = captureManagedFileNoFollow(path.join(root, authorityName(generation)));
	return { record: parseRecord(snapshot.bytes), identity: snapshot.identity };
}

function prepareWindowsAuthorityRoot(root: string) {
	return prepareManagedDirectoryRoot(root, "windows-existing-verify-first");
}

function parseRecord(data: Uint8Array): ProviderRecord {
	if (data.byteLength === 0 || data.byteLength > MAX_AUTHORITY_BYTES)
		throw new Error("gjc_tmux_provider_authority_invalid_record");
	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(data));
	} catch {
		throw new Error("gjc_tmux_provider_authority_invalid_record");
	}
	if (!payload || typeof payload !== "object") throw new Error("gjc_tmux_provider_authority_invalid_record");
	const value = payload as Record<string, unknown>;
	if (
		value.schema_version !== AUTHORITY_SCHEMA_VERSION ||
		value.kind !== "windows-psmux" ||
		value.platform !== "win32" ||
		typeof value.session_id !== "string" ||
		typeof value.owner_generation !== "string" ||
		typeof value.namespace !== "string" ||
		!/^gjc-[a-f0-9]{32}$/.test(value.namespace) ||
		value.target_syntax !== "-L" ||
		typeof value.executable_path !== "string" ||
		!(path.win32.isAbsolute(value.executable_path) || path.isAbsolute(value.executable_path)) ||
		typeof value.executable_identity !== "string"
	)
		throw new Error("gjc_tmux_provider_authority_invalid_record");
	return value as ProviderRecord;
}

export function bindGjcTmuxProviderAuthority(
	context: ProviderContext,
	input: { stateDir: string; sessionId: string; generation: string },
): ProviderAuthority {
	const stateDir = input.stateDir.trim();
	if (!stateDir || /[\0\r\n]/.test(stateDir)) throw new Error("gjc_tmux_provider_invalid_state_dir");
	return Object.freeze({
		...context,
		stateDir: path.resolve(stateDir),
		sessionId: requireSafePathComponent(input.sessionId, "session_id"),
		generation: requireSafePathComponent(input.generation, "generation"),
	});
}

function recordFor(authority: ProviderAuthority): ProviderRecord {
	if (!authority.namespace || !authority.executableIdentity)
		throw new Error("gjc_tmux_provider_authority_invalid_context");
	return {
		schema_version: 2,
		kind: "windows-psmux",
		platform: "win32",
		session_id: authority.sessionId,
		owner_generation: authority.generation,
		namespace: authority.namespace,
		target_syntax: "-L",
		executable_path: authority.command,
		executable_identity: authority.executableIdentity,
	};
}

/** Persist an immutable, generation-scoped authority before generation publication. Native tmux needs no record. */
// A retained lock descriptor for this exact authority name means another writer
// is mid-publish. Its lease may already be expired while its owner process is
// still alive — a paused or slow writer — and stealing in that window would let
// two writers publish the same generation-scoped authority. Expiry alone is
// therefore not permission to proceed: only an owner that is definitely gone
// releases the name. This is deliberately local to the psmux authority path so
// it does not depend on the managed-storage lease helpers.
function migrationBusyIfLiveHolder(locksDirectory: string, name: string): void {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(locksDirectory, `${name}.lock`), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw new Error("migration_busy");
	}
	let holder: { pid?: unknown } | undefined;
	try {
		holder = JSON.parse(raw) as { pid?: unknown };
	} catch {
		// An unreadable descriptor is indistinguishable from a live one.
		throw new Error("migration_busy");
	}
	const pid = typeof holder?.pid === "number" && Number.isInteger(holder.pid) ? holder.pid : undefined;
	if (pid === undefined) throw new Error("migration_busy");
	try {
		process.kill(pid, 0);
	} catch (error) {
		// ESRCH proves the owner is gone; EPERM proves it is alive under another uid.
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
	}
	throw new Error("migration_busy");
}
export function persistGjcTmuxProviderAuthoritySync(authority: ProviderAuthority): void {
	if (authority.kind !== "windows-psmux") return;
	requireWindowsAuthorityPlatform();
	const root = rootFor(authority);
	const bytes = new TextEncoder().encode(JSON.stringify(recordFor(authority)));
	const name = authorityName(authority.generation);
	const managedRoot = prepareWindowsAuthorityRoot(root);
	migrationBusyIfLiveHolder(path.join(managedRoot.canonicalPath, "provider-authority-locks"), name);
	// `publishManagedFileNoReplaceSync` is create-without-clobber, so it is itself
	// the mutual exclusion for this generation-scoped authority: a second writer
	// loses the create rather than racing a separate lock file. The readback below
	// still proves the published record binds this session and generation.
	publishManagedFileNoReplaceSync(
		path.join(managedRoot.canonicalPath, name),
		bytes,
		managedRoot,
		"windows-existing-verify-first",
	);
	const verified = readWindowsAuthority(managedRoot.canonicalPath, authority.generation);
	if (verified.record.session_id !== authority.sessionId || verified.record.owner_generation !== authority.generation)
		throw new Error("gjc_tmux_provider_authority_publish_failed");
}

export function readGjcTmuxProviderAuthoritySync(input: {
	stateDir: string;
	sessionId: string;
	generation: string;
}): ProviderAuthority {
	const stateDir = path.resolve(input.stateDir);
	const sessionId = requireSafePathComponent(input.sessionId, "session_id");
	const generation = requireSafePathComponent(input.generation, "generation");
	const root = rootFor({ stateDir, sessionId, generation });
	requireWindowsAuthorityPlatform();
	const managedRoot = prepareWindowsAuthorityRoot(root);
	assertCurrentGeneration(managedRoot.canonicalPath, sessionId, generation);
	const { record } = readWindowsAuthority(managedRoot.canonicalPath, generation);
	if (record.session_id !== sessionId || record.owner_generation !== generation)
		throw new Error("gjc_tmux_provider_authority_mismatch");
	const identity = resolveGjcTmuxExecutableIdentity(record.executable_path);
	if (!identity || identity !== record.executable_identity)
		throw new Error("gjc_tmux_provider_authority_executable_changed");
	return Object.freeze({
		kind: "windows-psmux",
		command: record.executable_path,
		commandPrefix: Object.freeze([record.target_syntax, record.namespace]),
		namespace: record.namespace,
		executableIdentity: record.executable_identity,
		binary: Object.freeze({ command: record.executable_path, isPsmux: true, viaExplicitOverride: true }),
		platform: "win32",
		stateDir,
		sessionId,
		generation,
	});
}
/** Enumerates owner-secured, executable-validated psmux authorities in one durable state root. */
export function listGjcTmuxProviderAuthoritiesSync(stateDirInput: string): ProviderAuthority[] {
	const stateDir = path.resolve(stateDirInput);
	requireWindowsAuthorityPlatform();
	prepareWindowsAuthorityRoot(stateDir);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(stateDir, { withFileTypes: true });
	} catch {
		throw new Error("gjc_tmux_provider_authority_unavailable");
	}
	const authorities: ProviderAuthority[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		try {
			const sessionId = requireSafePathComponent(entry.name, "session_id");
			const root = rootFor({ stateDir, sessionId, generation: "enumerate" });
			const generationSnapshot = captureManagedFileNoFollow(path.join(root, "generation.json"));
			const generationPayload = JSON.parse(new TextDecoder().decode(generationSnapshot.bytes)) as {
				generation?: unknown;
				session_id?: unknown;
			};
			if (typeof generationPayload.generation !== "string" || generationPayload.session_id !== sessionId)
				throw new Error("gjc_tmux_provider_authority_generation_mismatch");
			const generation = requireSafePathComponent(generationPayload.generation, "generation");
			authorities.push(
				readGjcTmuxProviderAuthoritySync({
					stateDir,
					sessionId,
					generation,
				}),
			);
		} catch {
			throw new Error("gjc_tmux_provider_authority_unavailable");
		}
	}
	return authorities;
}

/** Re-proves the staged immutable record and executable identity before generation publication. */
export function assertGjcTmuxStagedMutationAuthoritySync(authority: ProviderAuthority): void {
	if (authority.kind !== "windows-psmux") return;
	requireWindowsAuthorityPlatform();
	const root = prepareWindowsAuthorityRoot(rootFor(authority));
	const { record } = readWindowsAuthority(root.canonicalPath, authority.generation);
	if (
		record.session_id !== authority.sessionId ||
		record.owner_generation !== authority.generation ||
		record.namespace !== authority.namespace ||
		record.target_syntax !== "-L" ||
		record.executable_path !== authority.command ||
		record.executable_identity !== authority.executableIdentity
	)
		throw new Error("gjc_tmux_provider_authority_mismatch");
	const identity = resolveGjcTmuxExecutableIdentity(authority.command);
	if (!identity || identity !== authority.executableIdentity)
		throw new Error("gjc_tmux_provider_authority_executable_changed");
}
/** Re-proves the current pointer, exact executable identity, and native root before mutation. */
export function assertGjcTmuxMutationAuthoritySync(authority: ProviderAuthority): void {
	if (authority.kind !== "windows-psmux") return;
	requireWindowsAuthorityPlatform();
	const root = prepareWindowsAuthorityRoot(rootFor(authority));
	assertCurrentGeneration(root.canonicalPath, authority.sessionId, authority.generation);
	const { record } = readWindowsAuthority(root.canonicalPath, authority.generation);
	if (
		record.session_id !== authority.sessionId ||
		record.owner_generation !== authority.generation ||
		record.namespace !== authority.namespace ||
		record.target_syntax !== "-L" ||
		record.executable_path !== authority.command ||
		record.executable_identity !== authority.executableIdentity
	)
		throw new Error("gjc_tmux_provider_authority_mismatch");
	const identity = resolveGjcTmuxExecutableIdentity(authority.command);
	if (!identity || identity !== authority.executableIdentity)
		throw new Error("gjc_tmux_provider_authority_executable_changed");
}
