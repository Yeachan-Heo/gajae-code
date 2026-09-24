import { describe, expect, test } from "bun:test";
import {
	PUBLIC_COMMAND_DIAGNOSTICS,
	type PublicCommandErrorEnvelope,
	type PublicEffectProof,
	renderPublicCommandFailure,
} from "../src/cli/public-command-errors";
import { sdkPublicFailure } from "../src/sdk/cli/session-cli";

const command = ["sdk", "session", "query"] as const;

async function render(code: string, details?: unknown, proof?: PublicEffectProof) {
	return await renderPublicCommandFailure(sdkPublicFailure(code, details, proof), {
		command: [...command],
		json: true,
	});
}

function diagnosticCodes(envelope: PublicCommandErrorEnvelope): string[] {
	return (envelope.diagnostics ?? []).map(diagnostic => diagnostic.code);
}

describe("SDK session CLI resource_gone diagnostic", () => {
	test("attaches exactly one fixed diagnostic without changing the public classification", async () => {
		const control = await render("some_unmapped_host_code");
		const rendered = await render("resource_gone");

		expect(diagnosticCodes(control.envelope)).toEqual([]);
		expect(diagnosticCodes(rendered.envelope)).toEqual(["sdk_resource_gone"]);
		expect(rendered.envelope.diagnostics?.[0]?.message).toBe(PUBLIC_COMMAND_DIAGNOSTICS.sdk_resource_gone);
		expect(rendered.envelope.error.code).toBe(control.envelope.error.code);
		expect(rendered.envelope.error.category).toBe(control.envelope.error.category);
		expect(rendered.envelope.error.retryability).toBe(control.envelope.error.retryability);
		expect(rendered.envelope.error.outcomeCertainty).toBe(control.envelope.error.outcomeCertainty);
		expect(rendered.exitCode).toBe(control.exitCode);
		expect(rendered.envelope.error.nextSteps).toEqual(control.envelope.error.nextSteps);
		expect(rendered.envelope.omittedOptional).toEqual(control.envelope.omittedOptional);
		expect(rendered.envelope.complete).toBe(control.envelope.complete);
		expect(rendered.envelope.evidence).toEqual(control.envelope.evidence);
		expect(rendered.envelope.continuation).toEqual(control.envelope.continuation);
	});

	test("keeps the fixed wording cause-neutral and free of host-supplied text", async () => {
		const secret = "secret-host-detail";
		const rendered = await render("resource_gone", {
			sessionId: "session-1",
			message: secret,
			details: { endpoint: `https://${secret}.example`, token: secret },
			cause: secret,
		});

		expect(rendered.stdout).not.toContain(secret);
		expect(rendered.stderr).not.toContain(secret);
		const message = PUBLIC_COMMAND_DIAGNOSTICS.sdk_resource_gone;
		expect(message).not.toMatch(/restart|dead|closed|crash/i);
		expect(rendered.envelope.error.references).toContainEqual({ kind: "sessionId", value: "session-1" });
	});

	test("renders the fixed diagnostic on the text surface too", async () => {
		const rendered = await renderPublicCommandFailure(sdkPublicFailure("resource_gone"), {
			command: [...command],
		});

		expect(rendered.stderr + rendered.stdout).toContain(PUBLIC_COMMAND_DIAGNOSTICS.sdk_resource_gone);
	});

	test("never attaches the diagnostic to unknown or prototype-shaped codes", async () => {
		for (const code of ["unknown", "__proto__", "constructor", "toString", "resource_gone_", "Resource_Gone", ""]) {
			const rendered = await render(code);
			expect(diagnosticCodes(rendered.envelope)).toEqual([]);
		}
	});

	test("preserves the existing effect-proof matrix for resource_gone", async () => {
		const proofs: (PublicEffectProof | undefined)[] = [undefined, "pre-send", "sent", "accepted"];
		for (const proof of proofs) {
			const control = await render("some_unmapped_host_code", undefined, proof);
			const rendered = await render("resource_gone", undefined, proof);
			expect(rendered.envelope.error.outcomeCertainty).toBe(control.envelope.error.outcomeCertainty);
			expect(rendered.envelope.error.retryability).toBe(control.envelope.error.retryability);
			expect(diagnosticCodes(rendered.envelope)).toEqual(["sdk_resource_gone"]);
		}
	});

	test("never exceeds the 8192-byte output budget in either render mode", async () => {
		const cases = [
			undefined,
			{ sessionId: "session-1" },
			{ sessionId: "s".repeat(4_000), operationRef: "o".repeat(4_000) },
			{ sessionId: "s".repeat(9_000) },
		];
		for (const details of cases) {
			const failure = sdkPublicFailure("resource_gone", details);
			const json = await renderPublicCommandFailure(failure, { command: [...command], json: true });
			const text = await renderPublicCommandFailure(failure, { command: [...command] });
			expect(Buffer.byteLength(json.stdout)).toBeLessThanOrEqual(8192);
			expect(Buffer.byteLength(text.stderr)).toBeLessThanOrEqual(8192);
		}
	});

	test("drops the diagnostic at the omission boundary exactly like the existing optional-field contract", async () => {
		// Allowlisted references are what actually press the budget: four large ones
		// fill it, and the fifth is sized until the fixed diagnostic no longer fits
		// beside the retained references.
		const withSessionId = async (length: number, code: string) =>
			await render(code, {
				sessionId: "s".repeat(1_500),
				operationRef: "o".repeat(1_500),
				idempotencyKey: "i".repeat(1_500),
				claimId: "c".repeat(1_500),
				commandId: "m".repeat(length),
			});
		const dropped = async (length: number) =>
			(await withSessionId(length, "resource_gone")).envelope.diagnostics === undefined;

		expect(await dropped(1)).toBe(false);
		expect(await dropped(1_250)).toBe(true);
		let low = 1;
		let high = 1_250;
		while (high - low > 1) {
			const middle = Math.floor((low + high) / 2);
			if (await dropped(middle)) high = middle;
			else low = middle;
		}

		const lastFitting = await withSessionId(low, "resource_gone");
		expect(diagnosticCodes(lastFitting.envelope)).toEqual(["sdk_resource_gone"]);
		expect(Buffer.byteLength(lastFitting.stdout)).toBeLessThanOrEqual(8192);
		expect(Buffer.byteLength(lastFitting.stdout)).toBeGreaterThan(8192 - 256);
		expect(lastFitting.envelope.omittedOptional).not.toContainEqual({
			path: "diagnostics",
			reason: "output_budget",
		});

		const overBoundary = await withSessionId(high, "resource_gone");
		const control = await withSessionId(high, "some_unmapped_host_code");
		expect(overBoundary.envelope.diagnostics).toBeUndefined();
		expect(Buffer.byteLength(overBoundary.stdout)).toBeLessThanOrEqual(8192);
		expect(overBoundary.envelope.error.references.length).toBe(lastFitting.envelope.error.references.length);
		// The dropped diagnostic is reported through the existing optional-omission
		// contract, and nothing else in the envelope diverges from the control.
		expect(overBoundary.envelope.omittedOptional).toContainEqual({
			path: "diagnostics",
			reason: "output_budget",
		});
		expect(overBoundary.envelope.omittedOptional.filter(item => item.path !== "diagnostics")).toEqual(
			control.envelope.omittedOptional,
		);
		expect(overBoundary.envelope.error).toEqual(control.envelope.error);
		expect(overBoundary.envelope.complete).toBe(control.envelope.complete);
		expect(overBoundary.envelope.evidence).toEqual(control.envelope.evidence);
		expect(overBoundary.envelope.continuation).toEqual(control.envelope.continuation);
		expect(overBoundary.exitCode).toBe(control.exitCode);
	});

	test("keeps oversized host details out of the budgeted output entirely", async () => {
		const huge = "x".repeat(20_000);
		const control = await render("some_unmapped_host_code", { sessionId: "session-1", message: huge });
		const rendered = await render("resource_gone", { sessionId: "session-1", message: huge });

		expect(rendered.stdout).not.toContain(huge);
		expect(Buffer.byteLength(rendered.stdout)).toBeLessThanOrEqual(8192);
		expect(diagnosticCodes(rendered.envelope)).toEqual(["sdk_resource_gone"]);
		expect(rendered.envelope.omittedOptional).toEqual(control.envelope.omittedOptional);
		expect(rendered.envelope.complete).toBe(control.envelope.complete);
	});
});
