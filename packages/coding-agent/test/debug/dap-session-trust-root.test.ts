import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as piUtils from "@gajae-code/utils";
import { TempDir } from "@gajae-code/utils";
import { Settings } from "../../src/config/settings";
import { dapSessionManager } from "../../src/dap/session";
import type { ToolSession } from "../../src/tools";
import { DebugTool } from "../../src/tools/debug";

const POSIX_STUB = process.platform !== "win32";

interface AttackFixture {
	id: string;
	adapter: string;
	program: string;
	programBody: string;
	markers: Record<string, string>;
	stub: string;
	trailingSeparator?: boolean;
}

async function writeStub(file: string, marker: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, `#!/bin/sh\nprintf '%s\\n' executed >> ${JSON.stringify(marker)}\nexit 0\n`);
	await fs.promises.chmod(file, 0o755);
}

async function createRepository(root: string, fixture: AttackFixture, marker: string): Promise<string> {
	const repo = path.join(root, "repo");
	await fs.promises.mkdir(path.join(repo, ".git"), { recursive: true });
	await Bun.write(path.join(repo, fixture.program), fixture.programBody);
	for (const [name, body] of Object.entries(fixture.markers)) {
		await Bun.write(path.join(repo, name), body);
	}
	await writeStub(path.join(repo, fixture.stub), marker);
	return repo;
}

function sessionFor(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "debug.enabled": true }),
	};
}

async function rejectedLaunchMessage(launch: Promise<unknown>): Promise<string> {
	try {
		await launch;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the debug launch to reject");
}

afterEach(async () => {
	vi.restoreAllMocks();
	if (dapSessionManager.getActiveSession()) {
		await dapSessionManager.terminate(undefined, 1_000);
	}
});

describe("DAP adapter session workspace trust root", () => {
	it("does not spawn the session repository bin/gdb when the command cwd is a different project", async () => {
		using tempDir = TempDir.createSync("@gjc-dap-trust-split-cwd-");
		const marker = tempDir.join("project-stub-ran");
		const sessionRepo = await createRepository(
			tempDir.path(),
			{
				id: "split",
				adapter: "gdb",
				program: "main.c",
				programBody: "int main(void) { return 0; }\n",
				markers: { "go.mod": "module example\n" },
				stub: "bin/gdb",
			},
			marker,
		);
		const other = path.join(tempDir.path(), "other");
		await fs.promises.mkdir(path.join(other, ".git"), { recursive: true });
		await Bun.write(path.join(other, "main.c"), "int main(void) { return 0; }\n");
		const projectBinary = path.join(sessionRepo, "bin/gdb");
		vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "gdb" ? projectBinary : null));
		const tool = new DebugTool(sessionFor(sessionRepo));

		await expect(
			tool.execute("call-split-launch", {
				action: "launch",
				program: "main.c",
				adapter: "gdb",
				cwd: other,
				timeout: 5,
			}),
		).rejects.toThrow(/No debugger adapter available/);
		await expect(
			tool.execute("call-split-attach", {
				action: "attach",
				adapter: "gdb",
				pid: 1,
				cwd: other,
				timeout: 5,
			}),
		).rejects.toThrow(/No debugger adapter available/);
		expect(fs.existsSync(marker)).toBe(false);
	}, 20_000);

	it.skipIf(!POSIX_STUB)(
		"still launches a host debugger when cwd stays inside the session workspace (skipped on win32: POSIX stub)",
		async () => {
			using tempDir = TempDir.createSync("@gjc-dap-trust-inside-cwd-");
			const projectMarker = tempDir.join("project-stub-ran");
			const trustedMarker = tempDir.join("trusted-stub-ran");
			const sessionRepo = await createRepository(
				tempDir.path(),
				{
					id: "inside",
					adapter: "gdb",
					program: "main.c",
					programBody: "int main(void) { return 0; }\n",
					markers: { "go.mod": "module example\n" },
					stub: "bin/gdb",
				},
				projectMarker,
			);
			const inside = path.join(sessionRepo, "src");
			await fs.promises.mkdir(inside, { recursive: true });
			await Bun.write(path.join(inside, "main.c"), "int main(void) { return 0; }\n");
			const trustedBinary = tempDir.join("outside", "gdb");
			await writeStub(trustedBinary, trustedMarker);
			vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "gdb" ? trustedBinary : null));
			const tool = new DebugTool(sessionFor(sessionRepo));

			const message = await rejectedLaunchMessage(
				tool.execute("call-inside-cwd", {
					action: "launch",
					program: "main.c",
					adapter: "gdb",
					cwd: inside,
					timeout: 5,
				}),
			);
			expect(fs.existsSync(projectMarker)).toBe(false);
			expect(fs.existsSync(trustedMarker)).toBe(true);
			if (!message.includes("EPIPE")) {
				expect(message).toMatch(/DAP adapter exited/);
			}
		},
		20_000,
	);
});
