/**
 * MCP adapter disposition tests, split from sdk-adapter-dispositions.test.ts
 * (issue #4475): the combined machine-adapter cohorts exceeded the CI 300s
 * file-timeout budget at ~489s of genuine per-fixture runtime (291 production
 * SDK host startups at ~1.7s each). This is not a leaked-resource defect: the
 * process exits ~200ms after the final test. Each adapter cohort runs as its
 * own fresh process under the unchanged timeout.
 *
 * Coverage is byte-identical to the original monolithic file's MCP loop.
 */
import { expect, spyOn, test } from "bun:test";
import { createSdkMcpServer } from "../src/sdk/mcp";
import { findOperation } from "../src/sdk/protocol/operation-registry";
import { SessionRouter } from "../src/sdk/router";
import {
	adapterPrefix,
	assertMcpRow,
	expectedOutcome,
	fixture,
	type MachineAdapter,
	OPERATIONS,
} from "./helpers/sdk-adapter-dispositions-shared";

const adapter: MachineAdapter = "mcp";
for (const operation of OPERATIONS) {
	const name = `AD-${adapterPrefix[adapter]}-${operation.id}: ${operation.sdkId} ${expectedOutcome(adapter, operation)}`;
	test(name, async () => {
		await assertMcpRow(operation, false);
	}, 60_000);
	if (operation.id === "C36") {
		test(`AD-${adapterPrefix[adapter]}-C36-secret: config.patch secret input rejected before send`, async () => {
			await assertMcpRow(operation, true);
		}, 60_000);
	}
}

for (const [id, query, input] of [
	["Q44", "composer.complete", { text: "@", cursor: 1 }],
	["Q45", "session.info", {}],

	// Fixed metadata is included by the grouped managed diff-surface policy, not because it exposes paths.
	["Q47", "diff.scopes", {}],
	["Q48", "diff.summary", { scope: "working-tree" }],
	["Q49", "diff.file", { ref: "untrusted-reference" }],
] as const) {
	test(`MCP ${id} ${query} enforces managed observation policy before query routing or provider admission`, async () => {
		const operation = findOperation("query", query)!;
		expect(operation.id).toBe(id);
		const host = await fixture();
		const mcp = createSdkMcpServer({ agentDir: host.agentDir });
		const route = spyOn(SessionRouter.prototype, "request");
		try {
			const before = host.observed.length;
			const result = await mcp.callTool("gjc_session_query", { sessionId: host.sessionId, query, input });
			expect(route).not.toHaveBeenCalled();
			expect(host.observed.slice(before)).toEqual([]);
			expect(result).toEqual({
				ok: false,
				error: { code: "adapter_operation_prohibited", message: `${query} is not available through mcp.` },
			});
		} finally {
			route.mockRestore();
			await mcp.close();
			await host.stop();
		}
	}, 60_000);
}

test("session.spawn rejects capability-shaped input before MCP Broker startup", async () => {
	const mcp = createSdkMcpServer({ agentDir: process.cwd() });
	try {
		expect(
			await mcp.callTool("gjc_session_global", {
				operation: "session.spawn",
				input: {
					cwd: process.cwd(),
					task: "adapter disposition probe",
					masterCapability: "capability-shaped-probe",
					model: "openai/gpt-4o-mini",
					profile: "default",
				},
			}),
		).toMatchObject({ ok: false, error: { code: "adapter_operation_prohibited" } });
	} finally {
		await mcp.close();
	}
});
