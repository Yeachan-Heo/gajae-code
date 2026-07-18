import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { InternalUrlRouter } from "@gajae-code/coding-agent/internal-urls";
import type { ClientBridge } from "@gajae-code/coding-agent/session/client-bridge";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import type { ReadToolDetails } from "@gajae-code/coding-agent/tools/read";
import { ReadTool } from "@gajae-code/coding-agent/tools/read";

const BRIDGE_CONTENT = "// content from editor buffer\nexport function greet() { return 'bridge'; }\n";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

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

describe("read tool ACP fs routing", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-acp-fs-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("routes plain text reads through the bridge and does not call Bun.file().text()", async () => {
		// .ts file so summarize would normally run (read.summarize.enabled defaults to true)
		const filePath = path.join(tmpDir, "example.ts");
		await fs.writeFile(filePath, "export function greet() { return 'disk'; }\n");

		const bridge: ClientBridge = {
			capabilities: { readTextFile: true },
			readTextFile: async () => BRIDGE_CONTENT,
		};
		const bridgeSpy = spyOn(bridge, "readTextFile");

		// Wrap Bun.file() to detect any .text() calls
		let textCallCount = 0;
		const origBunFile = Bun.file.bind(Bun);
		const bunFileSpy = spyOn(Bun, "file").mockImplementation(
			(arg: string | URL | Uint8Array | ArrayBufferLike | number, opts?: BlobPropertyBag) => {
				const bunFile = origBunFile(arg as string, opts);
				const origText = bunFile.text.bind(bunFile);
				bunFile.text = async () => {
					textCallCount++;
					return origText();
				};
				return bunFile;
			},
		);

		try {
			const session = createSession(tmpDir, bridge);
			const tool = new ReadTool(session);

			const result = await tool.execute("call-1", { path: filePath });
			const text = textOutput(result);

			// Bridge content should appear in output
			expect(text).toContain("content from editor buffer");
			// Bridge readTextFile was invoked
			expect(bridgeSpy).toHaveBeenCalled();
			// Bun.file().text() must not have been called — bridge is source of truth
			expect(textCallCount).toBe(0);
		} finally {
			bunFileSpy.mockRestore();
		}
	});

	it("applies requested line ranges to bridge content exactly once", async () => {
		const filePath = path.join(tmpDir, "range.txt");
		await fs.writeFile(filePath, "disk one\ndisk two\ndisk three\n");
		const bridgeContent = "bridge one\nbridge two\nbridge three\n";
		const bridge: ClientBridge = {
			capabilities: { readTextFile: true },
			readTextFile: async params => {
				if (typeof params.line !== "number") return bridgeContent;
				const lines = bridgeContent.split("\n");
				const start = Math.max(0, params.line - 1);
				return lines.slice(start, params.limit === undefined ? undefined : start + params.limit).join("\n");
			},
		};

		const session = createSession(tmpDir, bridge);
		const tool = new ReadTool(session);

		const result = await tool.execute("call-range", { path: `${filePath}:2+1` });
		const text = textOutput(result);

		expect(text).toContain("bridge two");
		expect(text).not.toContain("Line 2 is beyond end");
		expect(text).not.toContain("disk two");
	});
	it("rejects malformed internal selectors before resolving the resource", async () => {
		const router = InternalUrlRouter.instance();
		const resolveSpy = spyOn(router, "resolve").mockResolvedValue({
			url: "artifact://3",
			content: "one\ntwo\nthree\n",
			contentType: "text/plain",
		});
		const tool = new ReadTool(createSession(tmpDir));

		try {
			await expect(tool.execute("malformed-negative", { path: "artifact://3:-100" })).rejects.toThrow(
				'Invalid internal URL selector "-100".',
			);
			await expect(tool.execute("malformed-compound", { path: "artifact://3:raw:-100" })).rejects.toThrow(
				'Invalid internal URL selector "raw:-100".',
			);

			expect(resolveSpy).not.toHaveBeenCalled();
		} finally {
			resolveSpy.mockRestore();
		}
	});

	it("reads internal URLs without a selector and preserves valid selectors", async () => {
		const router = InternalUrlRouter.instance();
		const resolveSpy = spyOn(router, "resolve").mockResolvedValue({
			url: "artifact://3",
			content: "one\ntwo\nthree\n",
			contentType: "text/plain",
		});
		const tool = new ReadTool(createSession(tmpDir));

		try {
			expect(textOutput(await tool.execute("default", { path: "artifact://3" }))).toContain("one");
			expect(textOutput(await tool.execute("raw", { path: "artifact://3:raw" }))).toBe("one\ntwo\nthree\n");
			expect(textOutput(await tool.execute("range", { path: "artifact://3:2-2" }))).toContain("two");
			expect(textOutput(await tool.execute("range-raw", { path: "artifact://3:2-2:raw" }))).toContain("two");

			expect(resolveSpy).toHaveBeenCalledTimes(4);
			expect(resolveSpy.mock.calls.map(([url]) => url)).toEqual([
				"artifact://3",
				"artifact://3",
				"artifact://3",
				"artifact://3",
			]);
		} finally {
			resolveSpy.mockRestore();
		}
	});
});
