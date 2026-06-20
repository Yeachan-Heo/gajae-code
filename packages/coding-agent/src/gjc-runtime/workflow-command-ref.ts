import { CANONICAL_GJC_WORKFLOW_SKILLS, type CanonicalGjcWorkflowSkill } from "../skill-state/canonical-skills";

export type CommandRefVisibility = "public" | "hidden" | "planned";
export type CommandRefIncludeWhen = "implemented-only" | "planned";

export interface CommandRefCommand {
	tokens: string[];
	rendered: string;
	visibility: CommandRefVisibility;
	includeWhen: CommandRefIncludeWhen;
	note?: string;
}

export interface CommandRefExample {
	label?: string;
	bytes: string;
}

export interface CommandRefBridge {
	from: string;
	to: string;
	rendered: string;
}

export interface CommandRefBlock {
	skill: CanonicalGjcWorkflowSkill;
	blockId: string;
	sourcePath: string;
	renderOrder: number;
	markers: {
		start: string;
		end: string;
	};
	commands: CommandRefCommand[];
	examples: CommandRefExample[];
	aliasesAndBridges: CommandRefBridge[];
	notes: string[];
}

export interface RenderedCommandRefBlock {
	skill: CanonicalGjcWorkflowSkill;
	blockId: string;
	markers: CommandRefBlock["markers"];
	bytes: string;
}

const skillPath = (skill: CanonicalGjcWorkflowSkill): string =>
	`packages/coding-agent/src/defaults/gjc/skills/${skill}/SKILL.md`;

const stateWrite = (skill: CanonicalGjcWorkflowSkill): CommandRefCommand => ({
	tokens: ["gjc", "state", skill, "write", "--input", `'{"current_phase":"handoff"}'`, "--json"],
	rendered: `gjc state ${skill} write --input '{"current_phase":"handoff"}' --json`,
	visibility: "public",
	includeWhen: "implemented-only",
	note: "Marks the workflow ready for the skill-tool chain guard.",
});

const stateHandoff = (
	skill: CanonicalGjcWorkflowSkill,
	targets: readonly CanonicalGjcWorkflowSkill[],
): CommandRefCommand => ({
	tokens: ["gjc", "state", skill, "handoff", "--to", `<${targets.join("|")}>`, "--json"],
	rendered: `gjc state ${skill} handoff --to <${targets.join("|")}> --json`,
	visibility: "public",
	includeWhen: "implemented-only",
	note: "Bridge command run in-process by the skill tool after slash-skill dispatch.",
});

export const WORKFLOW_COMMAND_REF_BLOCKS: readonly CommandRefBlock[] = [
	{
		skill: "deep-interview",
		blockId: "state",
		sourcePath: skillPath("deep-interview"),
		renderOrder: 10,
		markers: {
			start: "<!-- gjc:cmdref:start state -->",
			end: "<!-- gjc:cmdref:end state -->",
		},
		commands: [
			stateWrite("deep-interview"),
			{
				tokens: [
					"gjc",
					"deep-interview",
					"--write",
					"--stage",
					"final",
					"--slug",
					"{slug}",
					"--spec",
					"<markdown-or-path>",
					"--deliberate",
					"--json",
				],
				rendered:
					"gjc deep-interview --write --stage final --slug {slug} --spec <markdown-or-path> --deliberate --json",
				visibility: "public",
				includeWhen: "implemented-only",
				note: "Sanctioned deliberate deep-interview to ralplan bridge.",
			},
		],
		examples: [
			{
				label: "handoff state write",
				bytes: '```\ngjc state deep-interview write --input \'{"current_phase":"handoff"}\' --json\n```',
			},
			{
				label: "deliberate bridge",
				bytes: "```\ngjc \\\ndeep-interview --write --stage final --slug {slug} --spec <markdown-or-path> --deliberate --json\n```",
			},
		],
		aliasesAndBridges: [
			{
				from: "deep-interview",
				to: "ralplan",
				rendered:
					"gjc deep-interview --write --stage final --slug {slug} --spec <markdown-or-path> --deliberate --json",
			},
		],
		notes: [
			"Before invoking `/skill:ralplan`, `/skill:team`, or `/skill:ultragoal`, persist the final spec and mark deep-interview ready for handoff.",
		],
	},
	{
		skill: "ralplan",
		blockId: "state",
		sourcePath: skillPath("ralplan"),
		renderOrder: 10,
		markers: { start: "<!-- gjc:cmdref:start state -->", end: "<!-- gjc:cmdref:end state -->" },
		commands: [stateWrite("ralplan"), stateHandoff("ralplan", ["team", "ultragoal"])],
		examples: [
			{
				label: "handoff state write",
				bytes: '```\ngjc state ralplan write --input \'{"current_phase":"handoff"}\' --json\n```',
			},
		],
		aliasesAndBridges: [
			{ from: "ralplan", to: "team|ultragoal", rendered: "gjc state ralplan handoff --to <team|ultragoal> --json" },
		],
		notes: [
			"Before invoking `/skill:team` or `/skill:ultragoal`, mark ralplan ready for handoff so the skill tool's chain guard permits the transition.",
		],
	},
	{
		skill: "ultragoal",
		blockId: "state",
		sourcePath: skillPath("ultragoal"),
		renderOrder: 10,
		markers: { start: "<!-- gjc:cmdref:start state -->", end: "<!-- gjc:cmdref:end state -->" },
		commands: [stateWrite("ultragoal"), stateHandoff("ultragoal", ["ralplan", "deep-interview"])],
		examples: [
			{
				label: "handoff state write",
				bytes: '```\ngjc state ultragoal write --input \'{"current_phase":"handoff"}\' --json\n```',
			},
		],
		aliasesAndBridges: [
			{
				from: "ultragoal",
				to: "ralplan|deep-interview",
				rendered: "gjc state ultragoal handoff --to <ralplan|deep-interview> --json",
			},
		],
		notes: [
			"When the aggregate ultragoal is complete OR the user requests return to planning/clarification, mark ultragoal ready for handoff.",
		],
	},
	{
		skill: "team",
		blockId: "state",
		sourcePath: skillPath("team"),
		renderOrder: 10,
		markers: { start: "<!-- gjc:cmdref:start state -->", end: "<!-- gjc:cmdref:end state -->" },
		commands: [stateWrite("team"), stateHandoff("team", ["ralplan", "deep-interview", "ultragoal"])],
		examples: [
			{
				label: "handoff state write",
				bytes: '```\ngjc state team write --input \'{"current_phase":"handoff"}\' --json\n```',
			},
		],
		aliasesAndBridges: [
			{
				from: "team",
				to: "ralplan|deep-interview|ultragoal",
				rendered: "gjc state team handoff --to <ralplan|deep-interview|ultragoal> --json",
			},
		],
		notes: [
			"When the team task-set completes OR the user requests return to planning/persistence, mark team ready for handoff.",
		],
	},
] as const;

export function listCommandRefBlocks(skill?: CanonicalGjcWorkflowSkill): CommandRefBlock[] {
	const blocks =
		skill === undefined
			? WORKFLOW_COMMAND_REF_BLOCKS
			: WORKFLOW_COMMAND_REF_BLOCKS.filter(block => block.skill === skill);
	return [...blocks].sort(
		(a, b) => a.skill.localeCompare(b.skill) || a.renderOrder - b.renderOrder || a.blockId.localeCompare(b.blockId),
	);
}

export function renderCommandRefBlock(skill: CanonicalGjcWorkflowSkill, blockId = "state"): RenderedCommandRefBlock {
	const block = WORKFLOW_COMMAND_REF_BLOCKS.find(item => item.skill === skill && item.blockId === blockId);
	if (block === undefined) throw new Error(`Unknown command-reference block: ${skill}/${blockId}`);

	const lines: string[] = [];
	lines.push(block.markers.start);
	lines.push(`### Generated command reference: ${block.blockId}`);
	lines.push("");
	for (const note of block.notes) lines.push(note);
	lines.push("");
	lines.push("Commands:");
	for (const command of block.commands.filter(
		item => item.visibility === "public" && item.includeWhen === "implemented-only",
	)) {
		lines.push(`- \`${command.rendered}\``);
		if (command.note !== undefined) lines.push(`  - ${command.note}`);
	}
	lines.push("");
	lines.push("Examples:");
	for (const example of block.examples) {
		if (example.label !== undefined) lines.push(`- ${example.label}:`);
		lines.push(example.bytes);
	}
	lines.push("");
	lines.push("Aliases and bridges:");
	for (const bridge of block.aliasesAndBridges) lines.push(`- ${bridge.from} -> ${bridge.to}: \`${bridge.rendered}\``);
	lines.push(block.markers.end);
	lines.push("");

	return { skill, blockId: block.blockId, markers: block.markers, bytes: lines.join("\n") };
}

export function isCanonicalGjcWorkflowSkill(value: string): value is CanonicalGjcWorkflowSkill {
	return (CANONICAL_GJC_WORKFLOW_SKILLS as readonly string[]).includes(value);
}
