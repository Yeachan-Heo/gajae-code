import {
	ArrowUp,
	Check,
	ChevronRight,
	Circle,
	CircleAlert,
	CircleHelp,
	ListPlus,
	LoaderCircle,
	Square,
	Star,
	X,
} from "lucide-react";
import type { ButtonHTMLAttributes, ClipboardEventHandler, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type {
	DesktopMessage,
	DesktopMessageBlock,
	DesktopQuestion,
	DesktopSession,
	DesktopSetting,
} from "../../desktop-host/src/protocol";

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
const statuses = { idle: "대기", running: "작업 중", waiting: "응답 필요", error: "오류" };
const statusIcons = { idle: Circle, running: LoaderCircle, waiting: CircleHelp, error: CircleAlert };
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
					{statuses[session.status]}
				</small>
			</button>
			<Button
				className="session-star"
				aria-label={session.starred ? "즐겨찾기 해제" : "즐겨찾기"}
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
		return <p className="message-image-unavailable">이미지를 표시할 수 없습니다.</p>;
	return (
		<figure className="message-image">
			<img src={source} alt="대화에 포함된 이미지" onError={() => setFailedSource(source)} />
		</figure>
	);
}

function MessageBlocks({ blocks, tool }: { blocks: DesktopMessageBlock[]; tool: boolean }) {
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
							{block.text}
						</div>
					)
				) : null;
			case "thinking":
				return block.text.trim() ? (
					<details className="thinking-disclosure" key={index}>
						<summary>생각 과정</summary>
						<div className="message-text">{block.text}</div>
					</details>
				) : null;
			case "image":
				return <MessageImage key={index} block={block} />;
			case "image-unavailable":
				return (
					<p className="message-image-unavailable" key={index}>
						이미지를 표시할 수 없습니다. {block.reason}
					</p>
				);
		}
		return null;
	});
}

export function Message({ message }: { message: DesktopMessage }) {
	const labels = { user: "나", assistant: "GJC", tool: "도구", system: "시스템" };
	const blocks = message.blocks;
	const hasContent = blocks
		? blocks.some(block => block.type === "image" || block.type === "image-unavailable" || !!block.text.trim())
		: !!message.text.trim();
	if (message.role === "assistant" && !hasContent) return null;
	return (
		<article className={`message ${message.role} ${message.isError ? "message-error" : ""}`}>
			<strong className="role-label">{labels[message.role]}</strong>
			{message.truncated && (
				<small className="truncation-notice">
					긴 메시지의 앞부분을 생략했습니다. 전체 내용은 대화 내보내기로 확인하세요.
				</small>
			)}
			{message.role === "tool" ? (
				<details className="tool-disclosure">
					<summary>
						<ChevronRight className="disclosure-chevron" aria-hidden="true" />
						<span className="tool-name">{message.toolName || "도구 실행"}</span>
						{message.excludeFromContext && <small> · 모델 컨텍스트 제외</small>}
						{message.cancelled ? (
							<small> · 취소됨</small>
						) : (
							message.isError && (
								<span className="tool-failure">
									<CircleAlert aria-hidden="true" /> · 실패
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
							<pre className="bounded-output">출력 없음</pre>
						)}
					</div>
				</details>
			) : blocks ? (
				<MessageBlocks blocks={blocks} tool={false} />
			) : hasContent ? (
				<div className="message-text">{message.text}</div>
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
	hasAttachments?: boolean;
	allowQueue?: boolean;
	sendDisabled?: boolean;
	onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
}) {
	const id = useId();
	const deliverId = useId();
	const hintId = useId();
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
			<label className="sr-only" htmlFor={id}>
				메시지
			</label>
			<textarea
				id={id}
				aria-describedby={hintId}
				value={value}
				onChange={event => onChange(event.target.value)}
				placeholder="무엇을 함께 만들까요?"
				rows={3}
				disabled={disabled}
				onPaste={onPaste}
				onKeyDown={event => {
					if (event.key === "/" && !value && onSlash && !event.nativeEvent.isComposing) {
						event.preventDefault();
						onSlash();
						return;
					}
					if (
						event.key === "Enter" &&
						(event.metaKey || event.ctrlKey) &&
						!event.nativeEvent.isComposing &&
						canSubmit
					) {
						event.preventDefault();
						onSend();
					}
				}}
			/>
			{controls != null && (
				<div className="composer-controls" role="group" aria-label="메시지 작성 설정">
					{controls}
				</div>
			)}
			<div className="composer-actions">
				<small id={hintId} className="composer-hint">
					⌘ / Ctrl + Enter로 보내기
				</small>
				{busy && allowQueue && onDeliverAs && (
					<div className="composer-delivery">
						<label htmlFor={deliverId}>실행 중 입력</label>
						<select
							id={deliverId}
							value={deliverAs ?? "steer"}
							disabled={disabled}
							onChange={event => onDeliverAs(event.target.value === "followUp" ? "followUp" : "steer")}
						>
							<option value="steer">작업에 개입</option>
							<option value="followUp">끝난 뒤 후속</option>
						</select>
					</div>
				)}
				<div className="composer-buttons">
					{busy && (
						<Button onClick={onStop} disabled={disabled}>
							<Square aria-hidden="true" />
							작업 중지
						</Button>
					)}
					<Button type="submit" className="primary" disabled={!canSubmit}>
						{busy && allowQueue ? <ListPlus aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
						{busy && allowQueue ? "대기열에 추가" : "보내기"}
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
					연결 또는 응답 처리를 기다리는 중…
				</p>
			)}
			{question.message && <p>{question.message}</p>}
			{question.kind === "confirm" ? (
				<div className="actions">
					<Button disabled={pending} onClick={() => onAnswer(true)}>
						<Check aria-hidden="true" />
						확인
					</Button>
					<Button disabled={pending} onClick={() => onAnswer(false)}>
						아니요
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
					<label htmlFor={id}>답변</label>
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
						답변 보내기
					</Button>
				</form>
			)}
			<Button disabled={pending} onClick={() => onAnswer(null)}>
				취소
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
			onCancel={event => {
				event.preventDefault();
				onClose();
			}}
		>
			<header>
				<h2 id={titleId}>{title}</h2>
				<Button aria-label="닫기" onClick={onClose}>
					<X aria-hidden="true" />
					닫기
				</Button>
			</header>
			{children}
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
					setError("올바른 값을 입력하세요.");
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
				{pending ? "연결 또는 처리 대기" : setting.writable ? "저장" : "읽기 전용"}
			</Button>
			{error && <ErrorBanner>{error}</ErrorBanner>}
		</form>
	);
}
