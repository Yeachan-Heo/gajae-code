import { describe, expect, it } from "bun:test";
import { checkBashAllowedPrefixes } from "../../src/tools/bash-allowed-prefixes";

const ROLE_AGENT_PREFIXES = ["gjc ralplan --write", "gjc state"] as const;

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
