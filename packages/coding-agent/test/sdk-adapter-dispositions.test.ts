/**
 * Chat-adapter disposition tests.
 *
 * Issue #4475: this file previously also ran the machine-adapter (mcp, acp,
 * daemonCli) cohorts, totaling 291 production SDK host fixtures at ~1.7s each
 * (~489s of genuine test runtime) and exceeding the CI 300s file-timeout with
 * exit=0. Measurement (scripts/measure-sdk-adapter-exit.ts, since removed)
 * showed bun's own accounting attributing 488.80s to the tests themselves and
 * only ~200ms from last test to process exit, ruling out leaked
 * timers/sockets/workers. The machine cohorts now run as sibling files —
 * sdk-adapter-dispositions-mcp.test.ts, sdk-adapter-dispositions-acp.test.ts,
 * sdk-adapter-dispositions-daemon-cli.test.ts — each ~163s under the unchanged
 * timeout, with coverage preserved exactly.
 *
 * This file retains the chat-adapter loops (telegram/discord/slack), which need
 * no production host and complete in ~2s.
 */
import { expect, test } from "bun:test";
import { sendAuthorizedChatOperation } from "../src/sdk/bus/chat-command-policy";
import { OPERATIONS } from "../src/sdk/protocol/operation-registry";
import { type Expected, inputFor, parityRow } from "./helpers/sdk-adapter-dispositions-shared";

const chatAdapters = ["telegram", "discord", "slack"] as const;
const chatPrefix = { telegram: "T", discord: "D", slack: "S" } as const;
for (const adapter of chatAdapters) {
	for (const operation of OPERATIONS.filter(candidate => candidate.kind !== "reverse")) {
		test(`AD-${chatPrefix[adapter]}-${operation.id}: ${operation.sdkId} chat disposition`, async () => {
			let sends = 0;
			const row = parityRow(adapter, operation);
			const result = await sendAuthorizedChatOperation(
				adapter,
				{ kind: operation.kind, operation: operation.sdkId, input: inputFor(operation) },
				async () => {
					sends++;
					return "sent";
				},
			);
			const observed: Expected = result.ok ? "forwarded" : "rejected_before_send";
			expect(observed === row.expected).toBe(true);
			expect(sends).toBe(row.expected === "forwarded" ? 1 : 0);
		});
		if (operation.id === "C36") {
			test(`AD-${chatPrefix[adapter]}-C36-secret: config.patch secret input rejected before send`, async () => {
				const row = parityRow(adapter, operation, true);
				const secretInputs = [
					{ patch: { nested: { apiKey: "secret" } } },
					{ patch: { nested: { "api-key": "secret" } } },
					{ patch: { nested: { credential: "secret" } } },
					{ patch: { nested: { authorization: "secret" } } },
				];
				for (const input of secretInputs) {
					let sends = 0;
					const result = await sendAuthorizedChatOperation(
						adapter,
						{ kind: "control", operation: operation.sdkId, input },
						async () => {
							sends++;
							return "sent";
						},
					);
					expect(result).toMatchObject({ ok: false, error: { code: "secret_input_forbidden" } });
					expect(sends).toBe(0);
				}
				expect(row.expected).toBe("rejected_before_send");
			});
		}
	}
}

for (const adapter of chatAdapters) {
	for (const operation of OPERATIONS.filter(candidate => candidate.kind === "reverse")) {
		test(`AD-${chatPrefix[adapter]}-${operation.id}: ${operation.sdkId} internal_only/rejected-before-send`, async () => {
			let sends = 0;
			const row = parityRow(adapter, operation);
			const result = await sendAuthorizedChatOperation(
				adapter,
				{ kind: operation.kind, operation: operation.sdkId, input: inputFor(operation) },
				async () => {
					sends++;
					return "sent";
				},
			);
			const observed: Expected = result.ok ? "forwarded" : "rejected_before_send";
			expect(observed === row.expected).toBe(true);
			expect(sends).toBe(0);
		});
	}
}
