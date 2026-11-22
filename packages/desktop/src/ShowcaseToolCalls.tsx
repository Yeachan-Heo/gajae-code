import type { DesktopMessage } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolCall, DesktopToolDetail } from "@gajae-code/desktop-host/tool-protocol";
import { Message } from "./components";
import { t } from "./i18n";
import { ToolCallCard, ToolDetailContext, type ToolDetailSource } from "./ToolCallCard";
import { groupTranscript, ToolRun } from "./transcript-groups";

/** A fixture tool row; its call id doubles as the message id. */
function fixture(
	id: string,
	toolName: string,
	tool: Omit<DesktopToolCall, "callId" | "detail"> & { detail?: boolean },
	extra: Partial<DesktopMessage> = {},
): DesktopMessage {
	return {
		id: `showcase-${id}`,
		role: "tool",
		toolName,
		text: "",
		...(tool.status === "failed" ? { isError: true } : {}),
		...(tool.status === "cancelled" ? { isError: true } : {}),
		...extra,
		tool: { callId: `showcase-${id}`, detail: false, ...tool },
	};
}

/** Every family and status the summary line can show. Paths, commands and queries are fixture data. */
function callFixtures(): DesktopMessage[] {
	return [
		fixture(
			"read",
			"read",
			{
				family: "read",
				status: "done",
				subject: "packages/desktop/src/ToolCallCard.tsx",
				intent: t("tools.showcaseIntentRead"),
			},
			{ text: t("tools.showcaseOutputRead") },
		),
		fixture("edit", "edit", {
			family: "edit",
			status: "done",
			subject: "packages/desktop/src/ToolCallCard.tsx",
			intent: t("tools.showcaseIntentEdit"),
			stats: { added: 12, removed: 3 },
		}),
		fixture("edit-files", "ast_edit", {
			family: "edit",
			status: "done",
			subject: "src/ · test/",
			stats: { added: 8, removed: 8, files: 4 },
		}),
		fixture("write", "write", { family: "write", status: "done", subject: "docs/notes.md", stats: { added: 48 } }),
		fixture(
			"search",
			"search",
			{ family: "search", status: "done", subject: "useEffect\\( · src/**/*.tsx", stats: { matches: 4, files: 2 } },
			{ text: t("tools.showcaseOutputSearch") },
		),
		fixture("find", "find", { family: "find", status: "done", subject: "**/*.test.tsx", stats: { files: 7 } }),
		fixture(
			"shell-failed",
			"bash",
			{
				family: "shell",
				status: "failed",
				subject: "$ bun test packages/desktop/test/tool-call-card.test.tsx",
				intent: t("tools.showcaseIntentShell"),
				stats: { exitCode: 1 },
			},
			{ text: t("tools.showcaseOutputFailed") },
		),
		fixture(
			"shell-cancelled",
			"bash",
			{ family: "shell", status: "cancelled", subject: "$ sleep 30" },
			{ text: t("tools.showcaseOutputCancelled") },
		),
		fixture(
			"shell-running",
			"bash",
			{ family: "shell", status: "running", subject: "$ sleep 4; echo done", detail: true },
			{ id: "call:showcase-shell-running", text: t("tools.showcaseOutputLive") },
		),
		fixture(
			"waiting",
			"read",
			{ family: "read", status: "waiting", subject: "packages/desktop/DESIGN.md", detail: true },
			{ id: "call:showcase-waiting" },
		),
		fixture(
			"preparing",
			"edit",
			{ family: "edit", status: "preparing", subject: "packages/desktop/src/styles.css", detail: true },
			{ id: "call:showcase-preparing" },
		),
		fixture("background", "bash", { family: "shell", status: "background", subject: "$ bun run dev:ui" }),
		fixture("web", "web_search", { family: "web", status: "done", subject: "react details element toggle event" }),
		fixture("task", "task", { family: "task", status: "done", subject: "executor", stats: { tasks: 3 } }),
		fixture(
			"todo",
			"todo_write",
			{ family: "todo", status: "done", subject: "done · Write the card tests" },
			{ text: t("tools.showcaseOutputTodo") },
		),
		fixture(
			"tool-search",
			"search_tool_bm25",
			{ family: "tool-search", status: "done", subject: "todo list", stats: { activated: ["todo_write"] } },
			{ text: t("tools.showcaseOutputToolSearch") },
		),
		fixture(
			"other",
			"mcp__docs__lookup_reference",
			{ family: "other", status: "running" },
			{ id: "call:showcase-other" },
		),
		fixture("other-done", "mcp__docs__lookup_reference", { family: "other", status: "done" }),
		fixture("long", "read", {
			family: "read",
			status: "done",
			subject:
				"packages/desktop/src/very/deeply/nested/feature/directory/with/a/long/path/that/keeps/going/component-with-a-long-name.tsx",
			intent: t("tools.showcaseIntentLong"),
		}),
		// Retained CJK width fixture, like the model-name one in Showcase.tsx: it checks keep-all
		// wrapping of the intent line and a mixed-script subject, so it is not product copy.
		fixture("cjk", "read", {
			family: "read",
			status: "done",
			subject: "docs/설계/도구-카드-요약줄.md",
			intent: "한국어 의도 문장이 단어 단위로 줄바꿈되고 경로는 한 줄에서 말줄임표로 끝나는지 확인합니다",
		}),
	];
}

const resolved = (detail: Omit<DesktopToolDetail, "callId">): ToolDetailSource => ({
	load: async callId => ({ callId, ...detail }),
});
/** A load that never settles, so the loading state stays on screen. */
const pending: ToolDetailSource = { load: () => Promise.withResolvers<DesktopToolDetail>().promise };
const failing: ToolDetailSource = {
	load: async () => {
		throw new Error(t("tools.showcaseDetailGone"));
	},
};

const editDiff = [
	"@@ -40,4 +40,5 @@",
	" 40|export function toolVerb(tool: DesktopToolCall): string {",
	'-41|\tif (tool.family === "other") return tool.name;',
	'+41|\tif (tool.family === "other") return toolName || t("support.toolFallback");',
	"+42|\tconst family = FAMILIES[tool.family];",
	" 43|\treturn t(isLiveToolStatus(tool.status) ? family.live : family.done);",
	" 44|}",
].join("\n");

/** Expanded cards, one per detail state. Each one loads from its own local fixture source. */
function detailFixtures(): Array<{ id: string; source: ToolDetailSource | null; message: DesktopMessage }> {
	return [
		{
			id: "shell",
			source: resolved({
				command: "cd packages/desktop\nbun test test/tool-call-card.test.tsx --timeout 30000",
				args: JSON.stringify({ cwd: "packages/desktop", timeout: 60 }, null, 2),
			}),
			message: fixture(
				"detail-shell",
				"bash",
				{
					family: "shell",
					status: "failed",
					subject: "$ cd packages/desktop",
					stats: { exitCode: 1 },
					detail: true,
				},
				{ text: t("tools.showcaseOutputFailed") },
			),
		},
		{
			id: "edit",
			source: resolved({
				diff: [
					{ path: "packages/desktop/src/ToolCallCard.tsx", diff: editDiff, added: 2, removed: 1, op: "update" },
					{
						path: "packages/desktop/src/new-helper.ts",
						diff: "+1|export const helper = 1;",
						added: 1,
						removed: 0,
						op: "create",
					},
					{
						path: "packages/desktop/src/missing.ts",
						diff: "",
						added: 0,
						removed: 0,
						error: t("tools.showcaseEditError"),
					},
				],
			}),
			message: fixture("detail-edit", "edit", {
				family: "edit",
				status: "done",
				subject: "packages/desktop/src/ToolCallCard.tsx",
				stats: { added: 3, removed: 1, files: 3 },
				detail: true,
			}),
		},
		{
			id: "write",
			source: resolved({
				diff: [
					{
						path: "docs/notes.md",
						diff: "+1|# Notes\n+2|\n+3|Tool cards load details on first open.",
						added: 3,
						removed: 0,
					},
				],
			}),
			message: fixture("detail-write", "write", {
				family: "write",
				status: "done",
				subject: "docs/notes.md",
				stats: { added: 3 },
				detail: true,
			}),
		},
		{
			id: "args",
			source: resolved({
				args: JSON.stringify({ query: "react details element toggle event", recency: "month" }, null, 2),
				truncated: true,
			}),
			message: fixture("detail-args", "web_search", {
				family: "web",
				status: "done",
				subject: "react details element toggle event",
				detail: true,
			}),
		},
		{
			id: "loading",
			source: pending,
			message: fixture("detail-loading", "read", {
				family: "read",
				status: "done",
				subject: "src/App.tsx",
				detail: true,
			}),
		},
		{
			id: "error",
			source: failing,
			message: fixture("detail-error", "read", {
				family: "read",
				status: "done",
				subject: "src/App.tsx",
				detail: true,
			}),
		},
		{
			id: "unavailable",
			source: null,
			message: fixture("detail-unavailable", "read", {
				family: "read",
				status: "done",
				subject: "src/App.tsx",
				detail: true,
			}),
		},
	];
}

/** Transcript slices for the grouping examples. */
function groupFixtures(): Array<{ id: string; open: boolean; messages: DesktopMessage[] }> {
	return [
		{
			id: "collapsed",
			open: false,
			messages: [
				fixture("g1-read", "read", { family: "read", status: "done", subject: "src/ToolCallCard.tsx" }),
				fixture("g1-read-2", "read", { family: "read", status: "done", subject: "src/transcript-groups.tsx" }),
				fixture("g1-search", "search", {
					family: "search",
					status: "done",
					subject: "groupTranscript · src/",
					stats: { matches: 3, files: 2 },
				}),
				fixture(
					"g1-test",
					"bash",
					{
						family: "shell",
						status: "failed",
						subject: "$ bun test test/transcript-groups.test.ts",
						stats: { exitCode: 1 },
					},
					{ text: t("tools.showcaseOutputFailed") },
				),
				fixture(
					"g1-rerun",
					"bash",
					{ family: "shell", status: "running", subject: "$ bun test test/transcript-groups.test.ts" },
					{ id: "call:showcase-g1-rerun", text: t("tools.showcaseOutputLive") },
				),
			],
		},
		{
			id: "expanded",
			open: true,
			messages: [
				fixture("g2-read", "read", { family: "read", status: "done", subject: "src/ToolCallCard.tsx" }),
				{
					id: "showcase-g2-reasoning",
					role: "assistant",
					text: "",
					blocks: [{ type: "thinking", text: t("tools.showcaseReasoning") }],
				},
				fixture("g2-edit", "edit", {
					family: "edit",
					status: "done",
					subject: "src/ToolCallCard.tsx",
					stats: { added: 3, removed: 1 },
				}),
				fixture("g2-write", "write", {
					family: "write",
					status: "done",
					subject: "docs/notes.md",
					stats: { added: 12 },
				}),
			],
		},
		{
			id: "typed-shell",
			open: false,
			messages: [
				fixture("g3-read", "read", { family: "read", status: "done", subject: "package.json" }),
				{ id: "showcase-g3-typed", role: "tool", toolName: "Direct shell", text: "git status\nOn branch main" },
				fixture("g3-find", "find", { family: "find", status: "done", subject: "**/*.md", stats: { files: 9 } }),
			],
		},
	];
}

/** Showcase index links for the tool call card sections. */
export function ShowcaseToolCallsNav() {
	return (
		<>
			<a href="#showcase-tool-calls">{t("tools.showcaseNavCalls")}</a>
			<a href="#showcase-tool-details">{t("tools.showcaseNavDetails")}</a>
			<a href="#showcase-tool-groups">{t("tools.showcaseNavGroups")}</a>
		</>
	);
}

/**
 * Showcase sections for tool call cards. Each one is a `<section id="showcase-…">` with an
 * `<h2>` and a matching index link.
 */
export function ShowcaseToolCalls() {
	return (
		<>
			<ShowcaseToolCallRows />
			<ShowcaseToolDetails />
			<ShowcaseToolGroups />
		</>
	);
}

function ShowcaseToolCallRows() {
	return (
		<section id="showcase-tool-calls">
			<h2>{t("tools.showcaseCallsHeading")}</h2>
			<p className="muted">{t("tools.showcaseCallsNote")}</p>
			{callFixtures().map(message => (
				<div key={message.id} id={`showcase-tool-call-${message.tool!.callId.replace("showcase-", "")}`}>
					<ToolCallCard message={message} />
				</div>
			))}
			<div id="showcase-tool-call-legacy">
				<p className="muted">{t("tools.showcaseLegacyNote")}</p>
				<ToolCallCard message={{ id: "showcase-legacy", role: "tool", toolName: "read", text: "" }} />
			</div>
		</section>
	);
}

function ShowcaseToolDetails() {
	return (
		<section id="showcase-tool-details">
			<h2>{t("tools.showcaseDetailsHeading")}</h2>
			<p className="muted">{t("tools.showcaseDetailsNote")}</p>
			{detailFixtures().map(({ id, source, message }) => (
				<div key={id} id={`showcase-tool-detail-${id}`}>
					<ToolDetailContext.Provider value={source}>
						<ToolCallCard message={message} defaultOpen />
					</ToolDetailContext.Provider>
				</div>
			))}
		</section>
	);
}

function ShowcaseToolGroups() {
	return (
		<section id="showcase-tool-groups">
			<h2>{t("tools.showcaseGroupsHeading")}</h2>
			<p className="muted">{t("tools.showcaseGroupsNote")}</p>
			{groupFixtures().map(({ id, open, messages }) => (
				<div key={id} id={`showcase-tool-group-${id}`}>
					{groupTranscript(messages, messages.length).map(item =>
						item.tools ? (
							<ToolRun
								key={item.key}
								item={item}
								initialOpen={open}
								renderMessage={message => <Message message={message} />}
							/>
						) : (
							item.messages.map(message => <Message key={message.id} message={message} />)
						),
					)}
				</div>
			))}
		</section>
	);
}
