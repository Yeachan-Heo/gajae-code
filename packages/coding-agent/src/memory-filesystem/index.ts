export {
	doctorFilesystemMemory,
	type FilesystemMemoryDoctorFinding,
	type FilesystemMemoryDoctorReport,
} from "./doctor";
export {
	type FilesystemMemoryDocument,
	type FilesystemMemoryHeading,
	filesystemMemoryHeadingRange,
	parseFilesystemMemoryDocument,
	parseFilesystemMemoryMapping,
} from "./document";
export { type FilesystemMemoryMapRoute, parseFilesystemMemoryMap, resolveFilesystemMemoryMapRoute } from "./map";
export {
	FILESYSTEM_MEMORY_MAX_SELECTED_RESULTS,
	type FilesystemMemoryCitation,
	type FilesystemMemoryExcluded,
	type FilesystemMemoryResult,
	type FilesystemMemoryRetrieval,
	type FilesystemMemoryRoots,
	type FilesystemMemorySearchOptions,
	getFilesystemMemoryDocument,
	recallFilesystemMemory,
	searchFilesystemMemory,
} from "./retrieval";

export const FILESYSTEM_MEMORY_CAPABILITIES = {
	protocolVersion: 1,
	commands: ["init", "scopes", "resolve", "get", "search", "recall", "checkpoint", "resume", "doctor", "capabilities"],
	scopes: ["global", "project", "project-local", "session"],
	formats: ["text", "json", "jsonl"],
	bounds: {
		maxDocumentBytes: 1_048_576,
		maxDirectoryDepth: 16,
		maxVisitedDirectories: 256,
		maxInspectedEntries: 4_096,
		maxSelectedResults: 32,
	},
	deferrals: [
		"runtime memory backend integration",
		"prompt injection",
		"automatic capture",
		"model synthesis",
		"cloud sync",
		"embeddings",
		"retrieval ledger",
		"additional output formats",
	],
} as const;
