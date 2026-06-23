import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { registerTelegramFileSink } from "../src/notifications/attachment-registry";
import type { ToolSession } from "../src/tools";
import { TelegramSendTool } from "../src/tools/telegram-send";

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionId: () => "S",
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

describe("telegram_send egress containment", () => {
	const created: string[] = [];
	const sinkCalls: string[] = [];
	let disposeSink: (() => void) | undefined;

	afterEach(() => {
		disposeSink?.();
		disposeSink = undefined;
		sinkCalls.length = 0;
		for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	});

	function setup() {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-egress-root-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tg-egress-out-"));
		created.push(root, outside);
		fs.writeFileSync(path.join(root, "inside.txt"), "hello");
		fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
		disposeSink = registerTelegramFileSink("S", async f => {
			sinkCalls.push(f.path);
			return { ok: true };
		});
		return { root, outside, tool: new TelegramSendTool(makeSession(root)) };
	}

	it("sends a regular file inside the workspace", async () => {
		const { root, tool } = setup();
		const res = await tool.execute("c", { path: "inside.txt" });
		expect(res.isError).toBeFalsy();
		expect(sinkCalls).toHaveLength(1);
		expect(sinkCalls[0]).toBe(fs.realpathSync(path.join(root, "inside.txt")));
	});

	it("rejects an absolute path outside the workspace", async () => {
		const { outside, tool } = setup();
		const res = await tool.execute("c", { path: path.join(outside, "secret.txt") });
		expect(res.isError).toBe(true);
		expect(res.details?.error ?? "").toContain("escapes the workspace root");
		expect(sinkCalls).toHaveLength(0);
	});

	it("rejects a `..` traversal that escapes the workspace", async () => {
		const { outside, tool } = setup();
		const res = await tool.execute("c", { path: path.join("..", path.basename(outside), "secret.txt") });
		expect(res.isError).toBe(true);
		expect(sinkCalls).toHaveLength(0);
	});

	it("rejects a symlink inside the workspace that escapes it", async () => {
		const { root, outside, tool } = setup();
		fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
		const res = await tool.execute("c", { path: "link.txt" });
		expect(res.isError).toBe(true);
		expect(sinkCalls).toHaveLength(0);
	});

	it("rejects a missing file", async () => {
		const { tool } = setup();
		const res = await tool.execute("c", { path: "nope.txt" });
		expect(res.isError).toBe(true);
		expect(sinkCalls).toHaveLength(0);
	});
});
