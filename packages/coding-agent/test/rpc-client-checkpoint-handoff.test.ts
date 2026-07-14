import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@gajae-code/coding-agent/modes/rpc/rpc-client";
import type {
	RpcCheckpointForHandoffAuthority,
	RpcCheckpointForHandoffData,
} from "@gajae-code/coding-agent/modes/rpc/rpc-types";

const authority: RpcCheckpointForHandoffAuthority = {
	incarnationDigest: "a".repeat(64),
	epochRevision: 3,
	leaseId: 5,
	deploymentGeneration: 7,
};
const lane = "main" as const;
const expectedCommand = {
	type: "checkpoint_for_handoff",
	authority,
	lane,
	id: "req_1",
};
const receipt: RpcCheckpointForHandoffData = {
	protocolVersion: 1,
	authority,
	lane,
	cleanQuiesced: true,
	transcriptFsynced: true,
	completedMarkerDigest: "b".repeat(64),
	transcriptDigest: "c".repeat(64),
	sessionId: "handoff-test-session",
	sessionFile: "/tmp/gjc-checkpoint-handoff/session.jsonl",
	provider: "test-provider",
	model: "test-model",
	thinking: "high",
	modelProfile: "test-profile",
};

async function withFakeServer(responseBody: string, run: (client: RpcClient) => Promise<void>): Promise<void> {
	const scriptPath = path.join(os.tmpdir(), `gjc-rpc-checkpoint-handoff-${Date.now()}-${Math.random()}.js`);
	await Bun.write(
		scriptPath,
		`
let buffer = "";
function write(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) {
			const frame = JSON.parse(line);
			if (JSON.stringify(frame) !== ${JSON.stringify(JSON.stringify(expectedCommand))}) {
				write({ id: frame.id, type: "response", command: frame.type, success: false, error: "unexpected command: " + JSON.stringify(frame) });
			} else {
				${responseBody}
			}
		}
		index = buffer.indexOf("\\n");
	}
});
setInterval(() => {}, 1000);
`,
	);
	const client = new RpcClient({ cliPath: scriptPath });
	try {
		await run(client);
	} finally {
		client.stop();
		await fs.rm(scriptPath, { force: true });
	}
}

function successResponse(data: unknown, command = "checkpoint_for_handoff"): string {
	return `write({ id: frame.id, type: "response", command: ${JSON.stringify(command)}, success: true, data: ${JSON.stringify(data)} });`;
}

describe("RpcClient.checkpointForHandoff", () => {
	test("sends the exact checkpoint request and returns its validated receipt", async () => {
		await withFakeServer(successResponse(receipt), async client => {
			await client.start();

			const result = await client.checkpointForHandoff(authority, lane);

			expect(result).toEqual(receipt);
			expect(result).not.toHaveProperty("childDisposition");
		});
	});

	for (const [name, data] of [
		["wrong protocol version", { ...receipt, protocolVersion: 2 }],
		["mismatched authority", { ...receipt, authority: { ...authority, leaseId: authority.leaseId + 1 } }],
		["mismatched lane", { ...receipt, lane: "self" }],
		["false clean quiesced flag", { ...receipt, cleanQuiesced: false }],
		["false transcript fsynced flag", { ...receipt, transcriptFsynced: false }],
		["invalid completed marker digest", { ...receipt, completedMarkerDigest: "not-a-digest" }],
		["invalid transcript digest", { ...receipt, transcriptDigest: "C".repeat(64) }],
		["blank session id", { ...receipt, sessionId: " " }],
		["relative session file", { ...receipt, sessionFile: "session.jsonl" }],
		["blank provider", { ...receipt, provider: "" }],
		["blank model", { ...receipt, model: "" }],
		["blank thinking", { ...receipt, thinking: "" }],
		["blank model profile", { ...receipt, modelProfile: "" }],
		["unexpected child disposition", { ...receipt, childDisposition: "exited" }],
	] as Array<[string, unknown]>) {
		test(`rejects a ${name} receipt`, async () => {
			await withFakeServer(successResponse(data), async client => {
				await client.start();

				await expect(client.checkpointForHandoff(authority, lane)).rejects.toThrow(
					"Invalid checkpoint_for_handoff response",
				);
			});
		});
	}

	test("rejects a same-id success response for a different command", async () => {
		await withFakeServer(successResponse(receipt, "get_state"), async client => {
			await client.start();

			await expect(client.checkpointForHandoff(authority, lane)).rejects.toThrow(
				"Invalid checkpoint_for_handoff response",
			);
		});
	});

	test("propagates a correlated RPC error", async () => {
		await withFakeServer(
			`write({ id: frame.id, type: "response", command: "checkpoint_for_handoff", success: false, error: "checkpoint refused" });`,
			async client => {
				await client.start();

				await expect(client.checkpointForHandoff(authority, lane)).rejects.toThrow("checkpoint refused");
			},
		);
	});
});
