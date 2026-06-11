export interface CandidateAddon {
	variant: "modern" | "baseline" | "default";
	filename: string;
}

export interface BuildSidecar {
	languageSet?: string;
}

export interface NativeBuildInfo {
	languageSet?: string;
}

interface NativeAddonModule {
	nativeBuildInfo?: () => NativeBuildInfo;
}

export interface VerifyDefaultLanguageSetOptions {
	platformTag: string;
	hostPlatformTag: string;
	readBuildSidecar: (candidatePath: string) => Promise<BuildSidecar | null>;
	loadNativeAddon: (candidatePath: string) => NativeAddonModule;
	warn: (message: string) => void;
}

function assertDefaultLanguageSet(filename: string, languageSet: string | undefined, source: string): void {
	if (languageSet !== "default") {
		throw new Error(
			`Refusing to embed ${filename}: native addon ${source} languageSet is ${JSON.stringify(languageSet)}, expected "default". Rebuild without PI_NATIVE_FULL_LANGS=1.`,
		);
	}
}

export async function verifyDefaultLanguageSet(
	candidate: CandidateAddon,
	candidatePath: string,
	options: VerifyDefaultLanguageSetOptions,
): Promise<void> {
	const sidecar = await options.readBuildSidecar(candidatePath);
	if (sidecar) {
		assertDefaultLanguageSet(candidate.filename, sidecar.languageSet, "sidecar");
	}

	if (options.platformTag !== options.hostPlatformTag) {
		if (!sidecar) {
			options.warn(
				`Warning: ${candidate.filename} has no build sidecar; skipping in-process languageSet check for non-host platform ${options.platformTag}.`,
			);
		}
		return;
	}

	const addon = options.loadNativeAddon(candidatePath);
	const info = addon.nativeBuildInfo?.();
	assertDefaultLanguageSet(candidate.filename, info?.languageSet, "in-process");
}
