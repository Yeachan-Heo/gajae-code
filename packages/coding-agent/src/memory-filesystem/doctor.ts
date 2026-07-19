import {
	FILESYSTEM_MEMORY_MAX_DIRECTORY_DEPTH,
	FILESYSTEM_MEMORY_MAX_INSPECTED_ENTRIES,
	FILESYSTEM_MEMORY_MAX_VISITED_DIRECTORIES,
	type FilesystemMemoryScope,
	type FilesystemMemoryScopeAvailability,
} from "./contracts";
import { containsFilesystemMemorySecretLikeContent, parseFilesystemMemoryDocument } from "./document";
import { parseFilesystemMemoryMap } from "./map";
import type { FilesystemMemoryRoots } from "./retrieval";
import { listSafeFilesystemMemoryDirectory, readSafeFilesystemMemoryFile } from "./safe-path";

export interface FilesystemMemoryDoctorFinding {
	readonly scope: FilesystemMemoryScope;
	readonly path: string;
	readonly code: string;
}

export interface FilesystemMemoryDoctorReport {
	readonly healthy: boolean;
	readonly findings: readonly FilesystemMemoryDoctorFinding[];
}

function logicalPath(components: readonly string[]): string {
	return components.length ? components.join("/") : ".";
}

/** Performs bounded read-only validation and deliberately never creates, migrates, or repairs files. */
export async function doctorFilesystemMemory(
	roots: FilesystemMemoryRoots,
	availability: readonly FilesystemMemoryScopeAvailability[] = [],
): Promise<FilesystemMemoryDoctorReport> {
	const findings: FilesystemMemoryDoctorFinding[] = [];
	for (const entry of availability) {
		if (!entry.available && entry.reason) findings.push({ scope: entry.scope, path: ".", code: entry.reason });
	}
	let visitedDirectories = 0;
	let inspectedEntries = 0;
	for (const scope of ["global", "project", "project-local", "session"] as const) {
		const root = roots[scope];
		if (!root) continue;
		const requiredMap = await readSafeFilesystemMemoryFile(root, ["memory.yaml"]);
		if (requiredMap.code === "not_found") findings.push({ scope, path: "memory.yaml", code: "missing_map" });
		else if (requiredMap.code !== "ok") findings.push({ scope, path: "memory.yaml", code: requiredMap.code });
		const queue: Array<{ components: string[]; depth: number }> = [{ components: [], depth: 0 }];
		while (queue.length) {
			const current = queue.shift();
			if (!current) break;
			visitedDirectories += 1;
			if (visitedDirectories > FILESYSTEM_MEMORY_MAX_VISITED_DIRECTORIES) {
				findings.push({ scope, path: logicalPath(current.components), code: "directory_limit" });
				break;
			}
			const listed = await listSafeFilesystemMemoryDirectory(
				root,
				current.components,
				FILESYSTEM_MEMORY_MAX_INSPECTED_ENTRIES,
			);
			if (listed.code !== "ok") {
				findings.push({ scope, path: logicalPath(current.components), code: listed.code });
				continue;
			}
			for (const entry of listed.value.entries) {
				inspectedEntries += 1;
				const components = [...current.components, entry.name];
				const entryPath = logicalPath(components);
				if (inspectedEntries > FILESYSTEM_MEMORY_MAX_INSPECTED_ENTRIES) {
					findings.push({ scope, path: entryPath, code: "entry_limit" });
					queue.length = 0;
					break;
				}
				if (entry.type === "symlink") {
					findings.push({ scope, path: entryPath, code: "symlink_denied" });
					continue;
				}
				if (entry.type === "directory") {
					if (current.depth < FILESYSTEM_MEMORY_MAX_DIRECTORY_DEPTH)
						queue.push({ components, depth: current.depth + 1 });
					else findings.push({ scope, path: entryPath, code: "depth_limit" });
					continue;
				}
				if (
					entry.type !== "file" ||
					(!entry.name.endsWith(".md") && entry.name !== "memory.yaml" && entry.name !== "memory.json")
				)
					continue;
				const read = await readSafeFilesystemMemoryFile(root, components);
				if (read.code !== "ok") {
					findings.push({ scope, path: entryPath, code: read.code });
					continue;
				}
				let checkedCode: string | null = null;
				if (entry.name.endsWith(".md")) {
					const checked = parseFilesystemMemoryDocument(read.value.bytes);
					if (checked.code !== "ok") checkedCode = checked.code;
					else if (scope === "project" && containsFilesystemMemorySecretLikeContent(checked.value.body))
						checkedCode = "secret_like_shared_content";
					else if (checked.value.metadata.status && checked.value.metadata.status !== "active")
						checkedCode = `status_${checked.value.metadata.status}`;
				} else {
					try {
						const checked = parseFilesystemMemoryMap(
							new TextDecoder("utf-8", { fatal: true }).decode(read.value.bytes),
						);
						checkedCode = checked.code === "ok" ? null : checked.code;
					} catch {
						checkedCode = "invalid_path";
					}
				}
				if (checkedCode) findings.push({ scope, path: entryPath, code: checkedCode });
			}
		}
	}
	return {
		healthy: findings.length === 0,
		findings: findings.sort((left, right) =>
			`${left.scope}:${left.path}:${left.code}`.localeCompare(`${right.scope}:${right.path}:${right.code}`),
		),
	};
}
