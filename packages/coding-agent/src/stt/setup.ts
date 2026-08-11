import { detectRecordingTools } from "./recorder";
import { resolvePython } from "./transcriber";

export function getRecorderInstallHint(platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return "PowerShell fallback available. For better quality: install SoX or FFmpeg.";
	if (platform === "darwin") return "Install a recorder with Homebrew: brew install sox (or brew install ffmpeg)";
	return "Install a recorder: sudo apt install sox (or sudo apt install ffmpeg)";
}

export function formatSTTUsage(
	platform: NodeJS.Platform = process.platform,
	terminalProgram: string | undefined = Bun.env.TERM_PROGRAM,
): string {
	const lines = [
		"Enable STT: gjc config set stt.enabled true",
		"You can also enable it in /settings > Interaction > Speech-to-Text.",
		"In the composer, press Alt+H to start recording, then press Alt+H again to stop and transcribe.",
		"The transcription is inserted into the composer for review before you send it.",
		"Shortcut fallback: press Ctrl+P and select Toggle speech-to-text; repeat to stop and transcribe.",
	];
	if (platform === "darwin") {
		lines.push("On macOS, Alt+H is Option+H. Your terminal must forward Option as Meta/Esc.");
		if (terminalProgram?.toLowerCase().includes("ghostty")) {
			lines.push(
				"Ghostty: set macos-option-as-alt = true in its config, then reload the config or restart Ghostty.",
			);
		}
	}
	lines.push("Run /hotkeys inside GJC to confirm the active shortcut.");
	return lines.join("\n");
}

export interface STTDependencyStatus {
	recorder: { available: boolean; tool: string | null; installHint: string };
	python: { available: boolean; path: string | null; installHint: string };
	whisper: { available: boolean; installHint: string };
}

export async function checkDependencies(): Promise<STTDependencyStatus> {
	const recorderTools = detectRecordingTools();
	const recorderHint = getRecorderInstallHint();

	const pythonCmd = resolvePython();
	const pythonHint = "Install Python 3.8+ from https://python.org";

	let whisperAvailable = false;
	if (pythonCmd) {
		const check = Bun.spawnSync([pythonCmd, "-c", "import whisper"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		whisperAvailable = check.exitCode === 0;
	}
	const whisperHint = "Run 'gjc setup stt' to auto-install, or: pip install openai-whisper";

	return {
		recorder: { available: recorderTools.length > 0, tool: recorderTools[0] ?? null, installHint: recorderHint },
		python: { available: pythonCmd !== null, path: pythonCmd, installHint: pythonHint },
		whisper: { available: whisperAvailable, installHint: whisperHint },
	};
}

export function formatDependencyStatus(status: STTDependencyStatus): string {
	const lines: string[] = ["STT Dependencies:"];
	const check = (ok: boolean) => (ok ? "[ok]" : "[missing]");

	lines.push(`  Recorder: ${check(status.recorder.available)} ${status.recorder.tool ?? "none"}`);
	if (!status.recorder.available) lines.push(`    -> ${status.recorder.installHint}`);

	lines.push(`  Python:   ${check(status.python.available)} ${status.python.path ?? "none"}`);
	if (!status.python.available) lines.push(`    -> ${status.python.installHint}`);

	lines.push(`  Whisper:  ${check(status.whisper.available)}`);
	if (!status.whisper.available) lines.push(`    -> ${status.whisper.installHint}`);

	return lines.join("\n");
}
