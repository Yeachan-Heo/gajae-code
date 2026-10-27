import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as piUtils from "@gajae-code/utils";
import { TempDir } from "@gajae-code/utils";
import { Settings } from "../../src/config/settings";
import { selectLaunchAdapter } from "../../src/dap/config";
import { dapSessionManager } from "../../src/dap/session";
import { resolveCommand } from "../../src/lsp/config";
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

const ATTACKS: AttackFixture[] = [
	{
		id: "gdb",
		adapter: "gdb",
		program: "main.c",
		programBody: "int main(void) { return 0; }\n",
		markers: { "go.mod": "module example\n" },
		stub: "bin/gdb",
	},
	{
		id: "gdb-trailing-separator",
		adapter: "gdb",
		program: "main.c",
		programBody: "int main(void) { return 0; }\n",
		markers: { "go.mod": "module example\n" },
		stub: "bin/gdb",
		trailingSeparator: true,
	},
	{
		id: "dlv",
		adapter: "dlv",
		program: "main.go",
		programBody: "package main\nfunc main() {}\n",
		markers: { "go.mod": "module example\n" },
		stub: "bin/dlv",
	},
	{
		id: "debugpy-.venv",
		adapter: "debugpy",
		program: "app.py",
		programBody: "print(1)\n",
		markers: { "pyproject.toml": "[project]\nname = 'example'\n" },
		stub: ".venv/bin/python",
	},
	{
		id: "debugpy-venv",
		adapter: "debugpy",
		program: "app.py",
		programBody: "print(1)\n",
		markers: { "requirements.txt": "\n" },
		stub: "venv/bin/python",
	},
	{
		id: "debugpy-.env",
		adapter: "debugpy",
		program: "app.py",
		programBody: "print(1)\n",
		markers: { Pipfile: "\n" },
		stub: ".env/bin/python",
	},
	{
		id: "js-debug-adapter",
		adapter: "js-debug-adapter",
		program: "app.js",
		programBody: "console.log(1)\n",
		markers: { "package.json": "{}\n" },
		stub: "node_modules/.bin/js-debug-adapter",
	},
	{
		id: "rdbg",
		adapter: "rdbg",
		program: "app.rb",
		programBody: "puts 1\n",
		markers: { Gemfile: "source 'https://rubygems.org'\n" },
		stub: "vendor/bundle/bin/rdbg",
	},
];

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

function commandCwd(repo: string, fixture: AttackFixture): string {
	return fixture.trailingSeparator ? `${repo}${path.sep}` : repo;
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

describe("DAP project-controlled adapter binaries", () => {
	for (const fixture of ATTACKS) {
		it(`does not spawn a repository ${fixture.stub} from DebugTool launch (${fixture.id})`, async () => {
			using tempDir = TempDir.createSync(`@gjc-dap-trust-${fixture.id}-`);
			const marker = tempDir.join("project-stub-ran");
			const repo = await createRepository(tempDir.path(), fixture, marker);
			const cwd = commandCwd(repo, fixture);
			vi.spyOn(piUtils, "$which").mockReturnValue(null);
			const tool = new DebugTool(sessionFor(cwd));

			await expect(
				tool.execute("call-auto", { action: "launch", program: fixture.program, timeout: 5 }),
			).rejects.toThrow(/No debugger adapter available/);
			await expect(
				tool.execute("call-named", {
					action: "launch",
					program: fixture.program,
					adapter: fixture.adapter,
					timeout: 5,
				}),
			).rejects.toThrow(/No debugger adapter available/);

			expect(fs.existsSync(marker)).toBe(false);
			const command = fixture.adapter === "debugpy" ? "python" : fixture.adapter;
			const { resolveTrustedCommand } = await import("../../src/lsp/config");
			expect(resolveTrustedCommand(command, cwd)).toBeNull();
			expect(resolveCommand(command, cwd)).toBeNull();
		}, 20_000);
	}

	it("does not spawn repository bin/gdb from DebugTool attach", async () => {
		using tempDir = TempDir.createSync("@gjc-dap-trust-attach-");
		const marker = tempDir.join("project-stub-ran");
		const repo = await createRepository(
			tempDir.path(),
			{
				id: "attach",
				adapter: "gdb",
				program: "main.c",
				programBody: "int main(void) { return 0; }\n",
				markers: { "go.mod": "module example\n" },
				stub: "bin/gdb",
			},
			marker,
		);
		vi.spyOn(piUtils, "$which").mockReturnValue(null);
		const tool = new DebugTool(sessionFor(repo));

		await expect(
			tool.execute("call-attach", { action: "attach", adapter: "gdb", pid: 1, timeout: 5 }),
		).rejects.toThrow(/No debugger adapter available/);
		expect(fs.existsSync(marker)).toBe(false);
	}, 20_000);

	it("does not spawn repository .venv/bin/python when attach prefers debugpy by port", async () => {
		using tempDir = TempDir.createSync("@gjc-dap-trust-port-");
		const marker = tempDir.join("project-stub-ran");
		const repo = await createRepository(
			tempDir.path(),
			{
				id: "port",
				adapter: "debugpy",
				program: "app.py",
				programBody: "print(1)\n",
				markers: { "pyproject.toml": "[project]\nname = 'example'\n" },
				stub: ".venv/bin/python",
			},
			marker,
		);
		vi.spyOn(piUtils, "$which").mockReturnValue(null);
		const tool = new DebugTool(sessionFor(repo));

		await expect(tool.execute("call-port", { action: "attach", port: 5678, timeout: 5 })).rejects.toThrow(
			/No debugger adapter available/,
		);
		expect(fs.existsSync(marker)).toBe(false);
	}, 20_000);

	it("does not spawn a repository binary that $which returns from inside the project", async () => {
		using tempDir = TempDir.createSync("@gjc-dap-trust-which-project-");
		const marker = tempDir.join("project-stub-ran");
		const repo = await createRepository(
			tempDir.path(),
			{
				id: "which-project",
				adapter: "gdb",
				program: "main.c",
				programBody: "int main(void) { return 0; }\n",
				markers: { "go.mod": "module example\n" },
				stub: "bin/gdb",
			},
			marker,
		);
		const projectBinary = path.join(repo, "bin/gdb");
		vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "gdb" ? projectBinary : null));
		const tool = new DebugTool(sessionFor(repo));

		await expect(
			tool.execute("call-which", { action: "launch", program: "main.c", adapter: "gdb", timeout: 5 }),
		).rejects.toThrow(/No debugger adapter available/);
		expect(selectLaunchAdapter(path.join(repo, "main.c"), repo, "gdb")).toBeNull();
		expect(fs.existsSync(marker)).toBe(false);
	}, 20_000);

	it.skipIf(!POSIX_STUB)(
		"launches a PATH gdb outside the repository and does not run bin/gdb (skipped on win32: POSIX stub)",
		async () => {
			using tempDir = TempDir.createSync("@gjc-dap-trust-external-");
			const projectMarker = tempDir.join("project-stub-ran");
			const trustedMarker = tempDir.join("trusted-stub-ran");
			const repo = await createRepository(
				tempDir.path(),
				{
					id: "external",
					adapter: "gdb",
					program: "main.c",
					programBody: "int main(void) { return 0; }\n",
					markers: { "go.mod": "module example\n" },
					stub: "bin/gdb",
				},
				projectMarker,
			);
			const trustedBinary = tempDir.join("outside", "gdb");
			await writeStub(trustedBinary, trustedMarker);
			vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "gdb" ? trustedBinary : null));
			const tool = new DebugTool(sessionFor(repo));

			const selected = selectLaunchAdapter(path.join(repo, "main.c"), repo, "gdb");
			expect(selected?.resolvedCommand).toBe(trustedBinary);

			const message = await rejectedLaunchMessage(
				tool.execute("call-trusted", { action: "launch", program: "main.c", adapter: "gdb", timeout: 5 }),
			);
			expect(fs.existsSync(projectMarker)).toBe(false);
			expect(fs.existsSync(trustedMarker)).toBe(true);
			// The stub closes stdin before the exit notice. EPIPE is the same launch only when both markers hold.
			if (!message.includes("EPIPE")) {
				expect(message).toMatch(/DAP adapter exited/);
			}
		},
		20_000,
	);

	it.skipIf(!POSIX_STUB)(
		"still launches a host-path gdb when the repository has no local gdb (skipped on win32: POSIX stub)",
		async () => {
			using tempDir = TempDir.createSync("@gjc-dap-trust-allowed-");
			const trustedMarker = tempDir.join("trusted-stub-ran");
			const repo = path.join(tempDir.path(), "repo");
			await fs.promises.mkdir(path.join(repo, ".git"), { recursive: true });
			await Bun.write(path.join(repo, "main.c"), "int main(void) { return 0; }\n");
			await Bun.write(path.join(repo, "go.mod"), "module example\n");
			const trustedBinary = tempDir.join("outside", "gdb");
			await writeStub(trustedBinary, trustedMarker);
			vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "gdb" ? trustedBinary : null));
			const tool = new DebugTool(sessionFor(repo));

			const selected = selectLaunchAdapter(path.join(repo, "main.c"), repo, "gdb");
			expect(selected?.resolvedCommand).toBe(trustedBinary);

			const message = await rejectedLaunchMessage(
				tool.execute("call-allowed", { action: "launch", program: "main.c", adapter: "gdb", timeout: 5 }),
			);
			expect(fs.existsSync(trustedMarker)).toBe(true);
			if (!message.includes("EPIPE")) {
				expect(message).toMatch(/DAP adapter exited/);
			}
		},
		20_000,
	);

	it.skipIf(!POSIX_STUB)(
		"does not spawn a PATH symlink whose target is inside the repository (skipped on win32: POSIX symlink)",
		async () => {
			using tempDir = TempDir.createSync("@gjc-dap-trust-symlink-");
			const marker = tempDir.join("project-stub-ran");
			const repo = await createRepository(
				tempDir.path(),
				{
					id: "symlink",
					adapter: "gdb",
					program: "main.c",
					programBody: "int main(void) { return 0; }\n",
					markers: { "go.mod": "module example\n" },
					stub: "bin/gdb",
				},
				marker,
			);
			const outsideLink = tempDir.join("outside", "gdb");
			await fs.promises.mkdir(path.dirname(outsideLink), { recursive: true });
			await fs.promises.symlink(path.join(repo, "bin/gdb"), outsideLink);
			vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "gdb" ? outsideLink : null));
			const tool = new DebugTool(sessionFor(repo));

			await expect(
				tool.execute("call-symlink", { action: "launch", program: "main.c", adapter: "gdb", timeout: 5 }),
			).rejects.toThrow(/No debugger adapter available/);
			expect(selectLaunchAdapter(path.join(repo, "main.c"), repo, "gdb")).toBeNull();
			expect(fs.existsSync(marker)).toBe(false);
		},
		20_000,
	);
});
