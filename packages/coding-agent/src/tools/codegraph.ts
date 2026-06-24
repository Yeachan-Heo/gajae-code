import { existsSync } from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { $which, prompt, ptree } from "@gajae-code/utils";
import * as z from "zod/v4";
import codegraphDescription from "../prompts/tools/codegraph.md" with { type: "text" };
import type { ToolSession } from ".";
import { ToolError, throwIfAborted } from "./tool-errors";

/** Name of the CodeGraph CLI binary. */
export const CODEGRAPH_CLI = "codegraph";
/** Per-project index directory created by `codegraph init`. */
export const CODEGRAPH_DIR = ".codegraph";
/** Default cap for `search` results. */
const SEARCH_LIMIT_DEFAULT = 10;
/** Hard cap for `search` results. */
const SEARCH_LIMIT_MAX = 100;
/** CodeGraph CLI timeout (ms). Graph queries are local SQLite reads. */
const CODEGRAPH_TIMEOUT_MS = 60_000;

const codegraphSchema = z
	.object({
		op: z
			.enum(["explore", "search", "callers", "callees", "impact", "status"])
			.describe(
				"explore: surgical context (relevant source + call paths) for a natural-language query — prefer this for 'how does X work' questions; search: full-text symbol search (target=query); callers: who calls target; callees: what target calls; impact: blast radius of changing target; status: index health (no target).",
			),
		target: z
			.string()
			.optional()
			.describe(
				"For explore: a natural-language query or symbol(s). For callers/callees/impact: a symbol name. For search: the search query. Omit for status.",
			),
		limit: z
			.number()
			.int()
			.min(1)
			.max(SEARCH_LIMIT_MAX)
			.optional()
			.describe(`Max results for search (default ${SEARCH_LIMIT_DEFAULT}).`),
		maxFiles: z
			.number()
			.int()
			.min(1)
			.max(SEARCH_LIMIT_MAX)
			.optional()
			.describe("For explore: cap the number of files whose source is included."),
	})
	.strict();

type CodegraphParams = z.infer<typeof codegraphSchema>;

// ── CodeGraph CLI JSON shapes (subset of fields we render) ───────────────────

interface CodegraphNode {
	kind: string;
	name: string;
	qualifiedName?: string;
	filePath: string;
	startLine: number;
	signature?: string | null;
	isExported?: boolean;
}

interface SearchHit {
	node: CodegraphNode;
	score: number;
}

interface RefNode {
	name: string;
	kind: string;
	filePath: string;
	startLine: number;
}

interface CallersResult {
	symbol: string;
	callers: RefNode[];
}

interface CalleesResult {
	symbol: string;
	callees: RefNode[];
}

interface ImpactResult {
	symbol: string;
	depth: number;
	nodeCount: number;
	edgeCount: number;
	affected: RefNode[];
}

interface StatusResult {
	initialized: boolean;
	projectPath: string;
	fileCount: number;
	nodeCount: number;
	edgeCount: number;
	nodesByKind?: Record<string, number>;
	languages?: string[];
	pendingChanges?: { added: number; modified: number; removed: number };
}

/** Result of invoking the CodeGraph CLI. */
export interface CodegraphRunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

/** Injectable CLI runner (defaults to spawning the real `codegraph` binary). */
export type CodegraphRunner = (
	args: string[],
	opts: { cwd: string; signal?: AbortSignal },
) => Promise<CodegraphRunResult>;

const defaultRunner: CodegraphRunner = async (args, opts) => {
	const result = await ptree.exec([CODEGRAPH_CLI, ...args], {
		cwd: opts.cwd,
		signal: opts.signal,
		timeout: CODEGRAPH_TIMEOUT_MS,
		allowNonZero: true,
	});
	return { ok: result.ok, stdout: result.stdout, stderr: result.stderr };
};

/**
 * Build the CodeGraph CLI argument vector for an operation. All query commands
 * accept `--path`; `status` takes the project path as a positional argument.
 *
 * @throws ToolError when an op that needs a `target` is missing one.
 */
export function buildCodegraphArgs(params: CodegraphParams, cwd: string): string[] {
	const { op, target } = params;
	if (op === "status") {
		return ["status", cwd, "--json"];
	}
	const trimmed = target?.trim();
	if (!trimmed) {
		throw new ToolError(`codegraph ${op} requires a non-empty "target".`);
	}
	if (op === "search") {
		const limit = Math.min(params.limit ?? SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
		return ["query", trimmed, "--json", "--limit", String(limit), "--path", cwd];
	}
	if (op === "explore") {
		// `explore` emits a ready-to-use markdown report (no --json) and accepts a
		// variadic query, so split the target into words.
		const words = trimmed.split(/\s+/).filter(Boolean);
		const args = ["explore", ...words, "--path", cwd];
		if (params.maxFiles !== undefined) {
			args.push("--max-files", String(params.maxFiles));
		}
		return args;
	}
	return [op, trimmed, "--json", "--path", cwd];
}

function formatRef(ref: RefNode): string {
	return `  - ${ref.name} (${ref.kind}) — ${ref.filePath}:${ref.startLine}`;
}

function renderSearch(query: string, hits: SearchHit[]): string {
	if (hits.length === 0) {
		return `No symbols matched "${query}".`;
	}
	const lines = [`${hits.length} symbol(s) matching "${query}":`];
	for (const { node } of hits) {
		const exported = node.isExported ? " [exported]" : "";
		const sig = node.signature ? ` ${node.signature}` : "";
		lines.push(`  - ${node.name} (${node.kind})${sig}${exported} — ${node.filePath}:${node.startLine}`);
	}
	return lines.join("\n");
}

function renderCallers(result: CallersResult): string {
	if (result.callers.length === 0) {
		return `No callers found for "${result.symbol}".`;
	}
	return [`${result.callers.length} caller(s) of "${result.symbol}":`, ...result.callers.map(formatRef)].join("\n");
}

function renderCallees(result: CalleesResult): string {
	if (result.callees.length === 0) {
		return `"${result.symbol}" has no recorded callees.`;
	}
	return [`${result.callees.length} callee(s) of "${result.symbol}":`, ...result.callees.map(formatRef)].join("\n");
}

function renderImpact(result: ImpactResult): string {
	const header = `Impact of changing "${result.symbol}" (depth ${result.depth}): ${result.nodeCount} node(s), ${result.edgeCount} edge(s) affected.`;
	if (result.affected.length === 0) {
		return header;
	}
	return [header, "Affected:", ...result.affected.map(formatRef)].join("\n");
}

function renderStatus(result: StatusResult): string {
	if (!result.initialized) {
		return `CodeGraph is not initialized for ${result.projectPath}. Run \`codegraph init\` to build the index.`;
	}
	const lines = [
		`CodeGraph index for ${result.projectPath}:`,
		`  files: ${result.fileCount}, nodes: ${result.nodeCount}, edges: ${result.edgeCount}`,
	];
	if (result.languages?.length) {
		lines.push(`  languages: ${result.languages.join(", ")}`);
	}
	const pending = result.pendingChanges;
	if (pending && (pending.added || pending.modified || pending.removed)) {
		lines.push(`  pending sync: +${pending.added} ~${pending.modified} -${pending.removed}`);
	}
	return lines.join("\n");
}

/** Parse CLI stdout as JSON, raising a ToolError on malformed output. */
function parseJson<T>(op: string, stdout: string): T {
	try {
		return JSON.parse(stdout) as T;
	} catch {
		throw new ToolError(`codegraph ${op} returned unparseable output.`);
	}
}

/** Render a successful CodeGraph CLI invocation into agent-facing text. */
export function renderCodegraphResult(params: CodegraphParams, stdout: string): string {
	switch (params.op) {
		case "explore":
			// `explore` already returns a formatted markdown report; pass it through.
			return stdout.trim() || `No exploration results for "${params.target?.trim() ?? ""}".`;
		case "search":
			return renderSearch(params.target?.trim() ?? "", parseJson<SearchHit[]>(params.op, stdout));
		case "callers":
			return renderCallers(parseJson<CallersResult>(params.op, stdout));
		case "callees":
			return renderCallees(parseJson<CalleesResult>(params.op, stdout));
		case "impact":
			return renderImpact(parseJson<ImpactResult>(params.op, stdout));
		case "status":
			return renderStatus(parseJson<StatusResult>(params.op, stdout));
	}
}

/** Turn a CLI failure into actionable guidance. */
function failureError(stderr: string): ToolError {
	const lower = stderr.toLowerCase();
	if (lower.includes("not initialized") || lower.includes(".codegraph") || lower.includes("no index")) {
		return new ToolError(
			"CodeGraph is not initialized for this project. Run `codegraph init` in the project root to build the index.",
		);
	}
	const detail = stderr.trim();
	return new ToolError(detail ? `codegraph failed: ${detail}` : "codegraph failed with no diagnostic output.");
}

/** Optional dependency overrides for {@link CodegraphTool.createIf} (tests). */
export interface CodegraphAvailabilityDeps {
	which?: (command: string) => string | null;
	exists?: (candidate: string) => boolean;
}

/**
 * Read-only `codegraph` tool: queries a project's CodeGraph knowledge graph via
 * the local `codegraph` CLI. Registered only when the CLI is installed and the
 * project has been indexed (a `.codegraph/` directory exists).
 */
export class CodegraphTool implements AgentTool<typeof codegraphSchema, Record<string, never>> {
	readonly name = "codegraph";
	readonly label = "CodeGraph";
	readonly summary = "Query the project's code knowledge graph (symbols, callers, callees, impact)";
	readonly description = prompt.render(codegraphDescription);
	readonly parameters = codegraphSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(
		private readonly session: ToolSession,
		private readonly run: CodegraphRunner = defaultRunner,
	) {}

	static createIf(session: ToolSession, deps: CodegraphAvailabilityDeps = {}): CodegraphTool | null {
		if (session.settings.get("codegraph.enabled") === false) return null;
		const which = deps.which ?? $which;
		if (!which(CODEGRAPH_CLI)) return null;
		const exists = deps.exists ?? existsSync;
		if (!exists(path.join(session.cwd, CODEGRAPH_DIR))) return null;
		return new CodegraphTool(session);
	}

	async execute(
		_toolCallId: string,
		params: CodegraphParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<Record<string, never>>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<Record<string, never>>> {
		throwIfAborted(signal);
		const args = buildCodegraphArgs(params, this.session.cwd);
		const result = await this.run(args, { cwd: this.session.cwd, signal });
		throwIfAborted(signal);
		if (!result.ok) {
			throw failureError(result.stderr);
		}
		return { content: [{ type: "text", text: renderCodegraphResult(params, result.stdout) }] };
	}
}
