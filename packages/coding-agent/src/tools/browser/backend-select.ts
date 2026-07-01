import { ASIDE_INSTALL_COMMAND, ASIDE_INSTALL_URL, type AsideCliProbe, probeAsideCli } from "./aside-cli";

/**
 * Backend-selection logic for the `/browser` selector, decoupled from TUI rendering
 * so it is unit-testable. The overlay renders `browserBackendOptions()` and drives
 * `applyBrowserBackendChange()`; nothing here touches the terminal directly.
 */

export type BrowserBackend = "native" | "aside";

export interface BrowserBackendOption {
	value: BrowserBackend;
	label: string;
	description: string;
	/** True when selecting this option runs against the user's live logged-in profile. */
	liveProfile: boolean;
}

/** Options to show in the selector. Aside is hidden entirely off macOS. */
export function browserBackendOptions(platform: NodeJS.Platform = process.platform): BrowserBackendOption[] {
	const options: BrowserBackendOption[] = [
		{
			value: "native",
			label: "Native (default)",
			description: "Managed headless/CDP Chromium. Isolated. All app.* modes.",
			liveProfile: false,
		},
	];
	if (platform === "darwin") {
		options.push({
			value: "aside",
			label: "Aside — live logged-in profile (macOS)",
			description: "Drives your real signed-in Aside browser via the Aside CLI. NOT isolated.",
			liveProfile: true,
		});
	}
	return options;
}

export interface ApplyBackendDeps {
	target: BrowserBackend;
	platform?: NodeJS.Platform;
	/** Read the current setting value. */
	getSetting: () => BrowserBackend;
	/** Persist the setting (only called after prerequisites pass). */
	setSetting: (value: BrowserBackend) => Promise<void> | void;
	/** Await the session-level browser restart (drops default-backend tabs). */
	restart: () => Promise<void>;
	/** Probe for the Aside CLI. Defaults to the real probe. */
	probe?: () => AsideCliProbe;
	/**
	 * Typed-confirmation in-app install. Returns true once the user typed the exact
	 * confirmation AND the install command succeeded. If omitted or it returns false,
	 * the setting is left unchanged. Never invoked without explicit confirmation.
	 */
	confirmInstall?: () => Promise<boolean>;
}

export type ApplyBackendResult =
	| { status: "unchanged"; reason: string }
	| { status: "install-required"; manualInstallCommand: string; url: string; searched: string[] }
	| { status: "switched"; backend: BrowserBackend }
	| { status: "error"; reason: string };

export interface BrowserBackendSelectorDeps extends Omit<ApplyBackendDeps, "target"> {
	select: (
		options: readonly BrowserBackendOption[],
		initialIndex: number,
		title: string,
	) => Promise<BrowserBackend | undefined>;
	showStatus: (message: string) => void;
}

function formatBrowserBackendSelectorTitle(current: BrowserBackend, platform: NodeJS.Platform): string {
	const lines = ["Browser backend selection", ""];
	lines.push("Native is isolated managed Chromium. Aside drives your live logged-in Aside browser profile.");
	if (platform !== "darwin") lines.push("Aside is macOS-only and is hidden on this platform.");
	lines.push("");
	lines.push(`Current backend: ${current}`);
	return lines.join("\n");
}

function formatApplyBackendResult(result: ApplyBackendResult): string {
	switch (result.status) {
		case "switched":
			return `Browser backend switched to '${result.backend}'. Default browser tabs were restarted.`;
		case "install-required":
			return [
				"Aside CLI is required before selecting the Aside backend.",
				`Install: ${result.manualInstallCommand}`,
				`Docs: ${result.url}`,
				`Searched: ${result.searched.join(", ")}`,
			].join("\n");
		case "unchanged":
			return result.reason;
		case "error":
			return `Browser backend change failed: ${result.reason}`;
	}
}

export async function runBrowserBackendSelector(
	deps: BrowserBackendSelectorDeps,
): Promise<ApplyBackendResult | undefined> {
	const platform = deps.platform ?? process.platform;
	const current = deps.getSetting();
	const options = browserBackendOptions(platform);
	const initialIndex = Math.max(
		0,
		options.findIndex(option => option.value === current),
	);
	const selected = await deps.select(options, initialIndex, formatBrowserBackendSelectorTitle(current, platform));
	if (!selected) return undefined;
	const result = await applyBrowserBackendChange({ ...deps, platform, target: selected });
	deps.showStatus(formatApplyBackendResult(result));
	return result;
}

/**
 * Apply a backend change with the secure-by-default installer policy:
 * - Aside off macOS is rejected.
 * - Missing Aside CLI defaults to manual instructions (no execution). An optional
 *   typed-confirmation install may run; the setting is NOT persisted until a
 *   re-probe succeeds.
 * - The setting is persisted only after prerequisites pass, then the awaited restart
 *   runs; if the restart throws (e.g. busy default tab), the setting is reverted.
 */
export async function applyBrowserBackendChange(deps: ApplyBackendDeps): Promise<ApplyBackendResult> {
	const platform = deps.platform ?? process.platform;
	const probe = deps.probe ?? probeAsideCli;
	const previous = deps.getSetting();

	if (deps.target === previous) {
		return { status: "unchanged", reason: `Browser backend is already '${deps.target}'.` };
	}

	if (deps.target === "aside") {
		if (platform !== "darwin") {
			return { status: "unchanged", reason: "The Aside backend is only supported on macOS." };
		}
		let result = probe();
		if (!result.ok) {
			// Secure default: do not execute anything unless the caller supplies a
			// confirmed install AND it re-probes successfully.
			if (!deps.confirmInstall) {
				return {
					status: "install-required",
					manualInstallCommand: ASIDE_INSTALL_COMMAND,
					url: ASIDE_INSTALL_URL,
					searched: result.searched,
				};
			}
			const confirmed = await deps.confirmInstall();
			if (!confirmed) {
				return {
					status: "install-required",
					manualInstallCommand: ASIDE_INSTALL_COMMAND,
					url: ASIDE_INSTALL_URL,
					searched: result.searched,
				};
			}
			result = probe();
			if (!result.ok) {
				return { status: "unchanged", reason: "Aside CLI still not found after install; setting unchanged." };
			}
		}
	}

	// Prerequisites passed — persist, then restart. Revert on restart failure.
	await deps.setSetting(deps.target);
	try {
		await deps.restart();
	} catch (err) {
		await deps.setSetting(previous);
		return { status: "error", reason: err instanceof Error ? err.message : String(err) };
	}
	return { status: "switched", backend: deps.target };
}
