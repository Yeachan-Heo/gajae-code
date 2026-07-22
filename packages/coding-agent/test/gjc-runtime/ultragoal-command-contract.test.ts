import { describe, expect, it } from "bun:test";
import { runNativeUltragoalCommand } from "../../src/gjc-runtime/ultragoal-runtime";
import { getSkillManifest, type TypedArgSpec, typedArgsFor } from "../../src/gjc-runtime/workflow-manifest";

function publicTypedArgs(verb: string): Array<Pick<TypedArgSpec, "name" | "type" | "enumValues" | "required">> {
	return typedArgsFor("ultragoal", verb)
		.filter(arg => arg.planned !== true)
		.map(({ name, type, enumValues, required }) => ({
			name,
			type,
			...(enumValues === undefined ? {} : { enumValues }),
			...(required === undefined ? {} : { required }),
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
}

describe("ultragoal terminal critic command contract", () => {
	it("publishes terminal critic verbs, typed arguments, and help", async () => {
		const commands = ["record-critic-verdict", "record-critic-gate-override"];

		expect(getSkillManifest("ultragoal").verbs.filter(verb => commands.includes(verb.name))).toEqual([
			{ name: "record-critic-verdict", surface: "command-positional" },
			{ name: "record-critic-gate-override", surface: "command-positional" },
		]);
		expect(publicTypedArgs("record-critic-verdict")).toEqual([
			{ name: "blockers-json", type: "string" },
			{ name: "classification-event-id", type: "string" },
			{ name: "evidence", type: "string", required: true },
			{ name: "goal-id", type: "string" },
			{ name: "json", type: "boolean" },
			{ name: "terminus", type: "enum", enumValues: ["completion", "pause"], required: true },
			{ name: "verdict", type: "enum", enumValues: ["OKAY", "ITERATE", "REJECT"], required: true },
		]);
		expect(publicTypedArgs("record-critic-gate-override")).toEqual([
			{ name: "evidence", type: "string", required: true },
			{ name: "json", type: "boolean" },
		]);

		const cwd = process.cwd();
		const topLevel = await runNativeUltragoalCommand(["--help"], cwd);
		const verdict = await runNativeUltragoalCommand(["record-critic-verdict", "--help"], cwd);
		const override = await runNativeUltragoalCommand(["record-critic-gate-override", "--help"], cwd);
		const classifyBlocker = await runNativeUltragoalCommand(["classify-blocker", "--help"], cwd);

		expect(topLevel.status).toBe(0);
		expect(topLevel.stdout).toContain("record-critic-verdict");
		expect(topLevel.stdout).toContain("record-critic-gate-override");

		expect(verdict.status).toBe(0);
		expect(verdict.stdout).toContain(
			"gjc ultragoal record-critic-verdict --terminus <completion|pause> --verdict <OKAY|ITERATE|REJECT> --evidence <text>",
		);
		expect(verdict.stdout).toContain("--blockers-json=<value>");
		expect(verdict.stdout).toContain("--goal-id=<value>");
		expect(verdict.stdout).toContain("--classification-event-id=<id>");
		expect(verdict.stdout).toContain("--json");
		expect(verdict.stdout).toContain("completion or pause");
		expect(verdict.stdout).toContain("OKAY, ITERATE, or REJECT");

		expect(override.status).toBe(0);
		expect(override.stdout).toContain("gjc ultragoal record-critic-gate-override --evidence <text> [--json]");
		expect(override.stdout).toContain("--evidence=<value>");
		expect(override.stdout).toContain("--json");

		expect(classifyBlocker.status).toBe(0);
		expect(classifyBlocker.stdout).toContain("latest blocker_classified event");
		expect(classifyBlocker.stdout).toContain("later bound clean pause terminal critic OKAY verdict");
		expect(classifyBlocker.stdout).not.toContain("latest ledger event");
	});
});
