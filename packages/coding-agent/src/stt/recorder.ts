import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, logger, Snowflake } from "@gajae-code/utils";
import { $ } from "bun";

export interface RecordingHandle {
	stop(): Promise<void>;
}

const isWindows = process.platform === "win32";

/**
 * Returns available recording tools in priority order.
 */
export function detectRecordingTools(): string[] {
	const tools: string[] = [];
	if ($which("sox")) tools.push("sox");
	if ($which("ffmpeg")) tools.push("ffmpeg");
	if (!isWindows && $which("arecord")) tools.push("arecord");
	if (isWindows) tools.push("powershell");
	return tools;
}

// ── ffmpeg dshow device detection ──────────────────────────────────

async function detectWindowsAudioDevice(): Promise<string> {
	const result = await $`ffmpeg -f dshow -list_devices true -i dummy`.quiet().nothrow();
	const output = result.stderr.toString();
	const audioDevices: string[] = [];
	const re = /"([^"]+)"\s*\(audio\)/gi;
	for (const match of output.matchAll(re)) {
		audioDevices.push(match[1]);
	}
	if (audioDevices.length === 0) {
		throw new Error("No audio input device found via ffmpeg dshow. Ensure a microphone is connected.");
	}
	logger.debug("Detected dshow audio devices", { devices: audioDevices });
	return audioDevices[0];
}

// ── Recording implementations ──────────────────────────────────────

async function startSoxRecording(outputPath: string): Promise<RecordingHandle> {
	// On Windows, "-d" (default device) often fails. Use "-t waveaudio 0" for the first input.
	const inputArgs = isWindows ? ["-t", "waveaudio", "0"] : ["-d"];

	const proc = Bun.spawn(["sox", ...inputArgs, "-r", "16000", "-c", "1", "-b", "16", "-t", "wav", outputPath], {
		stdout: "pipe",
		stderr: "ignore",
	});
	await verifyProcessAlive(proc, "sox");
	return {
		async stop() {
			proc.kill("SIGTERM");
			await proc.exited;
		},
	};
}

async function startFFmpegRecording(outputPath: string, macosAudioDevice = ":default"): Promise<RecordingHandle> {
	let args: string[];
	if (isWindows) {
		const device = await detectWindowsAudioDevice();
		args = [
			"ffmpeg",
			"-f",
			"dshow",
			"-i",
			`audio=${device}`,
			"-ar",
			"16000",
			"-ac",
			"1",
			"-sample_fmt",
			"s16",
			"-flush_packets",
			"1",
			"-y",
			outputPath,
		];
	} else if (process.platform === "darwin") {
		// ":0" is the first *enumerated* avfoundation audio device, not the
		// system default — on machines with virtual devices (BlackHole,
		// Loopback) that records pure silence. ":default" targets the actual
		// default input; the caller falls back to ":0" if it fails to start.
		args = [
			"ffmpeg",
			"-f",
			"avfoundation",
			"-i",
			macosAudioDevice,
			"-ar",
			"16000",
			"-ac",
			"1",
			"-sample_fmt",
			"s16",
			"-flush_packets",
			"1",
			"-y",
			outputPath,
		];
	} else {
		args = [
			"ffmpeg",
			"-f",
			"pulse",
			"-i",
			"default",
			"-ar",
			"16000",
			"-ac",
			"1",
			"-sample_fmt",
			"s16",
			"-flush_packets",
			"1",
			"-y",
			outputPath,
		];
	}

	const proc = Bun.spawn(args, {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});
	await verifyProcessAlive(proc, "ffmpeg");

	return {
		async stop() {
			try {
				proc.stdin.write("q");
				proc.stdin.end();
			} catch {
				// stdin may already be closed
			}
			const killTimer = setTimeout(() => proc.kill(), 3000);
			await proc.exited;
			clearTimeout(killTimer);
		},
	};
}

async function startArecordRecording(outputPath: string): Promise<RecordingHandle> {
	const proc = Bun.spawn(["arecord", "-f", "S16_LE", "-r", "16000", "-c", "1", outputPath], {
		stdout: "pipe",
		stderr: "ignore",
	});
	await verifyProcessAlive(proc, "arecord");
	return {
		async stop() {
			proc.kill("SIGTERM");
			await proc.exited;
		},
	};
}

// ── PowerShell mci recorder (Windows zero-dep fallback) ────────────

const PS_RECORD_SCRIPT = `
param([string]$outPath)

if ($outPath -match '["\r\n]') {
    [Console]::Error.WriteLine("Invalid output path: $outPath")
    exit 1
}


Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class MciAudio {
    [DllImport("winmm.dll", CharSet=CharSet.Auto)]
    public static extern int mciSendString(
        string command, StringBuilder buffer, int bufferSize, IntPtr callback);
}
"@

function Mci([string]$cmd) {
    $buf = New-Object System.Text.StringBuilder 256
    $r = [MciAudio]::mciSendString($cmd, $buf, 256, [IntPtr]::Zero)
    if ($r -ne 0) {
        [Console]::Error.WriteLine("MCI error $r for: $cmd")
    }
    return $r
}

$r = Mci "open new type waveaudio alias gjc_rec"
if ($r -ne 0) { exit 1 }

Mci "set gjc_rec channels 1 samplespersec 16000 bitspersample 16"

$r = Mci "record gjc_rec"
if ($r -ne 0) {
    Mci "close gjc_rec"
    exit 1
}

Write-Output "RECORDING"
[Console]::Out.Flush()

# Block until parent closes stdin or writes a line
try { [Console]::In.ReadLine() | Out-Null } catch {}

# Stop and save
Mci "stop gjc_rec"
$saveCmd = 'save gjc_rec "' + $outPath + '"'
$r = Mci $saveCmd
if ($r -ne 0) {
    [Console]::Error.WriteLine("Save failed for: $saveCmd")
}
Mci "close gjc_rec"

if (Test-Path $outPath) {
    Write-Output "SAVED"
} else {
    Write-Error "Output file was not created: $outPath"
    exit 1
}
`;

async function startPowerShellRecording(outputPath: string): Promise<RecordingHandle> {
	// Write script to temp file — avoids quoting/escaping issues with -Command
	const scriptPath = path.join(os.tmpdir(), `gjc-stt-record-${Snowflake.next()}.ps1`);
	await Bun.write(scriptPath, PS_RECORD_SCRIPT);

	const proc = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, outputPath], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});

	proc.exited.then(() => {
		fs.unlink(scriptPath).catch(() => {});
	});

	// Wait for "RECORDING" on stdout to confirm it started
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let output = "";
	const deadline = Date.now() + 8000; // PowerShell + Add-Type is slow

	while (Date.now() < deadline) {
		const readPromise = reader.read();
		const timeoutPromise = Bun.sleep(deadline - Date.now()).then(() => ({ done: true, value: undefined }));
		const { done, value } = await Promise.race([readPromise, timeoutPromise]);
		if (done || !value) break;
		output += decoder.decode(value, { stream: true });
		if (output.includes("RECORDING")) break;
	}
	reader.releaseLock();

	if (!output.includes("RECORDING")) {
		proc.kill();
		await proc.exited;
		let stderrText = "";
		if (proc.stderr && typeof proc.stderr !== "number") {
			stderrText = await new Response(proc.stderr as ReadableStream).text();
		}
		// Clean up temp script
		fs.unlink(scriptPath).catch(() => {});
		throw new Error(
			`PowerShell audio recording failed to start: ${stderrText.trim() || output.trim() || "(no output)"}`,
		);
	}

	return {
		async stop() {
			try {
				proc.stdin.write("stop\n");
				proc.stdin.end();
			} catch {
				// stdin may already be closed
			}
			// Give PowerShell time to save the file
			const killTimer = setTimeout(() => proc.kill(), 8000);
			await proc.exited;
			clearTimeout(killTimer);
			// Clean up temp script
			fs.unlink(scriptPath).catch(() => {});
		},
	};
}

// ── Health check ───────────────────────────────────────────────────

async function verifyProcessAlive(proc: ReturnType<typeof Bun.spawn>, tool: string): Promise<void> {
	await Bun.sleep(300);

	const exited = await Promise.race([proc.exited.then(code => code), Bun.sleep(0).then(() => "running" as const)]);

	if (exited !== "running") {
		let stderr = "";
		if (proc.stderr && typeof proc.stderr !== "number") {
			stderr = await new Response(proc.stderr as ReadableStream).text();
		}
		throw new Error(`${tool} exited immediately (code ${exited}): ${stderr.trim() || "(no output)"}`);
	}
}

// ── Public API ─────────────────────────────────────────────────────

export async function startRecording(outputPath: string): Promise<RecordingHandle> {
	const tools = detectRecordingTools();
	if (tools.length === 0) {
		throw new Error(
			isWindows
				? "No audio recording tool found. Install FFmpeg or SoX and add to PATH."
				: "No audio recording tool found. Install SoX: sudo apt install sox, or FFmpeg: sudo apt install ffmpeg",
		);
	}

	const errors: string[] = [];
	for (const tool of tools) {
		logger.debug("Trying audio recording", { tool, outputPath });
		try {
			switch (tool) {
				case "sox":
					return await startSoxRecording(outputPath);
				case "ffmpeg":
					if (process.platform === "darwin") {
						try {
							return await startFFmpegRecording(outputPath, ":default");
						} catch {
							// Older ffmpeg builds without ":default" support.
							return await startFFmpegRecording(outputPath, ":0");
						}
					}
					return await startFFmpegRecording(outputPath);
				case "arecord":
					return await startArecordRecording(outputPath);
				case "powershell":
					return await startPowerShellRecording(outputPath);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.debug(`Recording tool ${tool} failed, trying next`, { error: msg });
			errors.push(`${tool}: ${msg}`);
		}
	}

	throw new Error(`All recording tools failed:\n${errors.join("\n")}`);
}

/**
 * Verify a recorded audio file is usable.
 * Returns the file size in bytes, or throws.
 */
export async function verifyRecordingFile(filePath: string): Promise<number> {
	try {
		const stat = await fs.stat(filePath);
		if (stat.size < 100) {
			throw new Error(
				`Recording file is too small (${stat.size} bytes) — audio may not have been captured. ` +
					"Check that a microphone is connected and permissions are granted.",
			);
		}
		return stat.size;
	} catch (err) {
		if (err instanceof Error && err.message.includes("too small")) throw err;
		throw new Error(
			"Recording file was not created. The recording process may have failed silently. " +
				"Check that a microphone is connected.",
		);
	}
}
