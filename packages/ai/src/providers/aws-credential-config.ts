import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $credentialEnv } from "@gajae-code/utils";
import type { AwsCredentials } from "./aws-sigv4";

export type AwsIniFile = Record<string, Record<string, string>>;

export interface AwsCredentialSourceOptions {
	profile?: string;
}

export interface AwsCredentialSource {
	profile: string;
	credentialsPath: string;
	configPath: string;
}

export type AwsProfileCapability = "static" | "process" | "sso" | undefined;

const AVAILABILITY_CACHE_MAX_AGE_MS = 1_000;
const MAX_AWS_INI_FILE_BYTES = 1024 * 1024;

interface FileFingerprint {
	exists: boolean;
	size?: number;
	mtimeMs?: number;
	ctimeMs?: number;
	ino?: number;
}

interface AvailabilityCacheEntry {
	source: AwsCredentialSource;
	credentials: FileFingerprint;
	config: FileFingerprint;
	value: boolean;
	checkedAt: number;
}

let availabilityCache: AvailabilityCacheEntry | undefined;

export function parseAwsIni(text: string): AwsIniFile {
	const out: AwsIniFile = {};
	let current: Record<string, string> | undefined;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[") && line.endsWith("]")) {
			let name = line.slice(1, -1).trim();
			if (name.startsWith("profile ")) name = name.slice(8).trim();
			if (name.startsWith("sso-session ")) name = `sso-session:${name.slice(12).trim()}`;
			current = out[name] ??= {};
			continue;
		}
		if (!current) continue;
		const equals = line.indexOf("=");
		if (equals === -1) continue;
		const key = line.slice(0, equals).trim();
		const value = line.slice(equals + 1).trim();
		if (key) current[key] = value;
	}
	return out;
}

export function resolveAwsCredentialSource(options: AwsCredentialSourceOptions = {}): AwsCredentialSource {
	const profile = options.profile || $credentialEnv("AWS_PROFILE") || "default";
	const home = os.homedir();
	return {
		profile,
		credentialsPath: path.resolve(
			$credentialEnv("AWS_SHARED_CREDENTIALS_FILE") || path.join(home, ".aws", "credentials"),
		),
		configPath: path.resolve($credentialEnv("AWS_CONFIG_FILE") || path.join(home, ".aws", "config")),
	};
}

export function readAwsStaticEnvironmentCredentials(): AwsCredentials | undefined {
	const accessKeyId = $credentialEnv("AWS_ACCESS_KEY_ID");
	const secretAccessKey = $credentialEnv("AWS_SECRET_ACCESS_KEY");
	if (!accessKeyId || !secretAccessKey) return undefined;
	const sessionToken = $credentialEnv("AWS_SESSION_TOKEN");
	return sessionToken ? { accessKeyId, secretAccessKey, sessionToken } : { accessKeyId, secretAccessKey };
}

export function classifyAwsProfileCapability(
	profile: string,
	credentialsIni: AwsIniFile | undefined,
	configIni: AwsIniFile | undefined,
): AwsProfileCapability {
	const merged = { ...(configIni?.[profile] ?? {}), ...(credentialsIni?.[profile] ?? {}) };
	if (merged.aws_access_key_id && merged.aws_secret_access_key) return "static";
	if (merged.sso_account_id && merged.sso_role_name) {
		if (merged.sso_start_url && merged.sso_region) return "sso";
		const session = merged.sso_session ? configIni?.[`sso-session:${merged.sso_session}`] : undefined;
		if (session?.sso_start_url && session.sso_region) return "sso";
	}
	if (merged.credential_process) return "process";
	return undefined;
}

export function hasResolvableAwsProfileSource(
	options: AwsCredentialSourceOptions & { /** @internal Test-only cache scan observer. */ onScan?: () => void } = {},
	now = Date.now(),
): boolean {
	const source = resolveAwsCredentialSource(options);
	const credentials = fingerprint(source.credentialsPath);
	const config = fingerprint(source.configPath);
	if (
		availabilityCache &&
		now >= availabilityCache.checkedAt &&
		now - availabilityCache.checkedAt < AVAILABILITY_CACHE_MAX_AGE_MS &&
		sameSource(availabilityCache.source, source) &&
		sameFingerprint(availabilityCache.credentials, credentials) &&
		sameFingerprint(availabilityCache.config, config)
	) {
		return availabilityCache.value;
	}
	options.onScan?.();
	const credentialsIni = readAwsIniSync(source.credentialsPath);
	const configIni = readAwsIniSync(source.configPath);
	const value = classifyAwsProfileCapability(source.profile, credentialsIni, configIni) !== undefined;
	availabilityCache = { source, credentials, config, value, checkedAt: now };
	return value;
}

export function isValidBedrockBearerToken(token: string | undefined): token is string {
	if (!token) return false;
	return !/[\x00-\x1f\x7f]/.test(token);
}

function readAwsIniSync(filePath: string): AwsIniFile | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_AWS_INI_FILE_BYTES) return undefined;
		const contents = Buffer.allocUnsafe(MAX_AWS_INI_FILE_BYTES + 1);
		let bytesRead = 0;
		while (bytesRead < contents.length) {
			const count = fs.readSync(fd, contents, bytesRead, contents.length - bytesRead, bytesRead);
			if (count === 0) break;
			bytesRead += count;
		}
		if (bytesRead > MAX_AWS_INI_FILE_BYTES) return undefined;
		return parseAwsIni(contents.toString("utf8", 0, bytesRead));
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Ignore close errors because file availability has already been determined.
			}
		}
	}
}

function fingerprint(filePath: string): FileFingerprint {
	try {
		const stat = fs.statSync(filePath);
		return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
	} catch {
		return { exists: false };
	}
}

function sameSource(a: AwsCredentialSource, b: AwsCredentialSource): boolean {
	return a.profile === b.profile && a.credentialsPath === b.credentialsPath && a.configPath === b.configPath;
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
	return (
		a.exists === b.exists &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs &&
		a.ino === b.ino
	);
}
