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
	it("persists normalized canonical correlation before one dispatch, replays, conflicts, and resolves both Q30 selectors", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-steer-production-"));
		roots.push(root);
		host = await startProductionSdkHost(root);
		const client = await SdkClient.connect(host.endpoint.url, host.endpoint.token);
		try {
			const first = await client.control("turn.steer", { text: "one steer", clientRef: " logical-steer-1 " });
			expect(first).toMatchObject({
				ok: true,
				result: { sessionId: host.sessionId, clientRef: "logical-steer-1", status: "accepted" },
			});
			const accepted = (first as { result: { commandId: string; turnId: string } }).result;
			expect(accepted.commandId).toEqual(expect.any(String));
			expect(accepted.turnId).toEqual(expect.any(String));
			expect(host.dispatches.filter(dispatch => dispatch.deliverAs === "steer")).toHaveLength(1);
			const replay = await client.control("turn.steer", { text: "one steer", clientRef: "logical-steer-1" });
			expect(replay).toMatchObject({ ok: true, result: accepted });
			expect(host.dispatches.filter(dispatch => dispatch.deliverAs === "steer")).toHaveLength(1);
			await expect(
				client.control("turn.steer", { text: "different steer", clientRef: "logical-steer-1" }),
			).rejects.toMatchObject({ code: "client_ref_conflict" });
			expect(host.dispatches.filter(dispatch => dispatch.deliverAs === "steer")).toHaveLength(1);
			const byRef = await client.query("turn.steer_status", { clientRef: "logical-steer-1" });
			const byCanonical = await client.query("turn.steer_status", {
				commandId: accepted.commandId,
				turnId: accepted.turnId,
			});
			expect(byRef).toMatchObject({ ok: true, result: accepted });
			expect(byCanonical).toMatchObject({ ok: true, result: accepted });
			const sessionFile = host.session.sessionManager.getSessionFile();
			expect(sessionFile).toEqual(expect.any(String));
			const state = fs.readFileSync(
				path.join(path.dirname(sessionFile!), ".sdk-reconciliation", `${host.sessionId}.json`),
				"utf8",
			);
			expect(state).not.toContain("one steer");
			const uncorrelated = await client.control("turn.steer", { text: "compatibility steer" });
			expect(uncorrelated).toMatchObject({ ok: true, result: { accepted: true } });
			const uncorrelatedResult = (uncorrelated as { result: { commandId?: string; turnId?: string } }).result;
			expect(uncorrelatedResult.commandId).toEqual(expect.any(String));
			expect(uncorrelatedResult.turnId).toEqual(expect.any(String));
		} finally {
			await client.close();
		}
	}, 30_000);
});
