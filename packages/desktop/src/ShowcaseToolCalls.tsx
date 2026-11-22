import type { DesktopMessage } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolCall } from "@gajae-code/desktop-host/tool-protocol";
import { t } from "./i18n";
import { ToolCallCard } from "./ToolCallCard";

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

/** Showcase index links for the tool call card sections. */
export function ShowcaseToolCallsNav() {
	return <a href="#showcase-tool-calls">{t("tools.showcaseNavCalls")}</a>;
}

/**
 * Showcase sections for tool call cards. Each one is a `<section id="showcase-…">` with an
 * `<h2>` and a matching index link.
 */
export function ShowcaseToolCalls() {
	return (
		<section id="showcase-tool-calls">
			<h2>{t("tools.showcaseCallsHeading")}</h2>
			<p className="muted">{t("tools.showcaseCallsNote")}</p>
			{callFixtures().map(message => (
				<div key={message.id} id={`showcase-tool-${message.tool!.callId.replace("showcase-", "")}`}>
					<ToolCallCard message={message} />
				</div>
			))}
			<div id="showcase-tool-legacy">
				<p className="muted">{t("tools.showcaseLegacyNote")}</p>
				<ToolCallCard message={{ id: "showcase-legacy", role: "tool", toolName: "read", text: "" }} />
			</div>
		</section>
	);
}
