import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "@gajae-code/utils";
import { PublicCommandFailure, renderPublicCommandFailure } from "../src/cli/public-command-errors";
import * as brokerEnsure from "../src/sdk/broker/ensure";
import {
	controlRequestFrame,
	lifecyclePublicFailure,
	operatorAbortBrokerRequest,
	runSdkSessionCli,
	sdkPublicFailure,
} from "../src/sdk/cli/session-cli";
import * as sdkDiscovery from "../src/sdk/client";
import { SdkClient, SdkClientError } from "../src/sdk/client";
import { AgentDirSessionLifecycleClient } from "../src/sdk/lifecycle/broker-client";
import { deriveSessionLifecycleIdempotencyKey, SessionLifecycleService } from "../src/sdk/lifecycle/service";
import { SessionRouter } from "../src/sdk/router";

describe("sdk session raw control envelope", () => {
	test("keeps JSON failure stderr empty for ignored exact-session repo", async () => {
		const repo = "/private/workspace/path";
		const stderr: string[] = [];
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		});
		try {
			for (const { args, command } of [
				{ args: { action: "inspect", repo, json: true }, command: ["sdk", "session", "inspect"] },
				{ args: { action: "send", repo, json: true }, command: ["sdk", "session", "send"] },
				{ args: { action: "status", repo, json: true }, command: ["sdk", "session", "status"] },
				{
					args: { action: "raw", rawAction: "query", query: "session.checkpoint", repo, json: true },
					command: ["sdk", "session", "raw", "query"],
				},
			]) {
				const error = await runSdkSessionCli(args, () => {}).catch(error => error);
				expect(error).toBeInstanceOf(PublicCommandFailure);
				expect(error).toMatchObject({ input: { kind: "usage", proof: "pre-effect" } });
				const rendered = await renderPublicCommandFailure(error, { command, json: true });
				expect(rendered.exitCode).toBe(2);
				expect(rendered.stderr).toBe("");
				expect(rendered.stdout).not.toContain(repo);
			}
			expect(stderr.join("")).toBe("");
		} finally {
			stderrSpy.mockRestore();
		}
	});

	test("keeps JSON stderr empty when an exact-session broker request fails", async () => {
		const repo = "/private/workspace/path";
		const stderr: string[] = [];
		const ensure = spyOn(brokerEnsure, "ensureBroker").mockRejectedValue(new Error("private broker detail"));
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		});
		try {
			const error = await runSdkSessionCli(
				{
					action: "inspect",
					sessionId: "session-5862-target",
					repo,
					agentDir: "/tmp/gjc-5862-agent",
					json: true,
				},
				() => {},
			).catch(error => error);
			expect(error).toBeInstanceOf(PublicCommandFailure);
			const rendered = await renderPublicCommandFailure(error, {
				command: ["sdk", "session", "inspect"],
				json: true,
			});
			expect(rendered.exitCode).toBe(1);
			expect(rendered.stderr).toBe("");
			expect(rendered.stdout).not.toContain(repo);
			expect(rendered.stdout).not.toContain("private broker detail");
			expect(stderr.join("")).toBe("");
		} finally {
			stderrSpy.mockRestore();
			ensure.mockRestore();
		}
	});

	test("ignores repo while routing successful exact-session calls by session ID", async () => {
		const repo = "/private/workspace/path";
		const sessionId = "session-5862-target";
		const listInputs: Record<string, unknown>[] = [];
		const routedTargets: Array<{ sessionId: string; operation: string }> = [];
		const warnings: string[] = [];
		const ensure = spyOn(brokerEnsure, "ensureBroker").mockResolvedValue({} as never);
		const start = spyOn(SessionRouter.prototype, "start").mockResolvedValue(undefined);
		const stop = spyOn(SessionRouter.prototype, "stop").mockResolvedValue(undefined);
		const attachment = spyOn(SessionRouter.prototype, "attachment").mockReturnValue({ generation: 1 } as never);
		const list = spyOn(SessionRouter.prototype, "listBrokerSessions").mockImplementation(async input => {
			listInputs.push(input);
			return {
				ok: true,
				result: {
					sessions: [
						{
							sessionId,
							locator: { cwd: "/workspace/target", worktreeRoot: null, stateRoot: "/workspace/target/state" },
							endpointGeneration: 1,
							pid: 123,
							live: true,
							deleted: false,
							indexSeq: 1,
						},
					],
				},
			};
		});
		const request = spyOn(SessionRouter.prototype, "request").mockImplementation(async (routedSessionId, frame) => {
			routedTargets.push({ sessionId: routedSessionId, operation: String(frame.operation ?? frame.query) });
			return {
				ok: true,
				result: frame.type === "control_request" ? { accepted: true } : { status: "complete" },
			};
		});
		const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			warnings.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		});
		try {
			const outputs: unknown[] = [];
			for (const args of [
				{ action: "inspect", sessionId, repo, json: true },
				{ action: "send", sessionId, text: "hello", repo, json: true },
				{ action: "status", sessionId, opRef: "op-5862", repo, json: true },
				{ action: "raw", rawAction: "query", sessionId, query: "session.checkpoint", repo, json: true },
			]) {
				await runSdkSessionCli({ ...args, agentDir: "/tmp/gjc-5862-agent" }, value => outputs.push(value));
			}
			expect(outputs).toHaveLength(4);
			expect(outputs.every(output => (output as { ok?: unknown }).ok === true)).toBe(true);
			expect(listInputs).toEqual([{ resolveSessionId: sessionId }]);
			expect(routedTargets).toEqual([
				{ sessionId, operation: "turn.prompt" },
				{ sessionId, operation: "turn.result" },
				{ sessionId, operation: "session.checkpoint" },
			]);
			expect(warnings.join("")).toBe(
				"Warning: --repo is ignored for exact-session commands; the session ID selects the broker target.\n".repeat(
					4,
				),
			);
			expect(JSON.stringify({ listInputs, routedTargets, warnings, outputs })).not.toContain(repo);
		} finally {
			stderr.mockRestore();
			request.mockRestore();
			list.mockRestore();
			attachment.mockRestore();
			stop.mockRestore();
			start.mockRestore();
			ensure.mockRestore();
		}
	});

	test("invalid JSON throws before output and the boundary never echoes its body", async () => {
		const output: unknown[] = [];
		const secret = "secret-body-not-for-output";
		const error = await runSdkSessionCli({ action: "send", sessionId: "session-1", jsonInput: `{${secret}` }, value =>
			output.push(value),
		).catch(error => error);
		expect(output).toEqual([]);
		expect(error).toMatchObject({ input: { kind: "invalid_json", proof: "pre-effect" } });
		const rendered = await renderPublicCommandFailure(error, { command: ["sdk", "session", "send"], json: true });
		expect(rendered.exitCode).toBe(2);
		expect(rendered.envelope.schema).toBe("gjc.command-error");
		expect(rendered.stdout).not.toContain(secret);
	});

	test("accepted wait timeout retains full operation and session references", async () => {
		const operationRef = "operation-reference";
		const rendered = await renderPublicCommandFailure(
			sdkPublicFailure("wait_timeout", { sessionId: "session-1", operationRef, message: "secret-message" }),
			{ command: ["sdk", "session", "send"], json: true },
		);
		expect(rendered.envelope.error.outcomeCertainty).toBe("applied");
		expect(rendered.envelope.error.references).toContainEqual({ kind: "operationRef", value: operationRef });
		expect(rendered.stdout).not.toContain("secret-message");
	});
	test("routes confirmed operator terminal aborts through the dedicated broker envelope", () => {
		const input = { mode: "terminal", scope: "owned", operator: true };
		expect(
			operatorAbortBrokerRequest("session-1", "turn.abort", input, {
				confirm: true,
				idempotencyKey: "gajae-abort-test-key",
			}),
		).toEqual({
			sessionId: "session-1",
			operation: "turn.abort",
			input,
			confirm: true,
		});
		expect(input).toEqual({ mode: "terminal", scope: "owned", operator: true });
	});

	test("does not route ordinary terminal aborts through broker operator authority", () => {
		expect(
			operatorAbortBrokerRequest(
				"session-1",
				"turn.abort",
				{ mode: "terminal", scope: "turn" },
				{
					confirm: true,
					idempotencyKey: "ordinary-key",
				},
			),
		).toBeUndefined();
	});

	test("allows the terminal abort scope to default on the broker route", () => {
		expect(
			operatorAbortBrokerRequest(
				"session-1",
				"turn.abort",
				{ mode: "terminal", operator: true },
				{
					confirm: true,
					idempotencyKey: "default-scope-key",
				},
			),
		).toEqual({
			sessionId: "session-1",
			operation: "turn.abort",
			input: { mode: "terminal", operator: true },
			confirm: true,
		});
	});

	test("omits an absent idempotency key for ordinary controls", () => {
		expect(controlRequestFrame("thinking.cycle", {}, { confirm: false })).toEqual({
			type: "control_request",
			operation: "thinking.cycle",
			input: {},
			confirm: false,
		});
	});
});

for (const accepted of [false, true]) {
	for (const cleanupFails of [false, true]) {
		test(`unknown send failure preserves generated references after accepted=${accepted}, cleanupFails=${cleanupFails}`, async () => {
			const ensure = spyOn(brokerEnsure, "ensureBroker").mockResolvedValue({} as never);
			const start = spyOn(SessionRouter.prototype, "start").mockResolvedValue(undefined);
			const stop = spyOn(SessionRouter.prototype, "stop").mockImplementation(async () => {
				if (cleanupFails) throw new Error("secret-cleanup");
			});
			const attachment = spyOn(SessionRouter.prototype, "attachment").mockReturnValue({ generation: 1 } as never);
			let generated: unknown;
			const request = spyOn(SessionRouter.prototype, "request").mockImplementation(async (_session, frame) => {
				if (frame.type === "control_request") {
					generated = (frame.input as { clientRef: string }).clientRef;
					if (accepted) return { ok: true, result: { accepted: true } };
				}
				throw new Error("secret-action");
			});
			const warn = spyOn(logger, "warn").mockImplementation(() => {});
			try {
				const outputs: unknown[] = [];
				const error = await runSdkSessionCli(
					{ action: "send", sessionId: "session-1", text: "hello", wait: true, idempotencyKey: "key-1" },
					value => outputs.push(value),
				).catch(error => error);
				expect(error).toBeInstanceOf(PublicCommandFailure);
				expect(generated).toEqual(expect.any(String));
				if (typeof generated !== "string") throw new Error("Expected generated operation reference");
				const rendered = await renderPublicCommandFailure(error, {
					command: ["sdk", "session", "send"],
					json: true,
				});
				expect(outputs).toEqual([]);
				expect(rendered.envelope.error).toMatchObject({
					code: "operation_failed",
					outcomeCertainty: accepted ? "applied" : "unknown",
				});
				expect(rendered.envelope.error.references).toContainEqual({ kind: "operationRef", value: generated });
				expect(rendered.envelope.error.references).toContainEqual({ kind: "sessionId", value: "session-1" });
				expect(rendered.envelope.error.references).toContainEqual({ kind: "idempotencyKey", value: "key-1" });
				expect(rendered.envelope).toMatchObject({ complete: true, evidence: { status: "inline" } });
				if (cleanupFails) expect(rendered.envelope.diagnostics).toMatchObject([{ code: "router_cleanup_failed" }]);
				else expect(rendered.envelope.diagnostics).toBeUndefined();
				expect(JSON.parse(rendered.stdout)).toEqual(rendered.envelope);
				expect(rendered.stderr).toBe("");
				expect(rendered.stdout).not.toContain("secret-");
				expect(Buffer.byteLength(rendered.stdout)).toBeLessThanOrEqual(8192);
				expect(warn).not.toHaveBeenCalled();
			} finally {
				warn.mockRestore();
				request.mockRestore();
				attachment.mockRestore();
				stop.mockRestore();
				start.mockRestore();
				ensure.mockRestore();
			}
		});
	}
}

test("successful send retains its sole success payload and static Router cleanup warning", async () => {
	const ensure = spyOn(brokerEnsure, "ensureBroker").mockResolvedValue({} as never);
	const start = spyOn(SessionRouter.prototype, "start").mockResolvedValue(undefined);
	const stop = spyOn(SessionRouter.prototype, "stop").mockRejectedValue(new Error("secret-cleanup"));
	const attachment = spyOn(SessionRouter.prototype, "attachment").mockReturnValue({ generation: 1 } as never);
	const request = spyOn(SessionRouter.prototype, "request").mockResolvedValue({
		ok: true,
		result: { accepted: true },
	});
	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	try {
		const outputs: unknown[] = [];
		await runSdkSessionCli({ action: "send", sessionId: "session-1", text: "hello" }, value => outputs.push(value));
		expect(outputs).toHaveLength(1);
		expect(outputs[0]).toMatchObject({ ok: true, result: { status: "accepted" } });
		expect(warn).toHaveBeenCalledWith("SDK session Router cleanup failed");
	} finally {
		warn.mockRestore();
		request.mockRestore();
		attachment.mockRestore();
		stop.mockRestore();
		start.mockRestore();
		ensure.mockRestore();
	}
});

for (const actionFails of [false, true]) {
	test(`broker operator action failure=${actionFails} preserves outcome across close failure`, async () => {
		const ensure = spyOn(brokerEnsure, "ensureBroker").mockResolvedValue({} as never);
		const discovery = spyOn(sdkDiscovery, "readSdkBrokerDiscovery").mockResolvedValue({
			url: "ws://127.0.0.1:1",
			token: "secret-token",
		} as never);
		const response = actionFails
			? { ok: false, error: { code: "authorization_denied", message: "secret-action" } }
			: { ok: true, result: { aborted: true } };
		const connect = spyOn(SdkClient, "connect").mockResolvedValue({
			global: async () => response,
			close: async () => {
				throw new Error("secret-cleanup");
			},
		} as unknown as SdkClient);
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const outputs: unknown[] = [];
			const error = await runSdkSessionCli(
				{
					action: "control",
					operation: "turn.abort",
					sessionId: "session-1",
					confirm: true,
					idempotencyKey: "key-1",
					jsonInput: JSON.stringify({ mode: "terminal", operator: true }),
				},
				value => outputs.push(value),
			).catch(error => error);
			if (actionFails) {
				expect(error).toBeInstanceOf(PublicCommandFailure);
				const rendered = await renderPublicCommandFailure(error, {
					command: ["sdk", "session", "raw"],
					json: true,
				});
				expect(outputs).toEqual([]);
				expect(rendered.envelope.error).toMatchObject({
					code: "authorization_denied",
					outcomeCertainty: "unknown",
				});
				expect(rendered.envelope.diagnostics).toMatchObject([{ code: "broker_cleanup_failed" }]);
				expect(JSON.parse(rendered.stdout)).toEqual(rendered.envelope);
				expect(rendered.stderr).toBe("");
				expect(rendered.stdout).not.toContain("secret-");
				expect(Buffer.byteLength(rendered.stdout)).toBeLessThanOrEqual(8192);
				expect(warn).not.toHaveBeenCalled();
			} else {
				expect(error).toBeUndefined();
				expect(outputs).toEqual([response]);
				expect(warn).toHaveBeenCalledWith("SDK broker client cleanup failed");
			}
		} finally {
			warn.mockRestore();
			connect.mockRestore();
			discovery.mockRestore();
			ensure.mockRestore();
		}
	});
}

test("lifecycle certainty variants do not invent effect proof from code or retryability", async () => {
	for (const certainty of ["terminal", "retryable", "cleanup_pending", "uncertain"] as const) {
		for (const code of ["invalid_input", "wait_timeout", "protocol_error", "cleanup_pending", "unavailable"]) {
			const outcome = {
				ok: false as const,
				operation: "session.delete" as const,
				certainty,
				error: { code, message: "secret-action" },
			};
			const execute = spyOn(SessionLifecycleService.prototype, "execute").mockResolvedValue(outcome);
			try {
				const outputs: unknown[] = [];
				const error = await runSdkSessionCli(
					{
						action: "global",
						operation: "session.delete",
						idempotencyKey: "key-1",
						jsonInput: JSON.stringify({ sessionId: "session-1" }),
					},
					value => outputs.push(value),
				).catch(error => error);
				expect(error).toBeInstanceOf(PublicCommandFailure);
				const rendered = await renderPublicCommandFailure(error, {
					command: ["sdk", "session", "raw"],
					json: true,
				});
				expect(outputs).toEqual([]);
				expect(rendered.envelope.error.outcomeCertainty).toBe(
					certainty === "retryable" && code === "protocol_error" ? "not-applied" : "unknown",
				);
				expect(rendered.envelope.error.references).toContainEqual({ kind: "sessionId", value: "session-1" });
				expect(rendered.envelope.error.references).toContainEqual({ kind: "idempotencyKey", value: "key-1" });
				expect(rendered.stdout).not.toContain("secret-action");
				expect(rendered.envelope.error.retryability).not.toBe("yes");
				expect(lifecyclePublicFailure(outcome).input.proof).toBe(
					certainty === "retryable" && code === "protocol_error" ? "pre-send" : "unknown",
				);
			} finally {
				execute.mockRestore();
			}
		}
	}
});

for (const returned of [false, true]) {
	for (const requestSent of [false, true, undefined]) {
		test(`real lifecycle protocol_error producer: returned=${returned}, requestSent=${requestSent}`, async () => {
			const ensure = spyOn(brokerEnsure, "ensureBroker").mockResolvedValue({} as never);
			const discovery = spyOn(sdkDiscovery, "readSdkBrokerDiscovery").mockResolvedValue({
				url: "ws://127.0.0.1:1",
				token: "secret-discovery-token",
			} as never);
			const dispatches: { operation: string; input: unknown; idempotencyKey: string | undefined }[] = [];
			let closes = 0;
			const connect = spyOn(SdkClient, "connect").mockResolvedValue({
				global: async (operation: string, input: unknown, options: { idempotencyKey?: string }) => {
					dispatches.push({ operation, input, idempotencyKey: options.idempotencyKey });
					const details = requestSent === undefined ? {} : { requestSent };
					if (returned)
						return { ok: false, error: { code: "protocol_error", message: "secret-dispatch", ...details } };
					throw new SdkClientError("protocol_error", "secret-dispatch", details);
				},
				close: async () => {
					closes++;
				},
			} as unknown as SdkClient);
			try {
				const service = new SessionLifecycleService(new AgentDirSessionLifecycleClient("/unused-agent"));
				const outcome = await service.executeWithIdempotencyKey(
					{
						operation: "session.delete",
						capability: "session.delete",
						actor: { id: "producer-test", namespace: "sdk-test" },
						requestKey: "request-key",
						target: { sessionId: "session-1" },
					},
					"key-1",
				);
				expect(outcome).toMatchObject({
					ok: false,
					certainty: returned ? "terminal" : requestSent === false ? "retryable" : "uncertain",
					error: { code: "protocol_error" },
				});
				if (outcome.ok) throw new Error("Expected lifecycle producer failure");
				const expectedCertainty = !returned && requestSent === false ? "not-applied" : "unknown";
				const projected = await renderPublicCommandFailure(lifecyclePublicFailure(outcome), {
					command: ["sdk", "session", "raw"],
					json: true,
				});
				expect(projected.envelope.error.outcomeCertainty).toBe(expectedCertainty);
				// Repeat through the actual CLI adapter, not a fabricated lifecycle response, to verify context forwarding.
				const outputs: unknown[] = [];
				const error = await runSdkSessionCli(
					{
						action: "global",
						operation: "session.delete",
						agentDir: "/unused-agent",
						idempotencyKey: "key-1",
						opRef: "operation-1",
						jsonInput: JSON.stringify({ sessionId: "session-1" }),
					},
					value => outputs.push(value),
				).catch(error => error);
				expect(error).toBeInstanceOf(PublicCommandFailure);
				const rendered = await renderPublicCommandFailure(error, {
					command: ["sdk", "session", "raw"],
					json: true,
				});
				expect(outputs).toEqual([]);
				expect(rendered.envelope.error).toMatchObject({
					code: "operation_failed",
					outcomeCertainty: expectedCertainty,
				});
				for (const reference of [
					{ kind: "sessionId", value: "session-1" },
					{ kind: "operationRef", value: "operation-1" },
					{ kind: "idempotencyKey", value: "key-1" },
				] as const)
					expect(rendered.envelope.error.references).toContainEqual(reference);
				expect(rendered.stdout).not.toContain("secret-");
				expect(rendered.stderr).toBe("");
				expect(dispatches).toEqual([
					{ operation: "session.delete", input: { sessionId: "session-1" }, idempotencyKey: "key-1" },
					{
						operation: "session.delete",
						input: { sessionId: "session-1" },
						idempotencyKey: deriveSessionLifecycleIdempotencyKey(
							{ id: "gjc-sdk-session-cli", namespace: "sdk:session-cli" },
							"key-1",
							"session.delete",
						),
					},
				]);
				expect(closes).toBe(2);
			} finally {
				connect.mockRestore();
				discovery.mockRestore();
				ensure.mockRestore();
			}
		});
	}
}
