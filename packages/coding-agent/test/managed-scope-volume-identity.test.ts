import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	prepareManagedSessionScopeForWriteSync,
	resolveManagedScope,
} from "../src/session/internal/managed-session-scope";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

function preparedScope() {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-scope-volume-home-"));
	temporaryDirectories.push(home);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-scope-volume-cwd-"));
	temporaryDirectories.push(cwd);
	const agentDir = path.join(home, "agent");
	const sessionsRoot = path.join(agentDir, "sessions");
	fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
	const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
	if (resolved.kind !== "resolved") throw new Error(`resolve failed: ${resolved.code}`);
	expect(prepareManagedSessionScopeForWriteSync(resolved.scope).kind).toBe("resolved");
	return resolved.scope;
}

function moveScopeDirectory(directoryPath: string, shift: { dev?: bigint; ino?: bigint }) {
	const lstatSync = fs.lstatSync;
	vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
		const stat = lstatSync(target, options) as fs.BigIntStats;
		if (path.resolve(String(target)) !== path.resolve(directoryPath) || typeof stat.dev !== "bigint") return stat;
		return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
			dev: stat.dev + (shift.dev ?? 0n),
			ino: stat.ino + (shift.ino ?? 0n),
		});
	}) as typeof fs.lstatSync);
}

// A remount, drive-letter change or volume-serial change keeps the inode but
// moves `dev` (#6750). The scope is still refused; the report must say why.
describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("managed scope volume identity", () => {
	it("names a same-inode directory on a different volume instead of a generic setup failure", () => {
		const scope = preparedScope();
		moveScopeDirectory(scope.directoryPath, { dev: 1n });

		const result = prepareManagedSessionScopeForWriteSync(scope);
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.message).toBe("volume_identity_changed");
		expect(result.cause?.diagnostic).toBe("prepare:retained_identity");
	});

	it("keeps reporting a replaced directory as a setup failure", () => {
		const scope = preparedScope();
		moveScopeDirectory(scope.directoryPath, { ino: 1n });

		const result = prepareManagedSessionScopeForWriteSync(scope);
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.message).toBe("Managed write protocol setup failed.");
	});
});
