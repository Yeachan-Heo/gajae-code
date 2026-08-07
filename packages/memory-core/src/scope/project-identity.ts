import { createHash } from "node:crypto";
import * as path from "node:path";
import type { ProjectIdentity, RepositoryRemote, RepositorySnapshot } from "../env";
import type { MemoryResult } from "../errors";
import { invalidInput } from "../errors";
import {
	isValidProjectKey,
	lookupProjectKey,
	type ProjectRegistry,
	type ProjectRegistryInput,
	parseProjectRegistry,
} from "./registry";

export interface NormalizedRemote {
	readonly name: string;
	readonly url: string;
	readonly forgeId: string;
}

export type ProjectIdentityRegistry = ProjectRegistryInput | null | undefined;

const EMPTY_IDENTITY = Object.freeze({
	forgeId: null,
	repoRoot: null,
	gitCommonDir: null,
	isLinkedWorktree: false,
	encodedKey: "",
	source: "path-fallback",
}) satisfies ProjectIdentity;

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

function isAbsolutePath(value: string): boolean {
	return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^[/\\]{2}/.test(value);
}

function canonicalPath(value: string): string | null {
	if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") || !isAbsolutePath(value))
		return null;
	return path.normalize(path.resolve(value));
}

function sha256(value: string): string {
	return createHash("sha256").update(value.normalize("NFC"), "utf8").digest("hex");
}

function validSegment(value: string): boolean {
	return (
		value.length > 0 &&
		value !== "." &&
		value !== ".." &&
		!/[\u0000-\u0020\u007f]/.test(value) &&
		!/[\\/%?#]/.test(value)
	);
}

function validRepositorySegment(value: string): boolean {
	return validSegment(value) && !value.includes(":");
}

function normalizedRepositoryPath(rawPath: string): { readonly owner: string; readonly repo: string } | null {
	if (rawPath.length === 0 || rawPath.includes("\\") || rawPath.includes("%") || rawPath.endsWith("/")) return null;
	const pathValue = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
	const pieces = pathValue.split("/");
	if (pieces.length !== 2) return null;
	const owner = pieces[0]?.normalize("NFC") ?? "";
	let repo = pieces[1]?.normalize("NFC") ?? "";
	if (/\.git$/i.test(repo)) repo = repo.slice(0, -4);
	if (!validRepositorySegment(owner) || !validRepositorySegment(repo)) return null;
	return { owner, repo };
}

function normalizedHost(host: string, port: string): string | null {
	const normalized = host.normalize("NFC").toLowerCase();
	if (!validSegment(normalized) || normalized.includes(":")) return null;
	if (port.length > 0 && !/^[0-9]+$/.test(port)) return null;
	return port.length === 0 ? normalized : `${normalized}:${port}`;
}

function normalizeUrlRemote(rawUrl: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return null;
	}
	const protocol = parsed.protocol.toLowerCase();
	if (protocol !== "ssh:" && protocol !== "https:") return null;
	if (parsed.search.length > 0 || parsed.hash.length > 0 || parsed.pathname.includes("%")) return null;
	const port = parsed.port;
	if (protocol === "ssh:" && port === "22")
		return normalizeUrlRemote(`${protocol}//${parsed.username}@${parsed.hostname}${parsed.pathname}`);
	if (protocol === "https:" && port === "443")
		return normalizeUrlRemote(`${protocol}//${parsed.username}@${parsed.hostname}${parsed.pathname}`);
	const host = normalizedHost(parsed.hostname, port);
	if (host === null) return null;
	const repository = normalizedRepositoryPath(parsed.pathname);
	if (repository === null) return null;
	return `${host}/${repository.owner}/${repository.repo}`;
}

function normalizeScpRemote(rawUrl: string): string | null {
	const match = /^(?:[^@/:\s]+@)?([^/:\s]+):([^\s]+)$/.exec(rawUrl);
	if (match === null) return null;
	const host = normalizedHost(match[1] ?? "", "");
	if (host === null) return null;
	const repository = normalizedRepositoryPath(match[2] ?? "");
	if (repository === null) return null;
	return `${host}/${repository.owner}/${repository.repo}`;
}

/** Normalize a supported remote URL into `host/owner/repo`. */
export function normalizeRemoteUrl(url: string): string | null {
	if (typeof url !== "string" || url.length === 0 || url.includes("\u0000") || url.trim() !== url) return null;
	const normalized = url.normalize("NFC");
	if (normalized.includes("\n") || normalized.includes("\r")) return null;
	if (/^[^/:\s]+@[^/:\s]+:[^\s]+$/.test(normalized)) return normalizeScpRemote(normalized);
	return normalizeUrlRemote(normalized);
}

function isRepositorySnapshot(value: RepositorySnapshot | null): value is RepositorySnapshot {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	if (typeof value.worktreeRoot !== "string" || !isAbsolutePath(value.worktreeRoot)) return false;
	if (value.commonDir !== null && (typeof value.commonDir !== "string" || !isAbsolutePath(value.commonDir)))
		return false;
	if (typeof value.isLinkedWorktree !== "boolean" || !Array.isArray(value.remotes)) return false;
	return value.remotes.every(
		remote =>
			remote !== null &&
			typeof remote === "object" &&
			typeof remote.name === "string" &&
			remote.name.length > 0 &&
			typeof remote.url === "string" &&
			remote.url.length > 0,
	);
}

/** Choose the first valid remote using upstream, origin, then NFC byte order. */
export function chooseRemote(remotes: readonly RepositoryRemote[]): MemoryResult<NormalizedRemote | null> {
	if (!Array.isArray(remotes)) return invalidInput("repository remotes must be an array");
	const normalized: NormalizedRemote[] = [];
	for (const remote of remotes) {
		if (
			remote === null ||
			typeof remote !== "object" ||
			typeof remote.name !== "string" ||
			remote.name.length === 0 ||
			typeof remote.url !== "string" ||
			remote.url.length === 0
		) {
			return invalidInput("repository remote is malformed");
		}
		const forgeId = normalizeRemoteUrl(remote.url);
		if (forgeId !== null) {
			normalized.push(
				Object.freeze({ name: remote.name.normalize("NFC"), url: remote.url.normalize("NFC"), forgeId }),
			);
		}
	}
	for (const preferred of ["upstream", "origin"] as const) {
		const match = normalized.find(remote => remote.name === preferred);
		if (match !== undefined) return { ok: true, value: match };
	}
	normalized.sort((left, right) => {
		const byName = compareUtf8(left.name, right.name);
		return byName !== 0 ? byName : compareUtf8(left.url, right.url);
	});
	return { ok: true, value: normalized[0] ?? null };
}

function safeProjectKey(base: string, forgeId: string): string {
	const sanitized = base
		.normalize("NFC")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	const prefix = (sanitized.length === 0 ? "project" : sanitized).slice(0, 48);
	return `${prefix}-${sha256(forgeId).slice(0, 7)}`;
}

/** Derive the stable safe project key for a normalized forge id. */
export function deriveForgeProjectKey(forgeId: string): MemoryResult<string> {
	if (typeof forgeId !== "string" || forgeId.length === 0) return invalidInput("forge id is invalid");
	const pieces = forgeId.normalize("NFC").split("/");
	if (
		pieces.length !== 3 ||
		pieces[0] === undefined ||
		pieces[1] === undefined ||
		pieces[2] === undefined ||
		!validSegment(pieces[0]) ||
		!validRepositorySegment(pieces[1]) ||
		!validRepositorySegment(pieces[2])
	)
		return invalidInput("forge id is invalid");
	const normalized = `${pieces[0]?.toLowerCase()}/${pieces[1]}/${pieces[2]}`;
	const key = safeProjectKey(normalized.replaceAll("/", "-"), normalized);
	if (!isValidProjectKey(key)) return invalidInput("derived project key is unsafe");
	return { ok: true, value: key };
}

function emptyIdentity(): ProjectIdentity {
	return EMPTY_IDENTITY;
}

function registryValue(input: ProjectIdentityRegistry): MemoryResult<ProjectRegistry | null> {
	if (input === undefined || input === null) return { ok: true, value: null };
	const parsed = parseProjectRegistry(input);
	return parsed.ok ? { ok: true, value: parsed.value } : parsed;
}

/** Resolve project identity from an injected repository snapshot; no git, cwd, or env probing occurs. */
export function resolveProjectIdentity(
	snapshot: RepositorySnapshot | null,
	registryInput?: ProjectIdentityRegistry,
): MemoryResult<ProjectIdentity> {
	if (snapshot === null) return { ok: true, value: emptyIdentity() };
	if (!isRepositorySnapshot(snapshot)) return invalidInput("repository snapshot is invalid");
	const worktreeRoot = canonicalPath(snapshot.worktreeRoot);
	const commonDir = snapshot.commonDir === null ? null : canonicalPath(snapshot.commonDir);
	if (worktreeRoot === null || (snapshot.commonDir !== null && commonDir === null)) {
		return invalidInput("repository snapshot paths must be absolute");
	}
	const registry = registryValue(registryInput);
	if (!registry.ok) return registry;
	const selected = chooseRemote(snapshot.remotes);
	if (!selected.ok) return selected;
	if (selected.value !== null) {
		const registeredKey =
			registry.value === null
				? null
				: lookupProjectKey(registry.value, [selected.value.forgeId], worktreeRoot, commonDir);
		const key =
			registeredKey === null
				? deriveForgeProjectKey(selected.value.forgeId)
				: ({ ok: true, value: registeredKey } satisfies MemoryResult<string>);
		if (!key.ok) return key;
		return {
			ok: true,
			value: Object.freeze({
				forgeId: selected.value.forgeId,
				repoRoot: worktreeRoot,
				gitCommonDir: commonDir,
				isLinkedWorktree: snapshot.isLinkedWorktree,
				encodedKey: key.value,
				source: "forge-remote",
			}),
		};
	}
	const stablePath = commonDir ?? worktreeRoot;
	const key = `local-${sha256(stablePath).slice(0, 12)}`;
	return {
		ok: true,
		value: Object.freeze({
			forgeId: null,
			repoRoot: worktreeRoot,
			gitCommonDir: commonDir,
			isLinkedWorktree: snapshot.isLinkedWorktree,
			encodedKey: key,
			source: "repo-root",
		}),
	};
}
