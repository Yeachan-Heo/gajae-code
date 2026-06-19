import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// Idle-RSS optimization: the eval tool (~23MB of module graph) must not be
// pulled into the tools barrel statically — it loads only when its factory is
// first invoked. These assertions lock that contract so a future refactor
// cannot silently re-add an eager import path.
const toolsIndexPath = path.join(import.meta.dir, "..", "src", "tools", "index.ts");
const toolsIndexSource = fs.readFileSync(toolsIndexPath, "utf8");
const evalModulePath = path.join(import.meta.dir, "..", "src", "tools", "eval.ts");
const evalModuleSource = fs.readFileSync(evalModulePath, "utf8");

describe("eval tool is lazy-loaded", () => {
	it("does not statically import EvalTool in the tools barrel", () => {
		expect(toolsIndexSource).not.toMatch(/import\s+\{[^}]*\bEvalTool\b[^}]*\}\s+from\s+["']\.\/eval["']/);
	});

	it("does not eagerly re-export the eval module from the barrel", () => {
		expect(toolsIndexSource).not.toMatch(/export\s+\*\s+from\s+["']\.\/eval["']/);
	});

	it("loads the eval module through a dynamic import in the eval factory", () => {
		expect(toolsIndexSource).toMatch(/import\(\s*["']\.\/eval["']\s*\)/);
	});

	it("does not statically import the python kernel preflight at module scope", () => {
		// The preflight import can transitively pull the eval tool tree; it must be
		// dynamically imported at its call site instead of at module scope.
		expect(toolsIndexSource).not.toMatch(/^import\s+\{[^}]*checkPythonKernelAvailability[^}]*\}\s+from/m);
	});

	it("defers the eval kernel backends so importing tools/eval is cheap", () => {
		// The heavy bit is the python/js execution kernels. eval.ts must NOT
		// statically import them; renderers.ts, sdk.ts and tool-execution.ts all
		// import from tools/eval at startup, so a static backend import there would
		// pull the ~23MB kernel graph into every session.
		expect(evalModuleSource).not.toMatch(
			/^import\s+\{[^}]*\b(jsBackend|pythonBackend)\b[^}]*\}\s+from\s+["']\.\.\/eval["']/m,
		);
		expect(evalModuleSource).toMatch(/await import\(\s*["']\.\.\/eval["']\s*\)/);
	});
});
