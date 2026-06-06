import { describe, expect, it } from "bun:test";
import type { RpcUnattendedActionClass, RpcUnattendedDeclaration } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import { classifyBashAction } from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-action-policy";
import {
	ActionDeniedError,
	UnattendedRunController,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-run-controller";

function readonlyOnlyController() {
	const decl: RpcUnattendedDeclaration = {
		actor: "redteam",
		budget: { max_tokens: 1000, max_tool_calls: 10, max_wall_time_ms: 10_000, max_cost_usd: 5 },
		scopes: ["bash"],
		action_allowlist: ["bash.readonly"],
	};
	return UnattendedRunController.negotiate(decl, {
		runId: "run-redteam",
		audit: () => {},
		providerSupportsTokenCostMetrics: true,
	});
}

type RedteamCase = {
	name: string;
	command: string;
	expected: RpcUnattendedActionClass;
};

const redteamCases: RedteamCase[] = [
	{ name: "env-var prefix delete", command: "FOO=bar rm -rf x", expected: "file.delete" },
	{ name: "leading sudo delete", command: "sudo rm -rf x", expected: "file.delete" },
	{ name: "xargs delete", command: "xargs rm", expected: "file.delete" },
	{ name: "command substitution delete", command: "echo $(rm -rf x)", expected: "file.delete" },
	{ name: "backtick substitution delete", command: "echo `rm -rf x`", expected: "file.delete" },
	{ name: "newline compound delete", command: "ls\nrm -rf x", expected: "file.delete" },
	{ name: "force-with-lease push", command: "git push --force-with-lease", expected: "git.force_push" },
	{ name: "plus-ref push", command: "git push origin +main", expected: "git.force_push" },
	{ name: "truncate write", command: "truncate -s 0 file", expected: "bash.mutating" },
	{ name: "bare output redirection", command: "> file", expected: "file.write" },
	{ name: "stdout output redirection", command: "echo hi > file", expected: "file.write" },
	{ name: "append output redirection", command: "echo hi >> file", expected: "file.write" },
	{ name: "fd-qualified output redirection", command: "echo hi 1>file", expected: "file.write" },
	{ name: "fd-qualified append redirection", command: "echo err 2>>err.log", expected: "file.write" },
	{
		name: "git clone (unlisted subcommand)",
		command: "git clone https://example.com/r.git d",
		expected: "bash.mutating",
	},
	{ name: "git init (unlisted subcommand)", command: "git init", expected: "bash.mutating" },
	{ name: "git worktree add", command: "git worktree add ../wt", expected: "bash.mutating" },
	{ name: "git -C global option force push", command: "git -C repo push --force", expected: "git.force_push" },
	{ name: "git push --delete remote branch", command: "git push --delete origin old", expected: "git.force_push" },
	{ name: "sort -o output write", command: "sort -o out.txt in.txt", expected: "file.write" },
	{ name: "uniq two-operand write", command: "uniq in.txt out.txt", expected: "file.write" },
	{ name: "date set system time", command: "date 010101012030", expected: "bash.mutating" },
	{ name: "git diff --output file write", command: "git diff --output=/tmp/x", expected: "file.write" },
];

describe("#319 bash classifier red-team evasion attempts", () => {
	for (const { name, command, expected } of redteamCases) {
		it(`${name}: classifies ${JSON.stringify(command)} as ${expected} and denies with readonly-only allowlist`, () => {
			expect(classifyBashAction(command)).toBe(expected);
			expect(() => readonlyOnlyController().authorizeBash(command)).toThrow(ActionDeniedError);
		});
	}

	it("benign ls remains readonly and is allowed by a readonly-only controller", () => {
		expect(classifyBashAction("ls")).toBe("bash.readonly");
		expect(readonlyOnlyController().authorizeBash("ls")).toBe("bash.readonly");
	});
});
