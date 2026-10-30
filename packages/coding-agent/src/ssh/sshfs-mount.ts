import * as fs from "node:fs";
import * as path from "node:path";
import { $which, getRemoteDir, postmortem } from "@gajae-code/utils";
import { $ } from "bun";
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

const mountedPaths = new Set<string>();

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

async function unmountPath(path: string): Promise<boolean> {
	const fusermount = $which("fusermount") ?? $which("fusermount3");
	if (fusermount) {
		const result = await $`${fusermount} -u ${path}`.quiet().nothrow();
		if (result.exitCode === 0) return true;
	}

	const umount = $which("umount");
	if (!umount) return false;
	const result = await $`${umount} ${path}`.quiet().nothrow();
	return result.exitCode === 0;
}

export function hasSshfs(): boolean {
	return $which("sshfs") !== null;
}

export async function isMounted(path: string): Promise<boolean> {
	const mountpoint = $which("mountpoint");
	if (!mountpoint) return false;
	const result = await $`${mountpoint} -q ${path}`.quiet().nothrow();
	return result.exitCode === 0;
}

let registered = false;

export async function mountRemote(host: SSHConnectionTarget, remotePath = "/"): Promise<string | undefined> {
	if (!hasSshfs()) return undefined;

	const mountPath = getMountPath(host);
	await Promise.all([ensureDir(REMOTE_DIR), ensureDir(CONTROL_DIR), ensureDir(mountPath)]);

	if (await isMounted(mountPath)) {
		if (!registered) {
			registered = true;
			postmortem.register("sshfs-cleanup", unmountAll);
		}
		mountedPaths.add(mountPath);
		return mountPath;
	}

	const target = `${buildSshTarget(host.username, host.host)}:${remotePath}`;
	const args = buildSshfsArgs(host);
	const result = await $`sshfs ${args} ${target} ${mountPath}`.nothrow();

	if (result.exitCode !== 0) {
		const detail = result.stderr.toString().trim();
		const suffix = detail ? `: ${detail}` : "";
		throw new Error(`Failed to mount ${target}${suffix}`);
	}

	mountedPaths.add(mountPath);
	return mountPath;
}

export async function unmountRemote(host: SSHConnectionTarget): Promise<boolean> {
	const mountPath = getMountPath(host);
	if (!(await isMounted(mountPath))) {
		mountedPaths.delete(mountPath);
		return false;
	}

	const success = await unmountPath(mountPath);
	if (success) {
		mountedPaths.delete(mountPath);
	}

	return success;
}

export async function unmountAll(): Promise<void> {
	for (const mountPath of Array.from(mountedPaths)) {
		await unmountPath(mountPath);
	}
	mountedPaths.clear();
}
