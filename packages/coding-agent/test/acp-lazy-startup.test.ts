import { describe, expect, it } from "bun:test";
import {
	type Client,
	ClientSideConnection,
	type CreateTerminalRequest,
	type CreateTerminalResponse,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { createAcpConnection } from "../src/modes/acp/acp-mode";

class TestClient implements Client {
	readonly updates: SessionNotification[] = [];

	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}

	async sessionUpdate(params: SessionNotification): Promise<void> {
		this.updates.push(params);
	}

	async createTerminal(_params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
		return { terminalId: "test-terminal" };
	}
}

describe("ACP lazy startup", () => {
	it("answers initialize without contacting a session runtime", async () => {
		const clientToAgent = new TransformStream();
		const agentToClient = new TransformStream();
		const client = new TestClient();
		const agentConnection = new ClientSideConnection(
			() => client,
			ndJsonStream(clientToAgent.writable, agentToClient.readable),
		);
		const serverConnection = createAcpConnection(ndJsonStream(agentToClient.writable, clientToAgent.readable));

		try {
			const initializeResponse = await Promise.race([
				agentConnection.initialize({ protocolVersion: 1, clientCapabilities: {} }),
				Bun.sleep(50).then(() => "timeout" as const),
			]);

			expect(initializeResponse).not.toBe("timeout");
			expect(initializeResponse).toEqual(
				expect.objectContaining({
					protocolVersion: 1,
					agentInfo: expect.objectContaining({ name: "gajae-code" }),
				}),
			);
		} finally {
			const closeConnection = (connection: unknown): void => {
				(connection as { connection: { close(error?: Error): void } }).connection.close();
			};
			closeConnection(agentConnection);
			closeConnection(serverConnection);
			await Promise.allSettled([agentConnection.closed, serverConnection.closed]);
		}
	});
});
