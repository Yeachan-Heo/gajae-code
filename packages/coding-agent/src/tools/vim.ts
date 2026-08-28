import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { Component } from "@gajae-code/tui";
import { extractSegments, sliceWithWidth, Text } from "@gajae-code/tui";
import { isEnoent, logger, prompt, untilAborted } from "@gajae-code/utils";
import * as Diff from "diff";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { createLspWritethrough, type FileDiagnosticsResult, type WritethroughCallback, writethroughNoop } from "../lsp";
import { getLanguageFromPath, highlightCode, type Theme } from "../modes/theme/theme";
import vimDescription from "../prompts/tools/vim.md" with { type: "text" };
import { CachedOutputBlock } from "../tui/output-block";
import { renderStatusLine } from "../tui/status-line";
import { VimBuffer } from "../vim/buffer";
import { VimEngine, type VimSaveResult } from "../vim/engine";
import { parseKeySequences } from "../vim/parser";
import {
	buildDetails,
	computeViewport,
	renderVimDetails,
	VIM_DEFAULT_VIEWPORT_LINES,
	VIM_OPEN_VIEWPORT_LINES,
} from "../vim/render";
import type { VimFingerprint, VimKeyToken, VimLoadedFile, VimToolDetails, VimViewportLine } from "../vim/types";
import { VimInputError } from "../vim/types";
import type { ToolSession } from ".";
import { parseArchivePathCandidates } from "./archive-reader";
import { assertEditableFile } from "./auto-generated-guard";
import { isReadableUrlPath } from "./fetch";
import { normalizePathLikeInput, resolveToCwd } from "./path-utils";
import { enforcePlanModeWrite } from "./plan-mode-guard";
import { formatDiagnostics, replaceTabs } from "./render-utils";
import { isSqliteFile, parseSqlitePathCandidates } from "./sqlite-reader";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const INTERNAL_URL_PREFIX = /^(agent|artifact|skill|rule|local|mcp):\/\//;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const vimStepSchema = z.object({
	kbd: z.array(z.string()).describe("vim key sequences"),
	insert: z.string().optional().describe("raw text to insert"),
});

const vimSchema = z.object({
	file: z.string().describe("file path"),
	steps: z.array(vimStepSchema).optional().describe("editing steps"),
	pause: z.boolean().optional().describe("skip auto-save"),
});

type VimParams = z.infer<typeof vimSchema>;
type VimStep = z.infer<typeof vimStepSchema>;

interface VimRenderStep {
	kbd?: string[];
	insert?: string;
}

export interface VimRenderArgs {
	file?: string;
	steps?: VimRenderStep[];
	pause?: boolean;
	__partialJson?: string;
}

function fingerprintEqual(left: VimFingerprint | null, right: VimFingerprint | null): boolean {
	if (left === null || right === null) {
		return left === right;
	}
	return (
		left.exists === right.exists &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.hash === right.hash
	);
}

function renderText(text: string): Component {
	return new Text(replaceTabs(text), 0, 0);
}

function serializeBufferText(buffer: Pick<VimBuffer, "getText" | "trailingNewline">): string {
	return `${buffer.getText()}${buffer.trailingNewline ? "\n" : ""}`;
}

function buildModelDiff(beforeText: string, afterText: string): string | undefined {
	if (beforeText === afterText) {
		return undefined;
	}
	const patch = Diff.structuredPatch("", "", beforeText, afterText, "", "", { context: 3 });
	const diff = patch.hunks
		.flatMap(hunk => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines])
		.join("\n");
	return diff.length > 0 ? diff : undefined;
}

function renderViewportCursor(line: VimViewportLine, styledText: string, uiTheme: Theme): string {
	if (!line.isCursor || line.cursorCol === undefined) {
		return styledText;
	}

	const totalWidth = Bun.stringWidth(line.text);
	const cursorCol = Math.max(0, Math.min(line.cursorCol, totalWidth));
	const cursorSlice = sliceWithWidth(line.text, cursorCol, 1, false);
	const replaceWidth = cursorSlice.width;
	const afterStart = Math.min(totalWidth, cursorCol + replaceWidth);
	const segments = extractSegments(styledText, cursorCol, afterStart, Math.max(0, totalWidth - afterStart), true);
	const cursorText = cursorSlice.text.length > 0 ? cursorSlice.text : " ";
	const invertedCursor = uiTheme.inverse(cursorText);
	const cursorHighlight = invertedCursor === cursorText ? `\x1b[7m${cursorText}\x1b[27m` : invertedCursor;
	return `${segments.before}${cursorHighlight}${segments.after}`;
}

function renderViewportLine(line: VimViewportLine, styledText: string, padWidth: number, uiTheme: Theme): string {
	const marker = line.isCursor ? ">" : line.isSelected ? "*" : "";
	const gutterText = `${marker}${line.line}`.padStart(padWidth + 1, " ");
	const gutterStyled = line.isCursor
		? uiTheme.fg("accent", gutterText)
		: line.isSelected
			? uiTheme.fg("warning", gutterText)
			: uiTheme.fg("dim", gutterText);
	const separator = uiTheme.fg("dim", "│");
	return `${gutterStyled}${separator}${renderViewportCursor(line, styledText, uiTheme)}`;
}

function splitTokensBySequence(kbd: string[]): Array<{ sequence: string; tokens: VimKeyToken[] }> {
	const groups = new Map<number, VimKeyToken[]>();
	for (const token of parseKeySequences(kbd)) {
		const group = groups.get(token.sequenceIndex);
		if (group) {
			group.push(token);
			continue;
		}
		groups.set(token.sequenceIndex, [token]);
	}
	return kbd.map((sequence, sequenceIndex) => ({ sequence, tokens: groups.get(sequenceIndex) ?? [] }));
}

async function executeKeySequences(
	engine: VimEngine,
	groups: Array<{ sequence: string; tokens: VimKeyToken[] }>,
	commandText: string,
	onStep?: () => Promise<void>,
): Promise<void> {
	for (let index = 0; index < groups.length; index += 1) {
		const group = groups[index]!;
		if (group.tokens.length === 0) {
			continue;
		}
		await engine.executeTokens(group.tokens, commandText, onStep);
		if (index < groups.length - 1 && engine.inputMode === "insert") {
			// Roll back partial changes to prevent buffer corruption across calls.
			engine.rollbackPendingInsert();
			const nextSeq = groups[index + 1]?.sequence ?? "";
			const looksLikeText = nextSeq.length > 0 && /\s/.test(nextSeq) && !/^[:/%]/.test(nextSeq);
			let hint =
				"Use the insert field for inserted text, or include <Esc> to return to NORMAL mode before the next kbd entry.";
			if (looksLikeText) {
				hint += ` The next entry (\`${nextSeq.length > 40 ? `${nextSeq.slice(0, 37)}...` : nextSeq}\`) looks like text content — put it in the \`insert\` field instead. For another edit location, add a new \`steps\` entry instead of another kbd entry.`;
			}
			throw new VimInputError(
				`Sequence ${index + 1} (\`${group.sequence}\`) entered INSERT mode — changes rolled back. ${hint}`,
				group.tokens[group.tokens.length - 1],
			);
		}
	}
}

// Module-level cache of the last real vim result so renderCall can reuse that
// viewport while the next tool call is still streaming.
let lastVimDetails: VimToolDetails | undefined;
function buildToolDetailsFromEngine(
	engine: VimEngine,
	viewportLines: number,
	preferredStart?: number,
	closed = false,
	errorLocation?: VimToolDetails["errorLocation"],
	statusMessage?: string,
): VimToolDetails {
	const cursorLine = engine.buffer.cursor.line + 1;
	const cursorCol = engine.buffer.cursor.col + 1;
	const viewport = computeViewport(cursorLine, engine.buffer.lineCount(), viewportLines, preferredStart);
	const details = buildDetails({
		file: engine.buffer.displayPath,
		mode: engine.getPublicMode(),
		cursor: { line: cursorLine, col: cursorCol },
		totalLines: engine.buffer.lineCount(),
		modified: engine.buffer.modified,
		lines: engine.buffer.lines,
		viewport,
		selection: engine.getSelection(),
		lastCommand: engine.lastCommand,
		statusMessage: statusMessage ?? engine.statusMessage,
		pendingInput: engine.getPendingInput(),
		errorLocation,
		closed,
	});
	details.diagnostics = engine.diagnostics;
	return details;
}

function getLastStepInsert(steps: readonly VimStep[] | undefined): string | undefined {
	if (!steps || steps.length === 0) {
		return undefined;
	}
	return steps[steps.length - 1]?.insert;
}

function getNormalizedSteps(steps: VimRenderArgs["steps"]): VimStep[] | undefined {
	if (!Array.isArray(steps)) {
		return undefined;
	}
	return steps.map(step => ({
		kbd: Array.isArray(step?.kbd) ? [...step.kbd] : [],
		...(step?.insert !== undefined ? { insert: step.insert } : {}),
	}));
}

function getStepsForDisplay(args: VimRenderArgs): VimStep[] | undefined {
	const steps = getNormalizedSteps(args.steps);
	if (!steps || steps.length === 0) {
		return steps;
	}

	const partialInsert = extractPartialInsert(args.__partialJson);
	if (partialInsert === undefined) {
		return steps;
	}

	const lastStep = steps[steps.length - 1]!;
	if (lastStep.insert === undefined || partialInsert.length >= lastStep.insert.length) {
		lastStep.insert = partialInsert;
	}
	return steps;
}

function splitInsertIntoChunks(text: string): string[] {
	const maxChunkChars = 32;
	if (text.length <= maxChunkChars) {
		return text.length === 0 ? [] : [text];
	}

	const chunks: string[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + maxChunkChars, text.length);
		if (end < text.length) {
			const lastNewline = text.lastIndexOf("\n", end - 1);
			if (lastNewline >= start) {
				end = lastNewline + 1;
			} else {
				const lastSpace = Math.max(text.lastIndexOf(" ", end - 1), text.lastIndexOf("\t", end - 1));
				if (lastSpace >= start + Math.floor(maxChunkChars / 2)) {
					end = lastSpace + 1;
				}
			}
		}
		if (end <= start) {
			end = Math.min(start + maxChunkChars, text.length);
		}
		chunks.push(text.slice(start, end));
		start = end;
	}
	return chunks;
}

async function applyInsertWithStreaming(
	engine: VimEngine,
	text: string,
	exitInsertMode: boolean,
	onStep?: () => Promise<void>,
): Promise<void> {
	const chunks = splitInsertIntoChunks(text);
	if (chunks.length === 0) {
		await engine.applyLiteralInsert("", exitInsertMode);
		return;
	}

	for (let index = 0; index < chunks.length; index += 1) {
		await engine.applyLiteralInsert(chunks[index]!, exitInsertMode && index === chunks.length - 1);
		await onStep?.();
	}
}

interface ExecuteVimStepsOptions {
	pauseLastStep?: boolean;
	onKbdStep?: () => Promise<void>;
	onInsertStep?: () => Promise<void>;
}

// Auto-reorder line-positioned steps to descending order (bottom-up) when all steps
// are simple `NG<cmd>` patterns and appear in ascending order (top-down). Bottom-up
// ordering is safe for any mix of insert/replace commands because edits at higher
// line numbers never shift lower line numbers.
function autoReorderSteps(steps: readonly VimStep[]): VimStep[] {
	if (steps.length < 2) return [...steps];

	// Match single kbd entry of `<number>G<cmd>` where cmd enters insert mode
	const linePattern = /^(\d+)G(o|O|cc|C|S|s|i|I|a|A)$/;
	const parsed: Array<{ line: number; step: VimStep }> = [];
	for (const step of steps) {
		if (step.kbd.length !== 1) return [...steps];
		const match = step.kbd[0]!.match(linePattern);
		if (!match) return [...steps];
		parsed.push({ line: Number(match[1]), step });
	}

	// Only reorder if steps are in strictly ascending order (top-down, likely a mistake).
	// If already descending, mixed, or equal, the model likely planned the order deliberately.
	for (let i = 1; i < parsed.length; i++) {
		if (parsed[i]!.line <= parsed[i - 1]!.line) {
			return [...steps];
		}
	}

	// Sort by descending line number (bottom-up)
	parsed.sort((a, b) => b.line - a.line);
	logger.debug("vim: auto-reordered steps to bottom-up", {
		original: steps.map(s => s.kbd[0]),
		reordered: parsed.map(p => p.step.kbd[0]),
	});
	return parsed.map(p => p.step);
}

async function executeVimSteps(
	engine: VimEngine,
	steps: readonly VimStep[],
	options: ExecuteVimStepsOptions = {},
): Promise<void> {
	// Auto-reorder ascending line-positioned steps to descending (bottom-up)
	// to prevent line-shift corruption from top-down edits.
	const orderedSteps = autoReorderSteps(steps);
	for (let index = 0; index < orderedSteps.length; index += 1) {
		if (engine.closed) {
			break;
		}

		const step = orderedSteps[index]!;
		const isLast = index === orderedSteps.length - 1;
		const hasKbd = step.kbd.some(sequence => sequence.length > 0);
		const preservePausedState = !hasKbd && step.insert === undefined && isLast && options.pauseLastStep === true;
		if (engine.inputMode === "insert" && (hasKbd || step.insert === undefined) && !preservePausedState) {
			engine.rollbackPendingInsert();
		}

		if (step.kbd.length > 0) {
			const commandText = step.kbd.join(" ");
			const tokenGroups = splitTokensBySequence(step.kbd);
			await executeKeySequences(engine, tokenGroups, commandText, options.onKbdStep);
		}

		if (!engine.closed && step.insert !== undefined && (step.insert.length > 0 || engine.inputMode === "insert")) {
			// Strip trailing newline from insert text — `o`/`O` already create a line boundary,
			// so a trailing \n would produce an unwanted blank line.
			const normalizedInsert = step.insert.endsWith("\n") ? step.insert.slice(0, -1) : step.insert;
			const exitInsertMode = !(isLast && options.pauseLastStep === true);
			await applyInsertWithStreaming(engine, normalizedInsert, exitInsertMode, options.onInsertStep);
		}

		if (!isLast && engine.inputMode === "insert") {
			engine.rollbackPendingInsert();
		}
	}
}

async function statFingerprint(absolutePath: string): Promise<VimFingerprint | null> {
	try {
		const file = Bun.file(absolutePath);
		const stat = await file.stat();
		if (!stat.isFile()) {
			throw new ToolError(`Not a regular file: ${absolutePath}`);
		}
		const bytes = await file.bytes();
		return {
			exists: true,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			hash: String(Bun.hash(bytes)),
		};
	} catch (error) {
		if (isEnoent(error)) {
			return null;
		}
		throw error;
	}
}

async function readTextFile(
	absolutePath: string,
): Promise<{ lines: string[]; trailingNewline: boolean; fingerprint: VimFingerprint | null }> {
	try {
		const file = Bun.file(absolutePath);
		const stat = await file.stat();
		if (!stat.isFile()) {
			throw new ToolError(`Not a regular file: ${absolutePath}`);
		}
		const bytes = await file.bytes();
		for (const byte of bytes) {
			if (byte === 0) {
				throw new ToolError("Edit tool in vim mode only supports UTF-8 text files in v1");
			}
		}
		const text = utf8Decoder.decode(bytes);
		const trailingNewline = text.endsWith("\n");
		const body = trailingNewline ? text.slice(0, -1) : text;
		return {
			lines: body.length === 0 ? [""] : body.split("\n"),
			trailingNewline,
			fingerprint: {
				exists: true,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				hash: String(Bun.hash(bytes)),
			},
		};
	} catch (error) {
		if (isEnoent(error)) {
			return {
				lines: [""],
				trailingNewline: false,
				fingerprint: null,
			};
		}
		if (error instanceof TypeError) {
			throw new ToolError("Edit tool in vim mode only supports UTF-8 text files in v1");
		}
		throw error;
	}
}

function normalizeTargetPath(inputPath: string, cwd: string): { absolutePath: string; displayPath: string } {
	const normalized = normalizePathLikeInput(inputPath);
	if (INTERNAL_URL_PREFIX.test(normalized)) {
		throw new ToolError("Edit tool in vim mode only supports regular filesystem paths in v1");
	}
	if (isReadableUrlPath(normalized)) {
		throw new ToolError("Edit tool in vim mode only supports local filesystem paths in v1");
	}
	if (parseArchivePathCandidates(normalized).some(candidate => candidate.archivePath === normalized)) {
		throw new ToolError("Edit tool in vim mode does not support archive targets in v1");
	}
	if (parseSqlitePathCandidates(normalized).some(candidate => candidate.sqlitePath === normalized)) {
		throw new ToolError("Edit tool in vim mode does not support SQLite targets in v1");
	}
	return {
		absolutePath: resolveToCwd(normalized, cwd),
		displayPath: normalized,
	};
}

export class VimTool implements AgentTool<typeof vimSchema, VimToolDetails> {
	readonly name = "vim";
	readonly label = "Vim";
	readonly description: string;
	readonly parameters = vimSchema;
	readonly concurrency = "exclusive";

	#engines = new Map<string, VimEngine>();
	#writethrough: WritethroughCallback;

	constructor(private readonly session: ToolSession) {
		const enableLsp = session.enableLsp ?? true;
		const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
		const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnWrite");
		this.#writethrough = enableLsp
			? createLspWritethrough(() => session.cwd, {
					enableFormat,
					enableDiagnostics,
					agentDir: () => session.getSessionAgentDir?.() ?? session.settings.getAgentDir(),
				})
			: writethroughNoop;
		this.description = prompt.render(vimDescription);
	}

	async #loadBuffer(targetPath: string): Promise<VimLoadedFile> {
		const { absolutePath, displayPath } = normalizeTargetPath(targetPath, this.session.cwd);
		if (await isSqliteFile(absolutePath)) {
			throw new ToolError("Edit tool in vim mode does not support SQLite targets in v1");
		}
		const loaded = await readTextFile(absolutePath);
		return {
			absolutePath,
			displayPath,
			lines: loaded.lines,
			trailingNewline: loaded.trailingNewline,
			fingerprint: loaded.fingerprint,
		};
	}

	async #beforeMutate(buffer: VimBuffer): Promise<void> {
		enforcePlanModeWrite(this.session, buffer.displayPath, { op: buffer.baseFingerprint ? "update" : "create" });
		if (!buffer.editabilityChecked && buffer.baseFingerprint) {
			await assertEditableFile(buffer.filePath, buffer.displayPath, this.session.settings);
			buffer.editabilityChecked = true;
		}
	}

	async #saveBuffer(buffer: VimBuffer, options?: { force?: boolean }): Promise<VimSaveResult> {
		enforcePlanModeWrite(this.session, buffer.displayPath, { op: buffer.baseFingerprint ? "update" : "create" });
		if (buffer.baseFingerprint) {
			await assertEditableFile(buffer.filePath, buffer.displayPath, this.session.settings);
		}
		if (!options?.force) {
			const diskFingerprint = await statFingerprint(buffer.filePath);
			if (!fingerprintEqual(buffer.baseFingerprint, diskFingerprint)) {
				throw new ToolError("File changed on disk since open; reload with :e! before saving.");
			}
		}
		const content = `${buffer.getText()}${buffer.trailingNewline ? "\n" : ""}`;
		const diagnostics = (await this.#writethrough(buffer.filePath, content)) as FileDiagnosticsResult | undefined;
		const loaded = await this.#loadBuffer(buffer.displayPath);
		return { loaded, diagnostics };
	}

	#renderFromEngine(
		engine: VimEngine,
		viewportLines: number,
		preferredStart?: number,
		closed = false,
		errorLocation?: VimToolDetails["errorLocation"],
		statusMessage?: string,
		modelDiff?: string,
	): AgentToolResult<VimToolDetails> {
		const details = buildToolDetailsFromEngine(
			engine,
			viewportLines,
			preferredStart,
			closed,
			errorLocation,
			statusMessage,
		);
		const resultText = modelDiff ? `${renderVimDetails(details)}\n\nDiff:\n${modelDiff}` : renderVimDetails(details);
		const builder = toolResult<VimToolDetails>(details).text(resultText);
		if (engine.diagnostics) {
			builder.diagnostics(engine.diagnostics.summary, engine.diagnostics.messages ?? []);
		}
		lastVimDetails = details;
		return builder.done();
	}

	#throwWithSnapshot(engine: VimEngine, error: unknown): never {
		const location = error instanceof VimInputError ? error.location : undefined;
		const statusMessage = error instanceof Error ? error.message : String(error);
		const result = this.#renderFromEngine(
			engine,
			VIM_DEFAULT_VIEWPORT_LINES,
			engine.viewportStart,
			engine.closed,
			location,
			statusMessage,
		);
		const text = result.content.find(block => block.type === "text")?.text ?? statusMessage;
		throw new ToolError(text);
	}

	async execute(
		_toolCallId: string,
		params: VimParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<VimToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<VimToolDetails>> {
		return untilAborted(signal, async () => {
			// Resolve file path and get-or-create engine for this buffer
			const { absolutePath } = normalizeTargetPath(params.file, this.session.cwd);
			let engine = this.#engines.get(absolutePath);
			let isNewBuffer = false;
			if (!engine) {
				const loaded = await this.#loadBuffer(params.file);
				engine = new VimEngine(new VimBuffer(loaded), {
					beforeMutate: buffer => this.#beforeMutate(buffer),
					loadBuffer: path => this.#loadBuffer(path),
					saveBuffer: (buffer, options) => this.#saveBuffer(buffer, options),
				});
				engine.viewportStart = 1;
				this.#engines.set(absolutePath, engine);
				isNewBuffer = true;
			} else if (!engine.buffer.modified) {
				// Sync fingerprint from disk to handle LSP writethrough reformats
				const fp = await statFingerprint(absolutePath);
				if (fp) engine.buffer.baseFingerprint = fp;
			}

			const steps = params.steps;
			if (!steps || steps.length === 0) {
				// No steps — just show the file viewport
				if (isNewBuffer) {
					engine.statusMessage = `Opened ${engine.buffer.displayPath}`;
				}
				return this.#renderFromEngine(engine, VIM_OPEN_VIEWPORT_LINES, engine.viewportStart);
			}

			const beforeText = serializeBufferText(engine.buffer);

			if (this.session.getPlanModeState?.()?.enabled) {
				if (steps.some(step => step.insert !== undefined)) {
					throw new ToolError("Plan mode: edit is read-only in vim mode; insert payloads are not allowed.");
				}
				const preview = engine.clone({
					beforeMutate: async () => {
						throw new VimInputError(
							"Plan mode: edit is read-only in vim mode; only navigation, search, open, and close are allowed.",
						);
					},
					saveBuffer: async () => {
						throw new VimInputError("Plan mode: :w is not allowed.");
					},
				});
				await executeVimSteps(preview, steps, { pauseLastStep: params.pause === true });
			}

			try {
				const FRAME_INTERVAL_MS = 16; // ~60fps
				let lastUpdateTime = 0;

				const emitUpdate = onUpdate
					? async (force = false) => {
							const now = Date.now();
							if (!force && now - lastUpdateTime < FRAME_INTERVAL_MS) {
								return; // throttle: skip if too soon
							}
							onUpdate(this.#renderFromEngine(engine, VIM_DEFAULT_VIEWPORT_LINES, engine.viewportStart));
							lastUpdateTime = Date.now();
							await Bun.sleep(FRAME_INTERVAL_MS); // real delay for terminal to render
						}
					: undefined;

				await executeVimSteps(engine, steps, {
					pauseLastStep: params.pause === true,
					onKbdStep: emitUpdate ? () => emitUpdate(true) : undefined,
					onInsertStep: emitUpdate ? () => emitUpdate(true) : undefined,
				});

				if (params.pause === true && !engine.closed && engine.getPendingInput()) {
					engine.statusMessage = engine.statusMessage ?? `Paused in ${engine.getPublicMode()} mode`;
				}
			} catch (error) {
				this.#throwWithSnapshot(engine, error);
			}

			if (beforeText !== serializeBufferText(engine.buffer)) {
				engine.centerViewportOnCursor();
			}

			// Auto-save when buffer was modified
			if (!engine.closed && engine.buffer.modified && params.pause !== true) {
				try {
					const result = await this.#saveBuffer(engine.buffer);
					engine.buffer.markSaved(result.loaded);
					engine.diagnostics = result.diagnostics;
					if (beforeText !== serializeBufferText(engine.buffer)) {
						engine.centerViewportOnCursor();
					}
				} catch (error) {
					this.#throwWithSnapshot(engine, error);
				}
			}

			const afterText = serializeBufferText(engine.buffer);
			const modelDiff = buildModelDiff(beforeText, afterText);

			const result = this.#renderFromEngine(
				engine,
				VIM_DEFAULT_VIEWPORT_LINES,
				engine.viewportStart,
				engine.closed,
				undefined,
				undefined,
				modelDiff,
			);
			if (engine.closed) {
				this.#engines.delete(absolutePath);
			}
			return result;
		});
	}
}

// Unescape JSON string escape sequences from a partial (potentially incomplete) JSON string value.
function unescapePartialJsonString(value: string): string {
	let output = "";
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char !== "\\") {
			output += char;
			continue;
		}
		const next = value[index + 1];
		if (!next) {
			output += "\\";
			break;
		}
		index += 1;
		switch (next) {
			case '"':
			case "\\":
			case "/":
				output += next;
				break;
			case "b":
				output += "\b";
				break;
			case "f":
				output += "\f";
				break;
			case "n":
				output += "\n";
				break;
			case "r":
				output += "\r";
				break;
			case "t":
				output += "\t";
				break;
			case "u": {
				const codePoint = value.slice(index + 1, index + 5);
				if (codePoint.length === 4) {
					const parsed = parseInt(codePoint, 16);
					if (!Number.isNaN(parsed)) {
						output += String.fromCharCode(parsed);
						index += 4;
						continue;
					}
				}
				output += "\\u";
				break;
			}
			default:
				output += `\\${next}`;
		}
	}
	return output;
}

// Extract partial insert text from raw JSON buffer during streaming.
// partial-json often doesn't surface string values until the closing quote is seen.
function extractPartialInsert(partialJson: string | undefined): string | undefined {
	if (!partialJson) {
		return undefined;
	}
	const matches = Array.from(partialJson.matchAll(/"insert"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/gu));
	const match = matches[matches.length - 1];
	if (!match) {
		return undefined;
	}
	return unescapePartialJsonString(match[1]!);
}

function describeStepsForDisplay(args: VimRenderArgs): string {
	const steps = getStepsForDisplay(args);
	if (!steps || steps.length === 0) {
		return "";
	}

	const kbdSummary = steps.map(step => step.kbd.join(" ")).filter(summary => summary.length > 0);
	let description = steps.length === 1 ? (kbdSummary[0] ?? "1 step") : `${steps.length} steps`;
	if (steps.length > 1 && kbdSummary.length > 0) {
		description += ` · ${kbdSummary.join(" → ")}`;
	}

	const insertText = getLastStepInsert(steps);
	if (insertText !== undefined && insertText.length > 0) {
		description += `${description.length > 0 ? " · " : ""}insert: ${insertText}`;
	}
	if (args.pause) {
		description += `${description.length > 0 ? " · " : ""}pause`;
	}
	return description;
}

export function resetVimRendererStateForTest(): void {
	lastVimDetails = undefined;
}

export const vimToolRenderer = {
	renderCall(args: VimRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		if (args.file && (!args.steps || args.steps.length === 0)) {
			return renderText(`${uiTheme.bold("Edit")} open ${args.file}`);
		}

		// Build a description of the streaming args for the header
		const argsDescription = describeStepsForDisplay(args);

		// Reuse the last real vim result for the same file while the next call is still streaming.
		const details = lastVimDetails?.file === args.file ? lastVimDetails : undefined;
		if (details?.viewportLines && details.viewportLines.length > 0) {
			const lang = getLanguageFromPath(details.file);
			const langIcon = uiTheme.getLangIcon(lang);
			const modified = details.modified ? " [+]" : "";
			const position = `L${details.cursor.line}:${details.cursor.col}`;
			const padWidth = String(details.viewport.end).length;
			const viewportLines = details.viewportLines;
			const highlightedLines = highlightCode(viewportLines.map(line => line.text).join("\n"), lang);
			const renderedLines = viewportLines.map((line, index) =>
				renderViewportLine(line, highlightedLines[index] ?? line.text, padWidth, uiTheme),
			);
			if (details.statusMessage) {
				renderedLines.push(uiTheme.fg("dim", details.statusMessage));
			}

			const outputBlock = new CachedOutputBlock();
			let cached: { key: string; result: string[] } | undefined;

			return {
				render: (width: number): string[] => {
					const cacheKey = `${width}|${options.spinnerFrame ?? -1}|${argsDescription}`;
					if (cached?.key === cacheKey) {
						return cached.result;
					}

					const header = renderStatusLine(
						{
							icon: "pending",
							spinnerFrame: options.spinnerFrame,
							title: "Edit",
							description: argsDescription || details.file + modified,
							meta: [`${langIcon} ${details.totalLines} lines`, position],
						},
						uiTheme,
					);

					const lines = outputBlock.render(
						{
							header,
							state: "pending",
							sections: [{ lines: renderedLines }],
							width,
						},
						uiTheme,
					);
					cached = { key: cacheKey, result: lines };
					return lines;
				},
				invalidate: () => {
					cached = undefined;
					outputBlock.invalidate();
				},
			};
		}

		// Fallback: no previous viewport available (first vim call)
		if (argsDescription) {
			return renderText(`${uiTheme.bold("Edit")} ${argsDescription}`);
		}
		return renderText(`${uiTheme.bold("Edit")}`);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: VimToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const details = result.details;
		const isError = result.isError === true;

		// No structured details (e.g. closed): fall back to plain text
		if (!details?.viewportLines || details.viewportLines.length === 0) {
			if (details) {
				return renderText(renderVimDetails(details));
			}
			const text = result.content.find(block => block.type === "text")?.text ?? "";
			return renderText(text);
		}

		const lang = getLanguageFromPath(details.file);
		const langIcon = uiTheme.getLangIcon(lang);
		const modified = details.modified ? " [+]" : "";
		const position = `L${details.cursor.line}:${details.cursor.col}`;
		const padWidth = String(details.viewport.end).length;
		const viewportLines = details.viewportLines;
		const highlightedLines = highlightCode(viewportLines.map(line => line.text).join("\n"), lang);
		const renderedLines = viewportLines.map((line, index) =>
			renderViewportLine(line, highlightedLines[index] ?? line.text, padWidth, uiTheme),
		);
		if (details.statusMessage) {
			renderedLines.push(uiTheme.fg("dim", details.statusMessage));
		}

		const sections: Array<{ label?: string; lines: string[] }> = [{ lines: renderedLines }];
		if (details.diagnostics?.messages && details.diagnostics.messages.length > 0) {
			const diagText = formatDiagnostics(
				{
					errored: isError,
					summary: details.diagnostics.summary,
					messages: details.diagnostics.messages,
				},
				options.expanded,
				uiTheme,
				(filePath: string) => uiTheme.getLangIcon(getLanguageFromPath(filePath)),
			);
			if (diagText) {
				sections.push({ lines: [diagText] });
			}
		}

		const outputBlock = new CachedOutputBlock();
		let cached: { key: string; result: string[] } | undefined;

		return {
			render: (width: number): string[] => {
				const cacheKey = `${width}|${options.isPartial ? 1 : 0}|${isError ? 1 : 0}|${options.spinnerFrame ?? -1}`;
				if (cached?.key === cacheKey) {
					return cached.result;
				}

				const icon = options.isPartial ? "pending" : isError ? "error" : "success";

				// Mode badge
				const modeBadge =
					details.mode === "NORMAL"
						? undefined
						: {
								label: details.mode,
								color:
									details.mode === "INSERT"
										? ("success" as const)
										: details.mode === "VISUAL" || details.mode === "VISUAL-LINE"
											? ("warning" as const)
											: ("accent" as const),
							};

				const header = renderStatusLine(
					{
						icon,
						spinnerFrame: options.spinnerFrame,
						title: "Edit",
						description: details.file + modified,
						badge: modeBadge,
						meta: [`${langIcon} ${details.totalLines} lines`, position],
					},
					uiTheme,
				);

				const lines = outputBlock.render(
					{
						header,
						state: options.isPartial ? "pending" : isError ? "error" : "success",
						sections,
						width,
					},
					uiTheme,
				);
				cached = { key: cacheKey, result: lines };
				return lines;
			},
			invalidate: () => {
				cached = undefined;
				outputBlock.invalidate();
			},
		};
	},
	mergeCallAndResult: true,
};

export { vimSchema };
