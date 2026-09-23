import { describe, expect, it } from "bun:test";
import { resolveStartupProvenance } from "../../src/modes/acp/startup-provenance";
import { AcpSdkAdapterError } from "../../src/sdk/acp";

const SESSION = "session-42";

function provenanceFailure(input: { capabilities: Record<string, unknown> | undefined; queryFailure?: unknown }) {
	try {
		resolveStartupProvenance({ sessionId: SESSION, ...input, queryFailure: input.queryFailure });
	} catch (error) {
		return error as AcpSdkAdapterError;
	}
	throw new Error("resolveStartupProvenance resolved a provenance it should have refused.");
}

describe("resolveStartupProvenance", () => {
	it("returns the surface a provenance-carrying host reports", () => {
		for (const surface of ["cli", "sdk"] as const) {
			expect(
				resolveStartupProvenance({
					sessionId: SESSION,
					capabilities: { promptTerminalOutcomeVersion: 1, primaryControlSurface: surface },
					queryFailure: undefined,
				}),
			).toBe(surface);
		}
	});

	it("maps known query failure codes to fixed safe categories", () => {
		const failures = [
			{ code: "connection_closed", label: "connection closed" },
			{ code: "timeout", label: "query timed out" },
			{ code: "uncertain_after_send", label: "query outcome uncertain" },
		] as const;
		const secretDetails =
			"token=sk-secret path=/private/alice/.ssh/config host-id=host-private pid=48102 errno=EACCES";
		for (const { code, label } of failures) {
			const error = provenanceFailure({
				capabilities: undefined,
				queryFailure: Object.assign(new Error(secretDetails), { code }),
			});
			expect(error).toBeInstanceOf(AcpSdkAdapterError);
			expect(error.code).toBe("unavailable");
			expect(error.message).toContain(SESSION);
			expect(error.message).toContain("did not answer runtime.capabilities");
			expect(error.message).toEndWith(`(${label}).`);
			expect(error.message).not.toContain(secretDetails);
			expect(error.message).not.toContain(code);
			// The host answered nothing, so its build age is unproven and must not be asserted.
			expect(error.message).not.toContain("predates");
		}
	});

	it("uses a fixed generic category for unknown failures without exposing details", () => {
		const secretMessage =
			"token=sk-secret path=/private/alice/.ssh/config host-id=host-private pid=48102 errno=EACCES";
		const secretStringification = "stringified secret at /private/alice/.ssh/config";
		const error = provenanceFailure({
			capabilities: undefined,
			queryFailure: {
				code: "host_private_failure_42",
				message: secretMessage,
				toString: () => secretStringification,
			},
		});
		expect(error.code).toBe("unavailable");
		expect(error.message).toEndWith("(query failed).");
		expect(error.message).not.toContain("host_private_failure_42");
		expect(error.message).not.toContain(secretMessage);
		expect(error.message).not.toContain(secretStringification);
	});

	it("omits a reason when the query failed without one", () => {
		const error = provenanceFailure({ capabilities: undefined });
		expect(error.message).toEndWith("provenance is unknown.");
	});

	it("names the live outdated host, and that upgrading the client does not fix it", () => {
		const error = provenanceFailure({ capabilities: { hostTools: false } });
		expect(error.code).toBe("unavailable");
		expect(error.message).toContain("predates startup control provenance");
		expect(error.message).toContain("stop it");
	});

	it("refuses a half-answered provenance rather than defaulting the missing half", () => {
		// Defaulting either field would hand ACP the permission/lifecycle authority that
		// #5411's gate exists to withhold from a host of unknown origin.
		expect(provenanceFailure({ capabilities: { primaryControlSurface: "sdk" } }).code).toBe("unavailable");
		expect(provenanceFailure({ capabilities: { promptTerminalOutcomeVersion: 1 } }).code).toBe("unavailable");
		expect(
			provenanceFailure({ capabilities: { promptTerminalOutcomeVersion: 2, primaryControlSurface: "sdk" } }).code,
		).toBe("unavailable");
		expect(
			provenanceFailure({ capabilities: { promptTerminalOutcomeVersion: 1, primaryControlSurface: "terminal" } })
				.code,
		).toBe("unavailable");
	});
});
