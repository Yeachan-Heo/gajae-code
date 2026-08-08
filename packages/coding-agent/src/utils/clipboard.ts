import { execSync } from "node:child_process";
import type { ClipboardImage } from "@gajae-code/natives";

let nativeClipboardModule: typeof import("@gajae-code/natives") | undefined;

function nativeClipboard(): typeof import("@gajae-code/natives") {
	nativeClipboardModule ??= require("@gajae-code/natives") as typeof import("@gajae-code/natives");
	return nativeClipboardModule;
}

import { logger } from "@gajae-code/utils";
import { settings } from "../config/settings";

function hasDisplay(): boolean {
	return process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function isWsl(): boolean {
	return process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

/** Thrown when an explicit clipboard transport (currently only `ssh`) fails.
 *
 * Explicit transports never silently fall back to native/OSC52 — the caller
 * must surface this to the user and leave the editor/clipboard unchanged.
 */
export class ClipboardTransportError extends Error {
	constructor(
		message: string,
		readonly context?: Record<string, unknown>,
	) {
		super(message);
		this.name = "ClipboardTransportError";
	}
}

const SSH_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SSH_OPERATION_TIMEOUT_MS = 5000;
const SSH_CONNECT_TIMEOUT_S = 3;
const CLIPBOARD_TEXT_MAX_BYTES = 1024 * 1024; // 1 MiB

function validateSshHost(host: string): void {
	if (!host || !SSH_HOST_PATTERN.test(host)) {
		throw new ClipboardTransportError(
			"Invalid clipboard SSH host: must be a non-empty alias with no whitespace, control characters, or leading dash.",
			{ operation: "validate-host" },
		);
	}
}

/**
 * Validate outbound clipboard text before it is spawned to `ssh`: reject NUL
 * bytes, unpaired surrogates (invalid UTF-16 that cannot round-trip as UTF-8),
 * and payloads over the 1 MiB cap. Runs before any process spawns.
 */
function validateOutboundClipboardText(text: string): void {
	if (text.includes("\u0000")) {
		throw new ClipboardTransportError("Clipboard text contains a NUL byte; rejecting.", { operation: "pbcopy" });
	}
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			// High surrogate: must be immediately followed by a low surrogate.
			const next = text.charCodeAt(i + 1);
			if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
				throw new ClipboardTransportError("Clipboard text contains an unpaired UTF-16 surrogate; rejecting.", {
					operation: "pbcopy",
				});
			}
			i++; // consume the low surrogate we just validated
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			// Lone low surrogate with no preceding high surrogate.
			throw new ClipboardTransportError("Clipboard text contains an unpaired UTF-16 surrogate; rejecting.", {
				operation: "pbcopy",
			});
		}
	}
	const byteLength = Buffer.byteLength(text, "utf8");
	if (byteLength > CLIPBOARD_TEXT_MAX_BYTES) {
		throw new ClipboardTransportError(
			`Clipboard text exceeds the ${CLIPBOARD_TEXT_MAX_BYTES}-byte limit (got ${byteLength}).`,
			{ operation: "pbcopy" },
		);
	}
}

function spawnSshClipboardProcess(argv: string[]) {
	// stdin is always "pipe" (a literal, not a ternary) so Bun's spawn overload
	// resolution narrows `proc.stdin` to a writable FileSink instead of `number`.
	// Callers that have no payload (pbpaste) end the stream immediately instead.
	return Bun.spawn(argv, {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
}

/**
 * Drain a stream up to `maxBytes`, decoding as fatal-strict UTF-8. Aborts
 * (kills `proc`) as soon as the cap is exceeded — never buffers past the cap
 * before checking it. Returns the decoded text on success.
 *
 * @throws ClipboardTransportError on oversize, invalid UTF-8, or a stream read error.
 */
async function readBoundedFatalUtf8(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	proc: { kill(): void },
	operation: "pbcopy" | "pbpaste",
): Promise<string> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let total = 0;
	let text = "";
	try {
		for await (const chunk of stream) {
			total += chunk.byteLength;
			if (total > maxBytes) {
				proc.kill();
				throw new ClipboardTransportError(
					`Mac clipboard ${operation} exceeds the ${maxBytes}-byte limit; aborted before full buffering.`,
					{ operation },
				);
			}
			// stream: true keeps partial multibyte sequences pending across chunks;
			// a genuinely invalid byte still throws (fatal: true) rather than emitting U+FFFD.
			text += decoder.decode(chunk, { stream: true });
		}
		text += decoder.decode(); // flush; throws on a truncated trailing sequence
	} catch (err) {
		if (err instanceof ClipboardTransportError) throw err;
		throw new ClipboardTransportError(`Mac clipboard ${operation} returned invalid UTF-8: ${String(err)}.`, {
			operation,
		});
	}
	return text;
}

/**
 * Run `ssh -o BatchMode=yes -o ConnectTimeout=3 <host> <remoteCommand>` via
 * argv spawn (never a shell string, so the host/command cannot be reinterpreted),
 * with a bounded whole-operation timeout that covers spawn, stdin write/end,
 * stdout/stderr drain, and process exit/reap. Optionally writes `stdin`.
 *
 * On any failure (spawn error, nonzero exit, timeout, invalid/oversize data)
 * this throws — callers in `ssh` transport mode must not catch-and-fall-back
 * to native/OSC52.
 */
async function runSshClipboardCommand(
	host: string,
	remoteCommand: "pbcopy" | "pbpaste",
	stdin: string | undefined,
): Promise<string> {
	validateSshHost(host);
	const argv = [
		"ssh",
		"-o",
		"BatchMode=yes",
		"-o",
		`ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
		"--",
		host,
		remoteCommand,
	];

	let proc: ReturnType<typeof spawnSshClipboardProcess>;
	try {
		proc = spawnSshClipboardProcess(argv);
	} catch (err) {
		throw new ClipboardTransportError(`Failed to start ssh for clipboard ${remoteCommand}: ${String(err)}`, {
			operation: remoteCommand,
			host,
		});
	}

	let timer: ReturnType<typeof setTimeout>;
	const timeoutPromise = new Promise<"timeout">(resolve => {
		timer = setTimeout(() => {
			proc.kill();
			resolve("timeout");
		}, SSH_OPERATION_TIMEOUT_MS);
	});

	// Drain stderr unconditionally so the subprocess cannot deadlock writing to
	// a full pipe buffer; never logged raw (payload/diagnostic privacy) — only
	// its length is available for diagnostics if ever needed.
	const stderrDrainPromise = new Response(proc.stderr).arrayBuffer().catch(() => new ArrayBuffer(0));

	const work = (async (): Promise<{ stdout: string; exitCode: number | null }> => {
		if (stdin !== undefined) {
			try {
				proc.stdin.write(stdin);
				await proc.stdin.end();
			} catch (err) {
				proc.kill();
				throw new ClipboardTransportError(
					`Failed to write to ssh stdin for clipboard ${remoteCommand}: ${String(err)}`,
					{ operation: remoteCommand, host },
				);
			}
		} else {
			proc.stdin.end();
		}
		const stdout = await readBoundedFatalUtf8(proc.stdout, CLIPBOARD_TEXT_MAX_BYTES, proc, remoteCommand);
		await stderrDrainPromise;
		const exitCode = await proc.exited;
		return { stdout, exitCode };
	})();

	const race = await Promise.race([work, timeoutPromise]);
	clearTimeout(timer!);
	if (race === "timeout") {
		throw new ClipboardTransportError(
			`Mac clipboard ${remoteCommand} timed out after ${SSH_OPERATION_TIMEOUT_MS}ms (host=${host}).`,
			{ operation: remoteCommand, host, timeoutMs: SSH_OPERATION_TIMEOUT_MS },
		);
	}
	const { stdout, exitCode } = race;
	if (exitCode !== 0) {
		throw new ClipboardTransportError(`Mac clipboard ${remoteCommand} failed (rc=${exitCode}, host=${host}).`, {
			operation: remoteCommand,
			host,
			exitCode,
		});
	}
	return stdout;
}

async function copyToClipboardViaSsh(host: string, text: string): Promise<void> {
	validateOutboundClipboardText(text);
	await runSshClipboardCommand(host, "pbcopy", text);
}

/**
 * Read text from the configured SSH clipboard host (`pbpaste`).
 *
 * Reads with a bounded, fatal-UTF-8-decoding stream drain (never buffers past
 * the 1 MiB cap before checking it) and rejects an inbound NUL byte. Throws
 * `ClipboardTransportError` on any failure — explicit `ssh` mode never falls
 * back to native/OSC52 paste.
 */
export async function pasteFromClipboardViaSsh(host: string): Promise<string> {
	const stdout = await runSshClipboardCommand(host, "pbpaste", undefined);
	if (stdout.includes("\u0000")) {
		throw new ClipboardTransportError("Mac clipboard paste contained a NUL byte; rejecting.", {
			operation: "pbpaste",
			host,
		});
	}
	return stdout;
}

function getClipboardTransportConfig(): { transport: "auto" | "native" | "osc52" | "ssh"; sshHost: string } {
	try {
		return {
			transport: settings.get("clipboard.transport") ?? "auto",
			sshHost: settings.get("clipboard.sshHost") ?? "",
		};
	} catch {
		// Settings not initialized (e.g. component-level tests) — behave as "auto".
		return { transport: "auto", sshHost: "" };
	}
}

function emitOsc52(text: string): void {
	if (!process.stdout.isTTY) return;
	const onError = (err: unknown) => {
		process.stdout.off("error", onError);
		// Prevent unhandled 'error' from crashing the process when stdout is a closed pipe.
		if ((err as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") {
			return;
		}
	};
	try {
		const encoded = Buffer.from(text).toString("base64");
		const osc52 = `\x1b]52;c;${encoded}\x07`;
		process.stdout.on("error", onError);
		process.stdout.write(osc52, err => {
			process.stdout.off("error", onError);
			// If stdout is closed (e.g. piped to a process that exits early),
			// ignore EPIPE and proceed with native clipboard best-effort.
			if ((err as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") {
				return;
			}
		});
	} catch (err) {
		process.stdout.off("error", onError);
		if ((err as NodeJS.ErrnoException | null | undefined)?.code !== "EPIPE") {
			// Ignore all write failures (OSC 52 is best-effort).
		}
	}
}

async function copyToClipboardNative(text: string): Promise<void> {
	try {
		if (process.env.TERMUX_VERSION) {
			try {
				execSync("termux-clipboard-set", { input: text, timeout: 5000 });
				return;
			} catch {
				// Fall through to native
			}
		}
		// upstream/dev drift: the lazy native accessor's copyToClipboard call is
		// synchronous (not awaited) here — preserved as-is; this path is
		// unaffected by the ssh/osc52 explicit-transport contract below, which
		// never reaches this function.
		nativeClipboard().copyToClipboard(text);
	} catch {
		// Ignore — native clipboard copy is best-effort
	}
}

/**
 * Copy text to the clipboard using the configured transport.
 *
 * - `auto` (default): emits OSC 52 over a real terminal, then best-effort
 *   native copy — unchanged from prior behavior.
 * - `native`: native clipboard only, no OSC 52.
 * - `osc52`: OSC 52 only, no native call.
 * - `ssh`: `ssh <clipboard.sshHost> pbcopy` via argv spawn with a 5s hard
 *   timeout covering the whole operation. Never falls back to native/OSC52 on
 *   failure — throws `ClipboardTransportError` instead so the caller can
 *   surface it.
 *
 * @param text - UTF-8 text to place on the clipboard.
 */
export async function copyToClipboard(text: string): Promise<void> {
	const { transport, sshHost } = getClipboardTransportConfig();

	if (transport === "ssh") {
		await copyToClipboardViaSsh(sshHost, text);
		return;
	}

	if (transport === "osc52") {
		emitOsc52(text);
		return;
	}

	if (transport === "native") {
		await copyToClipboardNative(text);
		return;
	}

	// auto: prior best-effort dual-path behavior.
	emitOsc52(text);
	await copyToClipboardNative(text);
}

/**
 * Paste text from the configured clipboard transport.
 *
 * Only meaningful for `clipboard.transport = ssh` today (the explicit
 * "Paste text from configured clipboard" action) — other transports have no
 * dedicated paste path yet and return null.
 *
 * @returns pasted UTF-8 text, or null when no explicit ssh transport is configured.
 * @throws ClipboardTransportError on ssh failure — never returns stale/empty text silently.
 */
export async function pasteFromClipboard(): Promise<string | null> {
	const { transport, sshHost } = getClipboardTransportConfig();
	if (transport !== "ssh") return null;
	return await pasteFromClipboardViaSsh(sshHost);
}

// PowerShell one-liner that emits the clipboard image as base64-encoded PNG on
// stdout, or nothing when the clipboard does not hold image data. Used as the
// WSL bridge — arboard cannot read the Windows clipboard through WSLg.
const POWERSHELL_IMAGE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -ne $null) {
	$ms = New-Object System.IO.MemoryStream
	$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
	[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
}
`;

const POWERSHELL_TIMEOUT_MS = 8000;

/**
 * Read a clipboard image through the Windows host's PowerShell.
 *
 * WSLg exposes a Wayland socket but no native clipboard image transport, so
 * `arboard` returns `ContentNotAvailable`. PowerShell, reached via WSL interop,
 * can read the Windows clipboard directly and round-trip the bitmap as PNG.
 *
 * Returns null when no image is on the clipboard, the host PowerShell is
 * missing, or the bridge times out.
 */
async function readImageViaPowerShell(): Promise<ClipboardImage | null> {
	try {
		const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_IMAGE_SCRIPT], {
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
		});
		const timer = setTimeout(() => proc.kill(), POWERSHELL_TIMEOUT_MS);
		let stdout = "";
		try {
			stdout = await new Response(proc.stdout).text();
			await proc.exited;
		} catch (err) {
			// powershell.exe is a Windows process reached over WSL interop; if it
			// doesn't reap cleanly, swallow the error so the dispatcher can fall
			// through to the native bridge instead of throwing.
			logger.warn("clipboard: powershell read failed", { error: String(err) });
			return null;
		} finally {
			clearTimeout(timer);
		}
		if (proc.exitCode !== 0) return null;
		const b64 = stdout.trim();
		if (!b64) return null;
		const bytes = Buffer.from(b64, "base64");
		if (bytes.byteLength === 0) return null;
		return { data: new Uint8Array(bytes), mimeType: "image/png" };
	} catch {
		return null;
	}
}

/**
 * Read an image from the system clipboard.
 *
 * Returns null on Termux (no image clipboard support) or when no display
 * server is available (headless/SSH without forwarding). Under WSL the
 * Windows clipboard is reached through `powershell.exe`, since WSLg's
 * Wayland clipboard does not carry image payloads through to `arboard`.
 *
 * @returns PNG payload or null when no image is available.
 */
export async function readImageFromClipboard(): Promise<ClipboardImage | null> {
	if (process.env.TERMUX_VERSION) {
		return null;
	}

	if (isWsl()) {
		const image = await readImageViaPowerShell();
		if (image) return image;
		// Fall through: arboard may still succeed on a future WSLg release —
		// but only when we actually have a display server. Headless WSL has
		// no display, so arboard would reject anyway.
	}

	if (!hasDisplay()) {
		return null;
	}

	return (await nativeClipboard().readImageFromClipboard()) ?? null;
}
