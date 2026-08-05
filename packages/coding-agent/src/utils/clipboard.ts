import { execSync } from "node:child_process";
import type { ClipboardImage } from "@gajae-code/natives";
import type * as native from "@gajae-code/natives";

let nativeClipboardLoad: Promise<typeof import("@gajae-code/natives")> | undefined;

async function nativeClipboard(): Promise<typeof import("@gajae-code/natives")> {
	nativeClipboardLoad ??= Promise.resolve(require("@gajae-code/natives") as typeof import("@gajae-code/natives"));
	return await nativeClipboardLoad;
}
import { logger } from "@gajae-code/utils";

function hasDisplay(): boolean {
	return process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function isWsl(): boolean {
	return process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

/**
 * Copy text to the system clipboard.
 *
 * Emits OSC 52 first when running in a real terminal (works over SSH/mosh),
 * then attempts native clipboard copy as best-effort for local sessions.
 * On Termux, tries `termux-clipboard-set` before native.
 *
 * @param text - UTF-8 text to place on the clipboard.
 */
export async function copyToClipboard(text: string): Promise<void> {
	if (process.stdout.isTTY) {
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

	// Also try native tools (best effort for local sessions)
	try {
		if (process.env.TERMUX_VERSION) {
			try {
				execSync("termux-clipboard-set", { input: text, timeout: 5000 });
				return;
			} catch {
				// Fall through to native
			}
		}

		await (await nativeClipboard()).copyToClipboard(text);
	} catch {
		// Ignore — clipboard copy is best-effort
	}
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

	return (await (await nativeClipboard()).readImageFromClipboard()) ?? null;
}
