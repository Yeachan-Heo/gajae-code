import { describe, expect, it } from "bun:test";
import { parseArgs } from "../../src/cli/args";
import { buildDefaultTmuxLaunchPlan } from "../../src/gjc-runtime/launch-tmux";

describe("launch argv preservation", () => {
	it("does not add synthetic inline values to the caller argv", () => {
		const argv = ["--model=opus", "hello"];
		const parsed = parseArgs(argv);
		expect(parsed.model).toBe("opus");
		expect(parsed.messages).toEqual(["hello"]);
		expect(argv).toEqual(["--model=opus", "hello"]);
	});
	it("keeps parsing and child-relaunch parsing equivalent", () => {
		const argv = ["--model=opus", "hello"];
		const first = parseArgs(argv);
		const child = parseArgs([...argv]);
		expect(child.model).toBe(first.model);
		expect(child.messages).toEqual(first.messages);
	});
	it("preserves inline dash-prefixed prompt values during forwarding", () => {
		const argv = ["--append-system-prompt=- keep concise", "hello"];
		const first = parseArgs(argv);
		expect(first.appendSystemPrompt).toBe("- keep concise");
		expect(argv).toEqual(["--append-system-prompt=- keep concise", "hello"]);
		expect(parseArgs([...argv]).messages).toEqual(first.messages);
	});
	it("does not progressively duplicate multiple inline option values", () => {
		const argv = ["--model=opus", "--provider=anthropic", "hello"];
		const first = parseArgs(argv);
		expect(first).toMatchObject({
			model: "opus",
			provider: "anthropic",
			messages: ["hello"],
		});
		expect(parseArgs([...argv]).messages).toEqual(["hello"]);
		expect(argv).toEqual(["--model=opus", "--provider=anthropic", "hello"]);
	});
	it("preserves separate values and literal delimiter", () => {
		const argv = ["--model", "opus", "--", "--literal=hello", "@file.md"];
		expect(parseArgs(argv)).toMatchObject({
			model: "opus",
			messages: ["--literal=hello"],
			fileArgs: ["file.md"],
		});
		expect(argv).toEqual(["--model", "opus", "--", "--literal=hello", "@file.md"]);
	});
});

it("forwards inline values once through the actual tmux launch planner", () => {
	const rawArgs = ["--tmux", "--model=opus", "hello"];
	const parsed = parseArgs(rawArgs, "deferred");
	const plan = buildDefaultTmuxLaunchPlan({
		parsed,
		rawArgs,
		cwd: "/repo",
		env: { GJC_PSMUX_DETECTION: "off" },
		argv: ["bun", "packages/coding-agent/src/cli.ts"],
		execPath: "/bin/bun",
		platform: "darwin",
		tty: { stdin: true, stdout: true, columns: 80, rows: 24 },
		tmuxAvailable: true,
		currentBranch: "",
		existingBranchSessionName: null,
	});
	expect(plan?.innerCommand).toContain("'--model=opus' 'hello'");
	expect(plan?.innerCommand).not.toContain("'--model=opus' 'opus'");
	expect(rawArgs).toEqual(["--tmux", "--model=opus", "hello"]);
});
