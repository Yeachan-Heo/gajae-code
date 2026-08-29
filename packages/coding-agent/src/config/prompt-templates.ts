import * as fs from "node:fs";
import * as path from "node:path";
import {
	getProjectDir,
	getProjectPromptsDir,
	getPromptsDir,
	logger,
	parseFrontmatter,
	prompt,
} from "@gajae-code/utils";
import { computeLineHash, HL_BODY_SEP } from "../hashline/hash";
import { jtdToTypeScript } from "../tools/jtd-to-typescript";
import { parseCommandArgs, substituteArgs } from "../utils/command-args";

/**
 * Represents a prompt template loaded from a markdown file
 */
export interface PromptTemplate {
	name: string;
	description: string;
	content: string;
	source: string; // e.g., "(user)", "(project)", "(project:frontend)"
}

prompt.registerHelper("jtdToTypeScript", (schema: unknown): string => {
	try {
		return jtdToTypeScript(schema);
	} catch {
		return "unknown";
	}
});

function formatHashlineRef(lineNum: unknown, content: unknown): { num: number; text: string; ref: string } {
	const num = typeof lineNum === "number" ? lineNum : Number.parseInt(String(lineNum), 10);
	const raw = typeof content === "string" ? content : String(content ?? "");
	const text = raw.replace(/\\t/g, "\t").replace(/\\n/g, "\n").replace(/\\r/g, "\r");
	const ref = `${num}${computeLineHash(num, text)}`;
	return { num, text, ref };
}

interface HashlineHelperRef {
	line: number;
	ref: string;
}

interface HashlineHelperState {
	last?: HashlineHelperRef;
	byLine: Map<number, HashlineHelperRef>;
}

const HL_HELPER_STATE = Symbol("hashlineHelperState");

interface HashlineHelperStateHolder {
	[HL_HELPER_STATE]?: HashlineHelperState;
}

function isHelperOptions(value: unknown): value is prompt.HelperOptions {
	return typeof value === "object" && value !== null && "hash" in value;
}

function splitHelperArgs(args: unknown[]): { positional: unknown[]; options?: prompt.HelperOptions } {
	const maybeOptions = args.at(-1);
	if (!isHelperOptions(maybeOptions)) return { positional: args };
	return { positional: args.slice(0, -1), options: maybeOptions };
}

function getHashlineHelperState(context: unknown, options: prompt.HelperOptions | undefined): HashlineHelperState {
	const data = options?.data;
	const root = data?.root;
	const holderTarget = data && typeof data === "object" ? data : root && typeof root === "object" ? root : context;
	if (!holderTarget || typeof holderTarget !== "object") {
		throw new Error("hashline prompt helpers require an object render context");
	}

	const holder = holderTarget as HashlineHelperStateHolder;
	if (!holder[HL_HELPER_STATE]) {
		holder[HL_HELPER_STATE] = { byLine: new Map() };
	}
	return holder[HL_HELPER_STATE];
}

function isLineNumberArg(value: unknown): boolean {
	const num = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	return Number.isFinite(num);
}

function rememberHashlineRef(state: HashlineHelperState, line: number, ref: string): void {
	const entry = { line, ref };
	state.last = entry;
	state.byLine.set(line, entry);
}

function requireStoredHashlineRef(state: HashlineHelperState, lineArg?: unknown): string {
	if (lineArg === undefined) {
		if (!state.last) {
			throw new Error("{{href}} requires a previous {{hline}} call in the same prompt render");
		}
		return state.last.ref;
	}

	const line = typeof lineArg === "number" ? lineArg : Number.parseInt(String(lineArg), 10);
	const entry = state.byLine.get(line);
	if (!entry) {
		throw new Error(`{{href ${line}}} requires a previous {{hline ${line} ...}} call in the same prompt render`);
	}
	return entry.ref;
}

function wrapHashlineRef(ref: string, args: unknown[]): string {
	const preStr = typeof args[0] === "string" ? args[0] : "";
	const postStr = typeof args[1] === "string" ? args[1] : "";
	return `${preStr}${ref}${postStr}`;
}

function resolveHashlineRef(state: HashlineHelperState, args: unknown[]): string {
	if (args.length === 0) return requireStoredHashlineRef(state);
	const [first, second, ...rest] = args;
	if (isLineNumberArg(first)) {
		if (second === undefined) return requireStoredHashlineRef(state, first);
		const { ref } = formatHashlineRef(first, second);
		return wrapHashlineRef(ref, rest);
	}
	return wrapHashlineRef(requireStoredHashlineRef(state), args);
}

/**
 * {{href lineNum "content"}} — compute a real hashline ref for prompt examples.
 * {{href lineNum}} — quote the ref remembered by the earlier {{hline lineNum "..."}}
 * {{href}} — quote the ref from the previous {{hline}} call.
 * {{href "[" "]"}} — wrap the previous {{hline}} ref with pre/post chars.
 * Returns `"lineNumBIGRAM"` (e.g., `"42nd"`), or `"[42nd]"` when pre/post are supplied.
 */
prompt.registerHelper("href", function (this: unknown, ...args: unknown[]): string {
	const { positional, options } = splitHelperArgs(args);
	const state = getHashlineHelperState(this, options);
	return JSON.stringify(resolveHashlineRef(state, positional));
});
prompt.registerHelper("hrefr", function (this: unknown, ...args: unknown[]): string {
	const { positional, options } = splitHelperArgs(args);
	const state = getHashlineHelperState(this, options);
	return resolveHashlineRef(state, positional);
});

/**
 * {{hline lineNum "content"}} — format a full read-style line with prefix.
 * Returns `"lineNumBIGRAM|content"` (pipe between anchor and content).
 */
prompt.registerHelper("hline", function (this: unknown, ...args: unknown[]): string {
	const { positional, options } = splitHelperArgs(args);
	const [lineNum, content] = positional;
	const { num, ref, text } = formatHashlineRef(lineNum, content);
	const state = getHashlineHelperState(this, options);
	rememberHashlineRef(state, num, ref);
	return `${ref}${HL_BODY_SEP}${text}`;
});

const INLINE_ARG_SHELL_PATTERN = /\$(?:ARGUMENTS|@(?:\[\d+(?::\d*)?\])?|\d+)/;
const INLINE_ARG_TEMPLATE_PATTERN = /\{\{[\s\S]*?(?:\b(?:arguments|ARGUMENTS|args)\b|\barg\s+[^}]+)[\s\S]*?\}\}/;

/**
 * Keep the check source-level and cheap: if the template text contains any explicit
 * inline-arg placeholder syntax, do not append the fallback text again.
 */
export function templateUsesInlineArgPlaceholders(templateSource: string): boolean {
	return INLINE_ARG_SHELL_PATTERN.test(templateSource) || INLINE_ARG_TEMPLATE_PATTERN.test(templateSource);
}

export function appendInlineArgsFallback(
	rendered: string,
	argsText: string,
	usesInlineArgPlaceholders: boolean,
): string {
	if (argsText.length === 0 || usesInlineArgPlaceholders) return rendered;
	if (rendered.length === 0) return argsText;

	return `${rendered}\n\n${argsText}`;
}

/**
 * Recursively scan a directory for .md files (and symlinks to .md files) and load them as prompt templates
 */
async function loadTemplatesFromDir(
	dir: string,
	source: "user" | "project",
	subdir: string = "",
): Promise<PromptTemplate[]> {
	const templates: PromptTemplate[] = [];
	try {
		const glob = new Bun.Glob("**/*");
		const entries = [];
		for await (const entry of glob.scan({ cwd: dir, absolute: false, onlyFiles: false })) {
			entries.push(entry);
		}

		// Group by path depth to process directories before deeply nested files
		entries.sort((a, b) => a.split("/").length - b.split("/").length);

		for (const entry of entries) {
			const fullPath = path.join(dir, entry);
			const file = Bun.file(fullPath);

			try {
				const stat = await file.exists();
				if (!stat) continue;

				if (entry.endsWith(".md")) {
					const rawContent = await file.text();
					const { frontmatter, body } = parseFrontmatter(rawContent, { source: fullPath });

					const name = entry.split("/").pop()!.slice(0, -3); // Remove .md extension

					// Build source string based on subdirectory structure
					const entryDir = entry.includes("/") ? entry.split("/").slice(0, -1).join(":") : "";
					const fullSubdir = subdir && entryDir ? `${subdir}:${entryDir}` : entryDir || subdir;

					let sourceStr: string;
					if (source === "user") {
						sourceStr = fullSubdir ? `(user:${fullSubdir})` : "(user)";
					} else {
						sourceStr = fullSubdir ? `(project:${fullSubdir})` : "(project)";
					}

					// Get description from frontmatter or first non-empty line
					let description = String(frontmatter.description || "");
					if (!description) {
						const firstLine = body.split("\n").find(line => line.trim());
						if (firstLine) {
							// Truncate if too long
							description = firstLine.slice(0, 60);
							if (firstLine.length > 60) description += "...";
						}
					}

					// Append source to description
					description = description ? `${description} ${sourceStr}` : sourceStr;

					templates.push({
						name,
						description,
						content: body,
						source: sourceStr,
					});
				}
			} catch (error) {
				logger.warn("Failed to load prompt template", { path: fullPath, error: String(error) });
			}
		}
	} catch (error) {
		if (!fs.existsSync(dir)) {
			return [];
		}
		logger.warn("Failed to scan prompt templates directory", { dir, error: String(error) });
	}

	return templates;
}

export interface LoadPromptTemplatesOptions {
	/** Working directory for project-local templates. Default: getProjectDir() */
	cwd?: string;
	/** Agent config directory for global templates. Default: from getPromptsDir() */
	agentDir?: string;
	profileAuthority?: "default" | "custom";
}

/**
 * Load all prompt templates from:
 * 1. Global: agentDir/prompts/
 * 2. Project: cwd/.gjc/prompts/
 */
export async function loadPromptTemplates(options: LoadPromptTemplatesOptions = {}): Promise<PromptTemplate[]> {
	const resolvedCwd = options.cwd ?? getProjectDir();
	const resolvedAgentDir = options.agentDir ?? getPromptsDir();

	const templates: PromptTemplate[] = [];

	// 1. Load global templates from agentDir/prompts/
	// Note: if agentDir is provided, it should be the agent dir, not the prompts dir
	const globalPromptsDir = options.agentDir ? path.join(options.agentDir, "prompts") : resolvedAgentDir;
	templates.push(...(await loadTemplatesFromDir(globalPromptsDir, "user")));

	// 2. Load project templates from cwd/.gjc/prompts/
	const projectPromptsDir = getProjectPromptsDir(resolvedCwd);
	templates.push(...(await loadTemplatesFromDir(projectPromptsDir, "project")));

	return templates;
}

/**
 * Expand a prompt template if it matches a template name.
 * Returns the expanded content or the original text if not a template.
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	if (!text.startsWith("/")) return text;

	const spaceIndex = text.indexOf(" ");
	const templateName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

	const template = templates.find(t => t.name === templateName);
	if (template) {
		const args = parseCommandArgs(argsString);
		const argsText = args.join(" ");
		const usesInlineArgPlaceholders = templateUsesInlineArgPlaceholders(template.content);
		const substituted = substituteArgs(template.content, args);
		const rendered = prompt.render(substituted, { args, ARGUMENTS: argsText, arguments: argsText });
		return appendInlineArgsFallback(rendered, argsText, usesInlineArgPlaceholders);
	}

	return text;
}
