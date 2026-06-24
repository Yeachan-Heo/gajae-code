# CodeGraph as a custom tool

[CodeGraph](https://github.com/colbymchenry/codegraph) is a local, language-agnostic
code knowledge graph for AI agents. It pre-indexes symbols, call edges, and
dependencies in a project so an agent can answer structural questions ("how does X
work", "who calls X", "what breaks if I change X") in a few graph queries instead
of crawling files with `search`/`read`.

This guide shows how to wire CodeGraph into GJC through the **custom-tool extension
path** — no core changes, no built-in provider. GJC intentionally keeps third-party
CLI integrations like this in the user/project extension layer rather than bundling
them, so you own the integration and its lifecycle.

> CodeGraph integrates with other agents over MCP, but this guide wires it as a GJC
> custom tool around CodeGraph's local **CLI** — it does not add an MCP server or a
> built-in provider. For how GJC treats MCP servers in standalone sessions, see
> [`standalone-mcp.md`](standalone-mcp.md).

## 1. Install and index

```bash
# Install the CodeGraph CLI (or use the install script from CodeGraph's README).
npm i -g @colbymchenry/codegraph

# Build the local index for a project.
cd your-project
codegraph init
```

`codegraph init` creates a local `.codegraph/` directory. No data leaves your
machine — it is a local SQLite index.

## 2. Add the custom tool

GJC discovers custom tools from a `tools/` directory in its config dirs:

- **Project-scoped**: `<project>/.gjc/tools/`
- **User-scoped (all projects)**: `~/.gjc/agent/tools/`

A `*.ts` tool file's default export is a factory `(pi) => CustomTool`. The factory
receives an API (`pi`) with members such as `exec`, `cwd`, `zod`, and `logger` — so
the tool needs no imports from GJC internals.

Save the following as `.gjc/tools/codegraph.ts` (project) or
`~/.gjc/agent/tools/codegraph.ts` (user):

```typescript
/**
 * CodeGraph custom tool for gajae-code (GJC).
 *
 * Wraps the local CodeGraph CLI (https://github.com/colbymchenry/codegraph) so the
 * agent can query a project's code knowledge graph instead of crawling files.
 *
 * It only runs CodeGraph's query-style (read-only) subcommands and never edits your
 * source files. It does not run indexing or sync commands. (CodeGraph maintains its
 * own local `.codegraph/` index via its own CLI; this tool only reads from it.)
 *
 * Prereqs: `npm i -g @colbymchenry/codegraph` and `codegraph init` in the project.
 */
import type { CustomToolFactory } from "@gajae-code/coding-agent"; // optional: editor types only

const CODEGRAPH_CLI = "codegraph";
const TIMEOUT_MS = 60_000;
const SEARCH_LIMIT_DEFAULT = 10;
const MAX = 100;

const codegraph: CustomToolFactory = (pi) => {
	const z = pi.zod;

	const parameters = z
		.object({
			op: z
				.enum(["explore", "search", "callers", "callees", "impact", "status"])
				.describe(
					"explore: context (relevant source + call paths) for a natural-language query — prefer for 'how does X work'; search: full-text symbol search (target=query); callers: who calls target; callees: what target calls; impact: blast radius of changing target; status: index health (no target).",
				),
			target: z
				.string()
				.optional()
				.describe(
					"For explore: a natural-language query or symbol(s). For callers/callees/impact: a symbol name. For search: the query. Omit for status.",
				),
			limit: z.number().int().min(1).max(MAX).optional().describe(`Max search results (default ${SEARCH_LIMIT_DEFAULT}).`),
			maxFiles: z.number().int().min(1).max(MAX).optional().describe("For explore: cap files whose source is included."),
		})
		.strict();

	type Params = import("zod/v4").infer<typeof parameters>;

	function buildArgs(params: Params): string[] {
		if (params.op === "status") return ["status", pi.cwd, "--json"];
		const target = params.target?.trim();
		if (!target) throw new Error(`codegraph ${params.op} requires a non-empty "target".`);
		if (params.op === "search") {
			const limit = Math.min(params.limit ?? SEARCH_LIMIT_DEFAULT, MAX);
			return ["query", target, "--json", "--limit", String(limit), "--path", pi.cwd];
		}
		if (params.op === "explore") {
			const args = ["explore", target, "--path", pi.cwd];
			if (params.maxFiles !== undefined) args.push("--max-files", String(params.maxFiles));
			return args;
		}
		return [params.op, target, "--json", "--path", pi.cwd];
	}

	function ref(r: { name: string; kind: string; filePath: string; startLine: number }): string {
		return `  - ${r.name} (${r.kind}) — ${r.filePath}:${r.startLine}`;
	}

	function render(params: Params, stdout: string): string {
		if (params.op === "explore") return stdout.trim() || `No exploration results for "${params.target?.trim() ?? ""}".`;
		let data: any;
		try {
			data = JSON.parse(stdout);
		} catch {
			throw new Error(`codegraph ${params.op} returned unparseable output.`);
		}
		if (params.op === "search") {
			const hits = data as Array<{ node: any }>;
			if (hits.length === 0) return `No symbols matched "${params.target?.trim() ?? ""}".`;
			return [
				`${hits.length} symbol(s) matching "${params.target?.trim() ?? ""}":`,
				...hits.map(({ node }) => {
					const exp = node.isExported ? " [exported]" : "";
					const sig = node.signature ? ` ${node.signature}` : "";
					return `  - ${node.name} (${node.kind})${sig}${exp} — ${node.filePath}:${node.startLine}`;
				}),
			].join("\n");
		}
		if (params.op === "callers") {
			const list = data.callers ?? [];
			return list.length === 0
				? `No callers found for "${data.symbol}".`
				: [`${list.length} caller(s) of "${data.symbol}":`, ...list.map(ref)].join("\n");
		}
		if (params.op === "callees") {
			const list = data.callees ?? [];
			return list.length === 0
				? `"${data.symbol}" has no recorded callees.`
				: [`${list.length} callee(s) of "${data.symbol}":`, ...list.map(ref)].join("\n");
		}
		if (params.op === "impact") {
			const header = `Impact of changing "${data.symbol}" (depth ${data.depth}): ${data.nodeCount} node(s), ${data.edgeCount} edge(s) affected.`;
			const list = data.affected ?? [];
			return list.length === 0 ? header : [header, "Affected:", ...list.map(ref)].join("\n");
		}
		// status
		if (!data.initialized) return `CodeGraph is not initialized for ${data.projectPath}. Run \`codegraph init\`.`;
		const lines = [
			`CodeGraph index for ${data.projectPath}:`,
			`  files: ${data.fileCount}, nodes: ${data.nodeCount}, edges: ${data.edgeCount}`,
		];
		if (data.languages?.length) lines.push(`  languages: ${data.languages.join(", ")}`);
		const p = data.pendingChanges;
		if (p && (p.added || p.modified || p.removed)) lines.push(`  pending sync: +${p.added} ~${p.modified} -${p.removed}`);
		return lines.join("\n");
	}

	return {
		name: "codegraph",
		label: "CodeGraph",
		description:
			"Query the project's CodeGraph code knowledge graph (symbols, callers, callees, impact, and an 'explore' context query) via the local codegraph CLI. Read-only with respect to your source. Prefer over search/read for structural questions. Requires `codegraph init` to have been run in the project.",
		parameters,
		strict: true,
		async execute(_id: string, params: Params, _onUpdate: unknown, _ctx: unknown, signal?: AbortSignal) {
			let result: { stdout: string; stderr: string; code: number };
			try {
				result = await pi.exec(CODEGRAPH_CLI, buildArgs(params), { cwd: pi.cwd, signal, timeout: TIMEOUT_MS });
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (/not found|enoent/i.test(msg)) {
					throw new Error("The `codegraph` CLI is not installed. Install it: npm i -g @colbymchenry/codegraph");
				}
				throw e;
			}
			if (result.code !== 0) {
				const err = result.stderr.toLowerCase();
				if (err.includes("not initialized") || err.includes(".codegraph") || err.includes("no index")) {
					throw new Error("CodeGraph is not initialized for this project. Run `codegraph init` in the project root.");
				}
				throw new Error(result.stderr.trim() || "codegraph failed with no diagnostic output.");
			}
			return { content: [{ type: "text", text: render(params, result.stdout) }] };
		},
	};
};

export default codegraph;
```

The `import type` line is optional — it only provides editor types when GJC is
resolvable from your tool file. It is erased at runtime, so the tool loads fine
without it.

## 3. Use it

Start GJC in the project. The `codegraph` tool is now available to the model. Ask
a structural question and it will call the tool, for example:

- `codegraph` with `{ "op": "explore", "target": "how requests are routed" }` can
  return relevant source plus graph context in one call.
- `{ "op": "callers", "target": "MyClass.handle" }` lists callers.
- `{ "op": "impact", "target": "parseConfig" }` shows what a change would affect.
- `{ "op": "status" }` reports index health.

## Operations

| `op` | `target` | Description |
| --- | --- | --- |
| `explore` | natural-language query | Context query: relevant symbols' source plus graph context (CodeGraph's `explore`). `maxFiles` caps included source. |
| `search` | query | Full-text symbol search (`limit`, default 10). |
| `callers` | symbol | Functions/methods that call the symbol, including dynamic dispatch. |
| `callees` | symbol | Functions/methods the symbol calls. |
| `impact` | symbol | Blast radius of changing the symbol. |
| `status` | — | Index health: file/node/edge counts, languages, pending sync. |

## Notes

- **Read-only with respect to your code.** The tool only runs CodeGraph's
  query-style subcommands; it never edits your files and does not run indexing or
  sync commands. CodeGraph maintains its own local `.codegraph/` index via its CLI.
  If results look stale or `status` reports pending changes, refresh the index with
  CodeGraph's CLI (e.g. `codegraph sync`) outside GJC.
- **Safe argument handling.** The example spawns CodeGraph with argv arrays via
  `pi.exec` (no shell), `op` is constrained to a fixed enum, and numeric inputs are
  capped — there is no shell interpolation of model-provided values.
- **Scope.** Use a project-scoped file to limit the tool to one repo, or a
  user-scoped file to make it available everywhere `codegraph init` has been run.
- **Naming.** The tool registers as `codegraph`; rename it in the file if it
  collides with another tool in your setup.
- **Fallback.** If the graph reports a symbol is missing, a file is flagged as
  pending sync, or you need a non-structural text search, refresh the CodeGraph
  index outside GJC or fall back to `read`/`search`.
- For background on how GJC treats external tools and MCP servers in standalone
  sessions, see [`standalone-mcp.md`](standalone-mcp.md).
