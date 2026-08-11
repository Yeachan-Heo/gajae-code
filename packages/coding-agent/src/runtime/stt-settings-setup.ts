export interface SttDependencySetupProgress {
	stage: string;
	percent?: number;
}

export interface SttDependencySetupOptions {
	modelName?: string;
	onProgress?: (progress: SttDependencySetupProgress) => void;
}

export type EnsureSttDependencies = (options?: SttDependencySetupOptions) => Promise<void>;

export interface ConfigureSttFromSettingsOptions {
	modelName?: string;
	ensureDependencies?: EnsureSttDependencies;
	setEnabled(enabled: false): void;
	flush(): Promise<void>;
	showStatus(message: string): void;
	showError(message: string): void;
}

let ensureDependenciesPromise: Promise<EnsureSttDependencies> | undefined;

async function loadEnsureSttDependencies(): Promise<EnsureSttDependencies> {
	ensureDependenciesPromise ??= import("../stt/downloader").then(module => module.ensureSTTDependencies);
	return ensureDependenciesPromise;
}

export async function configureSttFromSettings(options: ConfigureSttFromSettingsOptions): Promise<boolean> {
	options.showStatus("Checking speech-to-text dependencies...");
	try {
		const ensureDependencies = options.ensureDependencies ?? (await loadEnsureSttDependencies());
		await ensureDependencies({
			modelName: options.modelName,
			onProgress: progress => {
				options.showStatus(progress.stage + (progress.percent === undefined ? "" : ` (${progress.percent}%)`));
			},
		});
		options.showStatus("Speech-to-text is ready. Use /hotkeys or Ctrl+P → Toggle speech-to-text.");
		return true;
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		let rollbackFailure: string | undefined;
		try {
			options.setEnabled(false);
			await options.flush();
		} catch (rollbackError) {
			rollbackFailure = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
		}
		options.showError(
			rollbackFailure
				? `Speech-to-text setup failed: ${cause}. Disabling STT also failed: ${rollbackFailure}`
				: `Speech-to-text setup failed: ${cause}. STT was disabled; fix the dependency and enable it again.`,
		);
		return false;
	}
}
