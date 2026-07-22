import { describe, expect, it } from "bun:test";
import { classifyStateArgv } from "../../src/gjc-runtime/state-argv";
import { checkBashAllowedPrefixes } from "../../src/tools/bash-allowed-prefixes";

const ROLE_AGENT_PREFIXES = ["gjc ralplan --write", "gjc state"] as const;
describe("shared state argv classification", () => {
	it("preserves argv and runtime first-occurrence precedence", () => {
		const argv = ["write", "--mode", "", "--mode", "ralplan", "--input", "{}"];
		const classification = classifyStateArgv(argv);

		expect(classification.argv).toEqual(argv);
		expect(classification.action).toBe("write");
		expect(classification.effectiveAction).toBe("write");
		expect(classification.runtimeSelectorCandidates.map(candidate => candidate.value)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	it("classifies read migration by its runtime-effective action", () => {
		const classification = classifyStateArgv(["ralplan", "read", "--migrate", "--force"]);

		expect(classification.action).toBe("read");
		expect(classification.effectiveAction).toBe("migrate");
		expect(classification.runtimeSelectorCandidates.find(candidate => candidate.value)?.value).toBe("ralplan");
	});
	it("retains positional metadata while ignoring empty positional selectors", () => {
		const explicitSkill = classifyStateArgv(["ralplan", "", "--json"]);
		expect(explicitSkill.runtimeSelectorCandidates[1]).toEqual({
			source: "positional",
			value: "ralplan",
			index: 0,
		});

		const emptyActionSelector = classifyStateArgv(["read", "", "--json"]);
		expect(emptyActionSelector.positionalSkill).toBeUndefined();
		expect(emptyActionSelector.runtimeSelectorCandidates[1]).toEqual({
			source: "positional",
			value: undefined,
			index: -1,
		});
	});

	it("classifies known manifest flags with their declared arity", () => {
		const classification = classifyStateArgv(["write", "--mode", "ralplan", "--args", "manifest-value", "--json"]);

		expect(classification.unknownFlags).toEqual([]);
		expect(classification.flags.find(flag => flag.name === "--args")).toMatchObject({
			arity: "value",
			value: "manifest-value",
			malformed: false,
		});
		expect(classification.flags.find(flag => flag.name === "--json")).toMatchObject({
			arity: "boolean",
			malformed: false,
		});
	});

	it("keeps classifier-effective actions and restricted policy decisions conformant", () => {
		const cases = [
			{
				command: "gjc state read --mode ralplan --json",
				argv: ["read", "--mode", "ralplan", "--json"],
				effectiveAction: "read",
				allowed: true,
			},
			{
				command: "gjc state ralplan read --migrate --force --json",
				argv: ["ralplan", "read", "--migrate", "--force", "--json"],
				effectiveAction: "migrate",
				allowed: false,
			},
			{
				command: "gjc state clear --mode ralplan --json",
				argv: ["clear", "--mode", "ralplan", "--json"],
				effectiveAction: "clear",
				allowed: false,
			},
		] as const;

		for (const testCase of cases) {
			expect(classifyStateArgv(testCase.argv).effectiveAction).toBe(testCase.effectiveAction);
			expect(checkBashAllowedPrefixes(testCase.command, ROLE_AGENT_PREFIXES).allowed).toBe(testCase.allowed);
		}
	});
});

describe("checkBashAllowedPrefixes", () => {
	it("allows ralplan artifact writes for role agents", () => {
		expect(
			checkBashAllowedPrefixes(
				"gjc ralplan --write --stage architect --stage_n 1 --artifact 'Architect verdict'",
				ROLE_AGENT_PREFIXES,
			),
		).toEqual({ allowed: true });
	});

	it("allows ralplan artifact env writes for role agents", () => {
		expect(
			checkBashAllowedPrefixes(
				"gjc ralplan --write --stage critic --stage_n 1 --artifact-env GJC_RALPLAN_ARTIFACT --json",
				ROLE_AGENT_PREFIXES,
			),
		).toEqual({ allowed: true });
	});

	it("blocks non-write ralplan commands", () => {
		const result = checkBashAllowedPrefixes("gjc ralplan --consensus 'task'", ROLE_AGENT_PREFIXES);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("gjc ralplan --write");
	});

	it("allows GJC state writes through the sanctioned workflow CLI", () => {
		expect(
			checkBashAllowedPrefixes(
				'gjc state ralplan write --input \'{"current_phase":"handoff"}\' --json',
				ROLE_AGENT_PREFIXES,
			),
		).toEqual({ allowed: true });
	});
	it("allows canonical GJC state reads, writes, and contracts", () => {
		const commands = [
			"gjc state deep-interview",
			"gjc state read --mode ralplan --json",
			'gjc state ultragoal write --input \'{"current_phase":"handoff"}\' --json',
			"gjc state team contract",
		];

		for (const command of commands) {
			expect(checkBashAllowedPrefixes(command, ROLE_AGENT_PREFIXES)).toEqual({ allowed: true });
		}
	});

	it("blocks bare or unknown GJC state targets", () => {
		const commands = ["gjc state", "gjc state unknown write --json", "gjc state write --mode unknown --input '{}'"];

		for (const command of commands) {
			const result = checkBashAllowedPrefixes(command, ROLE_AGENT_PREFIXES);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("canonical workflow skill");
		}
	});
	it("blocks equals-form state modes that the runtime does not recognize", () => {
		const result = checkBashAllowedPrefixes("gjc state write --mode=ralplan --input '{}'", ROLE_AGENT_PREFIXES);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("documented `gjc state` action shapes");
	});

	it("blocks destructive state clears", () => {
		const result = checkBashAllowedPrefixes("gjc state ralplan clear --json", ROLE_AGENT_PREFIXES);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("gjc state clear");
	});

	it("blocks direct GJC state handoffs", () => {
		const result = checkBashAllowedPrefixes("gjc state ralplan handoff --to team --json", ROLE_AGENT_PREFIXES);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("gjc state handoff");
	});
	it("preserves empty quoted argv values when classifying destructive state actions", () => {
		const commands = [
			'gjc state --thread-id "" handoff ralplan --to team --session-id SESSION --json',
			"gjc state --thread-id '' clear ralplan --session-id SESSION --json",
		];

		for (const command of commands) {
			const direct = command.replace(/--thread-id (?:''|"") /u, "");
			expect(checkBashAllowedPrefixes(command, ROLE_AGENT_PREFIXES).allowed).toBe(false);
			expect(checkBashAllowedPrefixes(direct, ROLE_AGENT_PREFIXES).allowed).toBe(false);
		}
	});

	it("blocks state modifiers that change the runtime-effective action", () => {
		const result = checkBashAllowedPrefixes("gjc state ralplan read --migrate --force --json", ROLE_AGENT_PREFIXES);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("gjc state migrate");
	});

	it("allows agreeing canonical state targets across distinct selector sources", () => {
		const result = checkBashAllowedPrefixes(
			`gjc state ralplan write --input '{"mode":"ralplan","current_phase":"handoff"}' --json`,
			ROLE_AGENT_PREFIXES,
		);

		expect(result).toEqual({ allowed: true });
	});
	it("fails closed when canonical state target selectors conflict", () => {
		const commands = [
			"gjc state ralplan write --mode team --input '{}'",
			"gjc state write --mode ralplan --mode team --input '{}'",
		];

		for (const command of commands) {
			const result = checkBashAllowedPrefixes(command, ROLE_AGENT_PREFIXES);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("conflicting");
		}
	});
	it("rejects repeated selectors when runtime first-occurrence precedence differs", () => {
		const commands = [
			`gjc state write --mode "" --mode ralplan --input '{"current_phase":"handoff"}' --json`,
			`gjc state write --input '{}' --input '{"mode":"ralplan","current_phase":"handoff"}' --json`,
			"gjc state write --mode '' --mode ralplan --input '{}'",
			"gjc state write --mode ralplan --mode ralplan --input '{}'",
			"gjc state write --mode ralplan --input '{}' --input '{}'",
			"gjc state write --mode ralplan --input \"\" --input '{}'",
			"gjc state write --mode ralplan --input '' --input '{}'",
		];

		for (const command of commands) {
			const result = checkBashAllowedPrefixes(command, ROLE_AGENT_PREFIXES);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("repeated");
		}
	});

	it("rejects selectors that disagree with runtime precedence", () => {
		const commands = [
			"gjc state write team --mode ralplan --input '{}'",
			'gjc state write --mode ralplan --input \'{"mode":"team"}\'',
		];

		for (const command of commands) {
			const result = checkBashAllowedPrefixes(command, ROLE_AGENT_PREFIXES);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("disagree");
		}
	});

	it("rejects unknown and malformed state flags", () => {
		const commands = [
			"gjc state ralplan read --unknown",
			"gjc state ralplan write --mode",
			"gjc state ralplan write --input",
		];

		for (const command of commands) {
			const result = checkBashAllowedPrefixes(command, ROLE_AGENT_PREFIXES);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("documented `gjc state` action shapes");
		}
	});
	it("rejects file-backed state input", () => {
		const result = checkBashAllowedPrefixes(
			"gjc state write --mode ralplan --input @payload.json",
			ROLE_AGENT_PREFIXES,
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("file-backed");
	});

	it("blocks destructive actions after every empty quoted selector value", () => {
		const quoteForms = ['""', "''"];
		const selectors = ["--thread-id", "--turn-id", "--session-id"];

		for (const action of ["clear", "handoff"]) {
			for (const selector of selectors) {
				for (const empty of quoteForms) {
					const suffix = action === "handoff" ? "--to team" : "--json";
					const command = `gjc state ${selector} ${empty} ${action} ralplan ${suffix}`;
					expect(checkBashAllowedPrefixes(command, ROLE_AGENT_PREFIXES).allowed).toBe(false);
				}
			}
		}
	});

	it("blocks shell expansion that could synthesize a state action", () => {
		const result = checkBashAllowedPrefixes("gjc state ralplan $ACTION --json", ROLE_AGENT_PREFIXES);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("shell expansion character");
	});

	it("blocks double-quoted shell expansion that could synthesize a state action", () => {
		const dollar = "$";
		const result = checkBashAllowedPrefixes(
			`gjc state "${dollar}{X:-handoff}" --mode ralplan --to team`,
			ROLE_AGENT_PREFIXES,
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("shell expansion character");
	});

	it("blocks backslash escape smuggling", () => {
		const result = checkBashAllowedPrefixes("gjc state ralplan\\ clear --json", ROLE_AGENT_PREFIXES);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("backslash escapes");
	});

	it("blocks malformed or unknown state action shapes", () => {
		const result = checkBashAllowedPrefixes("gjc state ralplan nope --json", ROLE_AGENT_PREFIXES);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("documented `gjc state` action shapes");
	});

	it("blocks shell chaining that could smuggle destructive commands", () => {
		const result = checkBashAllowedPrefixes(
			"gjc ralplan --write --stage critic --artifact ok; rm -rf .gjc",
			ROLE_AGENT_PREFIXES,
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("shell control operator");
	});

	it("blocks ordinary shell commands for restricted role agents", () => {
		const result = checkBashAllowedPrefixes("echo verdict", ROLE_AGENT_PREFIXES);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("restricted role-agent bash only allows commands starting with");
	});
});
