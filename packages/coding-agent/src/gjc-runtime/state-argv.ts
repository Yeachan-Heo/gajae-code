import { CANONICAL_GJC_WORKFLOW_SKILLS, type CanonicalGjcWorkflowSkill } from "../skill-state/canonical-skills";
import { typedArgsFor } from "./workflow-manifest";

export type StateAction =
	| "read"
	| "write"
	| "clear"
	| "contract"
	| "handoff"
	| "graph"
	| "prune"
	| "gc"
	| "migrate"
	| "status"
	| "doctor";

export const STATE_ACTION_NAMES: ReadonlySet<StateAction> = new Set([
	"read",
	"write",
	"clear",
	"contract",
	"handoff",
	"graph",
	"prune",
	"gc",
	"migrate",
	"status",
	"doctor",
]);

export const STATE_FLAGS_WITH_VALUES: ReadonlySet<string> = new Set([
	"--input",
	"--mode",
	"--session-id",
	"--thread-id",
	"--turn-id",
	"--to",
	"--skill",
	"--format",
	"--older-than",
	"--status",
	"--fields",
	"--since",
	"--limit",
]);

export const STATE_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
	"--json",
	"--replace",
	"--hard",
	"--dry-run",
	"--migrate",
	"--compact",
	"--history",
	"--force",
]);

export interface StateFlagOccurrence {
	name: string;
	index: number;
	value?: string;
	arity: "boolean" | "value";
	form: "separate" | "attached";
	malformed: boolean;
}

export interface StateSelectorCandidate {
	source: "mode" | "positional" | "input.mode" | "input.skill";
	value: string | undefined;
	index: number;
}

export type StateInputKind = "empty" | "inline" | "file" | "invalid";

export interface StateInputClassification {
	index: number;
	raw: string;
	kind: StateInputKind;
	selectors: StateSelectorCandidate[];
}

export interface StateArgvClassification {
	argv: readonly string[];
	action: StateAction;
	effectiveAction: StateAction;
	positionalSkill?: string;
	positionals: readonly string[];
	flags: readonly StateFlagOccurrence[];
	unknownFlags: readonly string[];
	inputs: readonly StateInputClassification[];
	runtimeSelectorCandidates: readonly StateSelectorCandidate[];
	selectorCandidates: readonly StateSelectorCandidate[];
}

function normalizedFlagName(arg: string): string | undefined {
	if (!arg.startsWith("--")) return undefined;
	const equalsIndex = arg.indexOf("=");
	return equalsIndex < 0 ? arg : arg.slice(0, equalsIndex);
}

function normalizedSelector(value: unknown): string | undefined {
	return typeof value === "string" ? value.trim() || undefined : undefined;
}

interface StatePositional {
	value: string;
	index: number;
}

function parseRuntimePositionals(argv: readonly string[]): StatePositional[] {
	const positionals: StatePositional[] = [];
	let skipNext = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (STATE_FLAGS_WITH_VALUES.has(arg)) {
			skipNext = true;
			continue;
		}
		if (!arg.startsWith("-")) positionals.push({ value: arg, index });
	}
	return positionals;
}

function parseAction(positionals: readonly StatePositional[]): {
	action: StateAction;
	positionalSkill?: string;
	positionalSkillIndex: number;
} {
	const [first, second] = positionals;
	if (first?.value && STATE_ACTION_NAMES.has(first.value as StateAction)) {
		return {
			action: first.value as StateAction,
			...(second?.value ? { positionalSkill: second.value } : {}),
			positionalSkillIndex: second?.value ? second.index : -1,
		};
	}
	if (first?.value && second?.value && STATE_ACTION_NAMES.has(second.value as StateAction)) {
		return { action: second.value as StateAction, positionalSkill: first.value, positionalSkillIndex: first.index };
	}
	if (first?.value && !second?.value) {
		return { action: "read", positionalSkill: first.value, positionalSkillIndex: first.index };
	}
	return { action: "read", positionalSkillIndex: -1 };
}

function stateFlagArities(
	action: StateAction,
	positionalSkill: string | undefined,
): ReadonlyMap<string, "boolean" | "value"> {
	const arities = new Map<string, "boolean" | "value">();
	for (const flag of STATE_FLAGS_WITH_VALUES) arities.set(flag, "value");
	for (const flag of STATE_BOOLEAN_FLAGS) arities.set(flag, "boolean");

	const skills =
		positionalSkill && CANONICAL_GJC_WORKFLOW_SKILLS.includes(positionalSkill as CanonicalGjcWorkflowSkill)
			? [positionalSkill as CanonicalGjcWorkflowSkill]
			: CANONICAL_GJC_WORKFLOW_SKILLS;
	for (const skill of skills) {
		for (const arg of typedArgsFor(skill, action)) {
			const name = `--${arg.name}`;
			if (!arities.has(name)) arities.set(name, arg.type === "boolean" ? "boolean" : "value");
		}
	}
	return arities;
}

function classifyInput(occurrence: StateFlagOccurrence): StateInputClassification {
	const raw = occurrence.value ?? "";
	const trimmed = raw.trim();
	if (!trimmed) return { index: occurrence.index, raw, kind: "empty", selectors: [] };
	if (trimmed.startsWith("@")) return { index: occurrence.index, raw, kind: "file", selectors: [] };
	try {
		const payload = JSON.parse(trimmed) as unknown;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			return { index: occurrence.index, raw, kind: "invalid", selectors: [] };
		}
		const record = payload as Record<string, unknown>;
		return {
			index: occurrence.index,
			raw,
			kind: "inline",
			selectors: [
				{ source: "input.mode", value: normalizedSelector(record.mode), index: occurrence.index },
				{ source: "input.skill", value: normalizedSelector(record.skill), index: occurrence.index },
			],
		};
	} catch {
		return { index: occurrence.index, raw, kind: "invalid", selectors: [] };
	}
}

export function firstStateFlagValue(classification: StateArgvClassification, name: string): string | undefined {
	const index = classification.argv.indexOf(name);
	return index < 0 ? undefined : classification.argv[index + 1];
}

export function classifyStateArgv(argv: readonly string[]): StateArgvClassification {
	const preservedArgv = [...argv];
	const positionalEntries = parseRuntimePositionals(preservedArgv);
	const positionals = positionalEntries.map(positional => positional.value);
	const { action, positionalSkill, positionalSkillIndex } = parseAction(positionalEntries);
	const flagArities = stateFlagArities(action, positionalSkill);
	const flags: StateFlagOccurrence[] = [];
	const unknownFlags: string[] = [];

	for (let index = 0; index < preservedArgv.length; index += 1) {
		const arg = preservedArgv[index]!;
		const name = normalizedFlagName(arg);
		if (!name) continue;
		const arity = flagArities.get(name);
		if (!arity) {
			unknownFlags.push(name);
			continue;
		}
		if (arg !== name) {
			flags.push({
				name,
				index,
				value: arg.slice(name.length + 1),
				arity,
				form: "attached",
				malformed: true,
			});
			continue;
		}
		if (arity === "boolean") {
			flags.push({ name, index, arity, form: "separate", malformed: false });
			continue;
		}
		const value = preservedArgv[index + 1];
		flags.push({
			name,
			index,
			...(value === undefined ? {} : { value }),
			arity,
			form: "separate",
			malformed: value === undefined || value.startsWith("--"),
		});
	}
	const effectiveAction = action === "read" && preservedArgv.includes("--migrate") ? "migrate" : action;

	const modeFlags = flags.filter(flag => flag.name === "--mode" && flag.form === "separate");
	const inputFlags = flags.filter(flag => flag.name === "--input" && flag.form === "separate");
	const inputs = inputFlags.map(classifyInput);
	const positionalCandidate: StateSelectorCandidate = {
		source: "positional",
		value: normalizedSelector(positionalSkill),
		index: positionalSkillIndex,
	};
	const modeCandidates = modeFlags.map(flag => ({
		source: "mode" as const,
		value: normalizedSelector(flag.value),
		index: flag.index,
	}));
	const selectorCandidates = [positionalCandidate, ...modeCandidates, ...inputs.flatMap(input => input.selectors)];
	const firstModeIndex = preservedArgv.indexOf("--mode");
	const firstModeCandidate: StateSelectorCandidate = {
		source: "mode",
		value: normalizedSelector(firstModeIndex < 0 ? undefined : preservedArgv[firstModeIndex + 1]),
		index: firstModeIndex,
	};
	const firstInputIndex = preservedArgv.indexOf("--input");
	const firstInput =
		firstInputIndex < 0
			? undefined
			: classifyInput({
					name: "--input",
					index: firstInputIndex,
					value: preservedArgv[firstInputIndex + 1],
					arity: "value",
					form: "separate",
					malformed: false,
				});
	const runtimeSelectorCandidates = [firstModeCandidate, positionalCandidate, ...(firstInput?.selectors ?? [])];

	return {
		argv: preservedArgv,
		action,
		effectiveAction,
		...(positionalSkill === undefined ? {} : { positionalSkill }),
		positionals,
		flags,
		unknownFlags,
		inputs,
		runtimeSelectorCandidates,
		selectorCandidates,
	};
}
