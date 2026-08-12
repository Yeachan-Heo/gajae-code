import { Container, Ellipsis, type SelectItem, SelectList, Text, truncateToWidth } from "@gajae-code/tui";
import { isTaskRevealRoute, resolveTaskRevealRoute, type TaskRevealRoute } from "../attention-reveal-routing";

import type { TaskRow, TasksSnapshot } from "../tasks-aggregator";

import { getSelectListTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

export type TasksPaneRevealResult = unknown | Promise<unknown>;

export interface TasksPaneCallbacks {
	close(): void;
	requestRender(): void;
	/** Route to an existing owner surface. False/rejection means the route was not accepted. */
	reveal?(route: TaskRevealRoute): TasksPaneRevealResult;
	/** Explicit, awaited failure acknowledgement. Undefined means the owner committed synchronously. */
	acknowledgeFailures?(): unknown | Promise<unknown>;
}

/** Minimal observable task source consumed by the pane; TasksAggregator satisfies this structurally. */
export interface TasksPaneSource {
	getSnapshot(): TasksSnapshot;
	onChange(cb: () => void): () => void;
	acknowledgeFailures(): unknown | Promise<unknown>;
}

type AcknowledgementState = "idle" | "pending" | "acknowledged" | "committed-unconfirmed" | "degraded" | "failed";

const MAX_LABEL_WIDTH = 256;
const SAFE_FAILURE_MESSAGE = "Acknowledgement unavailable · try again";
const SAFE_REVEAL_MESSAGE = "Task reveal unavailable";
const SAFE_STALE_MESSAGE = "Task is no longer available";
const SAFE_ATTENTION_MESSAGE = "Attention history unavailable";

/** A compact, read-only unified task list. Source-specific controls remain in their owners. */
export class TasksPaneComponent extends Container {
	readonly #source: TasksPaneSource;
	readonly #callbacks: TasksPaneCallbacks;
	#selectList: SelectList | undefined;
	#unsubscribe: (() => void) | undefined;
	#disposed = false;
	#operationGeneration = 0;
	#acknowledgementState: AcknowledgementState = "idle";
	#inlineStatus: string | undefined;

	constructor(source: TasksPaneSource, callbacks: TasksPaneCallbacks) {
		super();
		this.#source = source;
		this.#callbacks = callbacks;
		this.#unsubscribe = this.#source.onChange?.(() => this.refresh());
		// Opening the pane is intentionally read-only. Acknowledgement is explicit
		// (`a`) and only becomes visible after its owner receipt settles.
		this.#render();
	}

	override dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#operationGeneration += 1;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#selectList = undefined;
		super.dispose();
	}

	getFocus(): SelectList {
		if (this.#disposed || !this.#selectList) throw new Error("Tasks pane has no focusable list");
		return this.#selectList;
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		if (data.length === 1 && data.toLowerCase() === "a") {
			this.#acknowledgeFailures();
			return;
		}
		// Enter, mouse-backed selection, navigation, and Escape all use the same
		// SelectList callback path. No second keyboard-only routing path exists here.
		this.#selectList?.handleInput(data);
	}

	refresh(): void {
		if (this.#disposed) return;
		if (
			this.#source.getSnapshot().failedUnacknowledged &&
			(this.#acknowledgementState === "acknowledged" ||
				this.#acknowledgementState === "committed-unconfirmed" ||
				this.#acknowledgementState === "degraded")
		) {
			this.#acknowledgementState = "idle";
			this.#inlineStatus = undefined;
		}
		this.#render();
	}

	override render(width: number): string[] {
		return super.render(Math.max(1, width)).map(line => truncateToWidth(line, Math.max(1, width)));
	}

	#render(): void {
		if (this.#disposed) return;
		const rows = this.#source.getSnapshot().rows;

		const rowsById = new Map(rows.map(row => [row.id, row]));
		const items = rows.length > 0 ? rows.map(taskItem) : [{ value: "close", label: "No tasks" }];
		this.clear();
		const status = this.#statusLine();
		if (status) this.addChild(new Text(status, 1, 0));
		this.addChild(new DynamicBorder());
		this.#selectList = new SelectList(items, 12, getSelectListTheme());
		this.#selectList.onSelect = item => {
			if (item.value === "close") {
				this.#callbacks.close();
				return;
			}
			const row = rowsById.get(item.value);
			if (!row) {
				this.#setInlineStatus(SAFE_STALE_MESSAGE);
				return;
			}
			this.#reveal(row);
		};
		this.#selectList.onCancel = () => this.#callbacks.close();
		this.addChild(this.#selectList);
		this.addChild(new DynamicBorder());
		this.#callbacks.requestRender();
	}

	#reveal(row: TaskRow): void {
		const route = resolveTaskRevealRoute(row);
		if (!isTaskRevealRoute(route)) {
			this.#setInlineStatus(SAFE_REVEAL_MESSAGE);
			return;
		}
		const reveal = this.#callbacks.reveal;
		if (!reveal) {
			this.#setInlineStatus(SAFE_REVEAL_MESSAGE);
			return;
		}
		const generation = ++this.#operationGeneration;
		let result: TasksPaneRevealResult;
		try {
			result = reveal(route);
		} catch {
			if (generation === this.#operationGeneration && !this.#disposed) this.#setInlineStatus(SAFE_REVEAL_MESSAGE);
			return;
		}
		if (!isPromiseLike(result)) {
			if (generation !== this.#operationGeneration || this.#disposed) return;
			if (isAcceptedRevealResult(result) && this.#isCurrentRow(row)) this.#callbacks.close();
			else this.#setInlineStatus(this.#isCurrentRow(row) ? SAFE_REVEAL_MESSAGE : SAFE_STALE_MESSAGE);
			return;
		}
		void Promise.resolve(result).then(
			resolved => {
				if (generation !== this.#operationGeneration || this.#disposed) return;
				if (isAcceptedRevealResult(resolved) && this.#isCurrentRow(row)) this.#callbacks.close();
				else this.#setInlineStatus(this.#isCurrentRow(row) ? SAFE_REVEAL_MESSAGE : SAFE_STALE_MESSAGE);
			},
			() => {
				if (generation === this.#operationGeneration && !this.#disposed)
					this.#setInlineStatus(this.#isCurrentRow(row) ? SAFE_REVEAL_MESSAGE : SAFE_STALE_MESSAGE);
			},
		);
	}

	#isCurrentRow(row: TaskRow): boolean {
		return this.#source.getSnapshot().rows.some(candidate => candidate.id === row.id && candidate.kind === row.kind);
	}

	#acknowledgeFailures(): void {
		if (this.#disposed || this.#acknowledgementState === "pending") return;
		const generation = ++this.#operationGeneration;
		this.#acknowledgementState = "pending";
		this.#inlineStatus = undefined;
		this.#render();

		let result: unknown;
		try {
			if (this.#callbacks.acknowledgeFailures) {
				result = this.#callbacks.acknowledgeFailures();
			} else {
				const fallbackResult = this.#source.acknowledgeFailures();

				result = isPromiseLike(fallbackResult)
					? Promise.resolve(fallbackResult).then(receipt => receipt ?? this.#snapshotAcknowledgementReceipt())
					: (fallbackResult ?? this.#snapshotAcknowledgementReceipt());
			}
		} catch {
			this.#settleAcknowledgement(generation, normalizeAcknowledgement(false));
			return;
		}
		if (!isPromiseLike(result)) {
			this.#settleAcknowledgement(generation, normalizeAcknowledgement(result));
			return;
		}
		void Promise.resolve(result).then(
			resolved => this.#settleAcknowledgement(generation, normalizeAcknowledgement(resolved)),
			() => this.#settleAcknowledgement(generation, normalizeAcknowledgement(false)),
		);
	}

	#snapshotAcknowledgementReceipt(): { ok: boolean; status: "ready" | "unavailable" } {
		const failed = this.#source.getSnapshot().failedUnacknowledged;

		return { ok: !failed, status: failed ? "unavailable" : "ready" };
	}

	#settleAcknowledgement(generation: number, outcome: AcknowledgementOutcome): void {
		if (this.#disposed || generation !== this.#operationGeneration) return;
		if (!outcome.ok) {
			this.#acknowledgementState = "failed";
			this.#inlineStatus = undefined;
			this.#render();
			return;
		}
		this.#acknowledgementState = outcome.state;
		this.#inlineStatus = undefined;
		this.#render();
	}

	#setInlineStatus(message: string): void {
		if (this.#disposed) return;
		this.#inlineStatus = message;
		this.#render();
	}

	#statusLine(): string | undefined {
		if (this.#inlineStatus) return theme.fg("warning", this.#inlineStatus);
		switch (this.#acknowledgementState) {
			case "pending":
				return theme.fg("warning", "Acknowledgement pending");
			case "failed":
				return theme.fg("error", SAFE_FAILURE_MESSAGE);
			case "committed-unconfirmed":
				return theme.fg("warning", "Failures acknowledged · commit unconfirmed");
			case "degraded":
				return theme.fg("warning", "Failures acknowledged · degraded");
			case "acknowledged":
				return theme.fg("success", "Failures acknowledged");
			case "idle":
				break;
		}
		const snapshot = this.#source.getSnapshot();
		if (snapshot.failedUnacknowledged) {
			return theme.fg("error", "Failures need acknowledgement · press a");
		}
		const overflowCount = boundedOverflowCount(snapshot.overflowCount);
		if (overflowCount > 0 || snapshot.attentionStatus === "overflow") {
			return theme.fg("warning", `+${Math.max(1, overflowCount)} more tasks`);
		}
		if (snapshot.attentionStatus !== undefined && snapshot.attentionStatus !== "memory_only") {
			return theme.fg("warning", SAFE_ATTENTION_MESSAGE);
		}
		return undefined;
	}
}

function boundedOverflowCount(value: number | undefined): number {
	if (value === undefined || !Number.isSafeInteger(value) || value < 0) return 0;
	return Math.min(value, 500);
}

export function taskItem(row: TaskRow): SelectItem {
	const badge = row.monitorOutputLines === undefined ? "" : ` (${safeLineCount(row.monitorOutputLines)} lines)`;
	const resumable = row.resumable ? " [resumable]" : "";
	return { value: row.id, label: `${statusLabel(row.status)} ${safeTaskLabel(row.label)}${badge}${resumable}` };
}

function statusLabel(status: TaskRow["status"]): string {
	switch (status) {
		case "running":
			return "Running";
		case "waiting":
			return "Waiting";
		case "done":
			return "Done";
		case "failed":
			return "Failed";
		case "cancelled":
			return "Cancelled";
	}
}

function safeTaskLabel(value: string): string {
	const text = typeof value === "string" ? value : "";
	const withoutAnsi = text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu, "");
	const singleLine = withoutAnsi
		.replace(/[\u0000-\u001f\u007f]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	const redacted = singleLine
		.replace(/(?:^|\s)(?:~|\.\.?|\/|[A-Za-z]:[\\/])[^\s]*/gu, " …")
		.replace(/\b(api[_-]?key|authorization|credential|password|secret|token)\s*[:=]\s*[^\s]+/giu, "$1=[redacted]")
		.replace(/\s+/gu, " ")
		.trim();
	return truncateToWidth(redacted, MAX_LABEL_WIDTH, Ellipsis.Omit);
}

function safeLineCount(value: number): number {
	return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 999_999) : 0;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	if (typeof value !== "object" || value === null) return false;
	try {
		return typeof (value as { then?: unknown }).then === "function";
	} catch {
		return false;
	}
}

function isAcceptedRevealResult(value: unknown): boolean {
	return value === true;
}

type AcknowledgementOutcome =
	| { ok: true; state: Exclude<AcknowledgementState, "idle" | "pending" | "failed"> }
	| { ok: false };

function normalizeAcknowledgement(value: unknown): AcknowledgementOutcome {
	if (value === false) return { ok: false };
	if (typeof value !== "object" || value === null) return { ok: true, state: "acknowledged" };
	if (value instanceof Error) return { ok: false };
	try {
		const candidate = value as {
			ok?: unknown;
			accepted?: unknown;
			committed?: unknown;
			kind?: unknown;
			status?: unknown;
			error?: unknown;
		};
		if (candidate.ok === false || candidate.accepted === false || candidate.error !== undefined) return { ok: false };
		const state = `${candidate.kind ?? candidate.status ?? ""}`.toLowerCase().replaceAll("_", "-");
		if (
			state === "failed" ||
			state === "rejected" ||
			state === "unavailable" ||
			state === "write-failed" ||
			state === "invalid-path" ||
			state === "corrupt"
		)
			return { ok: false };
		if (state === "committed-unconfirmed" || candidate.committed === false)
			return { ok: true, state: "committed-unconfirmed" };
		if (state === "degraded") return { ok: true, state: "degraded" };
		return { ok: true, state: "acknowledged" };
	} catch {
		return { ok: false };
	}
}
