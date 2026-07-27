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
		await Settings.init({ inMemory: true, cwd: tmpDir });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("routes plain text writes through the standard ACP bridge", async () => {
		const filePath = path.join(tmpDir, "output.txt");

		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => undefined,
		};

		const bridgeSpy = spyOn(bridge, "writeTextFile");

		const session = createSession(tmpDir, bridge);
		const tool = new WriteTool(session);

		await tool.execute("call-1", { path: filePath, content: FILE_CONTENT });

		expect(bridgeSpy).toHaveBeenCalledTimes(1);
		expect(bridgeSpy).toHaveBeenCalledWith({ path: filePath, content: FILE_CONTENT });
		expect(await Bun.file(filePath).exists()).toBe(false);
	});

	it("forwards existing-file overwrites through the standard ACP bridge", async () => {
		const filePath = path.join(tmpDir, "existing.txt");
		await fs.writeFile(filePath, "existing content\n", "utf8");
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => undefined,
		};
		const bridgeSpy = spyOn(bridge, "writeTextFile");

		const tool = new WriteTool(createSession(tmpDir, bridge));
		await tool.execute("call-existing", { path: filePath, content: FILE_CONTENT });
		expect(bridgeSpy).toHaveBeenCalledTimes(1);
		expect(bridgeSpy).toHaveBeenCalledWith({ path: filePath, content: FILE_CONTENT });
		expect(await fs.readFile(filePath, "utf8")).toBe("existing content\n");
	});
});
