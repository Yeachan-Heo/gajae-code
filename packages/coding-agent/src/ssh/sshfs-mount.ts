import * as fs from "node:fs";
import * as path from "node:path";
import { getRemoteDir, postmortem } from "@gajae-code/utils";
import { $ } from "bun";
import {
	createSessionChildEnvironment,
	type SessionLaunchEnvironment,
	whichWithSessionEnvironment,
} from "../sdk/session-environment";
import {
	getControlDir,
	getControlPathTemplate,
	type SSHConnectionTarget,
	supportsSshControlMaster,
} from "./connection-manager";
import { buildSshTarget, sanitizeHostName } from "./utils";

const REMOTE_DIR = getRemoteDir();
const CONTROL_DIR = getControlDir();
const CONTROL_PATH = getControlPathTemplate();

const mountedPaths = new Map<string, SessionLaunchEnvironment | undefined>();

async function ensureDir(path: string, mode = 0o700): Promise<void> {
	try {
		await fs.promises.mkdir(path, { recursive: true, mode });
	} catch {
		await fs.promises.chmod(path, mode).catch(e => void e);
	}
}

function getMountName(host: SSHConnectionTarget): string {
	const raw = (host.name ?? host.host).trim();
	return sanitizeHostName(raw);
}

function getMountPath(host: SSHConnectionTarget): string {
	return path.join(REMOTE_DIR, getMountName(host));
}

function buildSshfsArgs(host: SSHConnectionTarget): string[] {
	const args = [
		"-o",
		"reconnect",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
		"-o",
		"BatchMode=yes",
		"-o",
		"StrictHostKeyChecking=accept-new",
	];

	if (supportsSshControlMaster()) {
		args.push("-o", "ControlMaster=auto", "-o", `ControlPath=${CONTROL_PATH}`, "-o", "ControlPersist=3600");
	}

	if (host.port) {
		args.push("-p", String(host.port));
	}

	if (host.keyPath) {
		args.push("-o", `IdentityFile=${host.keyPath}`);
	}

	return args;
}

async function runResolvedCommand(
	executable: string,
	args: string[],
	sessionEnvironment: SessionLaunchEnvironment | undefined,
	quiet: boolean,
) {
	const environment = createSessionChildEnvironment(sessionEnvironment);
	const shell = $`${executable} ${args}`;
	const command = environment === undefined ? shell : shell.env(environment);
	return quiet ? await command.quiet().nothrow() : await command.nothrow();
}

async function unmountPath(path: string, sessionEnvironment?: SessionLaunchEnvironment): Promise<boolean> {
	const fusermount =
		whichWithSessionEnvironment("fusermount", sessionEnvironment) ??
		whichWithSessionEnvironment("fusermount3", sessionEnvironment);
	if (fusermount) {
		const result = await runResolvedCommand(fusermount, ["-u", path], sessionEnvironment, true);
		if (result.exitCode === 0) return true;
	}

	const umount = whichWithSessionEnvironment("umount", sessionEnvironment);
	if (!umount) return false;
	const result = await runResolvedCommand(umount, [path], sessionEnvironment, true);
	return result.exitCode === 0;
}

export function hasSshfs(sessionEnvironment?: SessionLaunchEnvironment): boolean {
	return whichWithSessionEnvironment("sshfs", sessionEnvironment) !== null;
}

export async function isMounted(path: string, sessionEnvironment?: SessionLaunchEnvironment): Promise<boolean> {
	const mountpoint = whichWithSessionEnvironment("mountpoint", sessionEnvironment);
	if (!mountpoint) return false;
	const result = await runResolvedCommand(mountpoint, ["-q", path], sessionEnvironment, true);
	return result.exitCode === 0;
}

let registered = false;

export async function mountRemote(
	host: SSHConnectionTarget,
	remotePath = "/",
	sessionEnvironment?: SessionLaunchEnvironment,
): Promise<string | undefined> {
	const sshfs = whichWithSessionEnvironment("sshfs", sessionEnvironment);
	if (!sshfs) return undefined;

	const mountPath = getMountPath(host);
	await Promise.all([ensureDir(REMOTE_DIR), ensureDir(CONTROL_DIR), ensureDir(mountPath)]);

	if (await isMounted(mountPath, sessionEnvironment)) {
		if (!registered) {
			registered = true;
			postmortem.register("sshfs-cleanup", unmountAll);
		}
		mountedPaths.set(mountPath, sessionEnvironment);
		return mountPath;
	}

	const target = `${buildSshTarget(host.username, host.host)}:${remotePath}`;
	const args = buildSshfsArgs(host);
	const result = await runResolvedCommand(sshfs, [...args, target, mountPath], sessionEnvironment, false);

	if (result.exitCode !== 0) {
		const detail = result.stderr.toString().trim();
		const suffix = detail ? `: ${detail}` : "";
		throw new Error(`Failed to mount ${target}${suffix}`);
	}

	mountedPaths.set(mountPath, sessionEnvironment);
	return mountPath;
}

export async function unmountRemote(
	host: SSHConnectionTarget,
	sessionEnvironment?: SessionLaunchEnvironment,
): Promise<boolean> {
	const mountPath = getMountPath(host);
	const effectiveEnvironment = mountedPaths.get(mountPath) ?? sessionEnvironment;
	if (!(await isMounted(mountPath, effectiveEnvironment))) {
		mountedPaths.delete(mountPath);
		return false;
	}

	const success = await unmountPath(mountPath, effectiveEnvironment);
	if (success) {
		mountedPaths.delete(mountPath);
	}

	return success;
}

export async function unmountAll(): Promise<void> {
	for (const [mountPath, sessionEnvironment] of Array.from(mountedPaths.entries())) {
		await unmountPath(mountPath, sessionEnvironment);
	}
	mountedPaths.clear();
}
