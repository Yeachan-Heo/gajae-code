import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
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

function fixture(): { cwd: string; agentDir: string; sessionsRoot: string } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-scope-capacity-home-"));
	temporaryDirectories.push(home);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-scope-capacity-cwd-"));
	temporaryDirectories.push(cwd);
	const agentDir = path.join(home, "agent");
	const sessionsRoot = path.join(agentDir, "sessions");
	fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
	return { cwd, agentDir, sessionsRoot };
}

function scopeFor(input: { cwd: string; agentDir: string; sessionsRoot: string }) {
	const resolved = resolveManagedScope(input);
	if (resolved.kind !== "resolved") throw new Error(`resolve failed: ${resolved.code}`);
	return resolved.scope;
}

// A managed scope grows past the native tree-snapshot budget purely from GJC's
// own session artifacts (tool logs, subagent transcripts). The snapshot then
// fails with `content_too_large`, which the resolver used to collapse into
// `binding_invalid` — reporting a corrupt binding for a scope whose binding is
// byte-for-byte canonical, and sending operators to delete a healthy file.
describe.skipIf(process.platform !== "linux")("managed scope capacity classification", () => {
	it("reports an over-budget tree as capacity_exceeded, not binding_invalid", () => {
		const input = fixture();

		// First prepare succeeds and writes a canonical binding.
		expect(prepareManagedSessionScopeForWriteSync(scopeFor(input)).kind).toBe("resolved");

		// The next prepare hits the native tree budget.
		vi.spyOn(native, "openRecoveryFsRoot").mockImplementation(() => {
			throw new Error("content_too_large");
		});

		const result = prepareManagedSessionScopeForWriteSync(scopeFor(input));
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.code).toBe("capacity_exceeded");
		// The operator-visible message must name the real failure so it does not
		// read as binding corruption.
		expect(result.message).toBe("content_too_large");
	});

	it("still classifies a genuinely unrecognized failure as binding_invalid", () => {
		const input = fixture();
		expect(prepareManagedSessionScopeForWriteSync(scopeFor(input)).kind).toBe("resolved");

		vi.spyOn(native, "openRecoveryFsRoot").mockImplementation(() => {
			throw new Error("some_unmapped_native_failure");
		});

		const result = prepareManagedSessionScopeForWriteSync(scopeFor(input));
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.code).toBe("binding_invalid");
	});

	// `migration_busy` is in the shared managedScopeFailureCodes set but was
	// missing from two of the three hand-copied classification arms, so the same
	// failure produced different codes depending on which arm observed it.
	it("preserves migration_busy from every classification path", () => {
		const input = fixture();
		expect(prepareManagedSessionScopeForWriteSync(scopeFor(input)).kind).toBe("resolved");

		vi.spyOn(native, "openRecoveryFsRoot").mockImplementation(() => {
			throw new Error("migration_busy");
		});

		const result = prepareManagedSessionScopeForWriteSync(scopeFor(input));
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.code).toBe("migration_busy");
	});
});
