/**
 * Pure model helpers for the jobs overlay.
 *
 * Kept free of UI/Component dependencies so the grouping/ordering and
 * detail-formatting logic is unit-testable. The selector controller wires these
 * SelectItem lists into nested SelectLists (list -> detail -> confirm).
 */
import type { SelectItem } from "@gajae-code/tui";
import type { JobsSnapshot } from "../jobs-observer";

export type JobRefKind = "monitor" | "cron";

export interface JobRef {
	kind: JobRefKind;
	id: string;
}

export interface JobsOverlayModelOptions {
	readonly safeAttentionReveal?: boolean;
}

const PROMPT_PREVIEW_MAX = 60;
const REDACTED = "<redacted>";
const SENSITIVE_ASSIGNMENT_PREFIX =
	/^(?:api[_ -]?key|access[_ -]?token|authorization|token|secret|password|passwd|credential)(?:[ \t]{0,16})[:=]/iu;
const SENSITIVE_KEY_PREFIX =
	/^(?:api[_ -]?key|access[_ -]?token|authorization|token|secret|password|passwd|credential)(?:[ \t]{0,16})[:=]?$/iu;

function stripTerminalControls(text: string): string {
	return text
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, " ")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, " ")
		.replace(/[\u0000-\u001f\u007f]/g, " ");
}

function stripTokenPrefix(token: string): string {
	let start = 0;
	while (start < token.length && "([{\\\"'`".includes(token[start] ?? "")) start += 1;
	return token.slice(start);
}

function isSensitiveUriOrPath(token: string): boolean {
	if (
		token.startsWith("http://") ||
		token.startsWith("https://") ||
		token.startsWith("ws://") ||
		token.startsWith("wss://") ||
		token.startsWith("ftp://")
	) {
		return true;
	}
	if (token.startsWith("~/")) return true;
	if (token.startsWith("/") && token.length > 1) return true;
	return token.length > 2 && token[1] === ":" && (token[2] === "/" || token[2] === "\\");
}

function redactSensitiveMaterial(text: string): string {
	const pieces: string[] = [];
	let cursor = 0;
	let redactNextToken = false;
	while (cursor < text.length) {
		const whitespaceStart = cursor;
		while (cursor < text.length && /\s/u.test(text[cursor] ?? "")) cursor += 1;
		pieces.push(text.slice(whitespaceStart, cursor));
		if (cursor >= text.length) break;

		const tokenStart = cursor;
		while (cursor < text.length && !/\s/u.test(text[cursor] ?? "")) cursor += 1;
		const token = text.slice(tokenStart, cursor);
		const candidate = stripTokenPrefix(token);
		if (redactNextToken) {
			pieces.push(REDACTED);
			redactNextToken = false;
		} else if (candidate.toLowerCase() === "bearer") {
			pieces.push(REDACTED);
			redactNextToken = true;
		} else if (SENSITIVE_ASSIGNMENT_PREFIX.test(candidate)) {
			pieces.push(REDACTED);
		} else if (SENSITIVE_KEY_PREFIX.test(candidate)) {
			pieces.push(REDACTED);
			redactNextToken = true;
		} else if (isSensitiveUriOrPath(candidate)) {
			pieces.push(REDACTED);
		} else {
			pieces.push(token);
		}
	}
	return pieces.join("");
}

function preview(text: string, max = PROMPT_PREVIEW_MAX): string {
	const oneLine = redactSensitiveMaterial(stripTerminalControls(text)).replace(/\s+/gu, " ").trim();
	if (oneLine.length === 0) return "(none)";
	return oneLine.length > max ? `${oneLine.slice(0, Math.max(1, max - 1))}…` : oneLine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Narrow an untrusted launch value to a concrete monitor/cron reference. */
export function isJobRef(value: unknown): value is JobRef {
	if (!isRecord(value)) return false;
	return (value.kind === "monitor" || value.kind === "cron") && typeof value.id === "string" && value.id.length > 0;
}

/** Parse a list item value back into a job reference. */
export function parseJobRef(value: string): JobRef | null {
	const sep = value.indexOf(":");
	if (sep === -1) return null;
	const kind = value.slice(0, sep);
	const id = value.slice(sep + 1);
	if ((kind === "monitor" || kind === "cron") && id.length > 0) {
		return { kind, id };
	}
	return null;
}

function hasJobRef(snapshot: JobsSnapshot, ref: JobRef): boolean {
	return ref.kind === "monitor"
		? snapshot.monitors.some(monitor => monitor.id === ref.id)
		: snapshot.crons.some(cron => cron.id === ref.id);
}

/** Return whether a job reference is still visible in the owner snapshot. */
export function isJobRefPresent(snapshot: JobsSnapshot, ref: JobRef): boolean {
	return hasJobRef(snapshot, ref);
}

/** Compact relative time, e.g. "in 5m", "2m ago", "now". */
export function formatRelative(targetMs: number | undefined, nowMs = Date.now()): string {
	if (targetMs === undefined) return "—";
	const deltaMs = targetMs - nowMs;
	const abs = Math.abs(deltaMs);
	const mins = Math.round(abs / 60_000);
	if (mins < 1) return "now";
	const unit = mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`;
	return deltaMs >= 0 ? `in ${unit}` : `${unit} ago`;
}

/**
 * Build the grouped jobs list: monitors first (newest-first), then crons
 * (newest-first). The snapshot arrays are already sorted newest-first.
 */
export function buildJobsListItems(snapshot: JobsSnapshot, options: JobsOverlayModelOptions = {}): SelectItem[] {
	const items: SelectItem[] = [];
	for (const monitor of snapshot.monitors) {
		items.push({
			value: `monitor:${monitor.id}`,
			label: `monitor · ${preview(monitor.label, 40)}`,
			description: monitor.status,
			hint: monitor.status === "failed" ? "failed" : undefined,
		});
	}
	for (const cron of snapshot.crons) {
		items.push({
			value: `cron:${cron.id}`,
			label: `cron · ${preview(cron.humanSchedule, 40)}`,
			description: options.safeAttentionReveal ? (cron.recurring ? "recurring" : "one-shot") : preview(cron.prompt),
		});
	}
	return items;
}

type DetailOutputOrOptions = string | JobsOverlayModelOptions;

/**
 * Build the detail-level items for a job. Safe attention reveals intentionally
 * omit monitor output, cron prompts, and cron expressions; direct jobs views
 * retain those fields only after the bounded/redacted preview pass.
 */
export function buildJobDetailItems(
	snapshot: JobsSnapshot,
	ref: JobRef,
	outputOrOptions: DetailOutputOrOptions = "",
	options: JobsOverlayModelOptions = {},
): SelectItem[] {
	const output = typeof outputOrOptions === "string" ? outputOrOptions : "";
	const modelOptions = typeof outputOrOptions === "string" ? options : outputOrOptions;
	const safeAttentionReveal = modelOptions.safeAttentionReveal === true;

	if (!hasJobRef(snapshot, ref)) return [{ value: "back", label: "Back (job no longer present)" }];

	if (ref.kind === "monitor") {
		const monitor = snapshot.monitors.find(m => m.id === ref.id);
		if (!monitor) return [{ value: "back", label: "Back (job no longer present)" }];
		const items: SelectItem[] = [
			{ value: "noop", label: "Status", description: monitor.status },
			{ value: "noop", label: "Label", description: preview(monitor.label) },
			{ value: "noop", label: "Started", description: formatRelative(monitor.startTime) },
		];
		if (!safeAttentionReveal) {
			const lastOutput = output.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "(no output captured)";
			items.push({ value: "noop", label: "Output", description: preview(lastOutput, 80) });
		}
		items.push(
			{ value: "action:cancel", label: "Cancel this monitor", hint: "stops the running job" },
			{ value: "back", label: "Back" },
		);
		return items;
	}

	const cron = snapshot.crons.find(c => c.id === ref.id);
	if (!cron) return [{ value: "back", label: "Back (job no longer present)" }];
	if (safeAttentionReveal) {
		return [
			{ value: "noop", label: "Status", description: cron.firing ? "running" : "waiting" },
			{ value: "noop", label: "Label", description: preview(cron.humanSchedule) },
			{ value: "noop", label: "Recurring", description: cron.recurring ? "yes" : "no" },
			{ value: "noop", label: "Next fire", description: formatRelative(cron.nextFireAt) },
			{ value: "action:delete", label: "Delete this cron", hint: "removes the schedule" },
			{ value: "back", label: "Back" },
		];
	}
	return [
		{
			value: "noop",
			label: "Schedule",
			description: `${preview(cron.humanSchedule)} (${preview(cron.cronExpression)})`,
		},
		{ value: "noop", label: "Recurring", description: cron.recurring ? "yes" : "no" },
		{ value: "noop", label: "Next fire", description: formatRelative(cron.nextFireAt) },
		{ value: "noop", label: "Prompt", description: preview(cron.prompt, 80) },
		{ value: "action:delete", label: "Delete this cron", hint: "removes the schedule" },
		{ value: "back", label: "Back" },
	];
}

/** Yes/No confirm items for a destructive action. */
export function buildConfirmItems(actionLabel: string): SelectItem[] {
	return [
		{ value: "no", label: "No, keep it" },
		{ value: "yes", label: `Yes, ${actionLabel}` },
	];
}
