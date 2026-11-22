import type { DesktopMessage, DesktopSession, DesktopTodoPhase } from "@gajae-code/desktop-host/protocol";
import { ListChecks } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button, Message } from "./components";
import { type MessageKey, t } from "./i18n";
import { SessionWorkProgress, sessionWorkLabel } from "./SessionWorkProgress";
import { SessionWorkTodos, TODO_TASK_LIMIT, TodoPanel } from "./TodoPanel";
import { TodoToolBody } from "./TodoToolBody";

// Fixture data only: nothing here is requested from the Host.
const singlePhase: DesktopTodoPhase[] = [
	{
		name: "Foundation",
		tasks: [
			{ content: "Read the shipped host projection", status: "completed" },
			{
				content: "Project task notes",
				status: "in_progress",
				notes: [
					"Notes are append-only, so the Host keeps the newest five.",
					"Each note is redacted whole before it is cut\nto 300 characters.",
				],
			},
			{ content: "Render the checklist", status: "pending" },
		],
	},
];

const manyPhases: DesktopTodoPhase[] = [
	{
		name: "Discovery",
		tasks: [
			{ content: "Read the terminal task list", status: "completed" },
			{ content: "Map the Session work card", status: "completed" },
		],
	},
	{
		name: "Host projection",
		tasks: [
			{ content: "Project notes", status: "completed", notes: ["Bounded per task."] },
			{ content: "Add a truncation flag", status: "abandoned", notes: ["Needs a protocol field."] },
		],
	},
	{
		name: "Panel",
		tasks: [
			{ content: "Number the phases", status: "in_progress", notes: ["A CSS counter keeps the heading text."] },
			{ content: "Draw the progress bar", status: "pending" },
		],
	},
	{ name: "", tasks: [{ content: "A phase the model left unnamed", status: "pending" }] },
	{
		name: "Release",
		tasks: [
			{ content: "Write the changelog fragment", status: "pending" },
			{ content: "Check the showcase", status: "pending" },
		],
	},
];

const longText: DesktopTodoPhase[] = [
	{
		name: "A phase name that is long enough to wrap onto a second line in the narrow Session work card",
		tasks: [
			{
				content:
					"packages/desktop/src/some/really/deep/directory/structure/with/a/very_long_file_name_without_spaces.tsx",
				status: "in_progress",
				notes: ["DESKTOP_TOOL_LIMITS_SUBJECT_AND_INTENT_AND_ARGUMENTS_ARE_APPLIED_AFTER_REDACTION_NEVER_BEFORE_IT"],
			},
			{
				content:
					"Check that a long task written as ordinary prose wraps at word boundaries, keeps its status icon aligned with the first line and never pushes the card wider than the window.",
				status: "pending",
			},
		],
	},
];

const cjkText: DesktopTodoPhase[] = [
	{
		name: "세션 작업 카드 정리",
		tasks: [
			{
				content: "작업 목록을 세션 작업 카드 안에 두고 진행률은 툴바 칩으로 항상 보여 줍니다",
				status: "in_progress",
				notes: ["메모는 진행 중인 작업 아래에 줄바꿈을 지킨 채 표시합니다.\n두 번째 줄입니다."],
			},
			{ content: "任务列表与进度条在窄窗口中也要正确换行，不能把卡片撑宽", status: "pending" },
			{ content: "タスク一覧の長い日本語テキストも正しく折り返すことを確認する", status: "completed" },
		],
	},
];

const fullNotes: DesktopTodoPhase[] = [
	{
		name: "Notes at the bound",
		tasks: [
			{
				content: "A task with more notes than the Host keeps",
				status: "in_progress",
				notes: ["Third note.", "Fourth note.", "Fifth note.", "Sixth note.", "Seventh, the newest note."],
			},
			{ content: "A pending task with notes", status: "pending", notes: ["1", "2", "3", "4", "5"] },
		],
	},
];

const capped: DesktopTodoPhase[] = ["Survey", "Build", "Verify"].map((name, phase) => ({
	name,
	tasks: Array.from({ length: TODO_TASK_LIMIT / 3 }, (_, index) => ({
		content: `${name} step ${index + 1}`,
		status:
			phase === 0
				? ("completed" as const)
				: phase === 1 && index === 0
					? ("in_progress" as const)
					: ("pending" as const),
	})),
}));

const baseSession: DesktopSession = {
	id: "showcase-todo",
	projectId: "fixture",
	title: "Task list fixture",
	starred: false,
	status: "running",
	imageInput: null,
	operatorRunning: false,
	controlGeneration: null,
	messages: [],
};

const todoRow: DesktopMessage = {
	id: "showcase-todo-row",
	role: "tool",
	toolName: "todo_write",
	text: 'Phase 1/1 "Foundation" — 1/3 tasks complete',
	tool: { callId: "showcase-todo-call", status: "done", family: "todo", detail: true },
};

const failedRow: DesktopMessage = {
	...todoRow,
	id: "showcase-todo-failed",
	isError: true,
	text: 'Unknown task "Render teh checklist".\nTodo update was not applied.',
	tool: { callId: "showcase-todo-failed", status: "failed", family: "todo", detail: false },
};

function withStatuses(statuses: DesktopTodoPhase["tasks"][number]["status"][]): DesktopSession {
	return {
		...baseSession,
		todos: [{ name: "Work", tasks: statuses.map((status, index) => ({ content: `Task ${index + 1}`, status })) }],
	};
}

function State({ caption, children }: { caption: MessageKey; children: ReactNode }) {
	return (
		<div className="showcase-todo-state">
			<h3>{t(caption)}</h3>
			{children}
		</div>
	);
}

function Card({ narrow, children }: { narrow?: boolean; children: ReactNode }) {
	return (
		<div
			className="session-work-card showcase-todo-card"
			style={{ width: narrow ? "min(100%, 320px)" : "min(100%, 380px)" }}
		>
			<section className="session-work-panel" aria-label={t("panels.sessionWorkTitle")}>
				<div className="session-work-body">{children}</div>
			</section>
		</div>
	);
}

function ChipRow({
	caption,
	session,
	pressed = false,
	badge = false,
}: {
	caption: MessageKey;
	session: DesktopSession;
	pressed?: boolean;
	badge?: boolean;
}) {
	const [open, setOpen] = useState(pressed);
	const label = sessionWorkLabel(session);
	return (
		<div className="toolbar showcase-todo-toolbar">
			<div className="toolbar-title">
				<small>{t(caption)}</small>
				<span className="showcase-todo-label">{label}</span>
			</div>
			<Button
				className="session-work-toggle"
				aria-label={label}
				title={label}
				aria-pressed={open}
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
			>
				<ListChecks size={15} aria-hidden="true" />
				<SessionWorkProgress session={session} />
				{badge && (
					<span className="activity-badge" role="status" aria-label={t("shell.needsInputCount", { count: 1 })}>
						1
					</span>
				)}
			</Button>
		</div>
	);
}

/** Showcase index links for the task list sections. */
export function ShowcaseTodoNav() {
	return (
		<>
			<a href="#showcase-todo-panel">{t("todo.showcaseNavPanel")}</a>
			<a href="#showcase-todo-card">{t("todo.showcaseNavCard")}</a>
			<a href="#showcase-todo-chip">{t("todo.showcaseNavChip")}</a>
			<a href="#showcase-todo-tool">{t("todo.showcaseNavTool")}</a>
		</>
	);
}

/**
 * Showcase sections for the task list: the panel's states, its group in the Session work card,
 * the toolbar chip and the `todo_write` row body. Each one is a `<section id="showcase-…">` with
 * an `<h2>` and a matching index link.
 */
export function ShowcaseTodo() {
	const stale = { ...baseSession, todos: singlePhase, messages: [failedRow] };
	return (
		<>
			<section id="showcase-todo-panel">
				<h2>{t("todo.showcasePanelHeading")}</h2>
				<p className="muted">{t("todo.showcasePanelNote")}</p>
				<div className="showcase-todo-states">
					<State caption="todo.showcaseCollapsed">
						<TodoPanel phases={singlePhase} />
					</State>
					<State caption="todo.showcaseSinglePhase">
						<TodoPanel phases={singlePhase} defaultOpen />
					</State>
					<State caption="todo.showcaseManyPhases">
						<TodoPanel phases={manyPhases} defaultOpen />
					</State>
					<State caption="todo.showcaseLongText">
						<TodoPanel phases={longText} defaultOpen />
					</State>
					<State caption="todo.showcaseCjk">
						<TodoPanel phases={cjkText} defaultOpen />
					</State>
					<State caption="todo.showcaseNotesBound">
						<TodoPanel phases={fullNotes} defaultOpen />
					</State>
					<State caption="todo.showcaseEmpty">
						<p className="muted">{t("todo.showcaseEmptyNote")}</p>
						<TodoPanel phases={[]} />
					</State>
				</div>
			</section>
			<section id="showcase-todo-card">
				<h2>{t("todo.showcaseCardHeading")}</h2>
				<p className="muted">{t("todo.showcaseCardNote")}</p>
				<div className="showcase-todo-states">
					<State caption="todo.showcaseCardCurrent">
						<Card>
							<SessionWorkTodos session={{ ...baseSession, todos: singlePhase, messages: [todoRow] }} />
						</Card>
					</State>
					<State caption="todo.showcaseCardStale">
						<Card>
							<SessionWorkTodos session={stale} />
						</Card>
					</State>
					<State caption="todo.showcaseCardNarrow">
						<Card narrow>
							<SessionWorkTodos session={{ ...stale, todos: cjkText }} />
						</Card>
					</State>
					<State caption="todo.showcaseCap">
						<Card>
							<TodoPanel phases={capped} defaultOpen />
						</Card>
					</State>
				</div>
			</section>
			<section id="showcase-todo-chip">
				<h2>{t("todo.showcaseChipHeading")}</h2>
				<p className="muted">{t("todo.showcaseChipNote")}</p>
				<ChipRow caption="todo.showcaseChipNone" session={baseSession} />
				<ChipRow
					caption="todo.showcaseChipStart"
					session={withStatuses(["pending", "pending", "pending", "pending"])}
				/>
				<ChipRow
					caption="todo.showcaseChipPartial"
					session={withStatuses(["completed", "abandoned", "in_progress", "pending", "pending"])}
				/>
				<ChipRow caption="todo.showcaseChipDone" session={withStatuses(["completed", "completed", "abandoned"])} />
				<ChipRow
					caption="todo.showcaseChipPressed"
					session={withStatuses(["completed", "completed", "in_progress", "pending", "pending"])}
					pressed
				/>
				<ChipRow
					caption="todo.showcaseChipBadge"
					session={withStatuses(["completed", "completed", "in_progress", "pending", "pending"])}
					badge
				/>
			</section>
			<section id="showcase-todo-tool">
				<h2>{t("todo.showcaseToolHeading")}</h2>
				<p className="muted">{t("todo.showcaseToolNote")}</p>
				<State caption="todo.showcaseToolTree">
					<div className="tool-disclosure">
						<TodoToolBody
							message={todoRow}
							detail={{ callId: "showcase-todo-call", todo: singlePhase }}
							output={<pre className="bounded-output">{todoRow.text}</pre>}
						/>
					</div>
				</State>
				<State caption="todo.showcaseToolFallback">
					<Message message={todoRow} />
				</State>
				<State caption="todo.showcaseToolFailed">
					<Message message={failedRow} />
				</State>
			</section>
		</>
	);
}
