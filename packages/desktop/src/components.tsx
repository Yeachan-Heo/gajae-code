import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type { DesktopMessage, DesktopQuestion, DesktopSession, DesktopSetting } from "../../desktop-host/src/protocol";

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
			{children}
		</div>
	);
}
const statuses = { idle: "대기", running: "작업 중", waiting: "응답 필요", error: "오류" };
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
	return (
		<div className={`session-row ${selected ? "selected" : ""}`}>
			<button className="session-select" aria-current={selected ? "page" : undefined} onClick={onSelect}>
				<span>{session.title}</span>
				<small className={`status ${session.status}`}>{statuses[session.status]}</small>
			</button>
			<Button
				aria-label={session.starred ? "즐겨찾기 해제" : "즐겨찾기"}
				aria-pressed={session.starred}
				onClick={onStar}
			>
				{session.starred ? "★" : "☆"}
			</Button>
		</div>
	);
}
export function Message({ message }: { message: DesktopMessage }) {
	const labels = { user: "나", assistant: "GJC", tool: "도구", system: "시스템" };
	return (
		<article className={`message ${message.role} ${message.isError ? "message-error" : ""}`}>
			<strong className="role-label">{labels[message.role]}</strong>
			{message.truncated && (
				<small>긴 메시지의 앞부분을 생략했습니다. 전체 내용은 대화 내보내기로 확인하세요.</small>
			)}
			{message.role === "tool" ? (
				<details>
					<summary>
						{message.toolName || "도구 실행"}
						{message.isError ? " · 실패" : ""}
					</summary>
					<pre className="bounded-output">{message.text}</pre>
				</details>
			) : (
				<div className="message-text">{message.text || "응답을 기다리는 중…"}</div>
			)}
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
}) {
	const id = useId();
	const deliverId = useId();
	return (
		<form
			className="composer"
			onSubmit={event => {
				event.preventDefault();
				onSend();
			}}
		>
			<label className="sr-only" htmlFor={id}>
				메시지
			</label>
			<textarea
				id={id}
				value={value}
				onChange={event => onChange(event.target.value)}
				placeholder="무엇을 함께 만들까요?"
				rows={3}
				disabled={disabled}
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
						!disabled &&
						value.trim()
					) {
						event.preventDefault();
						onSend();
					}
				}}
			/>
			<div className="composer-actions">
				<small>⌘ / Ctrl + Enter로 보내기</small>
				{busy && onDeliverAs && (
					<>
						<label htmlFor={deliverId}>실행 중 입력</label>
						<select
							id={deliverId}
							value={deliverAs ?? "steer"}
							onChange={event => onDeliverAs(event.target.value === "followUp" ? "followUp" : "steer")}
						>
							<option value="steer">작업에 개입</option>
							<option value="followUp">끝난 뒤 후속</option>
						</select>
					</>
				)}
				{busy && (
					<Button onClick={onStop} disabled={disabled}>
						작업 중지
					</Button>
				)}
				<Button type="submit" className="primary" disabled={disabled || !value.trim()}>
					{busy ? "대기열에 추가" : "보내기"}
				</Button>
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
	return (
		<section className="question-card" aria-busy={pending}>
			<h3>{question.title}</h3>
			{question.message && <p>{question.message}</p>}
			{question.kind === "confirm" ? (
				<div className="actions">
					<Button disabled={pending} onClick={() => onAnswer(true)}>
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
				</select>
			) : (
				<input
					id={id}
					disabled={!setting.writable || pending}
					value={value}
					onChange={event => setValue(event.target.value)}
				/>
			)}
			<Button type="submit" disabled={!setting.writable || pending}>
				{setting.writable ? "저장" : "읽기 전용"}
			</Button>
			{error && <ErrorBanner>{error}</ErrorBanner>}
		</form>
	);
}
