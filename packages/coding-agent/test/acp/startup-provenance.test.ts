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

	it("reports an unanswered capability query as unknown provenance, with the reason", () => {
		const error = provenanceFailure({
			capabilities: undefined,
			queryFailure: new Error("connection_closed"),
		});
		expect(error).toBeInstanceOf(AcpSdkAdapterError);
		expect(error.code).toBe("unavailable");
		expect(error.message).toContain(SESSION);
		expect(error.message).toContain("did not answer runtime.capabilities");
		expect(error.message).toContain("connection_closed");
		// The host answered nothing, so its build age is unproven and must not be asserted.
		expect(error.message).not.toContain("predates");
	});

	it("omits a reason when the query failed without one", () => {
		expect(provenanceFailure({ capabilities: undefined }).message).not.toContain("(");
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
