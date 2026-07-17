import { describe, expect, it } from "bun:test";
import type { AgentSideConnection, ClientCapabilities, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { createAcpClientBridge } from "../src/modes/acp/acp-client-bridge";

function expectPermissionPrompt(clientCapabilities: ClientCapabilities | undefined, enabled: boolean): void {
	const bridge = createAcpClientBridge({} as AgentSideConnection, "session-1", clientCapabilities);
	expect(bridge.capabilities.requestPermission).toBe(enabled);
	expect(typeof bridge.requestPermission === "function").toBe(enabled);
}

describe("ACP client bridge permission requests", () => {
	it("forwards pending tool-call status to session/request_permission", async () => {
		let request: RequestPermissionRequest | undefined;
		const connection = {
			async requestPermission(params: RequestPermissionRequest) {
				request = params;
				return { outcome: { outcome: "selected" as const, optionId: "allow_once" } };
			},
		} as unknown as AgentSideConnection;

		const bridge = createAcpClientBridge(connection, "session-1", {
			_meta: { gjc: { permissionHandling: "prompt" } },
		});

		await bridge.requestPermission!(
			{
				toolCallId: "call-1",
				toolName: "bash",
				title: "echo hi",
				kind: "execute",
				status: "pending",
				rawInput: { command: "echo hi" },
				content: [{ type: "content", content: { type: "text", text: "$ echo hi" } }],
			},
			[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
		);

		expect(request?.toolCall).toMatchObject({
			toolCallId: "call-1",
			title: "echo hi",
			kind: "execute",
			status: "pending",
			rawInput: { command: "echo hi" },
			content: [{ type: "content", content: { type: "text", text: "$ echo hi" } }],
		});
	});

	it("only enables ACP permission requests in prompt mode", () => {
		expectPermissionPrompt({ _meta: { gjc: { permissionHandling: "prompt" } } }, true);
		expectPermissionPrompt({ _meta: { gjc: { permissionHandling: "auto" } } }, false);
		expectPermissionPrompt({ _meta: { gjc: { permissionHandling: "always-allow" } } }, false);
	});

	it("uses GJC_ACP_PERMISSION_MODE when client metadata is absent", () => {
		const previous = process.env.GJC_ACP_PERMISSION_MODE;
		try {
			process.env.GJC_ACP_PERMISSION_MODE = "auto";
			expectPermissionPrompt(undefined, false);
			process.env.GJC_ACP_PERMISSION_MODE = "always-allow";
			expectPermissionPrompt({}, false);
			process.env.GJC_ACP_PERMISSION_MODE = "prompt";
			expectPermissionPrompt({}, true);
			process.env.GJC_ACP_PERMISSION_MODE = "invalid";
			expectPermissionPrompt({}, true);
			process.env.GJC_ACP_PERMISSION_MODE = "AUTO";
			expectPermissionPrompt({}, true);
			process.env.GJC_ACP_PERMISSION_MODE = " always-allow ";
			expectPermissionPrompt({}, true);
		} finally {
			if (previous === undefined) delete process.env.GJC_ACP_PERMISSION_MODE;
			else process.env.GJC_ACP_PERMISSION_MODE = previous;
		}
	});

	it("prefers client metadata and fails safely for invalid explicit values", () => {
		const previous = process.env.GJC_ACP_PERMISSION_MODE;
		try {
			process.env.GJC_ACP_PERMISSION_MODE = "prompt";
			expectPermissionPrompt({ _meta: { gjc: { permissionHandling: "auto" } } }, false);
			expectPermissionPrompt({ _meta: { gjc: { permissionHandling: "always-allow" } } }, false);
			process.env.GJC_ACP_PERMISSION_MODE = "always-allow";
			expectPermissionPrompt({ _meta: { gjc: { permissionHandling: "prompt" } } }, true);
			expectPermissionPrompt({ _meta: { gjc: { permissionHandling: "invalid" } } }, true);
			expectPermissionPrompt({ _meta: { gjc: { permissionHandling: "AUTO" } } }, true);
			expectPermissionPrompt({ _meta: { gjc: { permissionHandling: " always-allow " } } }, true);
			expectPermissionPrompt({ _meta: { gjc: { permissionHandling: null } } }, true);
		} finally {
			if (previous === undefined) delete process.env.GJC_ACP_PERMISSION_MODE;
			else process.env.GJC_ACP_PERMISSION_MODE = previous;
		}
	});
});
