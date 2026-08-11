import { $which, logger } from "@gajae-code/utils";
import { $ } from "bun";
import { getRecorderInstallHint } from "./setup";
import { resolvePython } from "./transcriber";

export interface DownloadProgress {
	stage: string;
	percent?: number;
}

export interface EnsureOptions {
	modelName?: string;
	onProgress?: (progress: DownloadProgress) => void;
}

// ── Recording tool ─────────────────────────────────────────────────

async function ensureRecordingTool(options?: EnsureOptions): Promise<void> {
	if ($which("sox")) return;
	if ($which("ffmpeg")) return;
	if (process.platform === "linux" && $which("arecord")) return;

	// Windows: PowerShell mciSendString is always available as fallback
	if (process.platform === "win32") {
		// Try to get ffmpeg for better quality, but don't block on failure
		options?.onProgress?.({ stage: "Trying to install FFmpeg via winget..." });
		const result = await $`winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements`
			.quiet()
			.nothrow();
		if (result.exitCode === 0) {
			logger.debug("FFmpeg installed via winget");
		}
		return;
	}

	throw new Error(`No audio recording tool found. ${getRecorderInstallHint()}`);
}

// ── Python whisper ─────────────────────────────────────────────────

async function ensurePythonWhisper(options?: EnsureOptions): Promise<void> {
	const pythonCmd = resolvePython();
	if (!pythonCmd) {
		throw new Error("Python not found. Install Python 3.8+ from https://python.org");
	}

	// Check if whisper module is already importable
	const check = Bun.spawnSync([pythonCmd, "-c", "import whisper"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (check.exitCode === 0) return;

	options?.onProgress?.({ stage: "Installing openai-whisper (this may take a few minutes)..." });
	logger.debug("Installing openai-whisper via pip");

	const install = await $`${pythonCmd} -m pip install -q openai-whisper`.quiet().nothrow();
	if (install.exitCode !== 0) {
		const stderr = install.stderr.toString().trim();
		throw new Error(`Failed to install openai-whisper: ${stderr.split("\n").pop()}`);
	}
	logger.debug("openai-whisper installed successfully");
}

// ── Public API ─────────────────────────────────────────────────────

export async function ensureSTTDependencies(options?: EnsureOptions): Promise<void> {
	await ensureRecordingTool(options);
	await ensurePythonWhisper(options);
}
