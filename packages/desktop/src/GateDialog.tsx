import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { DesktopActivityGate, DesktopActivityGateAnswer } from "../../desktop-host/src/activity-protocol";
import type { DesktopGatePresentation } from "../../desktop-host/src/gate-presentation-protocol";
import { Button, ErrorBanner, Modal } from "./components";

export interface GateDialogProps {
	presentation: DesktopGatePresentation;
	presented: boolean;
	retiring?: { nonce: string };
	pending?: boolean;
	error?: string;
	onPresented: (presentationId: string) => void;
	onRetired: (presentationId: string, nonce: string) => void;
	onAnswer: (presentationId: string, answer: DesktopActivityGateAnswer) => void;
	onWithdraw: (presentationId: string) => void;
}

export type GateJsonValidation =
	| { valid: true; bytes: number; answer: { kind: "json"; json: string } }
	| { valid: false; error: string };

/** Syntax and wire-size checks only. The host validates the original, immutable schema. */
export function validateGateJsonAnswer(json: string, maxAnswerBytes: number): GateJsonValidation {
	if (!Number.isSafeInteger(maxAnswerBytes) || maxAnswerBytes <= 0) {
		return { valid: false, error: "유효한 응답 크기 한도가 제공되지 않았습니다." };
	}
	const bytes = new TextEncoder().encode(json).byteLength;
	if (bytes > maxAnswerBytes) return { valid: false, error: `응답은 UTF-8 ${maxAnswerBytes}바이트 이하여야 합니다.` };
	try {
		JSON.parse(json);
	} catch {
		return { valid: false, error: "유효한 JSON 값을 입력하세요." };
	}
	return { valid: true, bytes, answer: { kind: "json", json } };
}

const CONTENT_LIMIT = 32_768;
const SCHEMA_LIMIT = 65_536;
const FIELD_LIMIT = 1024;
const ITEM_LIMIT = 64;
const contentFields = [
	["title", "제목"], ["prompt", "질문"], ["summary", "요약"],
	["plan", "계획"], ["source", "출처"], ["language", "언어"],
] as const;
const gateTitles = { question: "질문", approval: "승인 요청", execution: "실행 요청" };

function boundedText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const end = /[\uD800-\uDBFF]/u.test(text.charAt(limit - 1)) ? limit - 1 : limit;
	return `${text.slice(0, end)}… (긴 내용 생략)`;
}

/** Do not silently enable answers when even this browser's bounded display omitted evidence. */
function displayTruncated(gate: DesktopActivityGate): boolean {
	return contentFields.some(([field]) => (gate.content[field]?.length ?? 0) > CONTENT_LIMIT)
		|| gate.schemaJson.length > SCHEMA_LIMIT
		|| gate.artifacts.length > ITEM_LIMIT
		|| gate.choices.length > ITEM_LIMIT
		|| gate.optionLabels.length > ITEM_LIMIT
		|| gate.artifacts.some(item => [item.kind, item.path, item.sha256].some(text => (text?.length ?? 0) > FIELD_LIMIT))
		|| [...gate.choices, ...gate.optionLabels].some(item => item.label.length > FIELD_LIMIT || (item.description?.length ?? 0) > FIELD_LIMIT);
}

function GateJsonInput({ presentationId, maxAnswerBytes, disabled, onAnswer }: {
	presentationId: string;
	maxAnswerBytes: number;
	disabled: boolean;
	onAnswer: GateDialogProps["onAnswer"];
}) {
	const id = useId();
	const [json, setJson] = useState("");
	const validation = validateGateJsonAnswer(json, maxAnswerBytes);
	return (
		<form className="gate-answer" onSubmit={event => {
			event.preventDefault();
			if (!disabled && validation.valid) onAnswer(presentationId, validation.answer);
		}}>
			<label htmlFor={id}>구조화된 JSON 응답</label>
			<p id={`${id}-help`}>완전한 JSON 값을 직접 입력하세요. 표시용 스키마에서 입력 필드를 추정하지 않습니다. 원본 스키마 검증은 서버에서 수행합니다.</p>
			<textarea
				id={id}
				rows={6}
				value={json}
				disabled={disabled}
				spellCheck={false}
				aria-describedby={`${id}-help ${id}-validation`}
				aria-invalid={json.length > 0 && !validation.valid}
				onChange={event => setJson(event.target.value)}
			/>
			<p id={`${id}-validation`} className="gate-status" role="status">
				{!validation.valid ? validation.error : `UTF-8 ${validation.bytes} / ${maxAnswerBytes}바이트 · 구문 확인만 완료`}
			</p>
			<div className="gate-actions"><Button type="submit" disabled={disabled || !validation.valid}>JSON 응답 보내기</Button></div>
		</form>
	);
}

export function GateDialog({ presentation, presented, retiring, pending, error, onPresented, onRetired, onAnswer, onWithdraw }: GateDialogProps) {
	const { id, gate } = presentation;
	const root = useRef<HTMLDivElement | null>(null);
	const lastRoot = useRef<HTMLDivElement | null>(null);
	const presentedIds = useRef(new Set<string>());
	const retiredPairs = useRef(new Set<string>());
	const captureRoot = useCallback((node: HTMLDivElement | null) => {
		root.current = node;
		if (node) lastRoot.current = node;
	}, []);
	const nonce = retiring?.nonce;

	useEffect(() => {
		if (nonce !== undefined) {
			// This runs after the null render committed, never from cleanup or a timer.
			// Keep the detached node so a cleared ref alone cannot prove retirement.
			if (root.current !== null || lastRoot.current?.isConnected) return;
			const pair = JSON.stringify([id, nonce]);
			if (retiredPairs.current.has(pair)) return;
			retiredPairs.current.add(pair);
			onRetired(id, nonce);
			return;
		}
		const visibleRoot = root.current;
		const dialog = visibleRoot?.querySelector("dialog");
		if (!visibleRoot?.isConnected || !dialog?.isConnected || !dialog.open || presentedIds.current.has(id)) return;
		// Modal's child effect opened the native dialog. This exact committed root is visible.
		presentedIds.current.add(id);
		onPresented(id);
		// No cleanup ACK and no cancelled promise: StrictMode replays must retain the valid notification.
	}, [id, nonce, onPresented, onRetired]);

	// A retirement always removes the entire Modal, including while an answer is pending.
	if (retiring) return null;

	const truncated = gate.truncated || displayTruncated(gate);
	const invalidLimit = !Number.isSafeInteger(gate.maxAnswerBytes) || gate.maxAnswerBytes <= 0;
	const disabled = !gate.answerable || truncated || !presented || Boolean(pending) || invalidLimit;
	return (
		<div key={id} ref={captureRoot}>
			<Modal title={gateTitles[gate.kind]} className="gate-dialog" onClose={() => onWithdraw(id)}>
				<div className="gate-content" aria-busy={Boolean(pending)}>
					<p>단계: {boundedText(gate.stage, FIELD_LIMIT)}</p>
					{contentFields.map(([field, label]) => gate.content[field] !== undefined && (
						<section key={field}><h3>{label}</h3><p className="message-text">{boundedText(gate.content[field], CONTENT_LIMIT)}</p></section>
					))}
				</div>
				<section className="gate-evidence" aria-label="읽기 전용 아티팩트 참조">
					<h3>아티팩트 참조 · 읽기 전용</h3>
					<p>생산자가 제공한 비활성 참조입니다. 경로나 해시를 열거나 가져오지 않으며, 실행 권한을 뜻하지 않습니다.</p>
					{gate.artifacts.length === 0 ? <p>제공된 아티팩트 참조 없음</p> : <ul>{gate.artifacts.slice(0, ITEM_LIMIT).map((artifact, index) => (
						<li key={index}><dl>
							<dt>종류</dt><dd>{boundedText(artifact.kind, FIELD_LIMIT)}</dd>
							{artifact.path !== undefined && <><dt>경로</dt><dd><code>{boundedText(artifact.path, FIELD_LIMIT)}</code></dd></>}
							{artifact.sha256 !== undefined && <><dt>SHA-256</dt><dd><code>{boundedText(artifact.sha256, FIELD_LIMIT)}</code></dd></>}
						</dl></li>
					))}</ul>}
				</section>
				<section className="gate-schema" aria-label="읽기 전용 표시용 스키마">
					<h3>스키마 JSON · 읽기 전용</h3>
					<p>민감 정보가 가려진 표시용 안내이며 원본 검증 스키마가 아닙니다.</p>
					<pre className="bounded-output"><code>{boundedText(gate.schemaJson, SCHEMA_LIMIT)}</code></pre>
				</section>
				{gate.optionLabels.length > 0 && <section className="gate-evidence" aria-label="생산자 응답 안내">
					<h3>생산자 응답 안내</h3>
					<p>이 설명은 선택 버튼이 아닙니다. 완전한 응답으로 제공된 선택지만 아래 버튼으로 표시합니다.</p>
					<ul>{gate.optionLabels.slice(0, ITEM_LIMIT).map((option, index) => <li key={index}>
						<strong>{boundedText(option.label, FIELD_LIMIT)}</strong>
						{option.description !== undefined && <p>{boundedText(option.description, FIELD_LIMIT)}</p>}
					</li>)}</ul>
				</section>}
				<div className="gate-status" role="status" aria-live="polite">
					{!gate.answerable && <p>이 요청은 원격 응답을 지원하지 않거나 현재 응답할 수 없습니다. 읽기 전용입니다.</p>}
					{truncated && <p>요청 내용이 생략되었습니다. 완전한 내용을 확인할 수 없어 응답할 수 없습니다.</p>}
					{!presented && <p>화면 표시의 서버 확인을 기다리는 중입니다. 아직 응답할 수 없습니다.</p>}
					{pending && <p>연결 또는 응답 처리를 기다리는 중입니다. 승인이나 워크플로 진행 완료를 뜻하지 않습니다.</p>}
					{invalidLimit && <p>유효한 응답 크기 한도가 제공되지 않아 응답할 수 없습니다.</p>}
					{gate.reason && <p>{boundedText(gate.reason, FIELD_LIMIT)}</p>}
					<p>응답 수락은 실행 승인이나 워크플로 진행 완료를 뜻하지 않습니다. 닫기는 화면 철회 요청이며 워크플로 취소가 아닙니다.</p>
				</div>
				{error && <ErrorBanner>{boundedText(error, FIELD_LIMIT)}</ErrorBanner>}
				<div className="gate-actions" role="group" aria-label="제공된 완전한 응답 선택지">
					{gate.choices.slice(0, ITEM_LIMIT).map(choice => <Button key={choice.key} disabled={disabled} onClick={() => {
						if (!disabled) onAnswer(id, { kind: "choice", choiceKey: choice.key });
					}}>
						<span>{boundedText(choice.label, FIELD_LIMIT)}{choice.description !== undefined && <small>{boundedText(choice.description, FIELD_LIMIT)}</small>}</span>
					</Button>)}
					{gate.choices.length === 0 && <p>제공된 완전한 응답 선택지 없음 · JSON 응답을 사용하세요.</p>}
				</div>
				<GateJsonInput key={id} presentationId={id} maxAnswerBytes={gate.maxAnswerBytes} disabled={disabled} onAnswer={onAnswer} />
			</Modal>
		</div>
	);
}
