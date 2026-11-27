import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import type { AssistantMessage, StopReason, ToolCall, ToolResultMessage, Usage } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	applyPatchSchema,
	hashlineEditParamsSchema,
	patchEditSchema,
	replaceEditSchema,
} from "@gajae-code/coding-agent/edit";
import { SecretObfuscator } from "@gajae-code/coding-agent/secrets";
import {
	BTW_MAX_TOOL_STATUS_LINE_UTF8_BYTES,
	BTW_MAX_TOOL_STATUS_TOTAL_UTF8_BYTES,
	utf8ByteLength,
} from "@gajae-code/coding-agent/session/btw-contract";
import {
	type BtwProjectionEvidence,
	createBtwStatusSanitizer,
	projectBtwVisibleText,
} from "@gajae-code/coding-agent/session/btw-projection";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { BashTool } from "@gajae-code/coding-agent/tools/bash";
import { FindTool } from "@gajae-code/coding-agent/tools/find";
import { ReadTool } from "@gajae-code/coding-agent/tools/read";
import { SearchTool } from "@gajae-code/coding-agent/tools/search";
import { vimSchema } from "@gajae-code/coding-agent/tools/vim";
import { WriteTool } from "@gajae-code/coding-agent/tools/write";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const idle: BtwProjectionEvidence = { runActive: false, pendingToolCallIds: new Set() };
const identity = createBtwStatusSanitizer(undefined);

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function call(id: string, name: string, args: Record<string, unknown>, extra: Partial<ToolCall> = {}): ToolCall {
	return { type: "toolCall", id, name, arguments: args, ...extra };
}

function assistant(content: AssistantMessage["content"], stopReason: StopReason = "toolUse"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason,
		timestamp: 1,
	};
}

function result(id: string, name: string, isError = false, text = "tool output"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError,
		timestamp: 1,
	};
}

function project(messages: AgentMessage[], sanitize = identity, evidence: BtwProjectionEvidence = idle) {
	return projectBtwVisibleText(messages, { ...evidence, sanitize });
}

function statusLines(projected: { text: string }[]): string[] {
	return projected.flatMap(message => message.text.split("\n")).filter(line => line.startsWith("[tool] "));
}

function toolSession(): ToolSession {
	return {
		cwd: "/tmp/btw-projection-fixture",
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => "/tmp/btw-projection-fixture/session.jsonl",
		getSessionSpawns: () => "*",
		getArtifactsDir: () => "/tmp/btw-projection-fixture/session",
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: "/tmp/btw-projection-fixture/artifact-1.log" }),
		settings: Settings.isolated(),
	};
}

const CANARY = "GJCCANARY-BTW-7f3a9d2e-VALUE";

function canaryObfuscator(): SecretObfuscator {
	return new SecretObfuscator([{ type: "plain", content: CANARY }], new Uint8Array(32).fill(9));
}

/** Longest canary window (>= 6 chars) still present once the legitimate placeholder is removed. */
function leakedCanaryWindow(haystack: string, obfuscator: SecretObfuscator): string | undefined {
	const scanned = haystack.split(obfuscator.obfuscate(CANARY)).join("");
	for (let size = CANARY.length; size >= 6; size--) {
		for (let start = 0; start + size <= CANARY.length; start++) {
			const window = CANARY.slice(start, start + size);
			if (scanned.includes(window)) return window;
		}
	}
	return undefined;
}

describe("btw projection: allow-listed targets from real tool schemas", () => {
	const session = toolSession();
	const readTool = new ReadTool(session);
	const writeTool = new WriteTool(session);
	const findTool = new FindTool(session);
	const searchTool = new SearchTool(session);
	const bashTool = new BashTool(session);

	interface Fixture {
		label: string;
		name: string;
		args: Record<string, unknown>;
		accepts: { safeParse(value: unknown): { success: boolean } };
		line: string;
	}
	const fixtures: Fixture[] = [
		{
			label: "read path with selector",
			name: "read",
			args: { path: "src/a.ts:1-20" },
			accepts: readTool.parameters,
			line: "[tool] read src/a.ts:1-20: ok",
		},
		{
			label: "write path without content",
			name: "write",
			args: { path: "out/b.txt", content: "PRIVATE_BODY" },
			accepts: writeTool.parameters,
			line: "[tool] write out/b.txt: ok",
		},
		{
			label: "edit replace mode",
			name: "edit",
			args: { path: "src/c.ts", edits: [{ old_text: "PRIVATE_OLD", new_text: "PRIVATE_NEW" }] },
			accepts: replaceEditSchema,
			line: "[tool] edit src/c.ts: ok",
		},
		{
			label: "edit patch mode",
			name: "edit",
			args: { path: "src/d.ts", edits: [{ op: "update", diff: "PRIVATE_DIFF" }] },
			accepts: patchEditSchema,
			line: "[tool] edit src/d.ts: ok",
		},
		{
			label: "edit hashline mode with path",
			name: "edit",
			args: { path: "src/e.ts", input: "PRIVATE_HASHLINE" },
			accepts: hashlineEditParamsSchema,
			line: "[tool] edit src/e.ts: ok",
		},
		{
			label: "edit hashline mode without path",
			name: "edit",
			args: { input: "PRIVATE_HASHLINE" },
			accepts: hashlineEditParamsSchema,
			line: "[tool] edit: ok",
		},
		{
			label: "edit apply_patch mode has no target field",
			name: "edit",
			args: { input: "*** Begin Patch\nPRIVATE_PATCH\n*** End Patch" },
			accepts: applyPatchSchema,
			line: "[tool] edit: ok",
		},
		{
			label: "edit vim mode",
			name: "edit",
			args: { file: "src/f.ts" },
			accepts: vimSchema,
			line: "[tool] edit src/f.ts: ok",
		},
		{
			label: "find with exactly one path",
			name: "find",
			args: { paths: ["src/**/*.ts"] },
			accepts: findTool.parameters,
			line: "[tool] find src/**/*.ts: ok",
		},
		{
			label: "find with several paths",
			name: "find",
			args: { paths: ["src/**/*.ts", "test/**/*.ts"] },
			accepts: findTool.parameters,
			line: "[tool] find: ok",
		},
		{
			label: "search never projects the pattern",
			name: "search",
			args: { pattern: "PRIVATE_PATTERN", paths: ["src"] },
			accepts: searchTool.parameters,
			line: "[tool] search src: ok",
		},
		{
			label: "search without paths",
			name: "search",
			args: { pattern: "PRIVATE_PATTERN" },
			accepts: searchTool.parameters,
			line: "[tool] search: ok",
		},
		{
			label: "bash keeps only the first command word",
			name: "bash",
			args: { command: "git status --short PRIVATE_ARG" },
			accepts: bashTool.parameters,
			line: "[tool] bash git: ok",
		},
		{
			label: "bash with an env assignment prefix has no certain first token",
			name: "bash",
			args: { command: "TOKEN=PRIVATE_ENV git status" },
			accepts: bashTool.parameters,
			line: "[tool] bash: ok",
		},
		{
			label: "bash with an expansion",
			name: "bash",
			args: { command: "$(whoami) --flag" },
			accepts: bashTool.parameters,
			line: "[tool] bash: ok",
		},
		{
			label: "bash with a shell keyword",
			name: "bash",
			args: { command: "if true; then echo PRIVATE_BRANCH; fi" },
			accepts: bashTool.parameters,
			line: "[tool] bash: ok",
		},
		{
			label: "bash with a path-qualified program",
			name: "bash",
			args: { command: "/opt/PRIVATE_DIR/tool run" },
			accepts: bashTool.parameters,
			line: "[tool] bash: ok",
		},
		{
			label: "read of a url carries no target",
			name: "read",
			args: { path: "https://user:PRIVATE_PASS@example.com/x?token=PRIVATE_TOKEN" },
			accepts: readTool.parameters,
			line: "[tool] read: ok",
		},
		{
			label: "unknown tool keeps only its name",
			name: "mystery_tool",
			args: { path: "src/never.ts", command: "never" },
			accepts: { safeParse: () => ({ success: true }) },
			line: "[tool] mystery_tool: ok",
		},
	];

	for (const fixture of fixtures) {
		it(`projects ${fixture.label}`, () => {
			expect(fixture.accepts.safeParse(fixture.args).success).toBe(true);
			const projected = project([assistant([call("c1", fixture.name, fixture.args)]), result("c1", fixture.name)]);
			expect(projected).toEqual([{ role: "assistant", text: fixture.line }]);
			expect(projected[0]?.text).not.toContain("PRIVATE");
		});
	}

	it("omits the target of a call whose arguments are marked incomplete", () => {
		const projected = project([
			assistant([call("c1", "read", { path: "src/partial.ts" }, { incompleteArguments: true })]),
			result("c1", "read", true),
		]);
		expect(projected).toEqual([{ role: "assistant", text: "[tool] read: error" }]);
	});
});

describe("btw projection: status from typed evidence", () => {
	it("links results to calls by id, independent of order and tool name", () => {
		const projected = project(
			[
				assistant([
					call("a", "read", { path: "src/a.ts" }),
					call("b", "read", { path: "src/b.ts" }),
					call("c", "read", { path: "src/c.ts" }),
				]),
				result("b", "read", true),
				result("a", "read", false),
				result("ghost", "read", true),
			],
			identity,
			{ runActive: true, pendingToolCallIds: new Set(["c"]) },
		);
		expect(statusLines(projected)).toEqual([
			"[tool] read src/a.ts: ok",
			"[tool] read src/b.ts: error",
			"[tool] read src/c.ts: running",
		]);
	});

	it("never links ambiguous ids", () => {
		const duplicateCalls = project([
			assistant([call("dup", "read", { path: "src/one.ts" })]),
			result("dup", "read"),
			assistant([call("dup", "read", { path: "src/two.ts" })]),
		]);
		expect(statusLines(duplicateCalls)).toEqual([]);

		const duplicateResults = project([
			assistant([call("once", "read", { path: "src/one.ts" })]),
			result("once", "read"),
			result("once", "read", true),
		]);
		expect(statusLines(duplicateResults)).toEqual([]);
	});

	it("reports aborted only when the owning assistant message carries the typed aborted stop reason", () => {
		const abortedWithResult = project([
			assistant([call("c1", "bash", { command: "sleep 9" })], "aborted"),
			result("c1", "bash", true, "Tool execution was aborted"),
		]);
		expect(statusLines(abortedWithResult)).toEqual(["[tool] bash sleep: aborted"]);

		const abortedWithoutResult = project([assistant([call("c1", "bash", { command: "sleep 9" })], "aborted")]);
		expect(statusLines(abortedWithoutResult)).toEqual(["[tool] bash sleep: aborted"]);

		const abortPhraseOnly = project([
			assistant([call("c1", "bash", { command: "sleep 9" })], "toolUse"),
			result("c1", "bash", true, "Tool execution was aborted. cancelled. Aborted."),
		]);
		expect(statusLines(abortPhraseOnly)).toEqual(["[tool] bash sleep: error"]);
	});

	it("does not parse result text to decide ok versus error", () => {
		const projected = project([
			assistant([call("ok", "read", { path: "src/ok.ts" }), call("bad", "read", { path: "src/bad.ts" })]),
			result("ok", "read", false, "Error: this is only text, ENOENT, failed"),
			result("bad", "read", true, "all good, 0 errors"),
		]);
		expect(statusLines(projected)).toEqual(["[tool] read src/ok.ts: ok", "[tool] read src/bad.ts: error"]);
	});

	it("reports running only from pending ids or the trailing tool-use message of an active run", () => {
		const trailing = [assistant([call("t", "read", { path: "src/t.ts" })])];
		expect(statusLines(project(trailing, identity, { runActive: true, pendingToolCallIds: new Set() }))).toEqual([
			"[tool] read src/t.ts: running",
		]);
		// No typed evidence: the run is idle, so nothing is claimed.
		expect(statusLines(project(trailing))).toEqual([]);

		const notTrailing = [
			assistant([call("old", "read", { path: "src/old.ts" })]),
			assistant([call("new", "read", { path: "src/new.ts" })]),
			result("new", "read"),
		];
		expect(statusLines(project(notTrailing, identity, { runActive: true, pendingToolCallIds: new Set() }))).toEqual([
			"[tool] read src/new.ts: ok",
		]);

		const errored = [assistant([call("e", "read", { path: "src/e.ts" })], "error")];
		expect(statusLines(project(errored, identity, { runActive: true, pendingToolCallIds: new Set() }))).toEqual([]);
	});
});

describe("btw projection: visible text semantics", () => {
	it("concatenates several assistant text blocks and appends status lines on their own lines", () => {
		const projected = project([
			user("question"),
			assistant([
				{ type: "text", text: "first " },
				{ type: "thinking", thinking: "PRIVATE_THINKING" },
				{ type: "text", text: "second" },
				call("c1", "read", { path: "src/a.ts" }),
			]),
			result("c1", "read"),
		]);
		expect(projected).toEqual([
			{ role: "user", text: "question" },
			{ role: "assistant", text: "first second\n[tool] read src/a.ts: ok" },
		]);
	});

	it("keeps ordinary conversation text unchanged when there are no tool calls", () => {
		const projected = project([
			user("  hello  "),
			assistant([{ type: "text", text: " world " }], "stop"),
			assistant([{ type: "thinking", thinking: "only thinking" }], "stop"),
		]);
		expect(projected).toEqual([
			{ role: "user", text: "hello" },
			{ role: "assistant", text: "world" },
		]);
	});

	it("excludes custom, developer, thinking, image, provider payload and fake output statistics", () => {
		const messages = [
			{ role: "custom", customType: "private", content: "PRIVATE_CUSTOM", display: true, timestamp: 1 },
			{ role: "developer", content: "PRIVATE_DEVELOPER", timestamp: 1 },
			{
				role: "user",
				content: [
					{ type: "text", text: "visible user" },
					{ type: "image", data: "PRIVATE_IMAGE_BASE64", mimeType: "image/png" },
				],
				providerPayload: { private: "PRIVATE_PAYLOAD" },
				timestamp: 1,
			},
			assistant([
				{ type: "thinking", thinking: "PRIVATE_THINKING", thinkingSignature: "PRIVATE_SIGNATURE" },
				{ type: "redactedThinking", data: "PRIVATE_REDACTED" } as never,
				call("c1", "read", { path: "src/a.ts", extra: "PRIVATE_EXTRA" }),
			]),
			{
				...result("c1", "read", false, "999 lines, 123456 bytes exit=0 PRIVATE_OUTPUT"),
				details: { lines: 999, bytes: 123456, secret: "PRIVATE_DETAILS" },
				content: [
					{ type: "text", text: "999 lines, 123456 bytes exit=0 PRIVATE_OUTPUT" },
					{ type: "image", data: "PRIVATE_RESULT_IMAGE", mimeType: "image/png" },
				],
			},
		] as AgentMessage[];
		const projected = project(messages);
		expect(projected).toEqual([
			{ role: "user", text: "visible user" },
			{ role: "assistant", text: "[tool] read src/a.ts: ok" },
		]);
		const serialized = JSON.stringify(projected);
		for (const forbidden of ["PRIVATE", "999", "123456", "exit=", "bytes"]) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	it("does not modify the messages it reads", () => {
		const messages = [
			user("question"),
			assistant([call("c1", "bash", { command: "git status" })]),
			result("c1", "bash"),
		];
		const before = structuredClone(messages);
		project(messages, identity, { runActive: true, pendingToolCallIds: new Set(["c1"]) });
		expect(messages).toEqual(before);
	});
});

describe("btw projection: secret sanitation precedes every byte budget", () => {
	it("scrubs a secret from a path, a bash command word, and an unknown tool name", () => {
		const obfuscator = canaryObfuscator();
		const projected = project(
			[
				assistant([
					call("p", "read", { path: `src/${CANARY}/a.ts` }),
					call("b", "bash", { command: `${CANARY} --flag` }),
					call("u", `tool-${CANARY}`, {}),
				]),
				result("p", "read"),
				result("b", "bash"),
				result("u", `tool-${CANARY}`, true),
			],
			createBtwStatusSanitizer(obfuscator),
		);
		const lines = statusLines(projected);
		expect(lines).toHaveLength(3);
		expect(leakedCanaryWindow(lines.join("\n"), obfuscator)).toBeUndefined();
		expect(lines.join("\n")).toContain(obfuscator.obfuscate(CANARY));
		expect(lines[0]).toStartWith("[tool] read src/#GJC1_");
		expect(lines[2]).toEndWith(": error");
	});

	it("scrubs a secret that straddles the line byte cut before truncating", () => {
		const obfuscator = canaryObfuscator();
		const prefix = "[tool] read ";
		const suffix = ": ok";
		const cut = BTW_MAX_TOOL_STATUS_LINE_UTF8_BYTES - suffix.length;
		// Ten secret characters would remain in a truncate-then-sanitize pipeline.
		const offset = cut - prefix.length - 10;
		const path = `${"x".repeat(offset)}${CANARY}${"y".repeat(40)}`;
		const rawHead = `${prefix}${path}`;
		expect(rawHead.slice(0, cut)).toContain(CANARY.slice(0, 10));
		expect(rawHead.slice(0, cut)).not.toContain(CANARY);

		const projected = project(
			[assistant([call("c1", "read", { path })]), result("c1", "read")],
			createBtwStatusSanitizer(obfuscator),
		);
		const [line] = statusLines(projected);
		expect(line).toBeDefined();
		expect(leakedCanaryWindow(line!, obfuscator)).toBeUndefined();
		expect(utf8ByteLength(line!)).toBeLessThanOrEqual(BTW_MAX_TOOL_STATUS_LINE_UTF8_BYTES);
		expect(line).toEndWith(": ok");
	});

	it("uses the identity sanitizer only when no secret is active", () => {
		const emptySet = new SecretObfuscator([], new Uint8Array(32).fill(1));
		expect(createBtwStatusSanitizer(undefined)(CANARY)).toBe(CANARY);
		expect(createBtwStatusSanitizer(emptySet)(CANARY)).toBe(CANARY);
		const active = canaryObfuscator();
		expect(createBtwStatusSanitizer(active)(CANARY)).not.toContain(CANARY);
	});
});

describe("btw projection: byte budgets", () => {
	it("keeps a status line within 192 UTF-8 bytes without splitting a scalar", () => {
		for (const path of ["한".repeat(200), `src/${"🙂".repeat(120)}.ts`, `${"a".repeat(400)}.ts`]) {
			const projected = project([assistant([call("c1", "read", { path })]), result("c1", "read", true)]);
			const [line] = statusLines(projected);
			expect(line).toBeDefined();
			expect(utf8ByteLength(line!)).toBeLessThanOrEqual(BTW_MAX_TOOL_STATUS_LINE_UTF8_BYTES);
			expect(line).toEndWith(": error");
			expect(line).not.toContain("\uFFFD");
		}
	});

	it("keeps a line of exactly 192 bytes and truncates one byte over", () => {
		const fixed = utf8ByteLength("[tool] read ") + utf8ByteLength(": ok");
		const exact = project([
			assistant([call("c1", "read", { path: "p".repeat(BTW_MAX_TOOL_STATUS_LINE_UTF8_BYTES - fixed) })]),
			result("c1", "read"),
		]);
		expect(utf8ByteLength(statusLines(exact)[0]!)).toBe(BTW_MAX_TOOL_STATUS_LINE_UTF8_BYTES);
		expect(statusLines(exact)[0]).toContain("p".repeat(BTW_MAX_TOOL_STATUS_LINE_UTF8_BYTES - fixed));

		const over = project([
			assistant([call("c1", "read", { path: "p".repeat(BTW_MAX_TOOL_STATUS_LINE_UTF8_BYTES - fixed + 1) })]),
			result("c1", "read"),
		]);
		expect(utf8ByteLength(statusLines(over)[0]!)).toBe(BTW_MAX_TOOL_STATUS_LINE_UTF8_BYTES);
		expect(statusLines(over)[0]).toContain("p".repeat(BTW_MAX_TOOL_STATUS_LINE_UTF8_BYTES - fixed));
		expect(statusLines(over)[0]).not.toContain("p".repeat(BTW_MAX_TOOL_STATUS_LINE_UTF8_BYTES - fixed + 1));
	});

	it("drops the oldest status lines first once the total budget is exceeded", () => {
		const count = 40;
		const messages: AgentMessage[] = [];
		for (let index = 0; index < count; index++) {
			const id = `c${index}`;
			const path = `dir/${String(index).padStart(2, "0")}-${"p".repeat(80)}`;
			messages.push(assistant([call(id, "read", { path })]), result(id, "read"));
		}
		const projected = project(messages);
		const lines = statusLines(projected);
		const charged = lines.reduce((sum, line) => sum + utf8ByteLength(line) + 1, 0);
		expect(charged).toBeLessThanOrEqual(BTW_MAX_TOOL_STATUS_TOTAL_UTF8_BYTES);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.length).toBeLessThan(count);
		// Newest contiguous suffix survives; the oldest assistant messages vanish entirely.
		const firstKept = count - lines.length;
		lines.forEach((line, offset) => {
			expect(line).toContain(`dir/${String(firstKept + offset).padStart(2, "0")}-`);
		});
		expect(projected).toHaveLength(lines.length);
		expect(lines.at(-1)).toContain(`dir/${String(count - 1).padStart(2, "0")}-`);
		// One more line would not have fit.
		const nextCost = utf8ByteLength(lines[0]!) + 1;
		expect(charged + nextCost).toBeGreaterThan(BTW_MAX_TOOL_STATUS_TOTAL_UTF8_BYTES);
	});

	it("does not let status budgeting remove or alter ordinary text of dropped lines' messages", () => {
		const messages: AgentMessage[] = [user("kept question")];
		for (let index = 0; index < 40; index++) {
			const id = `c${index}`;
			messages.push(
				assistant([
					{ type: "text", text: `narration ${index}` },
					call(id, "read", { path: `dir/${String(index).padStart(2, "0")}-${"p".repeat(80)}` }),
				]),
				result(id, "read"),
			);
		}
		const projected = project(messages);
		expect(projected[0]).toEqual({ role: "user", text: "kept question" });
		expect(projected).toHaveLength(41);
		expect(projected[1]?.text).toBe("narration 0");
		expect(projected.at(-1)?.text).toStartWith("narration 39\n[tool] read dir/39-");
	});
});
