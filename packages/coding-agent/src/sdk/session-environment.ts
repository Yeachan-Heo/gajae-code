import { $which, getEnvValue } from "@gajae-code/utils";

export interface SessionLaunchEnvironment {
	readonly env?: Readonly<Record<string, string>>;
	readonly unsetEnv?: readonly string[];
}

export interface SessionEnvironmentNames {
	readonly set: string[];
	readonly unset: string[];
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_ENV_PREFIX = /^(?:GJC_|PI_|BUN_OPTIONS$|NODE_OPTIONS$|LD_|DYLD_)/iu;
const MAX_ENV_ENTRIES = 100;
const MAX_ENV_VALUE_LENGTH = 32_768;
const MAX_ENV_BYTES = 256 * 1024;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isValidEnvironmentName(name: string): boolean {
	return name.length <= 255 && ENV_NAME_PATTERN.test(name) && !RESERVED_ENV_PREFIX.test(name);
}

/** Validates caller-controlled session subprocess environment fields at the broker boundary. */
export function isValidSessionLaunchEnvironment(
	env: unknown,
	unsetEnv: unknown,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (env !== undefined && !isPlainRecord(env)) return false;
	if (unsetEnv !== undefined && !Array.isArray(unsetEnv)) return false;

	const setNames = new Set<string>();
	let totalBytes = 0;
	if (env !== undefined) {
		const entries = Object.entries(env);
		if (entries.length > MAX_ENV_ENTRIES) return false;
		for (const [name, value] of entries) {
			const normalizedName = platform === "win32" ? name.toUpperCase() : name;
			if (
				!isValidEnvironmentName(name) ||
				setNames.has(normalizedName) ||
				typeof value !== "string" ||
				value.length > MAX_ENV_VALUE_LENGTH ||
				value.includes("\0")
			)
				return false;
			setNames.add(normalizedName);
			totalBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
			if (totalBytes > MAX_ENV_BYTES) return false;
		}
	}
	if (unsetEnv !== undefined) {
		if (unsetEnv.length > MAX_ENV_ENTRIES) return false;
		const unsetNames = new Set<string>();
		for (const name of unsetEnv) {
			if (typeof name !== "string" || !isValidEnvironmentName(name)) return false;
			const normalizedName = platform === "win32" ? name.toUpperCase() : name;
			if (unsetNames.has(normalizedName) || setNames.has(normalizedName)) return false;
			unsetNames.add(normalizedName);
			totalBytes += Buffer.byteLength(name, "utf8");
			if (totalBytes > MAX_ENV_BYTES) return false;
		}
	}
	return true;
}

export function sessionLaunchEnvironment(env: unknown, unsetEnv: unknown): SessionLaunchEnvironment | undefined {
	if (!isValidSessionLaunchEnvironment(env, unsetEnv)) throw new Error("Session launch environment is invalid.");
	if (env === undefined && unsetEnv === undefined) return undefined;
	return {
		...(env === undefined ? {} : { env: Object.fromEntries(Object.entries(env as Record<string, string>)) }),
		...(unsetEnv === undefined ? {} : { unsetEnv: [...(unsetEnv as string[])] }),
	};
}

let currentProcessSessionEnvironment: SessionLaunchEnvironment | undefined;

export function setCurrentSessionLaunchEnvironment(environment: SessionLaunchEnvironment | undefined): void {
	currentProcessSessionEnvironment =
		environment === undefined ? undefined : sessionLaunchEnvironment(environment.env, environment.unsetEnv);
}

export function getCurrentSessionLaunchEnvironment(): SessionLaunchEnvironment | undefined {
	return currentProcessSessionEnvironment;
}

export function hasSessionPathOverride(
	environment: SessionLaunchEnvironment | undefined,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const isPathName = (name: string): boolean =>
		platform === "win32" ? name.toUpperCase() === "PATH" : name === "PATH";
	return Object.keys(environment?.env ?? {}).some(isPathName) || (environment?.unsetEnv ?? []).some(isPathName);
}

export function whichWithSessionEnvironment(
	command: string,
	launchEnvironment?: SessionLaunchEnvironment,
): string | null {
	if (!hasSessionPathOverride(launchEnvironment)) return $which(command);
	const environment = createSessionChildEnvironment(launchEnvironment);
	return $which(command, { PATH: environment === undefined ? "" : (getEnvValue(environment, "PATH") ?? "") });
}

/** Creates a child environment from the active session overlay, when one exists. */
export function createCurrentSessionChildEnvironment(): Record<string, string> | undefined {
	return createSessionChildEnvironment(currentProcessSessionEnvironment);
}

/** Creates an isolated child environment with the validated session overlay applied. */
export function createSessionChildEnvironment(
	launchEnvironment: SessionLaunchEnvironment | undefined,
	inheritedEnvironment: Record<string, string | undefined> = process.env,
): Record<string, string> | undefined {
	if (launchEnvironment === undefined) return undefined;
	const environment = Object.fromEntries(
		Object.entries(inheritedEnvironment).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	applySessionLaunchEnvironment(environment, launchEnvironment);
	return environment;
}

/** Applies the validated launch overlay to an isolated session environment map. */
export function applySessionLaunchEnvironment(
	environment: Record<string, string | undefined>,
	launchEnvironment: SessionLaunchEnvironment | undefined,
	platform: NodeJS.Platform = process.platform,
): void {
	if (!launchEnvironment) return;
	const deleteName = (name: string): void => {
		if (platform === "win32") {
			const normalizedName = name.toUpperCase();
			for (const existingName of Object.keys(environment)) {
				if (existingName.toUpperCase() === normalizedName) delete environment[existingName];
			}
		} else {
			delete environment[name];
		}
	};
	for (const name of launchEnvironment.unsetEnv ?? []) deleteName(name);
	for (const [name, value] of Object.entries(launchEnvironment.env ?? {})) {
		deleteName(name);
		Object.defineProperty(environment, name, { configurable: true, enumerable: true, value, writable: true });
	}
}

/** Names to mask from inherited environments before setting a session overlay. */
export function sessionLaunchEnvironmentUnsetNames(
	launchEnvironment: SessionLaunchEnvironment | undefined,
	inheritedEnvironment: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform,
): string[] {
	if (!launchEnvironment) return [];
	const names = [...Object.keys(launchEnvironment.env ?? {}), ...(launchEnvironment.unsetEnv ?? [])];
	if (platform !== "win32") return names;

	const inheritedNames = Object.keys(inheritedEnvironment);
	return [
		...new Set(
			names.flatMap(name => {
				const aliases = inheritedNames.filter(existingName => existingName.toUpperCase() === name.toUpperCase());
				return aliases.length > 0 ? aliases : [name];
			}),
		),
	];
}

export function sessionEnvironmentNames(environment: SessionLaunchEnvironment): SessionEnvironmentNames {
	return {
		set: Object.keys(environment.env ?? {}).sort(),
		unset: [...(environment.unsetEnv ?? [])].sort(),
	};
}
