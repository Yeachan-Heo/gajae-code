import { describe, expect, it } from "bun:test";
import type { RpcUnattendedActionClass, RpcUnattendedDeclaration } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import {
	actionClassForScope,
	classifyBashAction,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-action-policy";
import {
	ActionDeniedError,
	ScopeDeniedError,
	UnattendedRunController,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-run-controller";

function controller(actions: string[], scopes: string[] = ["bash", "prompt"]) {
	const decl: RpcUnattendedDeclaration = {
		actor: "hermes",
		budget: { max_tokens: 1000, max_tool_calls: 10, max_wall_time_ms: 10_000, max_cost_usd: 5 },
		scopes,
		action_allowlist: actions,
	};
	return UnattendedRunController.negotiate(decl, {
		runId: "run-a",
		audit: () => {},
		providerSupportsTokenCostMetrics: true,
	});
}

describe("classifyBashAction", () => {
	const cases: Array<[string, RpcUnattendedActionClass]> = [
		["ls -la", "bash.readonly"],
		["cat file.txt | grep foo", "bash.readonly"],
		["git status", "bash.readonly"],
		["git commit -m x", "bash.mutating"],
		["npm install", "bash.mutating"],
		["echo hi > out.txt", "file.write"],
		["sed -i s/a/b/ f", "file.write"],
		["rm -rf build", "file.delete"],
		["unlink foo", "file.delete"],
		["git push --force origin main", "git.force_push"],
		["git push -f", "git.force_push"],
		["git reset --hard HEAD~1", "bash.destructive"],
		["dd if=/dev/zero of=/dev/sda", "bash.destructive"],
		["somethingunknown --flag", "bash.mutating"],
	];
	for (const [cmd, expected] of cases) {
		it(`classifies "${cmd}" as ${expected}`, () => {
			expect(classifyBashAction(cmd)).toBe(expected);
		});
	}

	it("returns the most severe class across compound statements", () => {
		expect(classifyBashAction("ls && git push --force")).toBe("git.force_push");
		expect(classifyBashAction("echo hi > f.txt && rm -rf d")).toBe("file.delete");
	});

	it("maps coarse scopes to command.<scope> classes", () => {
		expect(actionClassForScope("bash")).toBe("command.bash");
		expect(actionClassForScope("admin")).toBe("command.admin");
		expect(actionClassForScope("message:read")).toBe("command.message_read");
	});
});

describe("UnattendedRunController authorization (default-deny)", () => {
	it("denies an undeclared scope with a typed pre-side-effect error", () => {
		const c = controller(["bash.readonly"], ["prompt"]);
		try {
			c.authorizeScope("bash", "ls");
			throw new Error("expected scope denial");
		} catch (e) {
			expect(e).toBeInstanceOf(ScopeDeniedError);
			expect((e as ScopeDeniedError).payload).toMatchObject({
				code: "scope_denied",
				scope: "bash",
				pre_side_effect: true,
			});
		}
	});

	it("denies an undeclared action class (default-deny)", () => {
		const c = controller(["bash.readonly"]);
		expect(() => c.authorizeAction("file.delete")).toThrow(ActionDeniedError);
	});

	it("allows declared scope + action", () => {
		const c = controller(["bash.readonly"]);
		expect(() => c.authorizeScope("bash")).not.toThrow();
		expect(c.authorizeBash("ls -la")).toBe("bash.readonly");
	});

	it("authorizeBash denies a destructive command not in the allowlist", () => {
		const c = controller(["bash.readonly", "bash.mutating"]);
		expect(() => c.authorizeBash("git push --force")).toThrow(ActionDeniedError);
	});
});
