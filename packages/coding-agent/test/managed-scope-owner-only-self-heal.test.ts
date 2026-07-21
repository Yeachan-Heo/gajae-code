import { afterEach, describe, expect, it } from "bun:test";
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
});

function resolveScope(cwd: string, agentDir: string, sessionsRoot: string) {
	const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
	if (resolved.kind !== "resolved") throw new Error(`resolve failed: ${resolved.code}`);
	return resolved.scope;
}

// A managed scope can accumulate group/other-readable descendants when another
// code path writes into it without the secured managed-storage helpers — notably
// the resident-cache EphemeralBlobStore created on the explicit session path.
// The strict managed-tree snapshot fails closed on the first such descendant with
// `mode_mismatch`, which previously aborted launch with an uncaught exception.
// Preparing the scope must re-secure the drifted tree in place and recover.
describe.skipIf(process.platform !== "linux")("managed scope owner-only self-heal", () => {
	it("re-secures a drifted (group/other-readable) descendant instead of failing closed", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-scope-heal-home-"));
		temporaryDirectories.push(home);
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-scope-heal-cwd-"));
		temporaryDirectories.push(cwd);

		const agentDir = path.join(home, "agent");
		const sessionsRoot = path.join(agentDir, "sessions");
		fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });

		// First launch succeeds and creates the v2 scope directory + binding.
		const first = prepareManagedSessionScopeForWriteSync(resolveScope(cwd, agentDir, sessionsRoot));
		expect(first.kind).toBe("resolved");
		const scopeDir = resolveScope(cwd, agentDir, sessionsRoot).directoryPath;

		// Simulate a foreign writer leaving a group/other-readable directory and
		// file under the managed scope (as the resident-cache blob store did).
		const driftDir = path.join(scopeDir, "resident-cache", "inst-1");
		fs.mkdirSync(driftDir, { recursive: true });
		const driftFile = path.join(driftDir, "blob");
		fs.writeFileSync(driftFile, "resident-cache blob");
		fs.chmodSync(path.join(scopeDir, "resident-cache"), 0o755);
		fs.chmodSync(driftDir, 0o755);
		fs.chmodSync(driftFile, 0o644);
		expect(fs.statSync(driftFile).mode & 0o077).not.toBe(0);
		expect(fs.statSync(driftDir).mode & 0o077).not.toBe(0);

		// Next launch must heal the drift and resolve rather than crash.
		const second = prepareManagedSessionScopeForWriteSync(resolveScope(cwd, agentDir, sessionsRoot));
		expect(second.kind).toBe("resolved");

		// Every drifted descendant is now owner-only.
		expect(fs.statSync(driftFile).mode & 0o077).toBe(0);
		expect(fs.statSync(driftDir).mode & 0o077).toBe(0);
		expect(fs.statSync(path.join(scopeDir, "resident-cache")).mode & 0o077).toBe(0);
	});
});
