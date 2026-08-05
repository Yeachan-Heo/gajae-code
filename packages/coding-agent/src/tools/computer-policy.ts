/** Dependency-free computer capability policy shared by the registry and implementation. */

export interface ComputerSettingsSource {
	settings: {
		get(key: string): unknown;
		has(key: string): boolean;
	};
}

let platformOverrideForTests: NodeJS.Platform | undefined;
let archOverrideForTests: NodeJS.Architecture | undefined;

export function setComputerPlatformForTests(platform: NodeJS.Platform | undefined): void {
	platformOverrideForTests = platform;
}

export function setComputerArchForTests(arch: NodeJS.Architecture | undefined): void {
	archOverrideForTests = arch;
}

export function currentComputerPlatform(): NodeJS.Platform {
	return platformOverrideForTests ?? process.platform;
}

export function currentComputerArch(): NodeJS.Architecture {
	return archOverrideForTests ?? process.arch;
}

export function isComputerSupportedPlatform(
	platform: NodeJS.Platform = currentComputerPlatform(),
	arch: NodeJS.Architecture = currentComputerArch(),
): boolean {
	return platform === "darwin" && arch === "arm64";
}

/** Whether the capability is listable on this host. Windows is the only excluded platform. */
export function isComputerLoadablePlatform(platform: NodeJS.Platform = process.platform): boolean {
	return platform !== "win32";
}

export function isComputerEnabled(session: ComputerSettingsSource): boolean {
	if (session.settings.get("computer.enabled")) return true;
	if (session.settings.has("computer.enabled")) return false;
	if (session.settings.has("computer.alwaysOn")) return Boolean(session.settings.get("computer.alwaysOn"));
	return true;
}

export function isComputerCallable(
	session: ComputerSettingsSource,
	platform: NodeJS.Platform = currentComputerPlatform(),
	arch: NodeJS.Architecture = currentComputerArch(),
): boolean {
	return isComputerSupportedPlatform(platform, arch) && isComputerEnabled(session);
}
