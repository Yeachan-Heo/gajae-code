import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as piUtils from "@gajae-code/utils";
import { TempDir } from "@gajae-code/utils";
import { Settings } from "../../src/config/settings";
import { selectLaunchAdapter } from "../../src/dap/config";
import { dapSessionManager } from "../../src/dap/session";
import type { ToolSession } from "../../src/tools";
import { DebugTool } from "../../src/tools/debug";

const PYTHON3 = piUtils.$which("python3");

function sessionFor(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "debug.enabled": true }),
	};
}

async function exitCode(command: string[], cwd?: string): Promise<number> {
	const child = Bun.spawn(command, { cwd, stdout: "ignore", stderr: "pipe" });
	return child.exited;
}

async function interpreterWithDebugpy(python3: string): Promise<string | null> {
	if ((await exitCode([python3, "-I", "-c", "import debugpy"])) === 0) return python3;
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "debugpy-site-"));
	const venv = path.join(root, "venv");
	if ((await exitCode([python3, "-m", "venv", venv])) !== 0) return null;
	const python = path.join(venv, "bin", "python");
	if ((await exitCode([python, "-m", "pip", "install", "--disable-pip-version-check", "debugpy"])) !== 0) {
		return null;
	}
	if ((await exitCode([python, "-I", "-c", "import debugpy"])) !== 0) return null;
	return python;
}

const DEBUGPY_PYTHON = PYTHON3 ? await interpreterWithDebugpy(PYTHON3) : null;

function resultText(result: { content?: Array<{ type?: string; text?: string }> }): string {
	return (result.content ?? [])
		.filter(part => part.type === "text" && typeof part.text === "string")
		.map(part => part.text)
		.join("\n");
}

afterEach(async () => {
	vi.restoreAllMocks();
	if (dapSessionManager.getActiveSession()) {
		await dapSessionManager.terminate(undefined, 1_000);
	}
});

describe("debugpy adapter isolated mode", () => {
	it.skipIf(!PYTHON3)(
		"does not import a repository debugpy package from a trusted python (skipped when python3 is absent)",
		async () => {
			if (!PYTHON3) throw new Error("python3 is absent");
			const python3 = PYTHON3;
			using tempDir = TempDir.createSync("@gjc-dap-trust-debugpy-module-");
			const marker = tempDir.join("project-debugpy-loaded");
			const repo = path.join(tempDir.path(), "repo");
			await fs.promises.mkdir(path.join(repo, ".git"), { recursive: true });
			await fs.promises.mkdir(path.join(repo, "debugpy"), { recursive: true });
			await Bun.write(path.join(repo, "pyproject.toml"), "[project]\nname = 'example'\n");
			await Bun.write(path.join(repo, "app.py"), "print(1)\n");
			const loader = `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("loaded\\n")\n`;
			await Bun.write(path.join(repo, "debugpy", "__init__.py"), loader);
			await Bun.write(path.join(repo, "debugpy", "adapter.py"), loader);
			vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "python" ? python3 : null));
			const tool = new DebugTool(sessionFor(repo));
			const selected = selectLaunchAdapter(path.join(repo, "app.py"), repo, "debugpy");
			expect(selected?.resolvedCommand).toBe(python3);

			let launchError: unknown;
			try {
				await tool.execute("call-debugpy-module", {
					action: "launch",
					program: "app.py",
					adapter: "debugpy",
					timeout: 5,
				});
			} catch (error) {
				launchError = error;
			}
			expect(fs.existsSync(marker)).toBe(false);
			if (launchError) {
				const message = launchError instanceof Error ? launchError.message : String(launchError);
				expect(message).not.toMatch(/No debugger adapter available/);
			}
			expect(selected?.args.slice(0, 3)).toEqual(["-I", "-m", "debugpy.adapter"]);
		},
		20_000,
	);

	it.skipIf(!DEBUGPY_PYTHON)(
		"still launches an interpreter-installed debugpy when the project has no debugpy package (skipped when that interpreter cannot be prepared)",
		async () => {
			if (!DEBUGPY_PYTHON) throw new Error("debugpy interpreter is absent");
			const python = DEBUGPY_PYTHON;
			using tempDir = TempDir.createSync("@gjc-dap-debugpy-installed-");
			const repo = path.join(tempDir.path(), "repo");
			await fs.promises.mkdir(path.join(repo, ".git"), { recursive: true });
			await Bun.write(path.join(repo, "pyproject.toml"), "[project]\nname = 'example'\n");
			await Bun.write(path.join(repo, "app.py"), "print(1)\n");
			vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "python" ? python : null));
			const tool = new DebugTool(sessionFor(repo));
			const selected = selectLaunchAdapter(path.join(repo, "app.py"), repo, "debugpy");
			expect(selected?.resolvedCommand).toBe(python);

			const launched = await tool.execute("call-debugpy-installed", {
				action: "launch",
				program: "app.py",
				adapter: "debugpy",
				timeout: 20,
			});
			const text = resultText(launched);
			expect(text).toContain("Adapter: debugpy");
			expect(text).toMatch(/Status: (stopped|running|configuring)/);
		},
		30_000,
	);
});
