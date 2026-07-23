import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ClientBridge } from "@gajae-code/coding-agent/session/client-bridge";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { WriteTool } from "@gajae-code/coding-agent/tools/write";

const FILE_CONTENT = "bridge write content\n";

function createSession(cwd: string, bridge?: ClientBridge): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		getClientBridge: bridge ? () => bridge : undefined,
	};
}

describe("write tool ACP fs routing", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-acp-fs-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("routes plain text writes through an atomic create-only bridge", async () => {
		const filePath = path.join(tmpDir, "output.txt");

		const bridge: ClientBridge = {
			capabilities: { createTextFile: true },
			createTextFile: async () => undefined,
		};

		const bridgeSpy = spyOn(bridge, "createTextFile");
		const bunWriteSpy = spyOn(Bun, "write");

		try {
			const session = createSession(tmpDir, bridge);
			const tool = new WriteTool(session);

			await tool.execute("call-1", { path: filePath, content: FILE_CONTENT });

			// Bridge was called with the exact path and content
			expect(bridgeSpy).toHaveBeenCalledTimes(1);
			expect(bridgeSpy).toHaveBeenCalledWith({ path: filePath, content: FILE_CONTENT });
			// Disk write must not have been called — bridge is the destination
			expect(bunWriteSpy).not.toHaveBeenCalled();
		} finally {
			bunWriteSpy.mockRestore();
		}
	});

	it("maps a client-side create conflict without touching local disk", async () => {
		const filePath = path.join(tmpDir, "existing.txt");
		const bridge: ClientBridge = {
			capabilities: { createTextFile: true },
			createTextFile: async () => {
				throw Object.assign(new Error("already exists"), { code: "EEXIST" });
			},
		};
		const bridgeSpy = spyOn(bridge, "createTextFile");

		const tool = new WriteTool(createSession(tmpDir, bridge));
		await expect(tool.execute("call-existing", { path: filePath, content: FILE_CONTENT })).rejects.toThrow(
			/already exists/i,
		);
		expect(bridgeSpy).toHaveBeenCalledTimes(1);
		expect(await Bun.file(filePath).exists()).toBe(false);
	});

	it("fails closed when the client cannot prove the path is absent", async () => {
		const filePath = path.join(tmpDir, "unknown.txt");
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => undefined,
		};
		const bridgeSpy = spyOn(bridge, "writeTextFile");

		const tool = new WriteTool(createSession(tmpDir, bridge));
		await expect(tool.execute("call-unknown", { path: filePath, content: FILE_CONTENT })).rejects.toThrow(
			/cannot guarantee atomic create-only writes/i,
		);
		expect(bridgeSpy).not.toHaveBeenCalled();
	});
});
