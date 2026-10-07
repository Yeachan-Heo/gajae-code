import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	PUBLIC_COMMAND_DIAGNOSTICS,
	type PublicCommandErrorEnvelope,
	PublicCommandFailure,
	renderPublicCommandFailure,
} from "../src/cli/public-command-errors";
import * as brokerEnsure from "../src/sdk/broker/ensure";
import { runSdkSessionCli, sdkPublicFailure } from "../src/sdk/cli/session-cli";
import { SdkClientError } from "../src/sdk/client";
import { SessionRouter } from "../src/sdk/router";

const BUSY_MESSAGE = "turn.prompt is unavailable while the agent is busy; use turn.steer explicitly.";

function diagnosticCodes(envelope: PublicCommandErrorEnvelope): string[] {
	return (envelope.diagnostics ?? []).map(diagnostic => diagnostic.code);
}

function stepArgv(envelope: PublicCommandErrorEnvelope): (string[] | undefined)[] {
	return envelope.error.nextSteps.map(step => step.argv);
}

describe("sdk session CLI keeps definite rejection codes", () => {
	const restores: Array<{ mockRestore(): void }> = [];
	afterEach(() => {
		for (const spy of restores.splice(0)) spy.mockRestore();
	});

	function routeSendTo(response: (frame: Record<string, unknown>) => Promise<unknown>): string[] {
		const operations: string[] = [];
		restores.push(
			spyOn(brokerEnsure, "ensureBroker").mockResolvedValue({} as never),
			spyOn(SessionRouter.prototype, "start").mockResolvedValue(undefined),
			spyOn(SessionRouter.prototype, "stop").mockResolvedValue(undefined),
			spyOn(SessionRouter.prototype, "attachment").mockReturnValue({ generation: 1 } as never),
			spyOn(SessionRouter.prototype, "request").mockImplementation(async (_sessionId, frame) => {
				operations.push(String(frame.operation ?? frame.query));
				return (await response(frame as Record<string, unknown>)) as never;
			}),
		);
		return operations;
	}

	async function sendFailure(): Promise<PublicCommandFailure> {
		const outputs: unknown[] = [];
		const error = await runSdkSessionCli(
			{ action: "send", sessionId: "session-busy", text: "correction", agentDir: "/tmp/gjc-busy-agent", json: true },
			value => outputs.push(value),
		).catch(caught => caught);
		expect(outputs).toEqual([]);
		expect(error).toBeInstanceOf(PublicCommandFailure);
		return error as PublicCommandFailure;
	}

	for (const shape of ["thrown", "response"] as const) {
		test(`send to a busy session reports a not-applied busy refusal (${shape})`, async () => {
			const operations = routeSendTo(async () => {
				if (shape === "thrown")
					throw new SdkClientError("busy", BUSY_MESSAGE, { code: "busy", message: BUSY_MESSAGE });
				return { ok: false, error: { code: "busy", message: BUSY_MESSAGE } };
			});
			const error = await sendFailure();
			expect(operations).toEqual(["turn.prompt"]);
			expect(error.input).toMatchObject({ kind: "busy", proof: "pre-effect" });

			const rendered = await renderPublicCommandFailure(error, {
				command: ["sdk", "session", "send"],
				json: true,
			});
			expect(rendered.exitCode).toBe(1);
			expect(rendered.envelope.error).toMatchObject({
				code: "busy",
				category: "unavailable",
				outcomeCertainty: "not-applied",
				retryability: "yes",
			});
			// The refused prompt has no operation record, so a status reconcile step would only say unknown.
			expect(stepArgv(rendered.envelope)).toEqual([["sdk", "session", "inspect", "session-busy"]]);
			expect(rendered.envelope.error.nextSteps[0]?.description).toContain("turn.steer");
			expect(rendered.stdout).not.toContain(BUSY_MESSAGE);
		});
	}

	test("a send failure after acceptance keeps applied wait semantics", async () => {
		routeSendTo(async frame => {
			if (frame.type === "control_request") return { ok: true, result: { accepted: true } };
			throw new SdkClientError("busy", BUSY_MESSAGE);
		});
		const outputs: unknown[] = [];
		const error = await runSdkSessionCli(
			{
				action: "send",
				sessionId: "session-busy",
				text: "correction",
				wait: true,
				timeoutMs: 5_000,
				agentDir: "/tmp/gjc-busy-agent",
				json: true,
			},
			value => outputs.push(value),
		).catch(caught => caught);
		expect(error).toBeInstanceOf(PublicCommandFailure);
		expect((error as PublicCommandFailure).input).toMatchObject({ kind: "busy", proof: "accepted" });
		const rendered = await renderPublicCommandFailure(error, { command: ["sdk", "session", "send"], json: true });
		expect(rendered.envelope.error.outcomeCertainty).toBe("applied");
	});

	test("busy without effect proof stays unknown and keeps reconciliation guidance", async () => {
		const rendered = await renderPublicCommandFailure(
			sdkPublicFailure("busy", { sessionId: "session-1", operationRef: "op-1" }),
			{ command: ["sdk", "session", "raw", "control"], json: true },
		);
		expect(rendered.envelope.error).toMatchObject({
			code: "busy",
			outcomeCertainty: "unknown",
			retryability: "unknown",
		});
		expect(stepArgv(rendered.envelope)).toContainEqual(["sdk", "session", "status", "session-1", "op-1"]);
	});

	test("raw control with an unknown op id is a usage error with fixed op-id guidance", async () => {
		const error = await runSdkSessionCli(
			{
				action: "raw",
				rawAction: "control",
				sessionId: "session-1",
				operation: "session.steer",
				jsonInput: JSON.stringify({ text: "x" }),
				idempotencyKey: "steer-1",
				json: true,
			},
			() => {},
		).catch(caught => caught);
		const rendered = await renderPublicCommandFailure(error, {
			command: ["sdk", "session", "raw", "control"],
			json: true,
		});
		expect(rendered.exitCode).toBe(2);
		expect(rendered.envelope.error).toMatchObject({
			code: "usage",
			outcomeCertainty: "not-applied",
			retryability: "no",
		});
		expect(diagnosticCodes(rendered.envelope)).toEqual(["sdk_unknown_operation"]);
		expect(PUBLIC_COMMAND_DIAGNOSTICS.sdk_unknown_operation).toContain("turn.steer");
	});

	test("a repository-scoped list outside Git is a usage error with scope guidance", async () => {
		const rendered = await renderPublicCommandFailure(
			sdkPublicFailure("not_a_repository", { message: "/private/outside/path" }),
			{ command: ["sdk", "session", "list"], json: true },
		);
		expect(rendered.exitCode).toBe(2);
		expect(rendered.envelope.error).toMatchObject({ code: "usage", outcomeCertainty: "not-applied" });
		expect(diagnosticCodes(rendered.envelope)).toEqual(["sdk_scope_requires_repository"]);
		expect(stepArgv(rendered.envelope)).toEqual([["sdk", "session", "list", "--help"]]);
		expect(rendered.stdout).not.toContain("/private/outside/path");
	});

	test("unmapped host codes still collapse to operation_failed without diagnostics", async () => {
		const rendered = await renderPublicCommandFailure(sdkPublicFailure("some_unmapped_host_code"), {
			command: ["sdk", "session", "send"],
			json: true,
		});
		expect(rendered.envelope.error.code).toBe("operation_failed");
		expect(diagnosticCodes(rendered.envelope)).toEqual([]);
	});
});
