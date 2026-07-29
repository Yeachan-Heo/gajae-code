import { describe, expect, it } from "bun:test";
import {
	ManagedSessionScopeStartupError,
	type SessionManagerRevisionSnapshot,
	toSessionManagerCheckpointRevisionStrings,
} from "../../src/session/session-manager";

describe("toSessionManagerCheckpointRevisionStrings", () => {
	it("converts every revision to a canonical decimal string", () => {
		const snapshot: SessionManagerRevisionSnapshot = {
			entry: 0,
			leaf: 1,
			headerExport: 2,
			label: 3,
			replayMetadata: 4,
		};
		expect(toSessionManagerCheckpointRevisionStrings(snapshot)).toEqual({
			entry: "0",
			leaf: "1",
			headerExport: "2",
			label: "3",
			replayMetadata: "4",
		});
	});

	it("rejects negative and unsafe revision values before serialization", () => {
		expect(() =>
			toSessionManagerCheckpointRevisionStrings({
				entry: -1,
				leaf: 1,
				headerExport: 2,
				label: 3,
				replayMetadata: 4,
			}),
		).toThrow("invalid_session_manager_revision:entry");
		expect(() =>
			toSessionManagerCheckpointRevisionStrings({
				entry: Number.MAX_SAFE_INTEGER + 1,
				leaf: 1,
				headerExport: 2,
				label: 3,
				replayMetadata: 4,
			}),
		).toThrow("invalid_session_manager_revision:entry");
	});
});
describe("managed session scope startup diagnostics", () => {
	const failure = (classification: string, diagnostic = "C:\\Users\\alice\\secret\\sessions") => ({
		kind: "error" as const,
		code: "binding_invalid" as const,
		message: "internal failure",
		cause: { classification, diagnostic },
	});

	it("maps Windows access-denied failures to safe token and user-owned-directory recovery", () => {
		const error = new ManagedSessionScopeStartupError("prepare", failure("EACCES"), "win32");
		expect(error.message).toContain("different token (including Administrator)");
		expect(error.message).toContain("user-owned");
		expect(error.message).not.toContain("icacls");
		expect(error.message).not.toContain("Everyone");
		expect(new ManagedSessionScopeStartupError("prepare", failure("EPERM"), "win32").message).toBe(error.message);
	});

	it("maps Windows owner, ACL, and path-identity failures without exposing diagnostics", () => {
		expect(new ManagedSessionScopeStartupError("prepare", failure("owner_mismatch"), "win32").message).toContain(
			"owner-only permissions",
		);
		expect(new ManagedSessionScopeStartupError("prepare", failure("acl_verify_failed"), "win32").message).toContain(
			"do not weaken its ACL",
		);
		expect(new ManagedSessionScopeStartupError("prepare", failure("reparse_point"), "win32").message).toContain(
			"junction, symlink, or replaced directory",
		);
		expect(new ManagedSessionScopeStartupError("prepare", failure("identity_mismatch"), "win32").message).toContain(
			"without reparse points",
		);
	});

	it("uses a bounded redacted Windows fallback with classification-only public cause", () => {
		const error = new ManagedSessionScopeStartupError("resolve", failure("unexpected_native_failure"), "win32");
		expect(error.message).toContain("could not safely verify");
		expect(error.message).not.toContain("C:\\Users\\alice");
		expect(error.cause).toEqual({ classification: "unexpected_native_failure" });
	});

	it("preserves the generic startup message on non-Windows platforms", () => {
		const error = new ManagedSessionScopeStartupError("resolve", failure("EACCES"), "linux");
		expect(error.message).toBe("Could not resolve managed session scope.");
	});
});
