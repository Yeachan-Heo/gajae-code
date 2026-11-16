/**
 * Session-dependent descriptions for tools whose prompt text varies with session settings.
 *
 * A discoverable tool is advertised before its implementation loads. The facade renders these
 * descriptions from the session itself, so the text sent before the first call is the text the
 * loaded tool reports afterwards, and the provider-visible `tools` block (and with it the
 * prompt-cache prefix) does not change when the implementation loads (#5992).
 */
import { parseFrontmatter, prompt } from "@gajae-code/utils";
import architectAgent from "../prompts/agents/architect.md" with { type: "text" };
import criticAgent from "../prompts/agents/critic.md" with { type: "text" };
import executorAgent from "../prompts/agents/executor.md" with { type: "text" };
import plannerAgent from "../prompts/agents/planner.md" with { type: "text" };
import evalDescription from "../prompts/tools/eval.md" with { type: "text" };
import searchDescription from "../prompts/tools/search.md" with { type: "text" };
import taskDescription from "../prompts/tools/task.md" with { type: "text" };
import { getTaskSimpleModeCapabilities, type TaskSimpleMode } from "../task/simple-mode";
import { getTaskSchema, type TaskToolSchemaInstance } from "../task/types";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { resolveEvalBackends } from "./eval-backends";

interface DescriptionSettings {
	get(
		key:
			| "task.maxConcurrency"
			| "task.isolation.mode"
			| "task.simple"
			| "task.disabledAgents"
			| "eval.py"
			| "eval.js"
			| "readLineNumbers"
			| "readHashLines"
			| "edit.mode",
	): unknown;
	getEffectiveAutorouting(): { active: boolean };
}

interface DescriptionSession {
	settings: DescriptionSettings;
	getSessionSpawns?: () => string | null;
	hasEditTool?: boolean;
}

interface BundledAgentName {
	name: string;
	hide?: boolean;
}

function parseBundledAgentName(markdown: string): BundledAgentName {
	const { frontmatter } = parseFrontmatter(markdown, { level: "fatal" });
	const { name, hide } = frontmatter;
	if (typeof name !== "string") {
		throw new Error("Bundled task agent frontmatter must include a name");
	}
	return { name, hide: hide === true };
}

// Read only each role's frontmatter; importing task/agents would also load and render the full prompts.
const BUNDLED_AGENT_NAMES = [
	parseBundledAgentName(executorAgent),
	parseBundledAgentName(architectAgent),
	parseBundledAgentName(plannerAgent),
	parseBundledAgentName(criticAgent),
];

export interface EvalToolDescriptionOptions {
	py?: boolean;
	js?: boolean;
}

export function getEvalToolDescription(options: EvalToolDescriptionOptions = {}): string {
	const py = options.py ?? true;
	const js = options.js ?? true;
	return prompt.render(evalDescription, { py, js });
}

export function evalToolDescriptionForSession(session: DescriptionSession | null | undefined): string {
	if (!session) return getEvalToolDescription();
	const backends = resolveEvalBackends({ settings: session.settings } as Parameters<typeof resolveEvalBackends>[0]);
	return getEvalToolDescription({ py: backends.python, js: backends.js });
}

export function searchToolDescriptionForSession(session: DescriptionSession): string {
	const displayMode = resolveFileDisplayMode(session);
	return prompt.render(searchDescription, {
		IS_HL_MODE: displayMode.hashLines,
		IS_LINE_NUMBER_MODE: !displayMode.hashLines && displayMode.lineNumbers,
	});
}

export function renderTaskDescription(session: DescriptionSession): string {
	const simpleMode = session.settings.get("task.simple") as TaskSimpleMode;
	const { contextEnabled, customSchemaEnabled } = getTaskSimpleModeCapabilities(simpleMode);
	const isolationMode = session.settings.get("task.isolation.mode");
	const parentSpawns = session.getSessionSpawns?.() ?? "*";
	const spawningDisabled = parentSpawns === "";
	const disabledSetting = session.settings.get("task.disabledAgents");
	const disabledAgents = Array.isArray(disabledSetting)
		? disabledSetting.filter((agent): agent is string => typeof agent === "string")
		: [];
	const allowedSpawns =
		parentSpawns === "*"
			? undefined
			: new Set(
					parentSpawns
						.split(",")
						.map(agent => agent.trim())
						.filter(Boolean),
				);
	const agents = BUNDLED_AGENT_NAMES.filter(
		agent =>
			agent.hide !== true &&
			!disabledAgents.includes(agent.name) &&
			(allowedSpawns === undefined || allowedSpawns.has(agent.name)),
	);
	return prompt.render(taskDescription, {
		agents: agents.map(({ name }) => ({ name })),
		spawningDisabled,
		MAX_CONCURRENCY: session.settings.get("task.maxConcurrency"),
		isolationEnabled: isolationMode !== "none",
		asyncEnabled: true,
		contextEnabled,
		customSchemaEnabled,
		defaultMode: simpleMode === "default",
		schemaFreeMode: simpleMode === "schema-free",
		independentMode: simpleMode === "independent",
		autoroutingActive: session.settings.getEffectiveAutorouting().active,
	});
}

export function taskParametersForSession(session?: DescriptionSession): TaskToolSchemaInstance {
	const simpleMode = session ? (session.settings.get("task.simple") as TaskSimpleMode) : "default";
	const isolationMode = session?.settings.get("task.isolation.mode");
	return getTaskSchema({ isolationEnabled: session !== undefined && isolationMode !== "none", simpleMode });
}
