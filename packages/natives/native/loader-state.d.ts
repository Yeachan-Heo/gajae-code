export interface EmbeddedAddonFile {
	variant: "modern" | "baseline" | "default";
	filename: string;
	filePath: string;
}

export interface EmbeddedAddon {
	platformTag: string;
	version: string;
	files: EmbeddedAddonFile[];
}

export interface DetectCompiledBinaryInput {
	embeddedAddon: EmbeddedAddon | null | undefined;
	env: Record<string, string | undefined>;
	importMetaUrl: string | null | undefined;
}

export function detectCompiledBinary(input: DetectCompiledBinaryInput): boolean;

export interface GetAddonFilenamesInput {
	tag: string;
	arch: string;
	variant: "modern" | "baseline" | null | undefined;
}

export function getAddonFilenames(input: GetAddonFilenamesInput): string[];

export interface ShouldStageNodeModulesAddonInput {
	platform: NodeJS.Platform | string;
	isCompiledBinary: boolean;
	nativeDir: string;
}

export function shouldStageNodeModulesAddon(input: ShouldStageNodeModulesAddonInput): boolean;

export interface ResolveLoaderCandidatesInput {
	addonFilenames: string[];
	isCompiledBinary: boolean;
	stageFromNodeModules?: boolean;
	nativeDir: string;
	execDir: string;
	versionedDir: string;
	userDataDir: string;
}

export function resolveLoaderCandidates(input: ResolveLoaderCandidatesInput): string[];

export function loadNative(): Record<string, unknown>;
