import {
	ArrowUp,
	Check,
	ChevronRight,
	Circle,
	CircleAlert,
	CircleCheck,
	CircleHelp,
	ListPlus,
	LoaderCircle,
	Square,
	Star,
	X,
} from "lucide-react";
import type { ButtonHTMLAttributes, ClipboardEventHandler, ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type {
	DesktopMessage,
	DesktopMessageBlock,
	DesktopQuestion,
	DesktopSession,
	DesktopSetting,
} from "../../desktop-host/src/protocol";
import { t } from "./i18n";

import { Markdown } from "./Markdown";

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
	onStar,
}: {
	session: DesktopSession;
	selected?: boolean;
	onSelect: () => void;
	onStar: () => void;
}) {
	const StatusIcon = statusIcons[session.status];
	return (
		<div className={`session-row ${selected ? "selected" : ""}`}>
			<button className="session-select" aria-current={selected ? "page" : undefined} onClick={onSelect}>
				<span className="session-title">{session.title}</span>
				<small className={`status ${session.status}`}>
					<StatusIcon aria-hidden="true" />
					{statuses[session.status]()}
				</small>
			</button>
			<Button
				className="session-star"
				aria-label={session.starred ? t("support.unstar") : t("support.star")}
				aria-pressed={session.starred}
				onClick={onStar}
			>
				<Star aria-hidden="true" fill={session.starred ? "currentColor" : "none"} />
			</Button>
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
export function Composer({
	value,
	onChange,
	onSend,
	onStop,
	busy,
	disabled,
	deliverAs,
	onDeliverAs,
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
	deliverAs?: "steer" | "followUp";
	onDeliverAs?: (value: "steer" | "followUp") => void;
	onSlash?: () => void;
	controls?: ReactNode;
	attachment?: ReactNode;
	hasAttachments?: boolean;
	allowQueue?: boolean;
	sendDisabled?: boolean;
	onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
}) {
	const id = useId();
	const deliverId = useId();
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
	return (
		<form
			className="composer"
			data-busy={busy || undefined}
			data-disabled={disabled || undefined}
			onSubmit={event => {
				event.preventDefault();
				if (canSubmit) onSend();
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
					placeholder={t("support.composerPlaceholder")}
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
							if (canSubmit) onSend();
						}
					}}
				/>
			</div>
			{controls != null && (
				<div className="composer-controls" role="group" aria-label={t("support.composerControls")}>
					{controls}
				</div>
			)}
			<div className="composer-actions">
				{busy && allowQueue && onDeliverAs && (
					<div className="composer-delivery">
						<label htmlFor={deliverId}>{t("support.deliverLabel")}</label>
						<select
							id={deliverId}
							value={deliverAs ?? "steer"}
							disabled={disabled}
							onChange={event => onDeliverAs(event.target.value === "followUp" ? "followUp" : "steer")}
						>
							<option value="steer">{t("support.deliverSteer")}</option>
							<option value="followUp">{t("support.deliverFollowUp")}</option>
						</select>
					</div>
				)}
				<div className="composer-buttons">
					{busy && (
						<Button onClick={onStop} disabled={disabled}>
							<Square aria-hidden="true" />
							{t("support.stop")}
						</Button>
					)}
					<Button type="submit" className="primary" disabled={!canSubmit}>
						{busy && allowQueue ? <ListPlus aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
						{busy && allowQueue ? t("support.queue") : t("support.send")}
					</Button>
				</div>
			</div>
		</form>
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
			<label htmlFor={id}>{setting.path}</label>
			{setting.description && <small>{setting.description}</small>}
			{setting.choices ? (
				<select
					id={id}
					disabled={!setting.writable || pending}
					value={value}
					onChange={event => setValue(event.target.value)}
				>
					{setting.choices.map(choice => (
						<option key={choice}>{choice}</option>
					))}
					{/* A hand-edited value outside the curated options must stay visible and saveable. */}
					{value !== "" && !setting.choices.includes(value) && <option>{value}</option>}
				</select>
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
