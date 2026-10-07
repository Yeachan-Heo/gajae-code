import { describe, expect, it } from "bun:test";
import { substitutePluginRoot } from "@gajae-code/coding-agent/discovery/substitute-plugin-root";

// Use concatenation to avoid noTemplateCurlyInString lint rule on literal placeholder names
const CLAUDE_VAR = "$" + "{CLAUDE_PLUGIN_ROOT}";
const GJC_VAR = "$" + "{GJC_PLUGIN_ROOT}";

describe("substitutePluginRoot", () => {
	const ROOT = "/plugins/my-plugin";

	it("replaces CLAUDE_PLUGIN_ROOT in strings", () => {
		expect(substitutePluginRoot(`${CLAUDE_VAR}/bin/server`, ROOT)).toBe("/plugins/my-plugin/bin/server");
	});

	it("replaces GJC_PLUGIN_ROOT in strings", () => {
		expect(substitutePluginRoot(`${GJC_VAR}/bin/server`, ROOT)).toBe("/plugins/my-plugin/bin/server");
	});

	it("replaces both variables in same string", () => {
		expect(substitutePluginRoot(`${CLAUDE_VAR}:${GJC_VAR}`, ROOT)).toBe("/plugins/my-plugin:/plugins/my-plugin");
	});

	it("handles arrays recursively", () => {
		expect(substitutePluginRoot(["--config", `${CLAUDE_VAR}/config.json`], ROOT)).toEqual([
			"--config",
			"/plugins/my-plugin/config.json",
		]);
	});

	it("handles objects recursively", () => {
		expect(substitutePluginRoot({ PATH: `${CLAUDE_VAR}/bin` }, ROOT)).toEqual({
			PATH: "/plugins/my-plugin/bin",
		});
	});

	it("handles nested structures", () => {
		const input = {
			command: `${CLAUDE_VAR}/server`,
			args: ["--port", "3000"],
			env: { HOME: GJC_VAR },
		};
		expect(substitutePluginRoot(input, ROOT)).toEqual({
			command: "/plugins/my-plugin/server",
			args: ["--port", "3000"],
			env: { HOME: "/plugins/my-plugin" },
		});
	});

	it("passes through non-string primitives", () => {
		expect(substitutePluginRoot(42, ROOT)).toBe(42);
		expect(substitutePluginRoot(true, ROOT)).toBe(true);
		expect(substitutePluginRoot(null, ROOT)).toBeNull();
		expect(substitutePluginRoot(undefined, ROOT)).toBeUndefined();
	});

	it("returns string unchanged when no variables present", () => {
		expect(substitutePluginRoot("no-vars-here", ROOT)).toBe("no-vars-here");
	});
	it("inserts an install path containing replacement-pattern characters verbatim", () => {
		// A string replacement would expand `$&`, `$$`, `` $` `` and `$'` inside the
		// path: `a$&b` became `a${CLAUDE_PLUGIN_ROOT}b`, `x$`y` lost `$`y`, and `q$'z`
		// spliced the remainder of the template into the middle of the path.
		for (const root of ["/plugins/a$&b", "/plugins/x$$y", "/plugins/x$`y", "/plugins/q$'z", "/plugins/$1"]) {
			expect(substitutePluginRoot(`${CLAUDE_VAR}/bin/server`, root)).toBe(`${root}/bin/server`);
			expect(substitutePluginRoot(`${GJC_VAR}/bin/server`, root)).toBe(`${root}/bin/server`);
			expect(substitutePluginRoot([`--config=${CLAUDE_VAR}/c.json`], root)).toEqual([`--config=${root}/c.json`]);
		}
	});
});
