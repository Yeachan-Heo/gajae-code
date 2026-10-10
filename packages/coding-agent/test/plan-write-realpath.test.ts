import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools";
import { WriteTool } from "../src/tools/write";

describe("plan mode write", () => {
	it("refuses an ordinary plan write through a symlink that leaves an explicit artifacts root", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "plan-write-"));
		const localRoot = path.join(root, "artifacts", "local");
		const outside = path.join(root, "outside");
		await mkdir(localRoot, { recursive: true });
		await mkdir(outside, { recursive: true });
		try {
			const secret = path.join(outside, "secret.txt");
			await writeFile(secret, "keep");
			await symlink(secret, path.join(localRoot, "PLAN.md"));
			const session: ToolSession = {
				cwd: root,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated(),
				getArtifactsDir: () => path.join(root, "artifacts"),
				isManagedSessionDestination: () => false,
				getSessionId: () => "session-a",
				getPlanModeState: () => ({ enabled: true, planFilePath: "local://PLAN.md" }),
			};
			const tool = new WriteTool(session);
			await expect(tool.execute("plan-write", { path: "PLAN.md", content: "overwrite\n" })).rejects.toThrow(
				/escapes the session local root/,
			);
			expect(await readFile(secret, "utf8")).toBe("keep");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
