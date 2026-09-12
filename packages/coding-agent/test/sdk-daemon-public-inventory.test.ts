import { describe, expect, test } from "bun:test";
import {
	getPublicCommand,
	getPublicCommandChildren,
	getPublicRawOperations,
	PUBLIC_COMMANDS,
	resolvePublicCommand,
} from "../src/cli/public-command-registry";

// Independent reachable CLI baseline: do not derive this from registry children or domain tokens.
const PATHS = [
	"sdk",
	"sdk serve",
	"sdk search",
	"sdk spawn",
	"sdk session",
	"sdk session list",
	"sdk session inspect",
	"sdk session send",
	"sdk session status",
	"sdk session tail",
	"sdk session retire",
	"sdk session raw",
	"sdk session raw control",
	"sdk session raw query",
	"sdk session raw global",
	"sdk guides",
	"sdk guides refresh",
	"sdk guides list",
	"sdk guides show",
	"sdk guides status",
	"sdk guides trust",
	"daemon",
	"daemon list",
	"daemon status",
	"daemon stop",
	"daemon restart",
	"daemon reload",
];
const OPERATION_FLAGS: Record<string, string[]> = {
	sdk: [],
	"sdk serve": ["stdio", "socket", "session", "pending-ceiling"],
	"sdk search": ["agent-dir", "repo", "scope", "limit", "cursor"],
	"sdk spawn": ["agent-dir", "cwd", "prompt", "model", "profile", "idempotency-key"],
	"sdk session": [],
	"sdk session list": ["agent-dir", "repo", "scope"],
	"sdk session inspect": ["agent-dir"],
	"sdk session send": [
		"agent-dir",
		"json-input",
		"json-input-file",
		"json-input-stdin",
		"text",
		"op-ref",
		"wait",
		"timeout-ms",
	],
	"sdk session status": ["agent-dir", "timeout-ms"],
	"sdk session tail": ["agent-dir", "repo", "cursor", "strict", "until-idle", "all-events", "timeout-ms"],
	"sdk session retire": ["agent-dir", "json-input", "json-input-file", "json-input-stdin", "idempotency-key"],
	"sdk session raw": [],
	"sdk session raw control": [
		"agent-dir",
		"json-input",
		"json-input-file",
		"json-input-stdin",
		"op",
		"confirm",
		"idempotency-key",
		"timeout-ms",
	],
	"sdk session raw query": [
		"agent-dir",
		"json-input",
		"json-input-file",
		"json-input-stdin",
		"query",
		"cursor",
		"timeout-ms",
	],
	"sdk session raw global": [
		"agent-dir",
		"json-input",
		"json-input-file",
		"json-input-stdin",
		"op",
		"idempotency-key",
		"page",
		"limit",
		"cursor",
	],
	"sdk guides": [],
	"sdk guides refresh": ["agent-dir", "url", "timeout-ms"],
	"sdk guides list": ["agent-dir"],
	"sdk guides show": ["agent-dir"],
	"sdk guides status": ["agent-dir"],
	"sdk guides trust": [],
	daemon: ["all", "verbose"],
	"daemon list": ["all", "verbose"],
	"daemon status": ["all", "verbose"],
	"daemon stop": ["all", "force", "graceful-timeout-ms", "kill-timeout-ms"],
	"daemon restart": ["all", "force", "graceful-timeout-ms", "kill-timeout-ms", "spawn-if-stopped"],
	"daemon reload": ["all", "force", "graceful-timeout-ms", "kill-timeout-ms", "spawn-if-stopped"],
};
function command(path: string) {
	const descriptor = getPublicCommand(path.split(" "));
	if (!descriptor) throw new Error(`Missing public command ${path}`);
	return descriptor;
}

describe("static SDK/daemon public inventory", () => {
	test("enumerates exactly the 27 reachable public paths and connects immediate children", () => {
		expect(PUBLIC_COMMANDS.map(row => row.command.join(" ")).sort()).toEqual([...PATHS].sort());
		for (const path of PATHS) {
			const descriptor = command(path);
			const expectedChildren = PATHS.filter(
				candidate =>
					candidate.startsWith(`${path} `) && candidate.split(" ").length === descriptor.command.length + 1,
			);
			expect(
				getPublicCommandChildren(descriptor)
					.map(row => row.command.join(" "))
					.sort(),
			).toEqual(expectedChildren.sort());
			expect(descriptor.parent).toEqual(path.includes(" ") ? path.split(" ").slice(0, -1) : null);
		}
	});

	test("each local grammar contains only semantically relevant operation flags", () => {
		for (const [path, flags] of Object.entries(OPERATION_FLAGS)) {
			expect(
				Object.entries(command(path).flags)
					.filter(([, flag]) => !flag.boundary)
					.map(([name]) => name)
					.sort(),
			).toEqual([...flags].sort());
		}
		expect(command("sdk session list").flags.scope?.options).toEqual(["repo", "cwd", "worktree", "all"]);
		expect(command("sdk search").flags.scope?.options).toEqual(["repo", "pwd", "global"]);
		expect(command("sdk search").flags.limit?.kind).toBe("integer");
		expect(command("sdk search").flags.limit?.validation).toBe("search-limit");
		expect(command("sdk guides refresh").flags.url?.required).toBe(true);
		expect(command("sdk spawn").flags.cwd?.required).toBe(true);
		expect(command("sdk spawn").flags.prompt?.required).toBe(true);
	});

	test("session and guide positional grammars do not leak sibling arguments", () => {
		const positional: Record<string, string[]> = {
			"sdk session list": [],
			"sdk session inspect": ["sessionId"],
			"sdk session send": ["sessionId"],
			"sdk session status": ["sessionId", "opRef"],
			"sdk session tail": ["sessionId"],
			"sdk session retire": ["sessionId"],
			"sdk session raw control": ["sessionId"],
			"sdk session raw query": ["sessionId"],
			"sdk session raw global": [],
			"sdk guides refresh": [],
			"sdk guides show": ["guideId"],
			"sdk guides list": [],
			"sdk guides status": [],
			"sdk guides trust": [],
		};
		for (const [path, names] of Object.entries(positional)) {
			expect(Object.keys(command(path).args)).toEqual(names);
			for (const arg of Object.values(command(path).args)) expect(arg.required).toBe(true);
		}
		expect(command("daemon status").args.kind).toMatchObject({
			required: false,
			multiple: true,
			options: ["telegram", "discord", "slack"],
		});
	});

	test("preserves alias identity, nearest known path and exact lookup distinction", () => {
		expect(command("daemon reload").canonicalCommand).toEqual(["daemon", "restart"]);
		expect(command("daemon reload").flags).toEqual(command("daemon restart").flags);
		expect(resolvePublicCommand(["sdk", "session", "raw", "query"])).toMatchObject({
			consumed: 4,
			remaining: [],
			exact: true,
		});
		expect(resolvePublicCommand(["sdk", "session", "raw", "unknown"])).toMatchObject({
			descriptor: { command: ["sdk", "session", "raw"] },
			consumed: 3,
			remaining: ["unknown"],
			exact: false,
		});
		expect(resolvePublicCommand(["sdk", "session", "inspect", "session-123"])).toMatchObject({
			consumed: 3,
			remaining: ["session-123"],
			exact: false,
		});
		expect(getPublicCommand(["sdk", "session", "inspect", "session-123"])).toBeUndefined();
		expect(resolvePublicCommand(["unrelated"])).toBeUndefined();
		expect(resolvePublicCommand([])).toBeUndefined();
	});

	test("excludes workers, function-only verbs and credential-disclosing raw operations", () => {
		for (const path of [
			"sdk broker-internal",
			"sdk session-host-internal",
			"daemon discord-internal",
			"daemon slack-internal",
			"sdk session search",
			"sdk session control",
			"sdk session query",
			"sdk session global",
			"daemon restart sdk",
		]) {
			expect(getPublicCommand(path.split(" "))).toBeUndefined();
		}
		for (const descriptor of PUBLIC_COMMANDS) {
			expect(descriptor.flags.smoke).toBeUndefined();
			expect(descriptor.flags["owner-id"]).toBeUndefined();
			if (descriptor.command[0] === "daemon") expect(descriptor.flags["agent-dir"]).toBeUndefined();
		}
		const global = getPublicRawOperations("global").map(row => row.sdkId);
		expect(global).toContain("session.reconcile_uncertain");
		expect(global).toContain("session.list");
		expect(global).not.toContain("session.get_endpoint");
		expect(global).not.toContain("session.spawn");
		expect(getPublicRawOperations("control").map(row => row.sdkId)).not.toContain("bash.execute");
		expect(getPublicRawOperations("query").find(row => row.sdkId === "turn.result")?.aliases).toContain(
			"turn.prompt_status",
		);
	});

	test("root-only evidence selectors are distinct from operation scope and require pinned references", () => {
		for (const family of ["sdk", "daemon"]) {
			const flags = command(family).flags;
			expect(flags["error-ref"]).toMatchObject({
				kind: "string",
				boundary: "retrieval",
				validation: "error-id",
				requires: ["error-sha256"],
				conflicts: ["help"],
			});
			expect(flags["error-sha256"]).toMatchObject({ validation: "sha256", requires: ["error-ref"] });
			expect(flags["error-page"]).toMatchObject({
				validation: "positive-safe-integer",
				requires: ["error-ref", "error-sha256"],
			});
			expect(flags["error-agent-dir"]?.requires).toEqual(["error-ref", "error-sha256"]);
		}
		for (const descriptor of PUBLIC_COMMANDS.filter(row => row.parent !== null)) {
			for (const name of ["error-ref", "error-sha256", "error-page", "error-agent-dir"])
				expect(descriptor.flags[name]).toBeUndefined();
		}
	});

	test("captures help selector arity, transport exclusivity and mutation semantics", () => {
		for (const descriptor of PUBLIC_COMMANDS) {
			expect(descriptor.flags.help).toMatchObject({ kind: "boolean", char: "h" });
			expect(descriptor.flags.json?.kind).toBe("boolean");
			expect(descriptor.flags["help-section"]).toMatchObject({
				kind: "string",
				requires: ["help"],
				options: ["overview", "usage", "children", "arguments", "options", "examples", "recovery"],
			});
			expect(descriptor.flags["help-page"]?.validation).toBe("positive-safe-integer");
			expect(descriptor.flags["help-revision"]?.validation).toBe("sha256");
			expect(descriptor.usage[0]?.syntax).toStartWith(`gjc ${descriptor.command.join(" ")}`);
			expect(descriptor.examples.length).toBeGreaterThan(0);
			for (const example of descriptor.examples) expect(example.executable).toBe(false);
			expect(descriptor.recovery.length).toBeGreaterThan(0);
		}
		expect(command("sdk serve").exactlyOneOf).toEqual([["stdio", "socket"]]);
		expect(command("sdk serve").flags.socket).toMatchObject({
			kind: "string",
			conflicts: ["stdio"],
			valueSyntax: "separate",
		});
		expect(command("sdk serve").flags["pending-ceiling"]?.validation).toBe("pending-ceiling");
		for (const path of [
			"daemon stop",
			"daemon restart",
			"daemon reload",
			"sdk session retire",
			"sdk session raw control",
		]) {
			expect(command(path).risk?.length).toBeGreaterThan(0);
			expect(
				command(path).recovery.some(step => step.requiresConfirmation && step.disruption === "interrupts-work"),
			).toBe(true);
		}
		expect(command("daemon stop").flags.force?.risk).toContain("SIGKILL");
		expect(command("sdk session retire").flags.confirm).toBeUndefined();
		expect(command("sdk session retire").flags["idempotency-key"]?.required).toBe(true);
		expect(command("sdk session retire").constraints.join(" ")).toContain("dead-host proof");
		expect(command("sdk session raw global").flags["idempotency-key"]?.required).not.toBe(true);
		expect(command("sdk session raw control").flags.op?.required).toBe(true);
		expect(command("sdk session raw query").flags.query?.required).toBe(true);
	});
});
