import type { CanonicalGjcWorkflowSkill } from "../skill-state/active-state";
import { CANONICAL_GJC_WORKFLOW_SKILLS } from "../skill-state/active-state";
import { getSkillManifest } from "./workflow-manifest";

export type StateGraphSkill = CanonicalGjcWorkflowSkill | "all";
export type StateGraphFormat = "ascii" | "mermaid" | "dot";

function assertGraphFormat(format: string): asserts format is StateGraphFormat {
	if (format !== "ascii" && format !== "mermaid" && format !== "dot") {
		throw new Error(`Invalid graph format: ${format}. Expected one of: ascii, mermaid, dot.`);
	}
}

function skillsFor(skill: StateGraphSkill): CanonicalGjcWorkflowSkill[] {
	return skill === "all" ? [...CANONICAL_GJC_WORKFLOW_SKILLS] : [skill];
}

function renderAscii(skill: StateGraphSkill): string {
	const chunks = skillsFor(skill).map(item => {
		const manifest = getSkillManifest(item);
		const states = manifest.states
			.map(state => {
				const markers = [state.initial ? "initial" : undefined, state.terminal ? "terminal" : undefined]
					.filter(Boolean)
					.join(", ");
				return `  - ${state.id}${markers ? ` (${markers})` : ""}`;
			})
			.join("\n");
		const transitions = manifest.transitions
			.map(transition => `  - ${transition.from} -> ${transition.to} [${transition.verb}]`)
			.join("\n");
		return `${manifest.skill} (${manifest.graphLabel})\nstates:\n${states}\ntransitions:\n${transitions}`;
	});
	return `${chunks.join("\n\n")}\n`;
}

function renderMermaid(skill: StateGraphSkill): string {
	const lines = ["stateDiagram-v2"];
	for (const item of skillsFor(skill)) {
		const manifest = getSkillManifest(item);
		lines.push(`  state "${manifest.graphLabel}" as ${item} {`);
		lines.push(`    [*] --> ${manifest.initialState}`);
		for (const transition of manifest.transitions) {
			lines.push(`    ${transition.from} --> ${transition.to}: ${transition.verb}`);
		}
		for (const terminal of manifest.terminalStates) {
			lines.push(`    ${terminal} --> [*]`);
		}
		lines.push("  }");
	}
	return `${lines.join("\n")}\n`;
}

function dotId(skill: CanonicalGjcWorkflowSkill, state: string): string {
	return `"${skill}:${state}"`;
}

function renderDot(skill: StateGraphSkill): string {
	const lines = ["digraph gjc_state {", "  rankdir=LR;"];
	for (const item of skillsFor(skill)) {
		const manifest = getSkillManifest(item);
		lines.push(`  subgraph "cluster_${item}" {`);
		lines.push(`    label="${manifest.graphLabel}";`);
		for (const state of manifest.states) {
			const shape = state.terminal ? "doublecircle" : "circle";
			lines.push(`    ${dotId(item, state.id)} [label="${state.id}", shape=${shape}];`);
		}
		lines.push(`    "${item}:__start" [label="", shape=point];`);
		lines.push(`    "${item}:__start" -> ${dotId(item, manifest.initialState)};`);
		for (const transition of manifest.transitions) {
			lines.push(
				`    ${dotId(item, transition.from)} -> ${dotId(item, transition.to)} [label="${transition.verb}"];`,
			);
		}
		lines.push("  }");
	}
	lines.push("}");
	return `${lines.join("\n")}\n`;
}

export function renderStateGraph(skill: StateGraphSkill, format: string = "ascii"): string {
	assertGraphFormat(format);
	if (format === "mermaid") return renderMermaid(skill);
	if (format === "dot") return renderDot(skill);
	return renderAscii(skill);
}
