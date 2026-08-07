import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SdkClient } from "../src/sdk/client/client";
import { startProductionSdkHost } from "./helpers/sdk-production-host";

const roots: string[] = [];
let host: Awaited<ReturnType<typeof startProductionSdkHost>> | undefined;

afterEach(async () => {
	await host?.stop();
	host = undefined;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("correlated steer production dispatch", () => {
	it("durably reserves before dispatch and replays the same clientRef without a second effect", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-steer-production-"));
		roots.push(root);
		host = await startProductionSdkHost(root);
		const client = await SdkClient.connect(host.endpoint.url, host.endpoint.token);
		try {
			const first = await client.control("turn.steer", { text: "one steer", clientRef: "logical-steer-1" });
			const replay = await client.control("turn.steer", { text: "one steer", clientRef: "logical-steer-1" });
			expect(first).toMatchObject({
				ok: true,
				result: { sessionId: host.sessionId, clientRef: "logical-steer-1", status: "accepted" },
			});
			expect(replay).toMatchObject({
				ok: true,
				result: { sessionId: host.sessionId, clientRef: "logical-steer-1", status: "accepted" },
			});
			expect(host.observed.filter(row => row.operation === "turn.steer")).toHaveLength(2);
			expect(host.session.getQueuedMessages().steering).toEqual(["one steer"]);
			const status = await client.query("turn.steer_status", { clientRef: "logical-steer-1" });
			expect(status).toMatchObject({
				ok: true,
				result: { clientRef: "logical-steer-1", status: "accepted" },
			});
		} finally {
			await client.close();
		}
	}, 30_000);
});
