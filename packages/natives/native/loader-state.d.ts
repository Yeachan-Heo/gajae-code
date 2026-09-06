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

export type Win32Avx2ProbeDiagnostic = "timeout" | "spawn_error" | "nonzero_exit" | "non_decisive_output";

export function detectWin32Avx2Support(
	probe?: () => boolean | undefined,
	command?: (
		file: string,
		args: string[],
		report?: (diagnostic: Win32Avx2ProbeDiagnostic) => void,
	) => string | null,
	report?: (diagnostic: Win32Avx2ProbeDiagnostic) => void,
): boolean;

export function getVariantOverride(env?: Record<string, string | undefined>): "modern" | "baseline" | null;

export interface GetAddonFilenamesInput {
	tag: string;
	arch: string;
	variant: "modern" | "baseline" | null | undefined;
}

export function getAddonFilenames(input: GetAddonFilenamesInput): string[];

export function getOptionalPackageNames(platformTag: string): string[];

export interface ResolveOptionalPackageNativeDirsInput {
	packageNames: string[];
	requireResolve: (id: string) => string;
}

export function resolveOptionalPackageNativeDirs(input: ResolveOptionalPackageNativeDirsInput): string[];

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
	isWorkspaceLoad?: boolean;
	optionalPackageNativeDirs?: string[];
	nativeDir: string;
	execDir: string;
	versionedDir: string;
	userDataDir: string;
}

export function resolveLoaderCandidates(input: ResolveLoaderCandidatesInput): string[];

export interface LoadFromCandidatesInput<T> {
	candidates: string[];
	requireCandidate: (candidate: string) => T;
	validateCandidate: (bindings: T, candidate: string) => void;
	describeCandidate: (candidate: string) => string;
}

export interface LoadFromCandidatesResult<T> {
	bindings: T | null;
	errors: string[];
}

export function loadFromCandidates<T>(input: LoadFromCandidatesInput<T>): LoadFromCandidatesResult<T>;

export interface CachedEmbeddedExtractionIsFreshInput {
	targetPath: string;
	embeddedPath: string;
	sizeOf: (path: string) => number | null;
}

export function cachedEmbeddedExtractionIsFresh(input: CachedEmbeddedExtractionIsFreshInput): boolean;

export interface NativeAddonSnapshot {
	bytes: Uint8Array;
	hash: string;
	identity: string;
}

export function validateLoadedBindings(
	ctx: { versionSentinelExport: string; packageVersion: string },
	bindings: Record<string, unknown>,
	candidate: string,
): void;

export interface LoaderContext {
	isCompiledBinary: boolean;
	platformTag: string;
	packageVersion?: string;
	addonLabel?: string;
	addonFilenames?: string[];
	versionedDir?: string;
	candidates?: string[];
	stageFromNodeModules?: boolean;
	nativeDir?: string;
	optionalPackageNativeDirs?: string[];
	selectedVariant?: "modern" | "baseline" | null;
	stagedCandidateSnapshots?: Map<string, NativeAddonSnapshot>;
	stagedSourceSnapshots?: Map<string, { sourcePath: string; snapshot: NativeAddonSnapshot }>;
}

export function maybeStageNodeModulesAddon(ctx: LoaderContext, errors: string[]): string[];

export function embeddedAddonIsAuthoritative(
	ctx: LoaderContext,
	addon?: EmbeddedAddon | null,
): boolean;

export interface LoadNativeOptions {
	context?: LoaderContext;
	extractEmbeddedAddons?: (ctx: LoaderContext) => string[];
	stageNodeModulesAddon?: (ctx: LoaderContext, errors: string[]) => string[] | string | null;
	acquireStagedCandidateLease?: (candidate: string) => () => void;
	requireCandidate?: (candidate: string) => Record<string, unknown>;
	validateCandidate?: (bindings: Record<string, unknown>, candidate: string) => void;
}

export function loadNative(options?: LoadNativeOptions): Record<string, unknown>;
