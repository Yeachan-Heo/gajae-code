import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { disposeAllShellSessions } from "../../src/exec/bash-executor";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";
import { checkBashAllowedPrefixes } from "../../src/tools/bash-allowed-prefixes";
import { stubBashExecutorSettings } from "../helpers/tool-session-settings";

afterEach(async () => {
	await disposeAllShellSessions();
});

function createReadOnlyBashTool(cwd: string, prefixes: string[]): BashTool {
	const session = {
		cwd,
		getSessionFile: () => null,
		getSessionId: () => "read-only-bash-test",
		bashAllowedPrefixes: prefixes,
		bashRestrictionProfile: "read-only" as const,
		settings: {
			has(key: string) {
				return this.get(key) !== undefined;
			},
			get(key: string) {
				if (key === "bashInterceptor.enabled") return false;
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bash.stripTrailingHeadTail") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
			...stubBashExecutorSettings,
		},
	} as unknown as ToolSession;
	return new BashTool(session);
}

describe("read-only bash file compilation", () => {
	it("still allows file option arguments that resemble compilation flags", () => {
		for (const command of [
			"file -m --compile sample.txt",
			"file --magic-file=--compile sample.txt",
			"file -e --comp sample.txt",
			"file -f --compile",
			"file -P --compile sample.txt",
			"file -- --compile",
		]) {
			expect(checkBashAllowedPrefixes(command, ["file"], { profile: "read-only" })).toEqual({ allowed: true });
		}
	});

	it.skipIf(process.platform === "win32")("still allows rg and tree pattern values through public bash", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp-read-only-pattern-ok-"));
		const originalWhich = Bun.which;
		try {
			for (const name of ["rg", "tree"]) {
				await fs.writeFile(path.join(root, name), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
				await fs.chmod(path.join(root, name), 0o755);
			}
			Bun.which = ((command: string) =>
				command === "rg" || command === "tree"
					? path.join(root, command)
					: originalWhich(command)) as typeof Bun.which;
			const tool = createReadOnlyBashTool(root, ["rg", "tree"]);
			for (const command of ["rg -e --p sample.txt", "tree -P --o ."]) {
				const result = await tool.execute("tool-call", { command });
				expect(result.content.find(part => part.type === "text")?.text).toContain(
					command.includes("rg") ? "--p" : "--o",
				);
			}
		} finally {
			Bun.which = originalWhich;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32" || !Bun.which("file"))(
		"rejects file compilation through the public bash entry before writing magic",
		async () => {
			const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp-read-only-file-compile-"));
			try {
				await fs.writeFile(path.join(root, "magic"), "0 string HELLO sample\n");
				const tool = createReadOnlyBashTool(root, ["file"]);
				for (const command of [
					"file -C -m magic",
					"file -bC -m magic",
					"file --compile -m magic",
					"file --comp -m magic",
					"file -m -- --compile",
					"file --magic-file -- --comp",
					"file -FC -C -m magic",
				]) {
					await expect(tool.execute("tool-call", { command })).rejects.toThrow(
						"read-only bash does not allow file magic compilation",
					);
				}
				await expect(fs.access(path.join(root, "magic.mgc"))).rejects.toThrow();
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32" || !Bun.which("file"))(
		"still allows file inspection with attached and separate option values",
		async () => {
			const root = await fs.mkdtemp(path.join(process.cwd(), ".tmp-read-only-file-ok-"));
			try {
				await fs.writeFile(path.join(root, "sample.txt"), "hello\n");
				const tool = createReadOnlyBashTool(root, ["file"]);
				for (const command of [
					"file sample.txt",
					"file -FC sample.txt",
					"file -bFC sample.txt",
					"file -F --compile sample.txt",
					"file --separator --comp sample.txt",
					"file --separator=--compile sample.txt",
					"file --mime sample.txt",
				]) {
					const result = await tool.execute("tool-call", { command });
					expect(result.content.find(part => part.type === "text")?.text).toContain("text");
				}
				await fs.writeFile(path.join(root, "--compile"), "hello\n");
				const result = await tool.execute("tool-call", { command: "file -- --compile" });
				expect(result.content.find(part => part.type === "text")?.text).toContain("--compile:");
				await expect(fs.access(path.join(root, "magic.mgc"))).rejects.toThrow();
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);
});
