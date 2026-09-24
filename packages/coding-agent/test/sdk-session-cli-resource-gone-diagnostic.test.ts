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

	test("keeps the bounded output budget and omission behavior under oversized details", async () => {
		const huge = "x".repeat(20_000);
		const control = await render("some_unmapped_host_code", { sessionId: "session-1", message: huge });
		const rendered = await render("resource_gone", { sessionId: "session-1", message: huge });

		expect(rendered.stdout).not.toContain(huge);
		expect(rendered.stdout.length).toBeLessThanOrEqual(8192 + PUBLIC_COMMAND_DIAGNOSTICS.sdk_resource_gone.length);
		expect(rendered.envelope.omittedOptional).toEqual(control.envelope.omittedOptional);
		expect(rendered.envelope.complete).toBe(control.envelope.complete);
	});
});
