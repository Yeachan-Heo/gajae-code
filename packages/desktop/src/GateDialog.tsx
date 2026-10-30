import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { DesktopActivityGate, DesktopActivityGateAnswer } from "../../desktop-host/src/activity-protocol";
import type { DesktopGatePresentation } from "../../desktop-host/src/gate-presentation-protocol";
import { Button, ErrorBanner, Modal } from "./components";
import { t } from "./i18n";

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
		return { valid: false, error: t("settings.answerLimitMissing") };
	}
	const bytes = new TextEncoder().encode(json).byteLength;
	if (bytes > maxAnswerBytes) return { valid: false, error: t("settings.answerTooLarge", { limit: maxAnswerBytes }) };
	try {
		JSON.parse(json);
	} catch {
		return { valid: false, error: t("settings.answerInvalidJson") };
	}
	return { valid: true, bytes, answer: { kind: "json", json } };
}

const CONTENT_LIMIT = 32_768;
const SCHEMA_LIMIT = 65_536;
const FIELD_LIMIT = 1024;
const ITEM_LIMIT = 64;
type GateContentField = keyof DesktopActivityGate["content"];
const contentFields: readonly GateContentField[] = ["title", "prompt", "summary", "plan", "source", "language"];
const contentLabels: Record<GateContentField, () => string> = {
	title: () => t("settings.contentTitle"),
	prompt: () => t("settings.contentPrompt"),
	summary: () => t("settings.contentSummary"),
	plan: () => t("settings.contentPlan"),
	source: () => t("settings.contentSource"),
	language: () => t("settings.contentLanguage"),
};
const gateTitles = {
	question: () => t("settings.gateQuestion"),
	approval: () => t("settings.gateApproval"),
	execution: () => t("settings.gateExecution"),
};

function boundedText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const end = /[\uD800-\uDBFF]/u.test(text.charAt(limit - 1)) ? limit - 1 : limit;
	return `${text.slice(0, end)}${t("settings.gateContentTruncated")}`;
}

/** Do not silently enable answers when even this browser's bounded display omitted evidence. */
function displayTruncated(gate: DesktopActivityGate): boolean {
	return (
		contentFields.some(field => (gate.content[field]?.length ?? 0) > CONTENT_LIMIT) ||
		gate.schemaJson.length > SCHEMA_LIMIT ||
		gate.artifacts.length > ITEM_LIMIT ||
		gate.choices.length > ITEM_LIMIT ||
		gate.optionLabels.length > ITEM_LIMIT ||
		gate.artifacts.some(item =>
			[item.kind, item.path, item.sha256].some(text => (text?.length ?? 0) > FIELD_LIMIT),
		) ||
		[...gate.choices, ...gate.optionLabels].some(
			item => item.label.length > FIELD_LIMIT || (item.description?.length ?? 0) > FIELD_LIMIT,
		)
	);
}

function GateJsonInput({
	presentationId,
	maxAnswerBytes,
	disabled,
	onAnswer,
}: {
	presentationId: string;
	maxAnswerBytes: number;
	disabled: boolean;
	onAnswer: GateDialogProps["onAnswer"];
}) {
	const id = useId();
	const [json, setJson] = useState("");
	const validation = validateGateJsonAnswer(json, maxAnswerBytes);
	return (
		<form
			className="gate-answer"
			onSubmit={event => {
				event.preventDefault();
				if (!disabled && validation.valid) onAnswer(presentationId, validation.answer);
			}}
		>
			<label htmlFor={id}>{t("settings.jsonLabel")}</label>
			<p id={`${id}-help`}>{t("settings.jsonHelp")}</p>
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
				{!validation.valid
					? validation.error
					: t("settings.jsonBytes", { bytes: validation.bytes, limit: maxAnswerBytes })}
			</p>
			<div className="gate-actions">
				<Button type="submit" disabled={disabled || !validation.valid}>
					{t("settings.jsonSubmit")}
				</Button>
			</div>
		</form>
	);
}

export function GateDialog({
	presentation,
	presented,
	retiring,
	pending,
	error,
	onPresented,
	onRetired,
	onAnswer,
	onWithdraw,
}: GateDialogProps) {
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
			<Modal title={gateTitles[gate.kind]()} className="gate-dialog" onClose={() => onWithdraw(id)}>
				<div className="gate-content" aria-busy={Boolean(pending)}>
					<p>{t("settings.gateStage", { stage: boundedText(gate.stage, FIELD_LIMIT) })}</p>
					{contentFields.map(
						field =>
							gate.content[field] !== undefined && (
								<section key={field}>
									<h3>{contentLabels[field]()}</h3>
									<p className="message-text">{boundedText(gate.content[field], CONTENT_LIMIT)}</p>
								</section>
							),
					)}
				</div>
				<section className="gate-evidence" aria-label={t("settings.artifactsRegion")}>
					<h3>{t("settings.artifactsHeading")}</h3>
					<p>{t("settings.artifactsHelp")}</p>
					{gate.artifacts.length === 0 ? (
						<p>{t("settings.artifactsEmpty")}</p>
					) : (
						<ul>
							{gate.artifacts.slice(0, ITEM_LIMIT).map((artifact, index) => (
								<li key={index}>
									<dl>
										<dt>{t("settings.artifactKind")}</dt>
										<dd>{boundedText(artifact.kind, FIELD_LIMIT)}</dd>
										{artifact.path !== undefined && (
											<>
												<dt>{t("settings.artifactPath")}</dt>
												<dd>
													<code>{boundedText(artifact.path, FIELD_LIMIT)}</code>
												</dd>
											</>
										)}
										{artifact.sha256 !== undefined && (
											<>
												<dt>SHA-256</dt>
												<dd>
													<code>{boundedText(artifact.sha256, FIELD_LIMIT)}</code>
												</dd>
											</>
										)}
									</dl>
								</li>
							))}
						</ul>
					)}
				</section>
				<section className="gate-schema" aria-label={t("settings.schemaRegion")}>
					<h3>{t("settings.schemaHeading")}</h3>
					<p>{t("settings.schemaHelp")}</p>
					<pre className="bounded-output">
						<code>{boundedText(gate.schemaJson, SCHEMA_LIMIT)}</code>
					</pre>
				</section>
				{gate.optionLabels.length > 0 && (
					<section className="gate-evidence" aria-label={t("settings.optionsRegion")}>
						<h3>{t("settings.optionsHeading")}</h3>
						<p>{t("settings.optionsHelp")}</p>
						<ul>
							{gate.optionLabels.slice(0, ITEM_LIMIT).map((option, index) => (
								<li key={index}>
									<strong>{boundedText(option.label, FIELD_LIMIT)}</strong>
									{option.description !== undefined && <p>{boundedText(option.description, FIELD_LIMIT)}</p>}
								</li>
							))}
						</ul>
					</section>
				)}
				<div className="gate-status" role="status" aria-live="polite">
					{!gate.answerable && <p>{t("settings.gateUnanswerable")}</p>}
					{truncated && <p>{t("settings.gateTruncated")}</p>}
					{!presented && <p>{t("settings.gateNotPresented")}</p>}
					{pending && <p>{t("settings.gatePending")}</p>}
					{invalidLimit && <p>{t("settings.gateLimitInvalid")}</p>}
					{gate.reason && <p>{boundedText(gate.reason, FIELD_LIMIT)}</p>}
					<p>{t("settings.gateNotice")}</p>
				</div>
				{error && <ErrorBanner>{boundedText(error, FIELD_LIMIT)}</ErrorBanner>}
				<div className="gate-actions" role="group" aria-label={t("settings.gateChoicesGroup")}>
					{gate.choices.slice(0, ITEM_LIMIT).map(choice => (
						<Button
							key={choice.key}
							disabled={disabled}
							onClick={() => {
								if (!disabled) onAnswer(id, { kind: "choice", choiceKey: choice.key });
							}}
						>
							<span>
								{boundedText(choice.label, FIELD_LIMIT)}
								{choice.description !== undefined && (
									<small>{boundedText(choice.description, FIELD_LIMIT)}</small>
								)}
							</span>
						</Button>
					))}
					{gate.choices.length === 0 && <p>{t("settings.gateChoicesEmpty")}</p>}
				</div>
				<GateJsonInput
					key={id}
					presentationId={id}
					maxAnswerBytes={gate.maxAnswerBytes}
					disabled={disabled}
					onAnswer={onAnswer}
				/>
			</Modal>
		</div>
	);
}
