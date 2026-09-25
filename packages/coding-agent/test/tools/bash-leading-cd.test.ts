import { describe, expect, it } from "bun:test";
import { extractLeadingCdCwd } from "@gajae-code/coding-agent/tools/bash";

describe("extractLeadingCdCwd", () => {
	it("lifts a bare single-word directory", () => {
		expect(extractLeadingCdCwd("cd packages/coding-agent && bun test")).toEqual({
			cwd: "packages/coding-agent",
			command: "bun test",
		});
	});

	it("unquotes double- and single-quoted directories with spaces", () => {
		expect(extractLeadingCdCwd('cd "my dir" && ls')).toEqual({ cwd: "my dir", command: "ls" });
		expect(extractLeadingCdCwd("cd 'my dir' && ls")).toEqual({ cwd: "my dir", command: "ls" });
	});

	it("resolves backslash-escaped spaces in a bare word", () => {
		expect(extractLeadingCdCwd("cd my\\ dir && ls")).toEqual({ cwd: "my dir", command: "ls" });
	});

	it.each([
		["a stderr redirect", "cd /repo 2>/dev/null && pwd"],
		["a chained fallback", "cd ~ ; gh api repos/x && echo ok"],
		["an || fallback", "cd /repo || mkdir -p /repo && cd /repo"],
		["a variable expansion", "cd $HOME/work && ls"],
		["a glob", "cd pkg* && ls"],
		["command substitution", "cd $(git rev-parse --show-toplevel) && ls"],
		["a multiline script", "cd /repo\necho a && echo b"],
		["a bare cd", "cd && ls"],
	])("leaves %s to the shell", (_label, command) => {
		expect(extractLeadingCdCwd(command)).toBeUndefined();
	});
});
