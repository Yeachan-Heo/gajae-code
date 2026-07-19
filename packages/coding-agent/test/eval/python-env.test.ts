import { describe, expect, it } from "bun:test";
import {
	resolvePythonIntegrationGate,
	resolvePythonIpcTrace,
	resolvePythonSkipCheck,
} from "@gajae-code/coding-agent/tools";
import {
	resolvePythonIntegrationGate as resolveKernelIntegrationGate,
	resolvePythonIpcTrace as resolveKernelIpcTrace,
	resolvePythonSkipCheck as resolveKernelSkipCheck,
} from "../../src/eval/py/env";

const RESOLVERS = [
	{
		kernel: resolveKernelSkipCheck,
		tool: resolvePythonSkipCheck,
		gjc: "GJC_PYTHON_SKIP_CHECK",
		pi: "PI_PYTHON_SKIP_CHECK",
	},
	{
		kernel: resolveKernelIpcTrace,
		tool: resolvePythonIpcTrace,
		gjc: "GJC_PYTHON_IPC_TRACE",
		pi: "PI_PYTHON_IPC_TRACE",
	},
	{
		kernel: resolveKernelIntegrationGate,
		tool: resolvePythonIntegrationGate,
		gjc: "GJC_PYTHON_INTEGRATION",
		pi: "PI_PYTHON_INTEGRATION",
	},
] as const;

describe("Python environment flag resolvers", () => {
	it("shares the kernel resolver with tool exports for hostile GJC/PI values", () => {
		for (const { kernel, tool, gjc, pi } of RESOLVERS) {
			expect(tool).toBe(kernel);
			expect(tool({ [gjc]: "0", [pi]: "1" })).toBe(true);
			expect(tool({ [gjc]: " \tYeS\n" })).toBe(true);
			expect(tool({ [gjc]: "false", [pi]: " 0 " })).toBe(false);
		}
	});
});
