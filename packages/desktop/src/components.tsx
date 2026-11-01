import {
	ArrowUp,
	Check,
	ChevronDown,
	ChevronRight,
	Circle,
	CircleAlert,
	CircleCheck,
	CircleHelp,
	ListChecks,
	LoaderCircle,
	Pause,
	Play,
	Square,
	Target,
	X,
} from "lucide-react";
import type { ButtonHTMLAttributes, ClipboardEventHandler, ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type {
	DesktopGoal,
	DesktopMessage,
	DesktopMessageBlock,
	DesktopQuestion,
	DesktopSession,
	DesktopSetting,
	DesktopTodoPhase,
} from "../../desktop-host/src/protocol";
import { t } from "./i18n";

import { Markdown } from "./Markdown";
import { Select } from "./Select";

export function Button({ children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button type="button" className={`button ${className}`} {...props}>
			{children}
		</button>
	);
}
export function ErrorBanner({ children }: { children: ReactNode }) {
	return (
		<div className="error-banner" role="alert">
			<CircleAlert aria-hidden="true" />
			<div className="error-content">{children}</div>
		</div>
	);
}
const statuses = {
	idle: () => t("support.statusIdle"),
	done: () => t("support.statusDone"),
	running: () => t("support.statusRunning"),
	waiting: () => t("support.statusWaiting"),
	error: () => t("support.statusError"),
};
const statusIcons = {
	idle: Circle,
	done: CircleCheck,
	running: LoaderCircle,
	waiting: CircleHelp,
	error: CircleAlert,
};
export function SessionRow({
	session,
	selected,
	onSelect,
	onMenu,
}: {
	session: DesktopSession;
	selected?: boolean;
	onSelect: () => void;
	/** Keyboard path for the row menu: the ContextMenu key or Shift+F10. */
	onMenu?: (x: number, y: number) => void;
}) {
	const StatusIcon = statusIcons[session.status];
	return (
		<div className={`session-row ${selected ? "selected" : ""}`}>
			<button
				className="session-select"
				aria-label={`${session.title} · ${statuses[session.status]()}`}
				title={`${session.title} · ${statuses[session.status]()}`}
				aria-current={selected ? "page" : undefined}
				aria-haspopup={onMenu ? "menu" : undefined}
				onClick={onSelect}
				onKeyDown={event => {
					if (!onMenu) return;
					if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
					event.preventDefault();
					const box = event.currentTarget.getBoundingClientRect();
					onMenu(box.left, box.bottom);
				}}
			>
				{/* One line: the state is a coloured indicator beside the name, not a second row. */}
				<span className={`session-state ${session.status}`} title={statuses[session.status]()}>
					<StatusIcon aria-hidden="true" />
					<span className="sr-only">{statuses[session.status]()}</span>
				</span>
				<span className="session-title">{session.title}</span>
			</button>
		</div>
	);
}
function MessageImage({ block }: { block: Extract<DesktopMessageBlock, { type: "image" }> }) {
	const [failedSource, setFailedSource] = useState<string>();
	const safeMime = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(block.mimeType);
	const safeData =
		typeof block.data === "string" && block.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(block.data);
	const source = `data:${block.mimeType};base64,${block.data}`;
	if (!safeMime || !safeData || failedSource === source)
		return <p className="message-image-unavailable">{t("support.imageUnavailable")}</p>;
	return (
		<figure className="message-image">
			<img src={source} alt={t("support.imageAlt")} onError={() => setFailedSource(source)} />
		</figure>
	);
}

function MessageBlocks({
	blocks,
	tool,
	markdown = false,
}: {
	blocks: DesktopMessageBlock[];
	tool: boolean;
	markdown?: boolean;
}) {
	return blocks.map((block, index) => {
		switch (block.type) {
			case "text":
				return block.text.trim() ? (
					tool ? (
						<pre className="bounded-output" key={index}>
							{block.text}
						</pre>
					) : (
						<div className="message-text" key={index}>
							{markdown ? <Markdown text={block.text} /> : block.text}
						</div>
					)
				) : null;
			case "thinking":
				return block.text.trim() ? (
					<details className="thinking-disclosure" key={index}>
						<summary>{t("support.reasoningSummary")}</summary>
						<div className="message-text">
							<Markdown text={block.text} />
						</div>
					</details>
				) : null;
			case "image":
				return <MessageImage key={index} block={block} />;
			case "image-unavailable":
				return (
					<p className="message-image-unavailable" key={index}>
						{t("support.imageUnavailableWithReason", { reason: block.reason })}
					</p>
				);
		}
		return null;
	});
}

export function Message({ message }: { message: DesktopMessage }) {
	/** Matches the TUI response header, which prints the literal `gajae` label. */
	const labels = {
		user: () => t("support.roleUser"),
		assistant: () => t("support.roleAssistant"),
		tool: () => t("support.roleTool"),
		system: () => t("support.roleSystem"),
	};
	const blocks = message.blocks;
	const hasContent = blocks
		? blocks.some(block => block.type === "image" || block.type === "image-unavailable" || !!block.text.trim())
		: !!message.text.trim();
	if (message.role === "assistant" && !hasContent) return null;
	return (
		<article className={`message ${message.role} ${message.isError ? "message-error" : ""}`}>
			<strong className="role-label">{labels[message.role]()}</strong>
			{message.truncated && <small className="truncation-notice">{t("support.truncated")}</small>}
			{message.role === "tool" ? (
				<details className="tool-disclosure">
					<summary>
						<ChevronRight className="disclosure-chevron" aria-hidden="true" />
						<span className="tool-name">{message.toolName || t("support.toolFallback")}</span>
						{message.excludeFromContext && <small> · {t("support.excludedFromContext")}</small>}
						{message.cancelled ? (
							<small> · {t("support.cancelled")}</small>
						) : (
							message.isError && (
								<span className="tool-failure">
									<CircleAlert aria-hidden="true" /> · {t("support.failed")}
								</span>
							)
						)}
					</summary>
					<div className="tool-output">
						{hasContent ? (
							blocks ? (
								<MessageBlocks blocks={blocks} tool />
							) : (
								<pre className="bounded-output">{message.text}</pre>
							)
						) : (
							<pre className="bounded-output">{t("support.noOutput")}</pre>
						)}
					</div>
				</details>
			) : blocks ? (
				<MessageBlocks blocks={blocks} tool={false} markdown={message.role === "assistant"} />
			) : hasContent ? (
				<div className="message-text">
					{message.role === "assistant" ? <Markdown text={message.text} /> : message.text}
				</div>
			) : null}
		</article>
	);
}
/** How long the send-to-stop swap ignores activation, so a second click cannot abort a fresh run. */
const STOP_GRACE_MS = 600;
export function Composer({
	value,
	onChange,
	onSend,
	onStop,
	busy,
	disabled,
	onSlash,
	controls,
	attachment,
	hasAttachments,
	allowQueue = true,
	sendDisabled,
	onPaste,
}: {
	value: string;
	onChange: (value: string) => void;
	onSend: () => void;
	onStop: () => void;
	busy: boolean;
	disabled?: boolean;
	onSlash?: () => void;
	controls?: ReactNode;
	attachment?: ReactNode;
	hasAttachments?: boolean;
	allowQueue?: boolean;
	sendDisabled?: boolean;
	onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
}) {
	const id = useId();
	const textarea = useRef<HTMLTextAreaElement>(null);
	const metrics = useRef<HTMLSpanElement>(null);
	const composing = useRef(false);
	const resize = () => {
		const element = textarea.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
		element.style.overflowY = element.scrollHeight > 200 ? "auto" : "hidden";
	};
	useLayoutEffect(resize, [value]);
	useEffect(() => {
		const element = textarea.current;
		if (!element) return;
		let width = element.clientWidth;
		let font = getComputedStyle(element).font;
		const observer = new ResizeObserver(entries => {
			const nextFont = getComputedStyle(element).font;
			if (
				element.clientWidth !== width ||
				nextFont !== font ||
				entries.some(entry => entry.target === metrics.current)
			) {
				width = element.clientWidth;
				font = nextFont;
				resize();
			}
		});
		observer.observe(element);
		if (metrics.current) observer.observe(metrics.current);
		return () => observer.disconnect();
	}, []);
	const canSubmit = !disabled && !sendDisabled && (!busy || allowQueue) && !!(value.trim() || hasAttachments);
	// While a turn runs the single slot either steers the draft or stops the turn: stop is the
	// fallback whenever the draft cannot actually be sent, so a run is never left uncontrollable
	// (empty draft, operator-owned turn, blocked recovery, not-ready attachment).
	const stopMode = busy && !canSubmit;
	// Sending clears the draft, which swaps this slot to stop under the same pointer. Ignore that
	// destructive activation for a moment so an impatient second click cannot abort the run.
	const lastSubmit = useRef(0);
	const submit = () => {
		lastSubmit.current = performance.now();
		onSend();
	};
	const stop = () => {
		if (performance.now() - lastSubmit.current < STOP_GRACE_MS) return;
		onStop();
	};
	return (
		<form
			className="composer"
			data-busy={busy || undefined}
			data-disabled={disabled || undefined}
			onSubmit={event => {
				event.preventDefault();
				if (canSubmit) submit();
			}}
		>
			<span ref={metrics} className="composer-metrics" aria-hidden="true">
				M
			</span>
			<label className="sr-only" htmlFor={id}>
				{t("support.composerLabel")}
			</label>
			<div className="composer-input">
				{attachment}
				<textarea
					ref={textarea}
					id={id}
					value={value}
					onChange={event => onChange(event.target.value)}
					placeholder={
						busy && allowQueue ? t("support.composerQueuedPlaceholder") : t("support.composerPlaceholder")
					}
					rows={1}
					disabled={disabled}
					onPaste={onPaste}
					onCompositionStart={() => {
						composing.current = true;
					}}
					onCompositionEnd={() => {
						composing.current = false;
					}}
					onKeyDown={event => {
						if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
						if (
							event.key === "/" &&
							!value &&
							onSlash &&
							!event.altKey &&
							!event.ctrlKey &&
							!event.metaKey &&
							!event.shiftKey
						) {
							event.preventDefault();
							onSlash();
							return;
						}
						if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
							event.preventDefault();
							if (canSubmit) submit();
						}
					}}
				/>
			</div>
			<div className="composer-footer">
				{controls != null && (
					<div className="composer-controls" role="group" aria-label={t("support.composerControls")}>
						{controls}
					</div>
				)}
				<div className="composer-actions">
					{/* One slot: stop while the turn runs with nothing waiting to be sent, otherwise
					    send. A message typed during a run is queued and steered into that run, as in
					    the TUI, so no delivery choice is offered anywhere. Icons only. */}
					{stopMode ? (
						<Button
							type="button"
							className="primary composer-action"
							disabled={disabled}
							aria-label={t("support.stop")}
							title={t("support.stop")}
							onClick={stop}
						>
							<Square aria-hidden="true" />
						</Button>
					) : (
						<Button
							type="submit"
							className="primary composer-action"
							disabled={!canSubmit}
							aria-label={busy && allowQueue ? t("support.sendSteer") : t("support.send")}
							title={busy && allowQueue ? t("support.sendSteer") : t("support.send")}
						>
							<ArrowUp aria-hidden="true" />
						</Button>
					)}
				</div>
			</div>
		</form>
	);
}
const todoStatusIcons = {
	pending: Circle,
	in_progress: LoaderCircle,
	completed: CircleCheck,
	abandoned: X,
};

/**
 * The live `todo_write` list. Collapsed it states the progress and the task in flight; expanded
 * it shows every task, so the tool's state is visible without reading the tool result.
 */
export function TodoPanel({ phases }: { phases: DesktopTodoPhase[] }) {
	const [open, setOpen] = useState(false);
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) return null;
	const done = tasks.filter(task => task.status === "completed").length;
	const active = tasks.find(task => task.status === "in_progress");
	return (
		<section className="todo-panel" aria-label={t("support.todosLabel")}>
			<button className="todo-toggle" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
				<ListChecks aria-hidden="true" />
				<span className="todo-summary">
					{t("support.todoProgress", { done, total: tasks.length })}
					{!open && active && <small>{active.content}</small>}
				</span>
				{open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
			</button>
			{open && (
				<div className="todo-phases">
					{phases.map((phase, phaseIndex) => (
						<div className="todo-phase" key={`${phaseIndex}-${phase.name}`}>
							{phase.name && <h3>{phase.name}</h3>}
							<ul>
								{phase.tasks.map((task, index) => {
									const Icon = todoStatusIcons[task.status];
									return (
										<li key={`${task.content}-${index}`} className={`todo-task ${task.status}`}>
											<Icon aria-hidden="true" />
											<span>{task.content}</span>
										</li>
									);
								})}
							</ul>
						</div>
					))}
				</div>
			)}
		</section>
	);
}

const goalStatusLabels = {
	active: () => t("support.goalActive"),
	paused: () => t("support.goalPaused"),
	complete: () => t("support.goalComplete"),
	dropped: () => t("support.goalDropped"),
};
const goalStatusIcons = {
	active: Target,
	paused: Pause,
	complete: CircleCheck,
	dropped: X,
};

/** Goal state from the `goal` tool, with the operations the desktop is allowed to request. */
export function GoalStrip({
	goal,
	pending,
	busy,
	onOperate,
}: {
	goal: DesktopGoal;
	pending?: boolean;
	/** A running turn owns the session, so the host would refuse the change. */
	busy?: boolean;
	onOperate: (op: "resume" | "pause" | "complete" | "drop") => void;
}) {
	const Icon = goalStatusIcons[goal.status];
	const actions =
		goal.status === "active"
			? (["pause", "complete", "drop"] as const)
			: goal.status === "paused"
				? (["resume", "drop"] as const)
				: (["drop"] as const);
	const labels = {
		resume: t("support.goalResume"),
		pause: t("support.goalPause"),
		complete: t("support.goalCompleteAction"),
		drop: t("support.goalDrop"),
	};
	return (
		<section className={`goal-strip ${goal.status}`} aria-label={t("support.goalLabel")}>
			<span className="goal-status">
				<Icon aria-hidden="true" />
				{goalStatusLabels[goal.status]()}
			</span>
			<span className="goal-objective" title={goal.objective}>
				{goal.objective}
			</span>
			{actions.map(op => (
				<Button
					key={op}
					className="goal-action"
					disabled={pending || busy}
					aria-label={labels[op]}
					title={labels[op]}
					onClick={() => onOperate(op)}
				>
					{op === "pause" ? <Pause aria-hidden="true" /> : null}
					{op === "resume" ? <Play aria-hidden="true" /> : null}
					{op === "complete" ? <Check aria-hidden="true" /> : null}
					{op === "drop" ? <X aria-hidden="true" /> : null}
				</Button>
			))}
		</section>
	);
}
export function QuestionCard({
	question,
	pending,
	onAnswer,
	value: controlledValue,
	onChange,
}: {
	question: DesktopQuestion;
	pending?: boolean;
	onAnswer: (value: string | boolean | null) => void;
	value?: string;
	onChange?: (value: string) => void;
}) {
	const [localValue, setLocalValue] = useState(question.initialValue || "");
	const value = controlledValue ?? localValue;
	const setValue = onChange ?? setLocalValue;
	const id = useId();
	const titleId = useId();
	return (
		<section className="question-card" aria-labelledby={titleId} aria-busy={pending}>
			<div className="question-heading">
				<CircleHelp aria-hidden="true" />
				<h3 id={titleId}>{question.title}</h3>
			</div>
			{pending && (
				<p className="question-pending">
					<LoaderCircle aria-hidden="true" />
					{t("support.waitingConnection")}
				</p>
			)}
			{question.message && <p>{question.message}</p>}
			{question.kind === "confirm" ? (
				<div className="actions">
					<Button disabled={pending} onClick={() => onAnswer(true)}>
						<Check aria-hidden="true" />
						{t("support.confirm")}
					</Button>
					<Button disabled={pending} onClick={() => onAnswer(false)}>
						{t("support.cancel")}
					</Button>
				</div>
			) : question.kind === "select" ? (
				<div className="option-list">
					{question.options?.map((option, index) => (
						<Button key={`${index}-${option}`} disabled={pending} onClick={() => onAnswer(option)}>
							{option}
						</Button>
					))}
				</div>
			) : (
				<form
					onSubmit={event => {
						event.preventDefault();
						onAnswer(value);
					}}
				>
					<label htmlFor={id}>{t("support.answerLabel")}</label>
					{question.kind === "editor" ? (
						<textarea
							id={id}
							rows={6}
							value={value}
							disabled={pending}
							onChange={event => setValue(event.target.value)}
						/>
					) : (
						<input id={id} value={value} disabled={pending} onChange={event => setValue(event.target.value)} />
					)}
					<Button type="submit" disabled={pending}>
						{t("support.sendAnswer")}
					</Button>
				</form>
			)}
			<Button disabled={pending} onClick={() => onAnswer(null)}>
				{t("support.cancel")}
			</Button>
		</section>
	);
}
export function Modal({
	title,
	children,
	onClose,
	className = "",
}: {
	title: string;
	children: ReactNode;
	onClose: () => void;
	className?: string;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	useEffect(() => {
		const previous = document.activeElement;
		const dialog = ref.current;
		dialog?.showModal();
		return () => {
			dialog?.close();
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, []);
	return (
		<dialog
			ref={ref}
			aria-labelledby={titleId}
			className={`modal ${className}`}
			onKeyDown={event => {
				if (event.key !== "Tab") return;
				const dialog = event.currentTarget;
				const targets = [
					...dialog.querySelectorAll<HTMLElement>(
						"button:enabled, input:enabled, select:enabled, textarea:enabled, a[href], summary, [tabindex]",
					),
				].filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
				const first = targets[0];
				const last = targets.at(-1);
				if (!first || !last) {
					event.preventDefault();
					dialog.focus();
				} else if (
					event.shiftKey &&
					(document.activeElement === first || !dialog.contains(document.activeElement))
				) {
					event.preventDefault();
					last.focus();
				} else if (
					!event.shiftKey &&
					(document.activeElement === last || !dialog.contains(document.activeElement))
				) {
					event.preventDefault();
					first.focus();
				}
			}}
			onCancel={event => {
				event.preventDefault();
				onClose();
			}}
		>
			<header>
				<h2 id={titleId}>{title}</h2>
				<Button className="modal-close" aria-label={t("support.close")} onClick={onClose}>
					<X aria-hidden="true" />
				</Button>
			</header>
			<div className="modal-content">{children}</div>
		</dialog>
	);
}
export function SettingField({
	setting,
	pending,
	onSave,
}: {
	setting: DesktopSetting;
	pending?: boolean;
	onSave: (value: unknown) => void;
}) {
	const [value, setValue] = useState(
		typeof setting.value === "string" ? setting.value : (JSON.stringify(setting.value) ?? "null"),
	);
	const [error, setError] = useState("");
	const id = useId();
	return (
		<form
			className="setting-field"
			aria-busy={pending}
			onSubmit={event => {
				event.preventDefault();
				try {
					// Only JSON-shaped types need parsing; strings and enum choices are literal.
					const parsed: unknown =
						setting.type === "boolean"
							? value === "true"
								? true
								: value === "false"
									? false
									: JSON.parse(value)
							: setting.type === "number"
								? JSON.parse(value)
								: value;
					setError("");
					onSave(parsed);
				} catch {
					setError(t("support.invalidValue"));
				}
			}}
		>
			{/* The listbox is not a native field, so the visible label names the control by id. */}
			<label id={`${id}-label`}>{setting.path}</label>
			{setting.description && <small>{setting.description}</small>}
			{setting.choices ? (
				<Select
					value={value}
					// A hand-edited value outside the curated options must stay visible and saveable.
					options={[
						...setting.choices.map(choice => ({ value: choice, label: choice })),
						...(value !== "" && !setting.choices.includes(value) ? [{ value, label: value }] : []),
					]}
					ariaLabel={setting.path}
					ariaLabelledby={`${id}-label`}
					disabled={!setting.writable || pending}
					onChange={setValue}
				/>
			) : setting.type === "boolean" ? (
				<input
					id={id}
					type="checkbox"
					disabled={!setting.writable || pending}
					checked={value === "true"}
					onChange={event => setValue(event.target.checked ? "true" : "false")}
				/>
			) : (
				<input
					id={id}
					type={setting.type === "number" ? "number" : "text"}
					step={setting.type === "number" ? "any" : undefined}
					disabled={!setting.writable || pending}
					value={value}
					onChange={event => setValue(event.target.value)}
				/>
			)}
			<Button type="submit" disabled={!setting.writable || pending}>
				{pending && <LoaderCircle aria-hidden="true" />}
				{pending ? t("support.settingPending") : setting.writable ? t("support.save") : t("support.readOnly")}
			</Button>
			{error && <ErrorBanner>{error}</ErrorBanner>}
		</form>
	);
}
