import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNotificationsExtension } from "../src/notifications/index";
import { readEndpoint } from "../src/notifications/telegram-reference";

/**
 * Regression for the text-before-ask ordering bug: the assistant text that
 * precedes an ask must reach the remote BEFORE the ask's action_needed (it used
 * to arrive only at turn_end, after the ask resolved), and must not be emitted
 * twice once turn_end fires.
 */

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 4000, label = "condition"): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`);
		await sleep(10);
	}
}

function fakeApi() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const api = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
		},
		registerCommand: () => {},
		sendUserMessage: () => {},
	};
	return { api: api as never, handlers };
}

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("assistant text preceding an ask is flushed before the ask and not duplicated at turn_end", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notif-order-"));
		tempDirs.push(cwd);
		const sid = `order-${process.pid}-${Date.now()}`;
		const { api, handlers } = fakeApi();
		createNotificationsExtension(api);

		const ctx = {
			cwd,
			sessionManager: {
				getSessionId: () => sid,
				getSessionName: () => "Ordering Test",
				getArtifactsDir: () => cwd,
				getCwd: () => cwd,
			},
		} as never;

		await handlers.get("session_start")!({ type: "session_start" }, ctx);

		const endpointFile = path.join(cwd, ".gjc", "state", "notifications", `${sid}.json`);
		await waitFor(() => fs.existsSync(endpointFile), 4000, "endpoint file");
		const { url, token } = readEndpoint(endpointFile);

		const frames: Array<{ type: string; text?: string }> = [];
		const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
		ws.addEventListener("message", ev => frames.push(JSON.parse(String((ev as MessageEvent).data))));
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new Error("ws error")));
		});
		// Let the server-side connection subscribe before any (unbuffered) broadcast.
		await sleep(250);

		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		// The assistant message (lead-in text) completes, then the ask tool starts.
		await handlers.get("message_end")!({ type: "message_end", message: { content: "Here are your options:" } }, ctx);
		await handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolName: "ask", toolCallId: "t1", args: {} },
			ctx,
		);

		// The lead-in must be flushed now (before the ask), not at turn_end.
		await waitFor(() => turnStreams().length === 1, 3000, "pre-ask turn_stream");
		expect(turnStreams()[0]!.text).toContain("Here are your options:");

		// turn_end for the same message must NOT duplicate the lead-in.
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { content: "Here are your options:" } },
			ctx,
		);
		await sleep(150);
		expect(turnStreams().length).toBe(1);

		// A later turn with different text streams once at turn_end.
		await handlers.get("message_end")!({ type: "message_end", message: { content: "All done." } }, ctx);
		await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 1, message: { content: "All done." } }, ctx);
		await waitFor(() => turnStreams().length === 2, 3000, "second turn_stream");
		expect(turnStreams()[1]!.text).toContain("All done.");

		ws.close();
		await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);
