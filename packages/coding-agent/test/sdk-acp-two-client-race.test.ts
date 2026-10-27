import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NotificationServer } from "../../natives/native/index.js";
import { ACP_SESSION_RECONNECT, AcpSdkAdapter } from "../src/sdk/acp";
import { SdkClient } from "../src/sdk/client";
import { SessionSdkHost } from "../src/sdk/host";

test("SDK-RPC-provider-conflict: real ACP clients race atomically for one provider lease", async () => {
	// Task-owned fixture root. A shared `/tmp` socket path is both collidable
	// between concurrent runs and unbindable where the sandbox denies `/tmp`, and
	// the bind failure happens before the old try block, so the fixture leaked.
	// `os.tmpdir()` honours TMPDIR, so the whole fixture stays inside this task.
	const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-acp-race-"));
	const stateRoot = path.join(fixtureRoot, "state");
	await fs.mkdir(stateRoot, { recursive: true });
	const server = new NotificationServer(`acp-race-${Date.now()}`, "token", path.join(fixtureRoot, "socket"), true);
	let onFrame: ((connectionId: string, frame: Record<string, unknown>) => void) | undefined;
	const installedDefinitions = new Map<string, unknown>();

	const host = new SessionSdkHost({
		sessionId: "s",
		stateRoot,
		token: "token",
		sendFrame: (connectionId, frame) => {
			server.sendTo(connectionId, JSON.stringify(frame));
			return "written";
		},
		onFrame: handler => {
			onFrame = handler;
			return () => {
				onFrame = undefined;
			};
		},
		installProviderDefinitions: (capability, definitions) => installedDefinitions.set(capability, definitions),
	});
	server.onSdkFrame((_error, event) => {
		if (event) onFrame?.(event.connectionId, JSON.parse(event.json) as Record<string, unknown>);
	});
	server.onConnectionClose((_error, connectionId) => {
		if (connectionId) host.handleDisconnect(connectionId);
	});
	const winnerProvider = { capability: "ui", definitions: [{ name: "winner-select" }] };
	const loserProvider = { capability: "ui", definitions: [{ name: "loser-select" }] };
	let winner: AcpSdkAdapter | undefined;
	let loser: AcpSdkAdapter | undefined;

	// `host.start()` and `server.start()` are inside the guarded region so a bind or
	// startup failure still releases the server, the host and the fixture root.
	try {
		await host.start();
		const endpoint = await server.start();
		winner = new AcpSdkAdapter({
			client: new SdkClient(endpoint.url, "token", { ...ACP_SESSION_RECONNECT }),
			providers: [winnerProvider],
		});
		loser = new AcpSdkAdapter({
			client: new SdkClient(endpoint.url, "token", { ...ACP_SESSION_RECONNECT }),
			providers: [loserProvider],
		});

		const settled = await Promise.allSettled([winner.start(), loser.start()]);
		expect(settled).toHaveLength(2);
		for (const result of settled)
			expect(result).toMatchObject({ status: "rejected", reason: { code: "operation_prohibited" } });
		expect(winner.leaseIds.size).toBe(0);
		expect(loser.leaseIds.size).toBe(0);
		expect(installedDefinitions.size).toBe(0);
	} finally {
		try {
			await winner?.close();
			await loser?.close();
			server.stop();
			await host.stop();
		} finally {
			// Runs even if a stop throws, so the fixture root never survives the test.
			await fs.rm(fixtureRoot, { recursive: true, force: true });
		}
	}
});
