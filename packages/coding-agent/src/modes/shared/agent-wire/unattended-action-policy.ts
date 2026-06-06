/**
 * Unattended action taxonomy + classifier (#319).
 *
 * Maps coarse command scopes and concrete bash commands onto the v1 action
 * taxonomy so the controller can authorize (default-deny) BEFORE any side effect.
 *
 * The classifier is deliberately FAIL-CLOSED for shell evasion:
 *  - nested execution via `$(...)`, backticks, and `<(...)` / `>(...)` is
 *    extracted and classified recursively, so a destructive command hidden in a
 *    substitution cannot masquerade as the harmless outer command;
 *  - statements are split on newlines and `; && || | &`, so a second
 *    (destructive) command on another line is classified too;
 *  - leading environment assignments and wrappers (`sudo`, `env`, `command`,
 *    `xargs`, …) are stripped/followed to the effective command;
 *  - anything that is not provably read-only escalates to at least
 *    `bash.mutating`, and clearly destructive forms escalate further, so an
 *    undeclared destructive action is denied rather than silently allowed.
 */
import type { RpcUnattendedActionClass } from "../../rpc/rpc-types";
import type { BridgeCommandScope } from "./scopes";

/** Coarse command scope -> `command.<scope>` action class. */
export function actionClassForScope(scope: BridgeCommandScope): RpcUnattendedActionClass {
	switch (scope) {
		case "prompt":
			return "command.prompt";
		case "control":
			return "command.control";
		case "bash":
			return "command.bash";
		case "export":
			return "command.export";
		case "session":
			return "command.session";
		case "model":
			return "command.model";
		case "message:read":
			return "command.message_read";
		case "host_tools":
			return "command.host_tools";
		case "host_uri":
			return "command.host_uri";
		case "admin":
			return "command.admin";
	}
}

const READONLY_COMMANDS = new Set([
	"ls",
	"cat",
	"pwd",
	"echo",
	"printf",
	"grep",
	"rg",
	"head",
	"tail",
	"wc",
	"stat",
	"file",
	"which",
	"type",
	"date",
	"whoami",
	"true",
	"false",
	"test",
	"diff",
	"sort",
	"uniq",
	"cut",
	"basename",
	"dirname",
	"realpath",
	"head",
	"tail",
	"cmp",
	"column",
	"tr",
]);

const MUTATING_COMMANDS = new Set([
	"mv",
	"cp",
	"mkdir",
	"touch",
	"ln",
	"chmod",
	"chown",
	"chgrp",
	"tee",
	"install",
	"patch",
	"truncate",
	"npm",
	"bun",
	"pnpm",
	"yarn",
	"pip",
	"pip3",
	"cargo",
	"make",
	"apt",
	"apt-get",
	"brew",
	"go",
	"gradle",
	"docker",
	"kubectl",
	"systemctl",
	"service",
]);

/** Wrappers that execute a following command; classification follows the wrapped command. */
const COMMAND_WRAPPERS = new Set([
	"sudo",
	"env",
	"command",
	"nice",
	"nohup",
	"doas",
	"time",
	"timeout",
	"stdbuf",
	"setsid",
	"ionice",
	"exec",
]);

const SEVERITY: RpcUnattendedActionClass[] = [
	"bash.readonly",
	"bash.mutating",
	"file.write",
	"file.delete",
	"git.force_push",
	"bash.destructive",
];

function worse(a: RpcUnattendedActionClass, b: RpcUnattendedActionClass): RpcUnattendedActionClass {
	return SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b;
}

function stripQuotes(token: string): string {
	return token.replace(/^['"]+/, "").replace(/['"]+$/, "");
}

/** Extract inner command strings from $(...), <(...), >(...), and backticks. */
function extractNested(s: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < s.length; i++) {
		const two = s.slice(i, i + 2);
		if (two === "$(" || two === "<(" || two === ">(") {
			let depth = 0;
			let j = i + 1;
			for (; j < s.length; j++) {
				if (s[j] === "(") depth++;
				else if (s[j] === ")") {
					depth--;
					if (depth === 0) break;
				}
			}
			if (j <= s.length) {
				out.push(s.slice(i + 2, j));
				i = j;
			}
		}
	}
	const backticks = s.match(/`([^`]*)`/g);
	if (backticks) for (const b of backticks) out.push(b.slice(1, -1));
	return out;
}

/** Replace nested substitutions with spaces so outer-statement parsing is clean. */
function stripNested(s: string): string {
	let result = s.replace(/`[^`]*`/g, " ");
	let prev: string;
	do {
		prev = result;
		result = result.replace(/(\$\(|<\(|>\()[^()]*\)/g, " ");
	} while (result !== prev);
	return result;
}

function splitStatements(command: string): string[] {
	return command
		.split(/\n|&&|\|\||;|\||&/)
		.map(s => s.trim())
		.filter(Boolean);
}

function tokenize(statement: string): string[] {
	return statement.split(/\s+/).filter(Boolean);
}

/** Strip leading env-assignments and command wrappers; returns effective argv. */
function effectiveTokens(tokens: string[]): string[] {
	let i = 0;
	while (i < tokens.length) {
		const raw = tokens[i] ?? "";
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) {
			i++;
			continue;
		}
		const bare = stripQuotes(raw);
		if (COMMAND_WRAPPERS.has(bare)) {
			i++;
			// Skip wrapper options and inline env-assignments (e.g. `env -i FOO=bar`).
			while (i < tokens.length && (/^-/.test(tokens[i] ?? "") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? ""))) {
				i++;
			}
			continue;
		}
		break;
	}
	return tokens.slice(i);
}

function classifyGit(rest: string[]): RpcUnattendedActionClass {
	// Skip git global options (`-C dir`, `-c kv`, `--git-dir=…`) to find the subcommand.
	let i = 0;
	while (i < rest.length && rest[i]?.startsWith("-")) {
		const opt = rest[i] ?? "";
		i++;
		if ((opt === "-C" || opt === "-c") && i < rest.length) i++; // these take an argument
	}
	const sub = rest[i];
	const args = rest.slice(i + 1);
	if (sub === "push") {
		const force = args.some(
			a =>
				a === "--force" ||
				a === "-f" ||
				a === "--force-with-lease" ||
				a.startsWith("--force-with-lease=") ||
				a === "--mirror" ||
				a.startsWith("+"),
		);
		const del = args.some(a => a === "--delete" || a === "-d");
		if (force || del) return "git.force_push";
		return "bash.mutating"; // a normal push still mutates the remote
	}
	if ((sub === "reset" && args.includes("--hard")) || (sub === "clean" && args.some(a => /^-[a-z]*f/.test(a)))) {
		return "bash.destructive";
	}
	// Fail-closed: only a known read-only subcommand stays readonly; everything
	// else (clone, init, fetch, pull, commit, worktree, remote, branch -d, …) is
	// treated as mutating so it cannot pass a readonly-only allowlist.
	const READONLY_GIT = new Set([
		"status",
		"log",
		"diff",
		"show",
		"rev-parse",
		"ls-files",
		"ls-remote",
		"ls-tree",
		"for-each-ref",
		"describe",
		"cat-file",
		"blame",
		"shortlog",
		"whatchanged",
		"grep",
		"var",
		"version",
		"help",
	]);
	if (sub !== undefined && READONLY_GIT.has(sub)) {
		// Even read-only subcommands can write a file via an output option.
		if (args.map(stripQuotes).some(a => a === "--output" || a.startsWith("--output=") || a === "-o"))
			return "file.write";
		return "bash.readonly";
	}
	return "bash.mutating";
}

function classifyStatement(statement: string): RpcUnattendedActionClass {
	// Redirection writes to a file (covers bare `> file` and `echo x >> f`).
	let cls: RpcUnattendedActionClass = "bash.readonly";
	// Output redirection to a FILE (incl. fd-qualified `1>f`, `2>>err`); excludes
	// fd duplication like `2>&1` / `>&2` where `&` follows the `>`.
	if (/\d*>>?\s*[^&>\s|]/.test(statement)) cls = worse(cls, "file.write");

	const lower = statement.toLowerCase();
	if (/\bmkfs\b/.test(lower) || /\bdd\b/.test(lower) || /:\(\)\s*\{/.test(statement) || /\bshred\b/.test(lower)) {
		return "bash.destructive";
	}

	const tokens = effectiveTokens(tokenize(statement));
	if (tokens.length === 0) return cls;
	const head = stripQuotes(tokens[0] ?? "");
	const rest = tokens.slice(1);

	// `xargs CMD` runs CMD as the sink; classify the sink.
	if (head === "xargs") {
		const sinkTokens = rest.filter(t => !t.startsWith("-") && !/^-/.test(t));
		if (sinkTokens.length > 0) return worse(cls, classifyStatement(sinkTokens.join(" ")));
		return worse(cls, "bash.mutating");
	}

	if (head === "git") return worse(cls, classifyGit(rest));

	if (head === "rm" || head === "unlink" || head === "rmdir") return worse(cls, "file.delete");
	if (
		head === "find" &&
		(rest.includes("-delete") || rest.includes("-exec") || rest.includes("-execdir") || rest.includes("-ok"))
	) {
		return worse(cls, "file.delete");
	}
	if (head === "sed" && rest.some(t => t === "-i" || t.startsWith("-i"))) return worse(cls, "file.write");

	// Some "read-only" commands can still write/mutate via specific options/operands.
	if (
		head === "sort" &&
		rest.some(a => a === "-o" || a.startsWith("-o") || a === "--output" || a.startsWith("--output="))
	) {
		return worse(cls, "file.write");
	}
	if (head === "uniq" && rest.filter(a => !a.startsWith("-")).length >= 2) return worse(cls, "file.write");
	if (head === "date" && rest.some(a => !a.startsWith("-") && !a.startsWith("+"))) return worse(cls, "bash.mutating");
	if (READONLY_COMMANDS.has(head)) return cls;
	if (MUTATING_COMMANDS.has(head)) return worse(cls, "bash.mutating");

	// Unknown command: conservatively require an explicit mutating allowance.
	return worse(cls, "bash.mutating");
}

/**
 * Classify a (possibly compound / nested) bash command into the most severe
 * action class across all statements and nested substitutions. Fail-closed.
 */
export function classifyBashAction(command: string): RpcUnattendedActionClass {
	let worst: RpcUnattendedActionClass = "bash.readonly";
	for (const inner of extractNested(command)) {
		worst = worse(worst, classifyBashAction(inner));
	}
	for (const stmt of splitStatements(stripNested(command))) {
		worst = worse(worst, classifyStatement(stmt));
	}
	return worst;
}
