import { describe, expect, it } from "bun:test";
import { commands } from "../../src/cli";
import { classifyQuickLane } from "../../src/quick-lane/classify";

describe("quick-lane classifier (issue #3984)", () => {
	describe("quick-lane selection", () => {
		it("routes a bounded single-file fix with a named symbol to quick", () => {
			const decision = classifyQuickLane("add validation to processKeywordDetector");
			expect(decision.lane).toBe("quick");
			expect(decision.reasons).toContain("named symbol (camelCase / snake_case)");
			expect(decision.exclusions).toEqual([]);
		});

		it("routes an explicit file-path fix to quick", () => {
			const decision = classifyQuickLane("fix src/hooks/bridge.ts so it loads");
			expect(decision.lane).toBe("quick");
			expect(decision.reasons).toContain("explicit file path");
		});

		it("routes an issue-number task to quick", () => {
			const decision = classifyQuickLane("implement #42");
			expect(decision.lane).toBe("quick");
			expect(decision.reasons).toContain("issue/PR number");
		});

		it("routes numbered steps with acceptance intent to quick", () => {
			const decision = classifyQuickLane("do:\n1. Add input validation\n2. Write tests\nReturn true when valid");
			expect(decision.lane).toBe("quick");
			expect(decision.reasons).toContain("numbered steps");
		});

		it("routes an explicit test request to quick", () => {
			const decision = classifyQuickLane("add a regression test that covers the empty input");
			expect(decision.lane).toBe("quick");
			expect(decision.reasons).toContain("explicit test/validation request");
		});

		it("routes an escape-prefixed task to quick", () => {
			const decision = classifyQuickLane("force: fix the parser edge case");
			expect(decision.lane).toBe("quick");
			expect(decision.reasons).toContain("explicit quick-lane override (force: / !)");
		});

		it("routes a snake_case symbol fix to quick", () => {
			const decision = classifyQuickLane("fix normalize_record_fields");
			expect(decision.lane).toBe("quick");
			expect(decision.reasons).toContain("named symbol (camelCase / snake_case)");
		});
		it("routes a PascalCase symbol with two or more segments to quick", () => {
			const decision = classifyQuickLane("fix UserService");
			expect(decision.lane).toBe("quick");
			expect(decision.reasons).toContain("named symbol (PascalCase)");
			expect(decision.exclusions).toEqual([]);
		});

		it("routes an explicit test-runner invocation to quick", () => {
			for (const request of ["run pytest", "run cargo test", "run vitest", "run go test", "run bun test"]) {
				const decision = classifyQuickLane(request);
				expect(decision.lane).toBe("quick");
				expect(decision.reasons).toContain("test runner");
				expect(decision.exclusions).toEqual([]);
			}
		});

		it("routes a bang-prefixed task to quick", () => {
			const decision = classifyQuickLane("! fix the parser edge case");
			expect(decision.lane).toBe("quick");
			expect(decision.reasons).toContain("explicit quick-lane override (force: / !)");
		});

		it("routes a real issue reference but not a hex color to quick", () => {
			const decision = classifyQuickLane("implement #4146");
			expect(decision.lane).toBe("quick");
			expect(decision.reasons).toContain("issue/PR number");
		});
	});

	describe("deep-path preservation (exclusions)", () => {
		it("keeps a vague/exploratory request on the deep path", () => {
			const decision = classifyQuickLane("i have a vague idea and am not sure what i want");
			expect(decision.lane).toBe("deep");
			expect(decision.exclusions.some(e => e.includes("ambiguity"))).toBe(true);
		});

		it("keeps a brainstorming request on the deep path", () => {
			const decision = classifyQuickLane("explore whether we should add authentication");
			expect(decision.lane).toBe("deep");
		});

		it("keeps a risk/safety request on the deep path even with a concrete anchor", () => {
			const decision = classifyQuickLane("add authentication to src/auth.ts");
			expect(decision.lane).toBe("deep");
			expect(decision.exclusions.some(e => e.includes("risk"))).toBe(true);
		});

		it("keeps a migration request on the deep path", () => {
			const decision = classifyQuickLane("migrate the whole codebase to the new store");
			expect(decision.lane).toBe("deep");
			expect(decision.exclusions.some(e => e.includes("risk"))).toBe(true);
		});

		it("keeps a multi-file / cross-contract request on the deep path", () => {
			const decision = classifyQuickLane("refactor across multiple modules everywhere");
			expect(decision.lane).toBe("deep");
			expect(decision.exclusions.some(e => e.includes("breadth"))).toBe(true);
		});

		it("keeps a request with no concrete anchor on the deep path", () => {
			const decision = classifyQuickLane("make the app better");
			expect(decision.lane).toBe("deep");
			expect(decision.exclusions.some(e => e.includes("no concrete anchor"))).toBe(true);
		});

		it("treats an empty request as deep", () => {
			expect(classifyQuickLane("").lane).toBe("deep");
			expect(classifyQuickLane("   ").lane).toBe("deep");
		});
		it("keeps a hex-color token on the deep path with no issue-number reason", () => {
			for (const request of [
				"use color #123",
				"paint the button #1a2b3c",
				"use accent #abc12345",
				"set background #f00",
			]) {
				const decision = classifyQuickLane(request);
				expect(decision.lane).toBe("deep");
				expect(decision.reasons).toEqual([]);
			}
		});

		it("keeps single-segment proper nouns on the deep path", () => {
			for (const request of ["Google", "improve iPhone support", "rename the eCommerce page"]) {
				const decision = classifyQuickLane(request);
				expect(decision.lane).toBe("deep");
			}
		});

		it("does not treat a mid-text bang as a quick-lane override", () => {
			const decision = classifyQuickLane("fix this! now");
			expect(decision.lane).toBe("deep");
			expect(decision.exclusions.some(e => e.includes("no concrete anchor"))).toBe(true);
		});

		it("keeps a multi-file request on the deep path even with file-path anchors", () => {
			const decision = classifyQuickLane("update src/a.ts and src/b.ts");
			expect(decision.lane).toBe("deep");
			expect(decision.exclusions.some(e => e.includes("multi-file"))).toBe(true);
		});

		it("keeps a password-related request on the deep path even with a file-path anchor", () => {
			const decision = classifyQuickLane("change password validation in src/user.ts");
			expect(decision.lane).toBe("deep");
			expect(decision.exclusions.some(e => e.includes("risk"))).toBe(true);
		});

		it("keeps wide-breadth keywords on the deep path even with concrete anchors", () => {
			const requests = [
				"add a regression test for all modules",
				"improve error handling across modules",
				"use color #123 while redesigning the app",
				"redesign the entire app",
				"rewrite the store from scratch",
				"In packages/coding-agent/src/session/agent-session.ts, redesign the entire session lifecycle architecture across every provider",
				"Fix #4146 by rewriting the SDK broker from scratch and migrating all persisted state",
			];
			for (const request of requests) {
				const decision = classifyQuickLane(request);
				expect(decision.lane).toBe("deep");
				expect(decision.exclusions.some(e => e.includes("breadth"))).toBe(true);
			}
		});
	});

	describe("eligibility does not override safety exclusions", () => {
		it("never quick-lanes a risky task even when a file path is named", () => {
			const decision = classifyQuickLane("fix the vulnerability in utils/security.ts");
			expect(decision.lane).toBe("deep");
		});

		it("never quick-lanes a risky task even with an escape override", () => {
			const decision = classifyQuickLane("force: disable the security checks");
			expect(decision.lane).toBe("deep");
		});
	});

	describe("CLI surface", () => {
		it("registers the quick-lane command so gjc quick-lane resolves", () => {
			const entry = commands.find(c => c.name === "quick-lane");
			expect(entry).toBeDefined();
		});

		it("lazily resolves the quick-lane entry to the command class", async () => {
			const entry = commands.find(c => c.name === "quick-lane");
			const cmd = (await entry?.load()) as { description?: string } | undefined;
			expect(cmd).toBeDefined();
			expect(cmd?.description ?? "").toMatch(/quick lane/i);
		});
	});

	describe("examples from the routing gate", () => {
		it("matches the documented quick-lane example", () => {
			expect(classifyQuickLane("team fix src/hooks/bridge.ts").lane).toBe("quick");
		});
		it("matches the documented well-specified symbol example", () => {
			expect(classifyQuickLane("team add validation to processKeywordDetector").lane).toBe("quick");
		});
		it("matches the documented numbered-steps example", () => {
			expect(classifyQuickLane("team do:\n1. Add input validation\n2. Write tests").lane).toBe("quick");
		});
		it("matches the documented gated examples", () => {
			expect(classifyQuickLane("team fix this").lane).toBe("deep");
			expect(classifyQuickLane("team build the app").lane).toBe("deep");
			expect(classifyQuickLane("team improve performance").lane).toBe("deep");
			expect(classifyQuickLane("team add authentication").lane).toBe("deep");
			expect(classifyQuickLane("team make it better").lane).toBe("deep");
		});
	});
	describe("signed-review adversarial corpus (golden)", () => {
		const deepCases: Array<[string, string | null]> = [
			["add a regression test for all modules", "breadth"],
			["improve error handling across modules", "breadth"],
			["improve iPhone support", null],
			["use color #123 while redesigning the app", "breadth"],
			["update src/a.ts and src/b.ts", "multi-file"],
			["change password validation in src/user.ts", "risk"],
			[
				"In packages/coding-agent/src/session/agent-session.ts, redesign the entire session lifecycle architecture across every provider",
				"breadth",
			],
			["Fix #4146 by rewriting the SDK broker from scratch and migrating all persisted state", "breadth"],
			["Update parseConfig to change the on-disk format for all users and write a migration", "risk"],
			["fix this! now", null],
		];
		it.each(deepCases)("classifies %s as deep", (request, exclusionFragment) => {
			const decision = classifyQuickLane(request);
			expect(decision.lane).toBe("deep");
			expect(decision.reasons).toEqual([]);
			if (exclusionFragment === null) {
				expect(decision.exclusions.length).toBeGreaterThan(0);
			} else {
				expect(decision.exclusions.join(" ")).toContain(exclusionFragment);
			}
		});

		const quickCases: Array<[string, string]> = [
			["fix UserService", "named symbol (PascalCase)"],
			["run pytest", "test runner"],
			["run cargo test", "test runner"],
			["run vitest", "test runner"],
			["team implement #4146", "issue/PR number"],
			["! fix the parser edge case", "explicit quick-lane override"],
		];
		it.each(quickCases)("classifies %s as quick", (request, reasonFragment) => {
			const decision = classifyQuickLane(request);
			expect(decision.lane).toBe("quick");
			expect(decision.exclusions).toEqual([]);
			expect(decision.reasons.join(" ")).toContain(reasonFragment);
		});
	});
});
