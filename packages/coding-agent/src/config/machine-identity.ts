import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir } from "@gajae-code/utils";
import { $ } from "bun";

export interface MachineIdentityDeps {
	platform?: NodeJS.Platform;
	readFile?: (file: string) => Promise<string>;
	runCommand?: (
		command: string,
		args: readonly string[],
	) => { exitCode: number; stdout: Uint8Array } | Promise<{ exitCode: number; stdout: Uint8Array }>;
	installationSecret?: string;
	configRootDir?: string;
	link?: (existingPath: string, newPath: string) => Promise<void>;
}

function normalizedMachineIdentity(value: string, pattern: RegExp): string | undefined {
	const normalized = value.trim().toLowerCase();
	if (!pattern.test(normalized) || /^0+$/.test(normalized.replace(/-/g, ""))) return undefined;
	return normalized;
}

/** @internal */
export function parseWindowsMachineGuid(output: string): string | undefined {
	const match = /^\s*MachineGuid\s+REG_\w+\s+(\S+)\s*$/im.exec(output);
	return match
		? normalizedMachineIdentity(match[1], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
		: undefined;
}

/** @internal */
export function parseMacPlatformUuid(output: string): string | undefined {
	const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output);
	return match
		? normalizedMachineIdentity(match[1], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
		: undefined;
}

async function loadInstallationSecret(deps: MachineIdentityDeps): Promise<string> {
	const directory = deps.configRootDir ?? getConfigRootDir();
	const file = path.join(directory, "machine-identity.secret");
	const link = deps.link ?? fs.link;
	const syncDirectory = async (): Promise<void> => {
		if ((deps.platform ?? process.platform) === "win32") return;
		const handle = await fs.open(directory, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	};
	const writeSecretExclusive = async (target: string, secret: string): Promise<void> => {
		const handle = await fs.open(target, "wx", 0o600);
		try {
			await handle.writeFile(`${secret}\n`, "utf8");
			await handle.chmod(0o600);
			await handle.sync();
		} finally {
			await handle.close();
		}
	};
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	await fs.chmod(directory, 0o700);
	let unsettledReads = 0;
	for (;;) {
		try {
			const before = await fs.lstat(file);
			if (!before.isFile() || before.isSymbolicLink())
				throw new Error(`installation identity secret is not a regular file at ${file}`);
			const handle = await fs.open(file, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
			let secret: string;
			try {
				const stat = await handle.stat();
				if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino)
					throw new Error(`installation identity secret changed while opening at ${file}`);
				await handle.chmod(0o600);
				secret = (await handle.readFile("utf8")).trim();
			} finally {
				await handle.close();
			}
			if (/^[0-9a-f]{64}$/.test(secret)) return secret;
			if (unsettledReads++ < 4) {
				await Bun.sleep(10);
				continue;
			}
			throw new Error(`installation identity secret is malformed at ${file}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		const secret = crypto.randomBytes(32).toString("hex");
		const temporary = path.join(directory, `.machine-identity.secret-${crypto.randomBytes(16).toString("hex")}`);
		try {
			await writeSecretExclusive(temporary, secret);
			try {
				await link(temporary, file);
				await syncDirectory();
				return secret;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "EEXIST") continue;
				if (!["EPERM", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(code ?? "")) throw error;
				try {
					await writeSecretExclusive(file, secret);
					await syncDirectory();
					return secret;
				} catch (writeError) {
					if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
				}
			}
		} finally {
			await fs.rm(temporary, { force: true });
		}
	}
}

function hashMachineIdentity(rawId: string, installationSecret: string): string {
	return crypto
		.createHmac("sha256", Buffer.from(installationSecret, "hex"))
		.update("gajae-code:machine-identity:v2\0")
		.update(rawId)
		.digest("hex");
}

function legacyMachineIdentity(rawId: string): string {
	return crypto
		.createHash("sha256")
		.update("gajae-code:telegram-daemon:machine-identity:v1\0")
		.update(rawId)
		.digest("hex");
}

async function loadRawMachineIdentity(deps: MachineIdentityDeps): Promise<string> {
	const platform = deps.platform ?? process.platform;
	const readFile = deps.readFile ?? (async (file: string) => await fs.readFile(file, "utf8"));
	const runCommand =
		deps.runCommand ??
		(async (command: string, args: readonly string[]) => {
			const result = await $`${command} ${[...args]}`.quiet().nothrow();
			return { stdout: result.bytes(), exitCode: result.exitCode };
		});

	let rawId: string | undefined;
	if (platform === "linux") {
		for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
			try {
				const value = normalizedMachineIdentity(await readFile(file), /^[0-9a-f]{32}$/);
				if (!value) continue;
				rawId = value;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	} else if (platform === "win32") {
		const result = await runCommand("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
		if (result.exitCode === 0) rawId = parseWindowsMachineGuid(new TextDecoder().decode(result.stdout));
	} else if (platform === "darwin") {
		const result = await runCommand("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
		if (result.exitCode === 0) rawId = parseMacPlatformUuid(new TextDecoder().decode(result.stdout));
	} else {
		throw new Error(`machine-local identity is unsupported on ${platform}`);
	}

	if (!rawId) throw new Error("machine-local identity is unavailable or malformed");
	return rawId;
}

/** Loads a verified machine-local identity without persisting the underlying machine ID. */
export async function loadInstallationHostId(deps: MachineIdentityDeps = {}): Promise<string> {
	const rawId = await loadRawMachineIdentity(deps);
	const installationSecret = deps.installationSecret ?? (await loadInstallationSecret(deps));
	if (!/^[0-9a-f]{64}$/.test(installationSecret)) throw new Error("installation identity secret is malformed");
	return hashMachineIdentity(rawId, installationSecret);
}

/** @internal Recognizes owner records written before installation-keyed identities. */
export async function loadLegacyInstallationHostId(deps: MachineIdentityDeps = {}): Promise<string> {
	return legacyMachineIdentity(await loadRawMachineIdentity(deps));
}
