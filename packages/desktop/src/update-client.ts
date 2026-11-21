import { invoke, isTauri } from "@tauri-apps/api/core";

export interface DesktopUpdateCheck {
	currentVersion: string;
	bundledGjcVersion: string;
	available: boolean;
	version?: string;
	reason?: string;
}

export async function checkDesktopUpdate(): Promise<DesktopUpdateCheck> {
	if (!isTauri()) throw new Error("Updates require the desktop app.");
	return invoke<DesktopUpdateCheck>("desktop_update_check");
}

export async function installDesktopUpdate(): Promise<void> {
	if (!isTauri()) throw new Error("Updates require the desktop app.");
	await invoke<void>("desktop_update_install");
}

export const desktopUpdateClient = {
	isNative: isTauri,
	check: checkDesktopUpdate,
	install: installDesktopUpdate,
};
