/**
 * Direct MCP server registration for standalone GJC.
 */
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { type MCPAction, type MCPCommandArgs, runMCPCommand } from "../cli/mcp-cli";

const ACTIONS: MCPAction[] = ["add", "list", "remove", "import"];

export default class MCP extends Command {
	static description = "Register standalone MCP servers explicitly in GJC config";
	static delegateHelp = true;

	static examples = [
		"gjc mcp add context7 npx -y @upstash/context7-mcp",
		"gjc mcp add docs --type http --url https://example.test/mcp --header Authorization=Bearer_TOKEN",
		"gjc mcp import claude",
		"gjc mcp import codex --dry-run",
		"gjc mcp list --json",
		"gjc mcp remove context7",
	];

	static args = {
		action: Args.string({ description: "MCP action", required: false, options: ACTIONS }),
		name: Args.string({ description: "Server name", required: false }),
		commandArgs: Args.string({
			description: "Command/URL and trailing args for add",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		project: Flags.boolean({ description: "Write/read project scope (./.gjc/mcp.json) instead of user scope" }),
		force: Flags.boolean({ description: "Overwrite an existing server during add/import", default: false }),
		"dry-run": Flags.boolean({ description: "Preview an import without writing anything", default: false }),
		json: Flags.boolean({
			char: "j",
			description: "Emit machine-readable JSON with sensitive values redacted",
			default: false,
		}),
		type: Flags.string({ description: "Server transport type", options: ["stdio", "http", "sse"] }),
		command: Flags.string({ description: "Stdio server command for add" }),
		url: Flags.string({ description: "HTTP/SSE server URL for add" }),
		arg: Flags.string({ description: "Argument passed to a stdio server (repeatable)", multiple: true }),
		env: Flags.string({
			description: "Environment variable for stdio server as KEY=VALUE (repeatable)",
			multiple: true,
		}),
		header: Flags.string({
			description: "HTTP/SSE header as KEY=VALUE (repeatable; redacted in output)",
			multiple: true,
		}),
		cwd: Flags.string({ description: "Working directory for stdio server" }),
		timeout: Flags.integer({ description: "Connection timeout in milliseconds" }),
	};

	async run(): Promise<void> {
		if (this.argv.includes("--help") || this.argv.includes("-h")) {
			this.printHelp();
			return;
		}

		const { args, flags } = await this.parse(MCP);
		const action = (args.action ?? "list") as MCPAction;
		const cmd: MCPCommandArgs = {
			action,
			name: args.name,
			commandArgs: args.commandArgs,
			flags: {
				project: flags.project,
				force: flags.force,
				json: flags.json,
				dryRun: flags["dry-run"],
				type: flags.type as MCPCommandArgs["flags"]["type"],
				command: flags.command,
				url: flags.url,
				arg: flags.arg,
				env: flags.env,
				header: flags.header,
				cwd: flags.cwd,
				timeout: flags.timeout,
			},
		};
		await runMCPCommand(cmd);
	}

	private printHelp(): void {
		process.stdout.write(`Register standalone MCP servers explicitly in GJC config

USAGE
  $ gjc mcp [add|list|remove|import] [NAME] [COMMAND_OR_URL] [ARGS...] [FLAGS]

COMMANDS
  add     Add an explicit user-provided MCP server definition
  list    List registered servers with env/header/auth values redacted
  remove  Remove a registered server and print the removed definition redacted
  import  Copy MCP servers from another host into GJC config:
          gjc mcp import <claude|codex|opencode|cursor|all> [--dry-run] [--force] [--project]

FLAGS
      --project          Use project scope (./.gjc/mcp.json) instead of user scope
      --force            Overwrite an existing server during add
  -j, --json             Emit machine-readable JSON with sensitive values redacted
      --type=<value>     stdio | http | sse (default: stdio, or http when --url is set)
      --command=<value>  Stdio server command for add
      --url=<value>      HTTP/SSE server URL for add
      --arg=<value>      Stdio server argument (repeatable)
      --env=<value>      Stdio env var as KEY=VALUE (repeatable; redacted in output)
      --header=<value>   HTTP/SSE header as KEY=VALUE (repeatable; redacted in output)
      --cwd=<value>      Working directory for stdio server
      --timeout=<int>    Connection timeout in milliseconds

EXAMPLES
  $ gjc mcp add context7 npx -y @upstash/context7-mcp
  $ gjc mcp add docs --type http --url https://example.test/mcp --header Authorization=Bearer_TOKEN
  $ gjc mcp import claude
  $ gjc mcp import codex --dry-run
  $ gjc mcp list --json
  $ gjc mcp remove context7

SECURITY
  \`add\` writes only the server definition supplied on this invocation. \`import\` copies definitions from another host's config exactly once — GJC never inherits live MCP runtime from Claude Code, Codex, OpenCode, or Cursor, and secret-indirection fields are omitted rather than read. Public output redacts env, header, auth, and OAuth credential values.
`);
	}
}
