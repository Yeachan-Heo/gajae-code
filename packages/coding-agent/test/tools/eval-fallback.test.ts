import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";

import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as evalIndex from "@gajae-code/coding-agent/eval";
import * as pyKernel from "@gajae-code/coding-agent/eval/py/kernel";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { EvalTool } from "@gajae-code/coding-agent/tools/eval";

function makeSession(settings = Settings.isolated()): ToolSession {
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
	};
}

const mockResult = {
	output: "ok",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	artifactId: undefined,
	totalLines: 1,
	totalBytes: 2,
	outputLines: 1,
	outputBytes: 2,
	displayOutputs: [],
};

const ENV_KEYS = ["GJC_PY", "PI_PY", "PI_JS"] as const;

function snapshotEnv(): Map<string, string | undefined> {
	return new Map(ENV_KEYS.map(key => [key, Bun.env[key]]));
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
	for (const key of ENV_KEYS) {
		const value = snapshot.get(key);
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
}

function clearEnv(): void {
	for (const key of ENV_KEYS) delete Bun.env[key];
}

describe("EvalTool language dispatch", () => {
	let previousEnv = new Map<string, string | undefined>();

	beforeEach(() => {
		previousEnv = snapshotEnv();
		clearEnv();
	});

	afterEach(() => {
		restoreEnv(previousEnv);
		vi.restoreAllMocks();
	});
	it("restores a pre-existing GJC_PY value after cleanup", () => {
		const suiteEnv = snapshotEnv();
		try {
			Bun.env.GJC_PY = "hostile-value";
			const testEnv = snapshotEnv();
			delete Bun.env.GJC_PY;
			restoreEnv(testEnv);
			expect(String(Bun.env.GJC_PY)).toBe("hostile-value");
		} finally {
			restoreEnv(suiteEnv);
		}
	});
	it('dispatches to the JS backend when cell.language === "js"', async () => {
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(mockResult);
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute");

		const tool = new EvalTool(makeSession());
		await tool.execute("call-js", {
			cells: [{ language: "js", code: "const x = 1;" }],
		});

		expect(jsExecuteSpy).toHaveBeenCalledTimes(1);
		expect(pythonExecuteSpy).not.toHaveBeenCalled();
	});

	it('dispatches to the Python backend when cell.language === "py"', async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.pythonBackend, "isAvailable").mockResolvedValue(true);
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute");

		const tool = new EvalTool(makeSession());
		await tool.execute("call-py", {
			cells: [{ language: "py", code: "print('hi')" }],
		});

		expect(pythonExecuteSpy).toHaveBeenCalledTimes(1);
		expect(jsExecuteSpy).not.toHaveBeenCalled();
	});

	it("interleaves backends across cells in a single call", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.pythonBackend, "isAvailable").mockResolvedValue(true);
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(mockResult);

		const tool = new EvalTool(makeSession());
		await tool.execute("call-mixed", {
			cells: [
				{ language: "py", code: "x = 1" },
				{ language: "js", code: "const y = 2;" },
			],
		});

		expect(pythonExecuteSpy).toHaveBeenCalledTimes(1);
		expect(jsExecuteSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects py cells when eval.py is disabled", async () => {
		const settings = Settings.isolated();
		settings.set("eval.py", false);
		const tool = new EvalTool(makeSession(settings));
		await expect(
			tool.execute("call-py-disabled", {
				cells: [{ language: "py", code: "print('hi')" }],
			}),
		).rejects.toThrow(/eval\.py = false/);
	});

	it("rejects py cells when GJC_PY selects JavaScript only", async () => {
		Bun.env.GJC_PY = "js";
		const tool = new EvalTool(makeSession());
		await expect(
			tool.execute("call-py-env-disabled", {
				cells: [{ language: "py", code: "print('hi')" }],
			}),
		).rejects.toThrow(/eval\.py = false/);
	});

	it("rejects js cells when eval.js is disabled", async () => {
		const settings = Settings.isolated();
		settings.set("eval.js", false);
		const tool = new EvalTool(makeSession(settings));
		await expect(
			tool.execute("call-js-disabled", {
				cells: [{ language: "js", code: "const x = 1;" }],
			}),
		).rejects.toThrow(/eval\.js = false/);
	});

	it("rejects js cells when GJC_PY selects Python only", async () => {
		Bun.env.GJC_PY = "py";
		const tool = new EvalTool(makeSession());
		await expect(
			tool.execute("call-js-env-disabled", {
				cells: [{ language: "js", code: "const x = 1;" }],
			}),
		).rejects.toThrow(/eval\.js = false/);
	});
});
