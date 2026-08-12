/** Deterministic visual capture for the production TasksPaneComponent. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { type TasksPaneCallbacks, TasksPaneComponent, type TasksPaneSource } from "../src/modes/components/tasks-pane";
import type { TaskRow, TasksSnapshot } from "../src/modes/tasks-aggregator";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";

export const ATTENTION_WORKSPACE_VISUAL_CAPTURE_SCHEMA = "gjc.attention.workspace.visual-capture";
export const ATTENTION_WORKSPACE_VISUAL_CAPTURE_VERSION = 1;
export const ATTENTION_WORKSPACE_VISUAL_CAPTURE_COUNT = 48;
export const ATTENTION_WORKSPACE_CAPTURE_TIMESTAMP = "1970-01-01T00:00:00.000Z";
export const ATTENTION_WORKSPACE_CAPTURE_LOCALE = "en-US";
export const ATTENTION_WORKSPACE_CAPTURE_TIMEZONE = "UTC";
export const ATTENTION_WORKSPACE_CAPTURE_SEED = "g004-attention-workspace-seed-v1";
export const ATTENTION_WORKSPACE_CAPTURE_THEME = "red-claw";
export const ATTENTION_WORKSPACE_CAPTURE_DEFAULT_OUTPUT = ".gjc/qa/G004-attention-workspace";
export const ATTENTION_WORKSPACE_CAPTURE_DEFAULT_REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

export const ATTENTION_WORKSPACE_SOURCE_CLOSURE_FILES: readonly string[] = Object.freeze([
	"packages/coding-agent/src/modes/components/tasks-pane.ts",
	"packages/coding-agent/src/modes/components/dynamic-border.ts",
	"packages/coding-agent/src/modes/tasks-aggregator.ts",
	"packages/coding-agent/src/modes/attention-event-store.ts",
	"packages/coding-agent/src/modes/attention-reveal-routing.ts",
	"packages/coding-agent/src/modes/theme/theme.ts",
	"packages/coding-agent/src/modes/theme/defaults/index.ts",
	"packages/coding-agent/src/modes/theme/defaults/red-claw.json",
	"packages/coding-agent/scripts/capture-attention-workspace-showcase.ts",
	"packages/coding-agent/scripts/verify-attention-workspace-showcase.ts",
	"packages/coding-agent/test/attention-workspace-visual-capture.test.ts",
	"packages/coding-agent/test/attention-tasks-pane-source.test.ts",
]);

export const ATTENTION_WORKSPACE_CAPTURE_FILES: readonly string[] = Object.freeze([
	"terminal.txt",
	"terminal-ansi.txt",
	"terminal.html",
	"metadata.json",
	"manifest.json",
]);

export type AttentionStateId =
	| "empty"
	| "running-bash"
	| "waiting-cron"
	| "failed-unack"
	| "failed-ack"
	| "done"
	| "cancelled"
	| "reveal-bash"
	| "reveal-cron"
	| "reveal-unavailable"
	| "reveal-stale"
	| "reveal-failed"
	| "ack-pending"
	| "ack-failed"
	| "cjk-long"
	| "no-color-disposed";

export const ATTENTION_STATE_IDS: readonly AttentionStateId[] = Object.freeze([
	"empty",
	"running-bash",
	"waiting-cron",
	"failed-unack",
	"failed-ack",
	"done",
	"cancelled",
	"reveal-bash",
	"reveal-cron",
	"reveal-unavailable",
	"reveal-stale",
	"reveal-failed",
	"ack-pending",
	"ack-failed",
	"cjk-long",
	"no-color-disposed",
]);

export type AttentionViewport = Readonly<{
	id: "80x24" | "120x36" | "160x48";
	columns: 80 | 120 | 160;
	rows: 24 | 36 | 48;
}>;

export const ATTENTION_VIEWPORTS: readonly AttentionViewport[] = Object.freeze([
	Object.freeze({ id: "80x24", columns: 80, rows: 24 }),
	Object.freeze({ id: "120x36", columns: 120, rows: 36 }),
	Object.freeze({ id: "160x48", columns: 160, rows: 48 }),
]);

export type AttentionWorkspaceSourceClosure = Readonly<{
	files: readonly string[];
	sha256: string;
}>;

type AttentionFlags = Readonly<{
	noColor: boolean;
	cjk: boolean;
	disposal: boolean;
}>;

type AttentionRenderTrace = Readonly<{
	component: "TasksPaneComponent";
	theme: typeof ATTENTION_WORKSPACE_CAPTURE_THEME;
	productionRender: true;
	noColorDisposition: "ansi_stripped" | "native_color";
	beforeInteractionSha256: string;
	afterInteractionSha256: string;
	interactionChanged: boolean;
	postDisposalSha256: string | null;
	postDisposalChanged: boolean;
}>;

export type AttentionWorkspaceCaptureEntry = Readonly<{
	key: string;
	stateId: AttentionStateId;
	semanticStateId: AttentionStateId;
	semanticDetailHash: string;
	viewport: AttentionViewport;
	flags: AttentionFlags;
	lineStart: number;
	lineCount: number;
	lineWidths: readonly number[];
	plainSha256: string;
	ansiSha256: string;
	productionRender: true;
	component: "TasksPaneComponent";
	theme: typeof ATTENTION_WORKSPACE_CAPTURE_THEME;
	renderTrace: AttentionRenderTrace;
	renderTraceHash: string;
	actions: readonly string[];
}>;

export type AttentionCaptureMetadata = Readonly<{
	schema: typeof ATTENTION_WORKSPACE_VISUAL_CAPTURE_SCHEMA;
	version: typeof ATTENTION_WORKSPACE_VISUAL_CAPTURE_VERSION;
	sourceHash: string;
	captureTimestamp: string;
	locale: typeof ATTENTION_WORKSPACE_CAPTURE_LOCALE;
	timezone: typeof ATTENTION_WORKSPACE_CAPTURE_TIMEZONE;
	seed: typeof ATTENTION_WORKSPACE_CAPTURE_SEED;
	theme: typeof ATTENTION_WORKSPACE_CAPTURE_THEME;
	sourceClosure: AttentionWorkspaceSourceClosure;
	expectedKeyCount: typeof ATTENTION_WORKSPACE_VISUAL_CAPTURE_COUNT;
	keys: readonly string[];
	entries: readonly AttentionWorkspaceCaptureEntry[];
	hashes: Readonly<Record<"terminal.txt" | "terminal-ansi.txt" | "terminal.html", string>>;
}>;

export type AttentionCaptureManifest = Readonly<{
	schema: typeof ATTENTION_WORKSPACE_VISUAL_CAPTURE_SCHEMA;
	version: typeof ATTENTION_WORKSPACE_VISUAL_CAPTURE_VERSION;
	sourceHash: string;
	sourceClosure: AttentionWorkspaceSourceClosure;
	expectedKeyCount: typeof ATTENTION_WORKSPACE_VISUAL_CAPTURE_COUNT;
	keys: readonly string[];
	files: Readonly<
		Record<
			"terminal.txt" | "terminal-ansi.txt" | "terminal.html" | "metadata.json",
			Readonly<{ sha256: string; byteLength: number }>
		>
	>;
	entries: readonly AttentionWorkspaceCaptureEntry[];
}>;

export type AttentionCaptureOptions = Readonly<{
	repoRoot?: string;
	sourceHash?: string;
	timestamp?: string;
}>;

const hash = (value: string | Uint8Array): string => {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(value);
	return hasher.digest("hex");
};
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const ATTENTION_WORKSPACE_VISUAL_KEYS = Object.freeze(
	ATTENTION_STATE_IDS.flatMap(stateId => ATTENTION_VIEWPORTS.map(viewport => `${stateId}/${viewport.id}`)),
);

if (
	ATTENTION_STATE_IDS.length !== 16 ||
	ATTENTION_VIEWPORTS.length !== 3 ||
	ATTENTION_WORKSPACE_VISUAL_KEYS.length !== 48
) {
	throw new Error("Attention workspace visual capture matrix must contain exactly 48 keys.");
}

function safeSourceHash(value: string | undefined, fallback: string): string {
	const candidate = value?.trim() || fallback;
	if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(candidate)) throw new Error("Invalid attention source hash.");
	return candidate;
}

function safeTimestamp(value: string | undefined): string {
	const candidate = value?.trim() || ATTENTION_WORKSPACE_CAPTURE_TIMESTAMP;
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(candidate))
		throw new Error("Invalid attention capture timestamp.");
	return candidate;
}

export async function computeAttentionSourceClosure(
	repoRootInput: string = ATTENTION_WORKSPACE_CAPTURE_DEFAULT_REPO_ROOT,
): Promise<AttentionWorkspaceSourceClosure> {
	const repoRoot = path.resolve(repoRootInput);
	const hasher = new Bun.CryptoHasher("sha256");
	for (const relativePath of ATTENTION_WORKSPACE_SOURCE_CLOSURE_FILES) {
		hasher.update(relativePath);
		hasher.update("\0");
		try {
			hasher.update(await fs.readFile(path.join(repoRoot, relativePath)));
		} catch {
			throw new Error(`Attention source closure file unavailable: ${relativePath}`);
		}
	}
	return Object.freeze({ files: ATTENTION_WORKSPACE_SOURCE_CLOSURE_FILES, sha256: hasher.digest("hex") });
}

function row(kind: TaskRow["kind"], id: string, label: string, status: TaskRow["status"]): TaskRow {
	return Object.freeze({ kind, id, label, status, startedAt: 1 });
}

function worstState(rows: readonly TaskRow[]): TasksSnapshot["worstState"] {
	const rank: Record<TaskRow["status"], number> = {
		done: 1,
		cancelled: 2,
		waiting: 3,
		running: 4,
		failed: 5,
	};
	let worst: TaskRow["status"] | undefined;
	for (const candidate of rows) {
		if (worst === undefined || rank[candidate.status] > rank[worst]) worst = candidate.status;
	}
	return worst ?? "none";
}

function snapshot(rows: readonly TaskRow[], failedUnacknowledged: boolean): TasksSnapshot {
	const frozenRows: TaskRow[] = rows.map(candidate => Object.freeze({ ...candidate }));
	Object.freeze(frozenRows);
	return Object.freeze({ rows: frozenRows, worstState: worstState(frozenRows), failedUnacknowledged });
}

type AcknowledgementReceipt = Readonly<{
	ok: boolean;
	status: "ready" | "unavailable";
	changed: boolean;
}>;

type AcknowledgementMode = "ready" | "pending" | "failed";

interface FixtureSource extends TasksPaneSource {
	setSnapshot(next: TasksSnapshot): void;
	resolveAcknowledgement(): void;
}

function createFixtureSource(initial: TasksSnapshot, acknowledgement: AcknowledgementMode = "ready"): FixtureSource {
	let current = initial;
	const listeners = new Set<() => void>();
	let resolvePending: (() => void) | undefined;
	const notify = (): void => {
		for (const listener of listeners) listener();
	};
	return {
		getSnapshot: () => current,
		onChange: listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		acknowledgeFailures: (): Promise<AcknowledgementReceipt> => {
			if (acknowledgement === "pending") {
				return new Promise(resolve => {
					resolvePending = () => resolve({ ok: true, status: "ready", changed: true });
				});
			}
			if (acknowledgement === "failed") return Promise.resolve({ ok: false, status: "unavailable", changed: false });
			if (!current.failedUnacknowledged) return Promise.resolve({ ok: true, status: "ready", changed: false });
			current = snapshot(current.rows, false);
			notify();
			return Promise.resolve({ ok: true, status: "ready", changed: true });
		},
		setSnapshot: next => {
			current = next;
			notify();
		},
		resolveAcknowledgement: () => {
			const resolve = resolvePending;
			resolvePending = undefined;
			resolve?.();
		},
	};
}

function sourceFor(stateId: AttentionStateId): FixtureSource {
	switch (stateId) {
		case "empty":
			return createFixtureSource(snapshot([], false));
		case "running-bash":
			return createFixtureSource(snapshot([row("bash", "bash:running", "Build service", "running")], false));
		case "waiting-cron":
			return createFixtureSource(snapshot([row("cron", "cron:waiting", "Nightly schedule", "waiting")], false));
		case "failed-unack":
			return createFixtureSource(snapshot([row("bash", "bash:failed", "Compile failure", "failed")], true));
		case "failed-ack":
			return createFixtureSource(snapshot([row("bash", "bash:failed-ack", "Recovered compile", "failed")], false));
		case "done":
			return createFixtureSource(snapshot([row("bash", "bash:done", "Finished build", "done")], false));
		case "cancelled":
			return createFixtureSource(snapshot([row("bash", "bash:cancelled", "Cancelled build", "cancelled")], false));
		case "reveal-bash":
			return createFixtureSource(snapshot([row("bash", "bash:bg_1", "Background shell", "running")], false));
		case "reveal-cron":
			return createFixtureSource(snapshot([row("cron", "cron:cron_1", "Nightly schedule", "waiting")], false));
		case "reveal-unavailable":
			return createFixtureSource(
				snapshot([row("subagent", "subagent:worker", "Unavailable worker", "waiting")], false),
			);
		case "reveal-stale":
			return createFixtureSource(snapshot([row("bash", "bash:stale", "Stale shell", "running")], false));
		case "reveal-failed":
			return createFixtureSource(snapshot([row("cron", "cron:failed", "Unavailable schedule", "waiting")], false));
		case "ack-pending":
			return createFixtureSource(
				snapshot([row("bash", "bash:pending", "Pending acknowledgement", "failed")], true),
				"pending",
			);
		case "ack-failed":
			return createFixtureSource(
				snapshot([row("bash", "bash:ack-failure", "Acknowledgement failure", "failed")], true),
				"failed",
			);
		case "cjk-long":
			return createFixtureSource(
				snapshot(
					[
						row(
							"subagent",
							"subagent:cjk",
							"研究者 · 日本語 · 한국어 · long-width evidence ".repeat(8),
							"waiting",
						),
					],
					false,
				),
			);
		case "no-color-disposed":
			return createFixtureSource(
				snapshot([row("bash", "bash:dispose", "Dispose preview", "running")], false),
				"pending",
			);
	}
}

function flagsFor(stateId: AttentionStateId): AttentionFlags {
	return Object.freeze({
		noColor: stateId === "no-color-disposed",
		cjk: stateId === "cjk-long",
		disposal: stateId === "no-color-disposed",
	});
}

function frameFor(
	pane: TasksPaneComponent,
	viewport: AttentionViewport,
	noColor: boolean,
): Readonly<{ ansi: string[]; plain: string[] }> {
	const rendered = pane.render(viewport.columns);
	const ansi = noColor ? rendered.map(line => Bun.stripANSI(line)) : [...rendered];
	return Object.freeze({ ansi, plain: ansi.map(line => Bun.stripANSI(line)) });
}

type RevealCallback = NonNullable<TasksPaneCallbacks["reveal"]>;

function revealCallback(stateId: AttentionStateId, source: FixtureSource): RevealCallback {
	return route => {
		switch (stateId) {
			case "reveal-bash":
			case "reveal-cron":
				return Promise.resolve({
					ok: route.kind === "jobs",
					status: route.kind === "jobs" ? "ready" : "unavailable",
				});
			case "reveal-stale":
				source.setSnapshot(snapshot([], false));
				return Promise.resolve({ ok: true, status: "ready" });
			case "reveal-failed":
				return Promise.reject(new Error("owner reveal failed"));
			default:
				return false;
		}
	};
}

interface CaptureHarness {
	pane: TasksPaneComponent;
	terminal: VirtualTerminal;
	tui: TUI;
	source: FixtureSource;
	dispose(): void;
}

async function createHarness(viewport: AttentionViewport, stateId: AttentionStateId): Promise<CaptureHarness> {
	const installedTheme = await getThemeByName(ATTENTION_WORKSPACE_CAPTURE_THEME);
	if (!installedTheme) throw new Error("Attention showcase red-claw theme is unavailable.");
	setThemeInstance(installedTheme);
	const source = sourceFor(stateId);
	const pane = new TasksPaneComponent(source, {
		close: () => {},
		requestRender: () => {},
		reveal: revealCallback(stateId, source),
	});
	const terminal = new VirtualTerminal(viewport.columns, viewport.rows, { isProcessTerminal: true });
	const tui = new TUI(terminal, false, { widthSettleMs: 0 });
	tui.addChild(pane);
	tui.setFocus(pane);
	tui.start();
	await terminal.waitForRender();
	return {
		pane,
		terminal,
		tui,
		source,
		dispose: () => {
			pane.dispose();
			tui.stop();
		},
	};
}

async function settle(harness: CaptureHarness): Promise<void> {
	await Promise.resolve();
	await Bun.sleep(0);
	await harness.terminal.waitForRender();
}

function shouldReveal(stateId: AttentionStateId): boolean {
	return (
		stateId === "reveal-bash" ||
		stateId === "reveal-cron" ||
		stateId === "reveal-unavailable" ||
		stateId === "reveal-stale" ||
		stateId === "reveal-failed"
	);
}

function actionForState(stateId: AttentionStateId): string {
	switch (stateId) {
		case "reveal-bash":
			return "reveal:bash-owner";
		case "reveal-cron":
			return "reveal:cron-owner";
		case "reveal-unavailable":
			return "reveal:unavailable";
		case "reveal-stale":
			return "reveal:stale";
		case "reveal-failed":
			return "reveal:failed";
		default:
			return "reveal:unavailable";
	}
}

async function renderState(
	stateId: AttentionStateId,
	viewport: AttentionViewport,
): Promise<
	Readonly<{
		plain: string[];
		ansi: string[];
		flags: AttentionFlags;
		renderTrace: AttentionRenderTrace;
		renderTraceHash: string;
		semanticDetailHash: string;
		actions: readonly string[];
	}>
> {
	const flags = flagsFor(stateId);
	const harness = await createHarness(viewport, stateId);
	const actions: string[] = ["render:TasksPaneComponent"];
	try {
		if (stateId === "no-color-disposed") {
			harness.pane.handleInput("a");
			actions.push("keyboard:a", "ack:pending");
		}
		const before = frameFor(harness.pane, viewport, flags.noColor);
		const beforeHash = hash(before.ansi.join("\n"));
		if (shouldReveal(stateId)) {
			harness.pane.getFocus().handleInput("\n");
			actions.push("keyboard:Enter", actionForState(stateId));
			await settle(harness);
		}
		if (stateId === "empty") {
			harness.pane.handleInput("\x1b");
			actions.push("keyboard:Escape");
			await settle(harness);
		}
		if (stateId === "ack-pending" || stateId === "ack-failed") {
			harness.pane.handleInput("a");
			actions.push("keyboard:a", stateId === "ack-pending" ? "ack:pending" : "ack:failure");
			if (stateId !== "ack-pending") await settle(harness);
		}
		const after = frameFor(harness.pane, viewport, flags.noColor);
		const afterHash = hash(after.ansi.join("\n"));
		let postDisposalSha256: string | null = null;
		let postDisposalChanged = false;
		if (flags.disposal) {
			harness.pane.dispose();
			actions.push("disposal:TasksPaneComponent");
			harness.source.setSnapshot(harness.source.getSnapshot());
			harness.source.resolveAcknowledgement();
			actions.push("late-callback:ignored");
			await settle(harness);
			const postDisposal = frameFor(harness.pane, viewport, flags.noColor);
			postDisposalSha256 = hash(postDisposal.ansi.join("\n"));
			postDisposalChanged = postDisposalSha256 !== afterHash;
		}
		const renderTrace: AttentionRenderTrace = {
			component: "TasksPaneComponent",
			theme: ATTENTION_WORKSPACE_CAPTURE_THEME,
			productionRender: true,
			noColorDisposition: flags.noColor ? "ansi_stripped" : "native_color",
			beforeInteractionSha256: beforeHash,
			afterInteractionSha256: afterHash,
			interactionChanged: beforeHash !== afterHash,
			postDisposalSha256,
			postDisposalChanged,
		};
		const renderTraceHash = hash(JSON.stringify(renderTrace));
		const semantic = hash(`${stateId}\0${after.plain.join("\n")}`);
		return Object.freeze({
			plain: after.plain,
			ansi: after.ansi,
			flags,
			renderTrace,
			renderTraceHash,
			semanticDetailHash: semantic,
			actions,
		});
	} finally {
		harness.source.resolveAcknowledgement();
		harness.dispose();
	}
}

function htmlEscape(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function ansiToHtml(value: string): string {
	let body = "";
	let offset = 0;
	let color: string | undefined;
	for (const match of value.matchAll(/\x1b\[([0-9;]*)m/gu)) {
		body += htmlEscape(value.slice(offset, match.index));
		offset = (match.index ?? 0) + match[0].length;
		const token = match[1] ?? "0";
		if (token === "0" || token === "39") {
			if (color) body += "</span>";
			color = undefined;
			continue;
		}
		const rgb = token.match(/^38;2;(\d+);(\d+);(\d+)$/u);
		if (rgb) {
			if (color) body += "</span>";
			color = `color:rgb(${rgb[1]},${rgb[2]},${rgb[3]})`;
			body += `<span style="${color}">`;
		}
	}
	body += htmlEscape(value.slice(offset));
	if (color) body += "</span>";
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><title>Attention workspace showcase</title><style>body{margin:0;background:#110b0b;color:#ffe7dc}pre{margin:0;padding:1em;white-space:pre;font-family:ui-monospace,monospace}</style></head><body><pre>${body}</pre></body></html>\n`;
}

function entryFor(
	stateId: AttentionStateId,
	viewport: AttentionViewport,
	lineStart: number,
	rendered: Awaited<ReturnType<typeof renderState>>,
): AttentionWorkspaceCaptureEntry {
	return Object.freeze({
		key: `${stateId}/${viewport.id}`,
		stateId,
		semanticStateId: stateId,
		semanticDetailHash: rendered.semanticDetailHash,
		viewport,
		flags: rendered.flags,
		lineStart,
		lineCount: rendered.plain.length,
		lineWidths: rendered.plain.map(line => Bun.stringWidth(line)),
		plainSha256: hash(rendered.plain.join("\n")),
		ansiSha256: hash(rendered.ansi.join("\n")),
		productionRender: true,
		component: "TasksPaneComponent",
		theme: ATTENTION_WORKSPACE_CAPTURE_THEME,
		renderTrace: rendered.renderTrace,
		renderTraceHash: rendered.renderTraceHash,
		actions: rendered.actions,
	});
}

export async function captureAttentionWorkspaceShowcase(
	outputRootInput: string = ATTENTION_WORKSPACE_CAPTURE_DEFAULT_OUTPUT,
	options: AttentionCaptureOptions = {},
): Promise<AttentionCaptureManifest> {
	const outputRoot = path.resolve(outputRootInput);
	const sourceClosure = await computeAttentionSourceClosure(options.repoRoot);
	const sourceHash = safeSourceHash(options.sourceHash, sourceClosure.sha256);
	const captureTimestamp = safeTimestamp(options.timestamp);
	const plainLines: string[] = [];
	const ansiLines: string[] = [];
	const entries: AttentionWorkspaceCaptureEntry[] = [];
	for (const stateId of ATTENTION_STATE_IDS) {
		for (const viewport of ATTENTION_VIEWPORTS) {
			const rendered = await renderState(stateId, viewport);
			const lineStart = plainLines.length;
			plainLines.push(...rendered.plain);
			ansiLines.push(...rendered.ansi);
			entries.push(entryFor(stateId, viewport, lineStart, rendered));
		}
	}
	const terminalText = `${plainLines.join("\n")}\n`;
	const terminalAnsiText = `${ansiLines.join("\n")}\n`;
	const terminalHtml = ansiToHtml(terminalAnsiText);
	const metadata: AttentionCaptureMetadata = {
		schema: ATTENTION_WORKSPACE_VISUAL_CAPTURE_SCHEMA,
		version: ATTENTION_WORKSPACE_VISUAL_CAPTURE_VERSION,
		sourceHash,
		captureTimestamp,
		locale: ATTENTION_WORKSPACE_CAPTURE_LOCALE,
		timezone: ATTENTION_WORKSPACE_CAPTURE_TIMEZONE,
		seed: ATTENTION_WORKSPACE_CAPTURE_SEED,
		theme: ATTENTION_WORKSPACE_CAPTURE_THEME,
		sourceClosure,
		expectedKeyCount: ATTENTION_WORKSPACE_VISUAL_CAPTURE_COUNT,
		keys: ATTENTION_WORKSPACE_VISUAL_KEYS,
		entries,
		hashes: {
			"terminal.txt": hash(terminalText),
			"terminal-ansi.txt": hash(terminalAnsiText),
			"terminal.html": hash(terminalHtml),
		},
	};
	const metadataText = json(metadata);
	const files: AttentionCaptureManifest["files"] = {
		"terminal.txt": { sha256: hash(terminalText), byteLength: Buffer.byteLength(terminalText) },
		"terminal-ansi.txt": { sha256: hash(terminalAnsiText), byteLength: Buffer.byteLength(terminalAnsiText) },
		"terminal.html": { sha256: hash(terminalHtml), byteLength: Buffer.byteLength(terminalHtml) },
		"metadata.json": { sha256: hash(metadataText), byteLength: Buffer.byteLength(metadataText) },
	};
	const manifest: AttentionCaptureManifest = Object.freeze({
		schema: ATTENTION_WORKSPACE_VISUAL_CAPTURE_SCHEMA,
		version: ATTENTION_WORKSPACE_VISUAL_CAPTURE_VERSION,
		sourceHash,
		sourceClosure,
		expectedKeyCount: ATTENTION_WORKSPACE_VISUAL_CAPTURE_COUNT,
		keys: ATTENTION_WORKSPACE_VISUAL_KEYS,
		files,
		entries,
	});
	await fs.mkdir(outputRoot, { recursive: true });
	await Promise.all([
		Bun.write(path.join(outputRoot, "terminal.txt"), terminalText),
		Bun.write(path.join(outputRoot, "terminal-ansi.txt"), terminalAnsiText),
		Bun.write(path.join(outputRoot, "terminal.html"), terminalHtml),
		Bun.write(path.join(outputRoot, "metadata.json"), metadataText),
		Bun.write(path.join(outputRoot, "manifest.json"), json(manifest)),
	]);
	return manifest;
}

function parseCaptureArgs(args: readonly string[]): AttentionCaptureOptions & { outputRoot: string } {
	let outputRoot = ATTENTION_WORKSPACE_CAPTURE_DEFAULT_OUTPUT;
	let repoRoot = ATTENTION_WORKSPACE_CAPTURE_DEFAULT_REPO_ROOT;
	let sourceHash: string | undefined;
	let timestamp: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--output" || arg === "--out") outputRoot = args[index + 1] ?? outputRoot;
		else if (arg === "--source-hash") sourceHash = args[index + 1];
		else if (arg === "--timestamp") timestamp = args[index + 1];
		else if (arg === "--repo-root") repoRoot = args[index + 1] ?? repoRoot;
		else throw new Error("Invalid attention workspace showcase arguments.");
		index += 1;
	}
	return { outputRoot, repoRoot, sourceHash, timestamp };
}

if (import.meta.main) {
	const parsed = parseCaptureArgs(process.argv.slice(2));
	const manifest = await captureAttentionWorkspaceShowcase(parsed.outputRoot, parsed);
	process.stdout.write(`Captured ${manifest.keys.length} attention workspace visual keys.\n`);
}
