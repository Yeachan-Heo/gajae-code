import { describe, expect, test } from "bun:test";
import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import { fitMessages, HISTORY_LIMIT, projectHistoryPage, projectMessages } from "../src/message-projection";
import type { DesktopMessage } from "../src/protocol";
import {
	LIVE_TAIL_LIMIT,
	observeToolEvent,
	projectLiveToolCalls,
	projectToolDetail,
	TOOL_DETAIL_GONE,
} from "../src/tool-projection";
import { DESKTOP_TOOL_LIMITS, type DesktopToolCall } from "../src/tool-protocol";

type Session = CreateAgentSessionResult["session"];

const live = { sessionGeneration: 1 };

/** One call and its result, projected the way the Host projects a live session. */
function row(
	name: string,
	args: Record<string, unknown>,
	result: Record<string, unknown> = {},
	redact: (text: string) => string = text => text,
): DesktopToolCall | undefined {
	const messages = projectMessages(
		[
			{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name, arguments: args }] },
			{ role: "toolResult", toolCallId: "c1", toolName: name, content: [{ type: "text", text: "ok" }], ...result },
		],
		redact,
		500_000,
		live,
	);
	return messages.find(message => message.role === "tool")?.tool;
}

describe("tool row summaries", () => {
	test("each family builds its subject only from its allowlisted fields", () => {
		const hidden = { content: "body-hidden", env: { TOKEN: "env-hidden" }, timeout: 5, _i: "intent-from-args" };
		const cases: Array<[string, Record<string, unknown>, Partial<DesktopToolCall>]> = [
			["read", { path: "src/app.ts:10-20", ...hidden }, { family: "read", subject: "src/app.ts:10-20" }],
			[
				"read",
				{ path: "https://user:pass@example.com/doc?q=1" },
				{ family: "read", subject: "https://example.com/doc?q=1" },
			],
			["write", { path: "notes/plan.md", content: "a\nb\n" }, { family: "write", subject: "notes/plan.md" }],
			["edit", { path: "src/a.ts", edits: [{ old_text: "old-hidden" }] }, { family: "edit", subject: "src/a.ts" }],
			[
				"edit",
				{
					input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-hidden-old\n+hidden-new\n*** Add File: src/b.ts\n+hidden\n*** End Patch",
				},
				{ family: "edit", subject: "src/a.ts · src/b.ts" },
			],
			[
				"edit",
				{ input: "§src/c.ts\n10=hidden-payload", path: "src/other.ts" },
				{ family: "edit", subject: "src/c.ts" },
			],
			["edit", { input: "10=hidden-payload", path: "src/d.ts" }, { family: "edit", subject: "src/d.ts" }],
			[
				"edit",
				{ file: "src/vim.ts", steps: [{ kbd: ["dd"], insert: "hidden" }] },
				{ family: "edit", subject: "src/vim.ts" },
			],
			["write", { file_path: "notes/alt.md", content: "hidden" }, { family: "write", subject: "notes/alt.md" }],
			[
				"ast_edit",
				{ ops: [{ pat: "pat-hidden" }], paths: ["src/", "test/"] },
				{ family: "edit", subject: "src/ · test/" },
			],
			[
				"search",
				{ pattern: "TODO\\(", paths: ["src/**/*.ts"], i: true },
				{ family: "search", subject: "TODO\\( · src/**/*.ts" },
			],
			["ast_grep", { pat: "foo($A)", paths: ["lib/"] }, { family: "search", subject: "foo($A) · lib/" }],
			["find", { paths: ["**/*.test.ts"], limit: 10 }, { family: "find", subject: "**/*.test.ts" }],
			[
				"bash",
				{ command: "\n  npm test -- --watch\nrm -rf hidden-line", ...hidden },
				{ family: "shell", subject: "$ npm test -- --watch" },
			],
			["ssh", { host: "host-hidden", command: "uptime" }, { family: "shell", subject: "$ uptime" }],
			["python", { action: "run", code: "import os\nprint(os.environ)" }, { family: "shell", subject: "import os" }],
			["eval", { cells: [{ language: "js", code: "1 + 1\nhidden()" }] }, { family: "shell", subject: "1 + 1" }],
			["web_search", { query: "bun test spyOn", recency: "week" }, { family: "web", subject: "bun test spyOn" }],
			[
				"task",
				{ agent: "executor", tasks: [{ assignment: "assignment-hidden" }, {}] },
				{ family: "task", subject: "executor", stats: { tasks: 2 } },
			],
			[
				"todo_write",
				{ ops: [{ op: "done", task: "Write tests" }, { op: "start" }] },
				{ family: "todo", subject: "done · Write tests" },
			],
			["search_tool_bm25", { query: "todo list", limit: 3 }, { family: "tool-search", subject: "todo list" }],
			["skill", { name: "ralplan", args: "args-hidden" }, { family: "other", subject: "ralplan" }],
			["mcp_server_tool", { query: "mcp-hidden" }, { family: "other" }],
		];
		for (const [name, args, expected] of cases) {
			const tool = row(name, args);
			expect(tool).toMatchObject({ callId: "c1", status: "done", ...expected });
			if (!expected.subject) expect(tool?.subject).toBeUndefined();
			expect(JSON.stringify(tool)).not.toMatch(/hidden/);
		}
		expect(row("read", { path: "a", _i: "Check the entry point" })?.intent).toBe("Check the entry point");
	});

	test("subjects and intent are redacted whole and stay on one bounded line", () => {
		const secret = "secret-value";
		const redact = (text: string) => text.replaceAll(secret, "[redacted]");
		const tool = row(
			"search",
			{
				pattern: `key=${secret}\nnext`,
				paths: [`dir/${secret}`, ...Array.from({ length: 200 }, () => "p".repeat(50))],
			},
			{},
			redact,
		);
		expect(tool?.subject?.startsWith("key=[redacted] next · dir/[redacted] · ")).toBe(true);
		expect(tool?.subject).toHaveLength(DESKTOP_TOOL_LIMITS.subject);
		const intent = row("read", { path: "a", _i: `${"i".repeat(195)}${secret}` }, {}, redact)?.intent;
		expect(intent).toBe(`${"i".repeat(195)}[reda`);
		expect(row("read", { path: "x".repeat(8 * 1024 * 1024 + 1) })?.subject).toBeUndefined();
	});

	test("status comes from the result", () => {
		expect(row("read", { path: "missing" }, { isError: true })?.status).toBe("failed");
		expect(
			row(
				"bash",
				{ command: "sleep 9" },
				{ isError: true, content: [{ type: "text", text: "Tool execution was aborted." }] },
			)?.status,
		).toBe("cancelled");
		expect(
			row(
				"bash",
				{ command: "x" },
				{ isError: true, content: [{ type: "text", text: "Skipped due to queued user message." }] },
			)?.status,
		).toBe("cancelled");
		expect(
			row("bash", { command: "serve" }, { details: { async: { state: "running", jobId: "j", type: "bash" } } })
				?.status,
		).toBe("background");
		expect(row("task", { agent: "a" }, { details: { async: { state: "completed" } } })?.status).toBe("done");
	});

	test("small facts come from result details", () => {
		const diff = "@@ -1,2 +1,3 @@\n 1|keep\n-2|old\n+2|new\n+3|added";
		expect(row("edit", { path: "a" }, { details: { diff } })?.stats).toEqual({ added: 2, removed: 1 });
		expect(
			row(
				"edit",
				{ path: "a" },
				{
					details: {
						diff: "",
						perFileResults: [
							{ path: "a", diff },
							{ path: "b", diff: "+1|x" },
						],
					},
				},
			)?.stats,
		).toEqual({ added: 3, removed: 1, files: 2 });
		expect(row("write", { path: "a", content: "one\ntwo\n" })?.stats).toEqual({ added: 2 });
		expect(row("search", { pattern: "x" }, { details: { matchCount: 4, fileCount: 2 } })?.stats).toEqual({
			matches: 4,
			files: 2,
		});
		expect(row("find", { paths: ["*"] }, { details: { fileCount: 7 } })?.stats).toEqual({ files: 7 });
		expect(
			row(
				"bash",
				{ command: "false" },
				{ isError: true, content: [{ type: "text", text: "out\n\nCommand exited with code 3" }] },
			)?.stats,
		).toEqual({ exitCode: 3 });
		expect(row("bash", { command: "true" })?.stats).toBeUndefined();
		const names = Array.from({ length: 12 }, (_, index) => `tool_${index}`);
		const redact = (text: string) => text.replaceAll("tool_0", "[redacted]");
		expect(row("search_tool_bm25", { query: "q" }, { details: { activated_tools: names } }, redact)?.stats).toEqual({
			activated: ["[redacted]", ...names.slice(1, DESKTOP_TOOL_LIMITS.statsActivated)],
		});
	});

	test("only a live Host projection marks rows as expandable", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }] },
			{ role: "toolResult", toolCallId: "c1", toolName: "read", content: "ok" },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c2", name: "read", arguments: { _i: "only intent" } }],
			},
			{ role: "toolResult", toolCallId: "c2", toolName: "read", content: "ok" },
		];
		expect(projectMessages(messages).map(message => message.tool?.detail)).toEqual([false, false]);
		expect(projectMessages(messages, undefined, 500_000, live).map(message => message.tool?.detail)).toEqual([
			true,
			false,
		]);
		expect(projectHistoryPage(messages, 0, 10, undefined, live).page.map(message => message.tool?.detail)).toEqual([
			true,
			false,
		]);
	});

	test("a committed call's subject and intent are redacted once per secret set, and again after it changes", () => {
		const secret = "sk-learned-later-0123456789";
		const secrets = new Set<string>();
		const input = `*** Begin Patch\n*** Update File: src/${secret}.ts\n${"+ line\n".repeat(1_000)}*** End Patch`;
		let reads = 0;
		const redact = (text: string) => {
			if (text === input) reads++;
			for (const known of secrets) text = text.replaceAll(known, "[redacted]");
			return text;
		};
		const call = { type: "toolCall", id: "c1", name: "edit", arguments: { input, _i: `Edit ${secret}` } };
		const messages = [
			{ role: "assistant", stopReason: "toolUse", content: [call] },
			{ role: "toolResult", toolCallId: "c1", toolName: "edit", content: "ok", details: { diff: "+1|a" } },
		];
		const project = () => projectMessages(messages, redact, 500_000, { ...live, secrets })[0]?.tool;
		expect(project()).toMatchObject({ subject: `src/${secret}.ts`, intent: `Edit ${secret}` });
		expect(project()?.subject).toBe(`src/${secret}.ts`);
		expect(reads).toBe(1);
		// A secret learned after the first projection is redacted on the next one.
		secrets.add(secret);
		expect(project()).toMatchObject({ subject: "src/[redacted].ts", intent: "Edit [redacted]" });
		expect(reads).toBe(2);
		// Status and stats come from the result every time: the SDK rewrites results in place.
		(messages[1] as { isError?: boolean }).isError = true;
		expect(project()).toMatchObject({ status: "failed", subject: "src/[redacted].ts" });
		expect(reads).toBe(2);
		// Without the Host's secret set nothing is remembered.
		projectMessages(messages, redact, 500_000, live);
		projectMessages(messages, redact, 500_000, live);
		expect(reads).toBe(4);
	});

	test("a reused call id pairs each result with its nearest preceding call", () => {
		const messages = projectMessages([
			{ role: "assistant", content: [{ type: "toolCall", id: "dup", name: "read", arguments: { path: "first" } }] },
			{ role: "toolResult", toolCallId: "dup", toolName: "read", content: "1" },
			{ role: "assistant", content: [{ type: "toolCall", id: "dup", name: "read", arguments: { path: "second" } }] },
			{ role: "toolResult", toolCallId: "dup", toolName: "read", content: "2" },
			{ role: "toolResult", toolCallId: "orphan", toolName: "read", content: "3" },
			{ role: "toolResult", toolName: "read", content: "no id" },
		]);
		expect(messages.map(message => message.tool?.subject)).toEqual(["first", "second", undefined, undefined]);
		expect(messages[2]?.tool).toEqual({ callId: "orphan", status: "done", family: "read", detail: false });
		expect(messages[3]?.tool).toBeUndefined();
	});

	test("a result in the window pairs with its call even when the call is older than the window", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", id: "far", name: "read", arguments: { path: "old.ts" } }] },
			...Array.from({ length: HISTORY_LIMIT + 40 }, (_, index) => ({ role: "user", content: `note ${index}` })),
			{ role: "toolResult", toolCallId: "far", toolName: "read", content: "ok" },
		];
		const projected = projectMessages(messages, undefined, 500_000, live);
		expect(projected).toHaveLength(HISTORY_LIMIT);
		expect(projected.at(-1)?.tool?.subject).toBe("old.ts");
	});

	test("tool metadata stays small enough for a full window in the snapshot budget", () => {
		const window = (query: string, intent: string, activated: string[]) => {
			const messages: unknown[] = [];
			for (let index = 0; index < HISTORY_LIMIT; index++) {
				const id = `toolu_${index}_${"x".repeat(24)}`;
				messages.push({
					role: "assistant",
					content: [{ type: "toolCall", id, name: "search_tool_bm25", arguments: { query, _i: intent } }],
				});
				messages.push({
					role: "toolResult",
					toolCallId: id,
					toolName: "search_tool_bm25",
					content: "ok",
					details: { activated_tools: activated },
				});
			}
			return projectMessages(messages, undefined, 500_000, live);
		};
		// Worst case: every bound reached with three-byte characters.
		const worst = window(
			"長".repeat(400),
			"長".repeat(400),
			Array.from({ length: 20 }, () => "n".repeat(200)),
		);
		expect(worst).toHaveLength(HISTORY_LIMIT);
		const sizes = worst.map(message => Buffer.byteLength(JSON.stringify(message.tool), "utf8"));
		expect(Math.max(...sizes)).toBeLessThan(3_000);
		expect(worst.every((message: DesktopMessage) => message.tool?.subject?.length === 300)).toBe(true);
		// One conversation's whole snapshot share holds even the worst-case window.
		expect(fitMessages(worst, 500_000).truncated).toBe(false);
		// Typical rows fit when three conversations share the snapshot.
		const typical = window("todo list", "Find the task tool", ["todo_write"]);
		expect(fitMessages(typical, Math.floor(500_000 / 3)).truncated).toBe(false);
	});
});

/** The parts of a live SDK session the live-row projection reads. */
function fakeSession(messages: unknown[], pending: string[] = [], isStreaming = true) {
	return { isStreaming, messages, state: { pendingToolCalls: new Set(pending) } } as unknown as Session;
}
const assistantCalls = (...calls: Array<[string, string, Record<string, unknown>]>) => ({
	role: "assistant",
	stopReason: "toolUse",
	content: calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })),
});

describe("live tool rows", () => {
	test("calls without a result are preparing, waiting or running only while the session streams", () => {
		const history = [
			{ role: "user", content: "earlier" },
			assistantCalls(["old", "read", { path: "never-settled" }]),
			{ role: "user", content: "now" },
			assistantCalls(
				["a", "read", { path: "a.ts" }],
				["b", "bash", { command: "npm test" }],
				["c", "edit", { path: "c.ts" }],
			),
			{ role: "toolResult", toolCallId: "a", toolName: "read", content: "done" },
		];
		const streaming = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "d", name: "write", arguments: { path: "d.md", __partialJson: '{"path":"d.md' } },
			],
		};
		const session = fakeSession(history, ["b"]);
		const rows = projectLiveToolCalls(session, streaming, text => text);
		expect(rows.map(row => [row.id, row.role, row.tool?.status, row.tool?.subject])).toEqual([
			["call:b", "tool", "running", "$ npm test"],
			["call:c", "tool", "waiting", "c.ts"],
			["call:d", "tool", "preparing", "d.md"],
		]);
		expect(rows.every(row => row.tool?.detail === true && row.text === "")).toBe(true);
		expect(projectLiveToolCalls(fakeSession(history, ["b"], false), streaming, text => text)).toEqual([]);
		expect(projectLiveToolCalls(undefined, streaming, text => text)).toEqual([]);
	});

	test("a call stays running after its execution ends until its result is appended", () => {
		const history = [{ role: "user", content: "go" }, assistantCalls(["a", "read", { path: "a.ts" }])];
		const session = fakeSession(history);
		const status = () => projectLiveToolCalls(session, undefined, text => text).map(row => row.tool?.status);
		expect(status()).toEqual(["waiting"]);
		observeToolEvent(session, { type: "tool_execution_start", toolCallId: "a" } as { type: string });
		observeToolEvent(session, { type: "tool_execution_end", toolCallId: "a" } as { type: string });
		expect(status()).toEqual(["running"]);
		const result = { role: "toolResult", toolCallId: "a", toolName: "read", content: "ok" };
		history.push(result);
		observeToolEvent(session, { type: "message_end", message: result } as { type: string });
		expect(status()).toEqual([]);
		// A new run starts clean: an id seen before is not running until it starts again.
		history.pop();
		observeToolEvent(session, { type: "agent_start" });
		expect(status()).toEqual(["waiting"]);
		// A malformed event is ignored; it neither throws nor disturbs tracked state.
		observeToolEvent(session, { type: "tool_execution_start", toolCallId: 7 } as { type: string });
		expect(status()).toEqual(["waiting"]);
	});

	test("a running shell row carries the newest streamed output, redacted before the cut", () => {
		const secret = "sk-abcdefghij1234567890";
		const redact = (text: string) => text.replaceAll(secret, "[redacted]");
		const session = fakeSession([
			{ role: "user", content: "go" },
			assistantCalls(["a", "bash", { command: "make" }]),
		]);
		const update = (partialResult: unknown) =>
			observeToolEvent(session, { type: "tool_execution_update", toolCallId: "a", partialResult } as {
				type: string;
			});
		// The secret straddles the tail bound: cutting first would leave its suffix.
		const body = `${secret}${"o".repeat(LIVE_TAIL_LIMIT - 5)}`;
		update({ content: [{ type: "text", text: `start\n${body}` }], details: {} });
		const [row] = projectLiveToolCalls(session, undefined, redact);
		expect(row?.tool?.status).toBe("running");
		expect(row?.text).toHaveLength(LIVE_TAIL_LIMIT);
		expect(row?.text.startsWith("cted]")).toBe(true);
		expect(row?.text).not.toContain("1234567890");
		expect(row?.truncated).toBe(true);
		// Bash also reports content-less progress (a terminal id); that keeps the last output.
		update({ content: [], details: { terminalId: "t1" } });
		expect(projectLiveToolCalls(session, undefined, redact)[0]?.text).toBe(row?.text);
		update({ content: [{ type: "text", text: "short" }] });
		expect(projectLiveToolCalls(session, undefined, redact)[0]).toMatchObject({ text: "short" });
		expect(projectLiveToolCalls(session, undefined, redact)[0]?.truncated).toBeUndefined();
	});

	describe("values still growing withhold any part of a known secret", () => {
		const secret = "sk-live-ABCDEFGHIJKLMNOP";
		const secrets = new Set([secret]);
		const redact = (text: string) => text.replaceAll(secret, "[redacted]");
		const running = () => {
			const session = fakeSession([
				{ role: "user", content: "go" },
				assistantCalls(["a", "bash", { command: "print-key" }]),
			]);
			const tail = (text: string) => {
				observeToolEvent(session, {
					type: "tool_execution_update",
					toolCallId: "a",
					partialResult: { content: [{ type: "text", text }] },
				} as { type: string });
				return projectLiveToolCalls(session, undefined, redact, secrets)[0]?.text;
			};
			return tail;
		};

		test("a running tail holds back a secret split across output chunks until it is whole", () => {
			const tail = running();
			expect(tail("key is sk-live-ABCDEFGH")).toBe("key is ");
			expect(tail("key is sk-live-ABCDEFGHIJKLMNOP done")).toBe("key is [redacted] done");
			// A tail that ends in an unrelated character shows everything.
			expect(tail("key is sk-live-ABCDEFGHIJKLMNOP done\nnext")).toBe("key is [redacted] done\nnext");
		});

		test("once the command has finished, its tail's end is shown in full; a settled row never withholds", () => {
			const session = fakeSession([
				{ role: "user", content: "go" },
				assistantCalls(["a", "bash", { command: "count" }]),
			]);
			const event = (event: Record<string, unknown>) =>
				observeToolEvent(session, { toolCallId: "a", ...event } as unknown as { type: string });
			const shown = () => projectLiveToolCalls(session, undefined, redact, secrets)[0];
			event({ type: "tool_execution_start" });
			event({
				type: "tool_execution_update",
				partialResult: { content: [{ type: "text", text: "progress: 10 items" }] },
			});
			// While output can still arrive, a trailing "s" could be the start of the key.
			expect(shown()?.text).toBe("progress: 10 item");
			event({ type: "tool_execution_end" });
			// The row stays running until its result is appended, but its output is complete.
			expect(shown()?.tool?.status).toBe("running");
			expect(shown()?.text).toBe("progress: 10 items");
			const settled = projectMessages(
				[
					assistantCalls(["a", "bash", { command: "count" }]),
					{ role: "toolResult", toolCallId: "a", toolName: "bash", content: "progress: 10 items" },
				],
				redact,
				500_000,
				{ ...live, secrets },
			);
			expect(settled.at(-1)?.text).toBe("progress: 10 items");
		});

		test("a tail the SDK cut inside a secret drops the secret's remaining end", () => {
			const tail = running();
			const shown = tail("IJKLMNOP and the rest\nnext line");
			expect(shown).toBe(" and the rest\nnext line");
			expect(shown).not.toContain("MNOP");
			// Finishing does not reveal it: the SDK's partial result never says whether the start was cut.
			const session = fakeSession([
				{ role: "user", content: "go" },
				assistantCalls(["a", "bash", { command: "print-key" }]),
			]);
			for (const type of ["tool_execution_start", "tool_execution_update", "tool_execution_end"])
				observeToolEvent(session, {
					type,
					toolCallId: "a",
					partialResult: { content: [{ type: "text", text: "IJKLMNOP and the rest" }] },
				} as { type: string });
			expect(projectLiveToolCalls(session, undefined, redact, secrets)[0]?.text).toBe(" and the rest");
		});

		test("hold-back reads the redacted tail, so a whole secret is never cut into a visible prefix", () => {
			// The end of one secret starts another: holding back raw text first would show "tok-".
			const first = "tok-1234";
			const both = new Set([first, "1234-other-secret"]);
			const mask = (text: string) =>
				text.replaceAll(first, "[redacted]").replaceAll("1234-other-secret", "[redacted]");
			const session = fakeSession([
				{ role: "user", content: "go" },
				assistantCalls(["a", "bash", { command: "print-key" }]),
			]);
			observeToolEvent(session, {
				type: "tool_execution_update",
				toolCallId: "a",
				partialResult: { content: [{ type: "text", text: `use ${first}` }] },
			} as { type: string });
			const shown = projectLiveToolCalls(session, undefined, mask, both)[0]?.text;
			expect(shown).toBe("use [redacted]");
			expect(shown).not.toContain("tok-");
		});

		test("a call whose arguments still stream shows neither the start of a secret nor its details", () => {
			const session = fakeSession([{ role: "user", content: "go" }]);
			const streaming = assistantCalls([
				"p",
				"bash",
				{ command: "curl -H 'Authorization: Bearer sk-live-ABCDEF", _i: "Call with sk-live-ABC" },
			]);
			const [row] = projectLiveToolCalls(session, streaming, redact, secrets);
			expect(row?.tool).toMatchObject({
				status: "preparing",
				subject: "$ curl -H 'Authorization: Bearer",
				intent: "Call with",
			});
			const detail = projectToolDetail(session, streaming, "p", redact, secrets);
			expect(detail.command).toBe("curl -H 'Authorization: Bearer ");
			expect(JSON.stringify([row, detail])).not.toContain("sk-live");
			// Once the message is complete the same arguments are shown as written.
			const committed = fakeSession([
				{ role: "user", content: "go" },
				assistantCalls(["p", "bash", { command: "echo sk-live-ABCDEF" }]),
			]);
			expect(projectLiveToolCalls(committed, undefined, redact, secrets)[0]?.tool?.subject).toBe(
				"$ echo sk-live-ABCDEF",
			);
		});
	});

	test("live rows join only the display list and are redacted like settled rows", () => {
		const redact = (text: string) => text.replaceAll("token-123", "[redacted]");
		const session = fakeSession([
			{ role: "user", content: "go" },
			assistantCalls(["a", "bash", { command: "curl -H token-123 host", env: { KEY: "env-secret" } }]),
		]);
		const [row] = projectLiveToolCalls(session, undefined, redact);
		expect(row?.tool?.subject).toBe("$ curl -H [redacted] host");
		const [secretId] = projectLiveToolCalls(
			fakeSession([{ role: "user", content: "go" }, assistantCalls(["id-token-123", "read", { path: "a" }])]),
			undefined,
			redact,
		);
		expect([secretId?.id, secretId?.tool?.callId]).toEqual(["call:id-[redacted]", "id-[redacted]"]);
		expect(JSON.stringify(row)).not.toContain("env-secret");
		expect(JSON.stringify(row)).not.toContain("token-123");
	});
});

describe("tool call details", () => {
	const detail = (messages: unknown[], callId = "c1", redact = (text: string) => text, streaming?: unknown) =>
		projectToolDetail({ messages } as unknown as Session, streaming, callId, redact);
	const pair = (name: string, args: Record<string, unknown>, result: Record<string, unknown> = {}) => [
		assistantCalls(["c1", name, args]),
		{ role: "toolResult", toolCallId: "c1", toolName: name, content: "ok", ...result },
	];

	test("arguments are pretty JSON without underscore keys, redacted leaf by leaf, then bounded", () => {
		const secret = 'tok"en\\value';
		const redact = (text: string) => text.replaceAll(secret, "[redacted]");
		const result = detail(
			pair("web_search", {
				query: `find ${secret}`,
				nested: { [secret]: [secret, 3] },
				_i: "intent",
				__partialJson: "{",
			}),
			"c1",
			redact,
		);
		expect(result).toEqual({
			callId: "c1",
			args: JSON.stringify({ query: "find [redacted]", nested: { "[redacted]": ["[redacted]", 3] } }, null, 2),
		});
		const long = detail(pair("web_search", { query: "q".repeat(DESKTOP_TOOL_LIMITS.args * 2) }));
		expect(long.args).toHaveLength(DESKTOP_TOOL_LIMITS.args);
		expect(long.truncated).toBe(true);
	});

	test("a shell call shows its whole command and the remaining arguments", () => {
		expect(detail(pair("bash", { command: "cd app\nnpm test", timeout: 30 }))).toEqual({
			callId: "c1",
			command: "cd app\nnpm test",
			args: JSON.stringify({ timeout: 30 }, null, 2),
		});
		expect(detail(pair("eval", { cells: [{ code: "a = 1" }, { code: "a + 1" }] })).command).toBe("a = 1\n\na + 1");
		expect(detail(pair("python", { code: "print(1)" }))).toEqual({ callId: "c1", command: "print(1)" });
	});

	test("edits and writes show per-file diffs, bounded together", () => {
		const diff = "@@ -1 +1 @@\n-1|old\n+1|new";
		expect(
			detail(
				pair(
					"edit",
					{ path: "a.ts", edits: [] },
					{
						details: {
							diff: "",
							perFileResults: [
								{ path: "a.ts", diff, op: "update" },
								{
									path: "b.ts",
									diff: "",
									isError: true,
									errorText: "raw",
									displayErrorText: "No match in b.ts",
								},
							],
						},
					},
				),
			).diff,
		).toEqual([
			{ path: "a.ts", diff, added: 1, removed: 1, op: "update" },
			{ path: "b.ts", diff: "", added: 0, removed: 0, error: "No match in b.ts" },
		]);
		expect(detail(pair("write", { path: "n.md", content: "one\ntwo\n" })).diff).toEqual([
			{ path: "n.md", diff: "+1|one\n+2|two", added: 2, removed: 0 },
		]);
		const big = "+1|".padEnd(40_000, "x");
		const bounded = detail(
			pair(
				"edit",
				{ path: "a" },
				{
					details: {
						perFileResults: [
							{ path: "a", diff: big },
							{ path: "b", diff: big },
						],
					},
				},
			),
		);
		expect(bounded.diff?.map(item => item.diff.length)).toEqual([40_000, DESKTOP_TOOL_LIMITS.diff - 40_000]);
		expect(bounded.diff?.map(item => item.added)).toEqual([1, 1]);
		expect(bounded.truncated).toBe(true);
		// A hashline or apply_patch result names no path; the envelope header does.
		expect(
			detail(pair("edit", { input: "§src/tok-123.ts\n≔2dj\nTWO" }, { details: { diff: "+2|TWO" } }), "c1", text =>
				text.replaceAll("tok-123", "[redacted]"),
			).diff?.[0]?.path,
		).toBe("src/[redacted].ts");
		// Without a diff, a failed edit falls back to its arguments.
		expect(detail(pair("edit", { path: "a.ts" }, { isError: true })).args).toBe(
			JSON.stringify({ path: "a.ts" }, null, 2),
		);
	});

	test("a write's content is redacted whole before its lines are numbered, and file_path names it too", () => {
		// Line prefixes inside the value would hide a secret that spans lines from exact matching.
		const secret = "line-one-SECRET\nline-two-SECRET";
		const redact = (text: string) => text.replaceAll(secret, "[redacted]").replaceAll("path-SECRET", "[redacted]");
		const written = detail(
			pair("write", { file_path: "notes/path-SECRET.md", content: `head\n${secret}\ntail\n` }),
			"c1",
			redact,
		);
		expect(written.diff).toEqual([
			{ path: "notes/[redacted].md", diff: "+1|head\n+2|[redacted]\n+3|tail", added: 3, removed: 0 },
		]);
		expect(JSON.stringify(written)).not.toContain("SECRET");
	});

	test("a tool search shows its bounded matches and a todo write its task list", () => {
		const tools = Array.from({ length: 30 }, (_, index) => ({
			name: `tool_${index}`,
			label: `Tool ${index}`,
			description: `${"d".repeat(300)}`,
			server_name: index === 0 ? "docs" : undefined,
			schema_keys: ["secret_schema"],
			score: 1,
		}));
		const search = detail(
			pair(
				"search_tool_bm25",
				{ query: "todo" },
				{ details: { query: "todo", activated_tools: ["todo_write"], tools } },
			),
		).toolSearch;
		expect(search?.matches).toHaveLength(DESKTOP_TOOL_LIMITS.searchMatches);
		expect(search?.matches[0]).toEqual({
			name: "tool_0",
			label: "Tool 0",
			description: "d".repeat(DESKTOP_TOOL_LIMITS.description),
			mcpServer: "docs",
		});
		expect(search).toMatchObject({ query: "todo", activated: ["todo_write"], total: 30 });
		expect(JSON.stringify(search)).not.toContain("secret_schema");
		const phases = [{ name: "Build", tasks: [{ content: "Write tests", status: "in_progress" }] }];
		expect(detail(pair("todo_write", { ops: [{ op: "start" }] }, { details: { phases } })).todo).toEqual([
			{ name: "Build", tasks: [{ content: "Write tests", status: "in_progress" }] },
		]);
	});

	test("lookup covers the streaming call, a redacted id and results without a call", () => {
		const streaming = assistantCalls(["live", "read", { path: "still-streaming" }]);
		expect(detail([], "live", undefined, streaming).args).toBe(JSON.stringify({ path: "still-streaming" }, null, 2));
		const redact = (text: string) => text.replaceAll("secret", "[redacted]");
		const messages = pair("read", { path: "a" });
		(messages[0] as { content: Array<{ id: string }> }).content[0]!.id = "id-secret";
		(messages[1] as { toolCallId: string }).toolCallId = "id-secret";
		expect(detail(messages, "id-[redacted]", redact)).toMatchObject({ callId: "id-[redacted]" });
		const orphan = [
			{ role: "toolResult", toolCallId: "o", toolName: "edit", content: "ok", details: { diff: "+1|x" } },
		];
		expect(detail(orphan, "o").diff).toEqual([{ path: "", diff: "+1|x", added: 1, removed: 0 }]);
		expect(() => detail(messages, "missing")).toThrow(TOOL_DETAIL_GONE);
	});
});
