import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectAgentDir } from "@gajae-code/utils";
import { repo } from "../utils/git";
import {
	FILESYSTEM_MEMORY_PRIVATE_DIRECTORY_MODE,
	type FilesystemMemoryIdentityRegistryV1,
	type FilesystemMemoryOutcome,
	type FilesystemMemoryRepositoryIdentityV1,
} from "./contracts";

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface FilesystemMemoryProjectIdentity {
	readonly projectId: string;
	readonly commonDir: string;
	readonly registryKey: string;
	readonly remoteDisplay: string | null;
	readonly sharedRoot: string;
	readonly privateRoot: string;
}

export interface ResolveFilesystemMemoryProjectIdentityOptions {
	readonly cwd: string;
	readonly registry: FilesystemMemoryIdentityRegistryV1;
	readonly remoteDisplay?: string | null;
	readonly agentDir?: string;
}

function identityFailure(
	code: "identity_unavailable" | "identity_drift",
	message: string,
): FilesystemMemoryOutcome<never> {
	return { code, message };
}

export function getFilesystemMemoryDataDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "memory-filesystem");
}

export function getFilesystemMemoryRegistryPath(agentDir: string = getAgentDir()): string {
	return path.join(getFilesystemMemoryDataDir(agentDir), "identity-registry.v1.json");
}

export function registryKeyForCommonDir(commonDir: string): string {
	return crypto.createHash("sha256").update(commonDir).digest("hex");
}

/** Removes credentials, controls, and query/fragment material from untrusted remote display text. */
export function sanitizeFilesystemMemoryRemoteDisplay(value: string | null | undefined): string | null {
	if (!value) return null;
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim()
		.slice(0, 512);
	if (!cleaned) return null;
	try {
		const parsed = new URL(cleaned);
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return cleaned.replace(/^[^@\s/:]+@/, "").replace(/[?#].*$/, "") || null;
	}
}

export async function resolveFilesystemMemoryProjectIdentity(
	options: ResolveFilesystemMemoryProjectIdentityOptions,
): Promise<FilesystemMemoryOutcome<FilesystemMemoryProjectIdentity>> {
	const repository = await repo.resolve(options.cwd);
	if (!repository) return identityFailure("identity_unavailable", "The current directory is not a Git worktree.");
	let commonDir: string;
	let worktreeRoot: string;
	try {
		[commonDir, worktreeRoot] = await Promise.all([
			fs.realpath(repository.commonDir),
			fs.realpath(repository.repoRoot),
		]);
	} catch {
		return identityFailure("identity_unavailable", "Git worktree identity cannot be canonicalized.");
	}
	const registryKey = registryKeyForCommonDir(commonDir);
	const existing = options.registry.repositories[registryKey];
	if (!existing)
		return identityFailure("identity_unavailable", "Repository is not enrolled in the private identity registry.");
	if (
		!PROJECT_ID.test(existing.projectId) ||
		typeof existing.commonDir !== "string" ||
		(existing.remoteDisplay !== null && typeof existing.remoteDisplay !== "string") ||
		typeof existing.enrolledAt !== "string"
	)
		return identityFailure("identity_unavailable", "Enrolled repository identity is malformed.");
	if (existing.commonDir !== commonDir)
		return identityFailure("identity_drift", "Enrolled repository common directory has changed.");
	return {
		code: "ok",
		value: {
			projectId: existing.projectId,
			commonDir,
			registryKey,
			remoteDisplay: sanitizeFilesystemMemoryRemoteDisplay(existing.remoteDisplay),
			sharedRoot: path.join(getProjectAgentDir(worktreeRoot), "memory"),
			privateRoot: path.join(getFilesystemMemoryDataDir(options.agentDir), "projects", existing.projectId),
		},
	};
}

export function enrollFilesystemMemoryProjectIdentity(
	registry: FilesystemMemoryIdentityRegistryV1,
	commonDir: string,
	remoteDisplay: string | null | undefined,
	now: string,
): FilesystemMemoryIdentityRegistryV1 {
	const registryKey = registryKeyForCommonDir(commonDir);
	const existing = registry.repositories[registryKey];
	const identity: FilesystemMemoryRepositoryIdentityV1 = existing ?? {
		projectId: crypto.randomUUID(),
		commonDir,
		remoteDisplay: sanitizeFilesystemMemoryRemoteDisplay(remoteDisplay),
		enrolledAt: now,
	};
	return { version: 1, repositories: { ...registry.repositories, [registryKey]: identity } };
}

export async function ensureFilesystemMemoryPrivateDirectory(
	directory: string,
): Promise<FilesystemMemoryOutcome<string>> {
	const absolute = path.resolve(directory);
	let existing = absolute;
	const missing: string[] = [];
	try {
		while (true) {
			try {
				const stat = await fs.lstat(existing);
				if (stat.isSymbolicLink() || !stat.isDirectory())
					return { code: "symlink_denied", message: "Private filesystem memory path is not a trusted directory." };
				const canonical = await fs.realpath(existing);
				if (canonical !== existing)
					return {
						code: "symlink_denied",
						message: "Private filesystem memory path contains a symbolic-link ancestor.",
					};
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				const parent = path.dirname(existing);
				if (parent === existing) throw error;
				missing.unshift(path.basename(existing));
				existing = parent;
			}
		}
		for (const segment of missing) {
			existing = path.join(existing, segment);
			try {
				await fs.mkdir(existing, { mode: FILESYSTEM_MEMORY_PRIVATE_DIRECTORY_MODE });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const stat = await fs.lstat(existing);
			if (stat.isSymbolicLink() || !stat.isDirectory() || (await fs.realpath(existing)) !== existing)
				return { code: "symlink_denied", message: "Private filesystem memory path changed during creation." };
		}
		if (process.platform !== "win32") await fs.chmod(absolute, FILESYSTEM_MEMORY_PRIVATE_DIRECTORY_MODE);
		return { code: "ok", value: absolute };
	} catch {
		return { code: "permission_denied", message: "Private filesystem memory directory could not be secured." };
	}
}
