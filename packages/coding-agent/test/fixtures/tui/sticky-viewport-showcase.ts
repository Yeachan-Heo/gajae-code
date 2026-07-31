import { Agent } from "@gajae-code/agent-core";
import { Text } from "@gajae-code/tui";
import { TempDir } from "@gajae-code/utils";
import chalk from "chalk";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";
import { ModelRegistry } from "../../../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";
import { computeIrcWorkLaneWidths } from "../../../src/modes/components/irc-sidebar";
import { InteractiveMode } from "../../../src/modes/interactive-mode";
import { initTheme } from "../../../src/modes/theme/theme";
import { AgentSession } from "../../../src/session/agent-session";
import { AuthStorage } from "../../../src/session/auth-storage";
import { SessionManager } from "../../../src/session/session-manager";

export const STICKY_VIEWPORT_SHOWCASE_KEYS = [
	"live-overflow/80x24/unicode-color",
	"live-overflow/120x36/unicode-color",
	"manual-history/80x24/unicode-color",
	"manual-history/120x36/unicode-color",
	"manual-new-output/80x24/unicode-color",
	"manual-new-output/120x36/unicode-color",
	"multiline-editor-hooks-pet/80x24/unicode-color",
	"multiline-editor-hooks-pet/120x36/unicode-color",
	"capacity-many/80x24/unicode-color",
	"capacity-many/120x36/unicode-color",
	"capacity-one/80x24/unicode-color",
	"capacity-one/120x36/unicode-color",
	"capacity-zero/80x24/unicode-color",
	"capacity-zero/120x36/unicode-color",
	"selection-boundary/80x24/unicode-color",
	"selection-boundary/120x36/unicode-color",
	"manual-new-output/80x24/ascii-no-color",
	"capacity-zero/48x10/ascii-no-color",
	"multiline-editor-hooks-pet/48x10/unicode-color",
	"narrow-cjk/48x10/unicode-color",
] as const;
export type StickyViewportShowcaseKey = (typeof STICKY_VIEWPORT_SHOWCASE_KEYS)[number];
export type StickyViewportShowcaseEntry = {
	key: StickyViewportShowcaseKey;
	stateId: string;
	viewport: { id: string; columns: number; rows: number };
	renderMode: "unicode-color" | "ascii-no-color";
};
export type StickyViewportShowcaseRender = {
	terminalText: string;
	terminalAnsiText: string;
	sourceRevision: string;
	outputRevision: string;
	cjkPhraseBoundaries: readonly string[];
	state: Record<string, unknown>;
};
export const STICKY_VIEWPORT_SHOWCASE_ENTRIES: readonly StickyViewportShowcaseEntry[] =
	STICKY_VIEWPORT_SHOWCASE_KEYS.map(key => {
		const [stateId, id, renderMode] = key.split("/") as [string, string, "unicode-color" | "ascii-no-color"];
		const [columns, rows] = id.split("x").map(Number) as [number, number];
		return { key, stateId, viewport: { id, columns, rows }, renderMode };
	});
export const STICKY_VIEWPORT_SHOWCASE_COVERAGE = {
	irc: ["empty", "streaming", "long"],
	todo: ["empty", "populated", "long", "multi-phase", "collapsed", "expanded"],
	widths: [64, 65, 80, 120, 160, 120, 80, 65, 64],
	heights: ["short", "standard"],
	viewport: ["manual", "follow", "resize-grow", "resize-shrink"],
	chrome: ["pending", "statusContainer", "btw", "statusLine", "hooks", "editor", "pet"],
	evidence: ["overlap", "width-overflow", "hidden-cursor-focus", "anchor-loss", "cjk-semantic-break"],
} as const;
const PROBES = [
	{ columns: 64, rows: 10 },
	{ columns: 65, rows: 10 },
	{ columns: 80, rows: 24 },
	{ columns: 120, rows: 36 },
	{ columns: 160, rows: 48 },
	{ columns: 120, rows: 36 },
	{ columns: 80, rows: 24 },
	{ columns: 65, rows: 10 },
	{ columns: 64, rows: 10 },
] as const;
const CJK_BOUNDARIES = ["의미 있는 문장 경계", "意味のある文の境界", "保留语义短语边界"] as const;
const semanticRootIds = (mode: InteractiveMode) =>
	mode.ui.children.map(child => {
		if (child === mode.ui.getViewportAnchorComponent()) return "irc-split";
		if (child === mode.pendingMessagesContainer) return "pending-messages";
		if (child === mode.statusContainer) return "status-container";
		if (child === mode.todoContainer) return "todos";
		if (child === mode.btwContainer) return "btw";
		if (child === mode.statusLine) return "status-line";
		if (child === mode.hookWidgetContainerAbove) return "hooks-above";
		if (child === mode.editorContainer) return "editor-container";
		if (child === mode.petFloorContainer) return "pet-floor";
		if (child === mode.hookWidgetContainerBelow) return "hooks-below";
		throw new Error("unexpected production root child");
	});
// Domain-separated semantic anchor identity. A geometry-only digest is forgeable
// and aliasing: distinct evidence entries painting different content at the same
// row/cell offsets collapse onto one id, and an 8-hex truncation is searchable by
// brute force. The preimage therefore binds the evidence entry key, the painted
// anchor row text, the COMPLETE geometry (grapheme and cell start AND end plus
// frameRow), and the committed frame digest, under a versioned domain literal so
// the digest cannot be repurposed in another context.
export const SEMANTIC_ANCHOR_DOMAIN = "gjc.sticky-viewport.semantic-anchor.v1";
// Netstring framing (`<byteLength>:<value>,`). A plain `a:b:c` join is ambiguous
// as soon as any field may itself contain `:` — which namespaces and painted row
// text both do — so distinct field tuples could otherwise share a preimage.
export const semanticAnchorPreimage = (fields: readonly string[]) =>
	fields.map(field => `${Buffer.byteLength(field)}:${field},`).join("");
export const semanticAnchorDigest = (input: {
	entryKey: string;
	namespace: string;
	rowText: string;
	graphemeStart: number;
	graphemeEnd: number;
	cellStart: number;
	cellEnd: number;
	frameRow: number;
	frameTextSha256: string;
}) =>
	new Bun.CryptoHasher("sha256")
		.update(
			semanticAnchorPreimage([
				SEMANTIC_ANCHOR_DOMAIN,
				input.entryKey,
				input.namespace,
				input.rowText,
				String(input.graphemeStart),
				String(input.graphemeEnd),
				String(input.cellStart),
				String(input.cellEnd),
				String(input.frameRow),
				input.frameTextSha256,
			]),
		)
		.digest("hex");
/** Namespace of a renderer anchor id, i.e. everything before its volatile per-run suffix. */
export const semanticAnchorNamespace = (id: string) => id.split(":").slice(0, -1).join(":");
// Immutable per-entry witness over the WHOLE painted frame, not just the anchor
// row. The semantic anchor pins exactly one row; in an 80x24 frame only 13 rows
// carry content, so every other painted row -- including the transcript rows that
// carry the bundle's own evidence text -- was pinned to nothing. `frame_sha256`
// cannot close that: the verifier recomputes it from the bundle's own artifact, so
// a producer who rewrites a row and rehashes every dependent digest stays
// internally consistent and was accepted.
//
// The digest is over the ANSI-STRIPPED paint (`stickyViewportFrameTextDigest`).
// An ANSI-frame digest is not pinnable: `detectColorMode()` negotiates truecolor
// `38;2;r;g;b` versus indexed `38;5;n` from COLORTERM/TERM, so one committed value
// would reject an honest capture on the other host. The stripped paint is
// byte-identical across both, which is why `terminal.txt` is the pinned surface
// and `frame_sha256` stays as host-dependent artifact binding only.
//
// The three capacity-zero entries have a null semantic anchor, so before this
// table their frames carried no immutable expectation at all. They are covered
// here like every other key.
//
// Values are rendered output, not authored constants: regenerate by printing
// `stickyViewportFrameTextDigest(render.terminalText)` for each key. Both this
// table and the digest derivation in the verifier are in `ORACLE_SOURCES`, so
// `verifyOracleIntegrity()` forces them to match their committed blobs at the
// reviewed authority commit -- a producer cannot restate either side.
export const STICKY_VIEWPORT_FRAME_TEXT_WITNESS: Readonly<Record<StickyViewportShowcaseKey, string>> = Object.freeze({
	"live-overflow/80x24/unicode-color": "18ff7c45f2d6871a12fe0c6eb5b444b8f53c3c83f012bf551c460753c1af4bbe",
	"live-overflow/120x36/unicode-color": "d5ed298e00b6f3f775cca5103deec287d56a6cc5efa68fa5fb3da9f2bf7bced0",
	"manual-history/80x24/unicode-color": "f2b5cc88983601d313b32d58fe62170adbba19056d9486fa9fd595040b954332",
	"manual-history/120x36/unicode-color": "904c7e94fc0d20a31deabc2e93f794261dcbfbc97f8bd31e8a386698235fde13",
	"manual-new-output/80x24/unicode-color": "dce169b90e5a7f6557c1db829cda47716fc250d71698892637ba00b199c4a706",
	"manual-new-output/120x36/unicode-color": "e7cfa1971dead39a00f98200e6172117f4535301040cb4c7f40486e2e55d2463",
	"multiline-editor-hooks-pet/80x24/unicode-color": "b6d42786e23bd931c450ba0a63886bb633c3976c4f410aad1f2fc7775a3e48fe",
	"multiline-editor-hooks-pet/120x36/unicode-color":
		"3944f1563c74aba7bbac2b287d8fe17917e8aefe39d74a4d6fbd7433ffba60b2",
	"capacity-many/80x24/unicode-color": "b55610b0ecd90502338a67a951d014f9b2311658a0c64d008d6590613fef3101",
	"capacity-many/120x36/unicode-color": "956a4cc18b50abaf30fcbe0401cf5cf876da6f1611ad1f326d2b0a0042fda409",
	"capacity-one/80x24/unicode-color": "58dee6e4f2df74de3324ed39cfa89680f6888850717f312d9da994f932031755",
	"capacity-one/120x36/unicode-color": "80d87c6062a26c39f932a21446cfd453852edd694db6d005544bb46d02eb916e",
	"capacity-zero/80x24/unicode-color": "174bbb2e5913a0361c32e74abb519e0a34ed7f46d4dc29235d8c7fb568c76a86",
	"capacity-zero/120x36/unicode-color": "482db3cfb4f47050fbdebb450721851b3f6aefb3493825321e259810848b7339",
	"selection-boundary/80x24/unicode-color": "8a6b28cff37576e3e11d5d8a549aa33efde56b4dd6d6704da91e506d79a0ca44",
	"selection-boundary/120x36/unicode-color": "9e45f3a188c836870c708290e5d094842f75d142de1a072465866ef1425fa027",
	"manual-new-output/80x24/ascii-no-color": "dce169b90e5a7f6557c1db829cda47716fc250d71698892637ba00b199c4a706",
	"capacity-zero/48x10/ascii-no-color": "d39aeb89abc4aaaa5523668f63cfe918dae6751a8dac1025178c9dbcfb68c8f9",
	"multiline-editor-hooks-pet/48x10/unicode-color": "c54fbe3d52e8e3625cd90e746b0c4be25f5563a0c950be615d372e7295afde59",
	"narrow-cjk/48x10/unicode-color": "dcdc88cc87b4693ef0f1500fe304de994da6f2c6916faf5165bacda77c66c161",
});
// Every persisted frame must be canonical for its render mode, not just the
// top-level payload. `metadata.json` is a required manifest artifact, so raw
// frames here would make the whole bundle host-dependent: theme.ts emits SGR
// directly and `detectColorMode()` picks truecolor vs indexed `38;5;n` from
// COLORTERM/TERM. Stripping at the single capture point keeps
// `visible_empty_irc_frame` and every resize probe byte-identical across hosts.
const captureFrame = (terminal: VirtualTerminal, renderMode: StickyViewportShowcaseEntry["renderMode"]) => {
	const raw = terminal.getViewportAnsi();
	const ansi = renderMode === "ascii-no-color" ? Bun.stripANSI(raw) : raw;
	return {
		ansi,
		text: Bun.stripANSI(ansi),
		sha256: new Bun.CryptoHasher("sha256").update(ansi).digest("hex"),
	};
};

/** Production InteractiveMode assembly with its ProcessTerminal replaced by the first-party VirtualTerminal test transport before startup. */
async function createMode(entry: StickyViewportShowcaseEntry) {
	resetSettingsForTest();
	const dir = TempDir.createSync("@sticky-viewport-");
	// The default status-line preset paints the `git` and `path` segments into every
	// frame at >=120 columns. Both are host state, not renderer state: `path` prints
	// the cwd basename, and `git` prints the branch plus staged/unstaged counts that
	// `StatusLineComponent` resolves through an async `git status --porcelain` whose
	// completion races the capture — the same worktree at the same merge state paints
	// `detached` or `detached +8` depending on which render observes the resolved
	// promise. `metadata.json` is a required artifact, so that race makes the bundle
	// digest nondeterministic run-to-run and across hosts. Neither segment carries
	// sticky-viewport evidence, so the capture pins a deterministic custom preset that
	// excludes them instead of sampling repository state at all.
	const statusLineOverrides = {
		"statusLine.preset": "custom",
		"statusLine.leftSegments": ["model"],
		"statusLine.rightSegments": ["session_name"],
	} as const;
	await Settings.init({
		inMemory: true,
		cwd: dir.path(),
		overrides: { "startup.quiet": true, "mouse.enabled": true, ...statusLineOverrides },
	});
	const auth = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(auth);
	const model = registry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("production model fixture unavailable");
	const settings = Settings.isolated();
	settings.set("startup.quiet", true);
	settings.set("mouse.enabled", true);
	settings.set("statusLine.preset", statusLineOverrides["statusLine.preset"]);
	settings.set("statusLine.leftSegments", [...statusLineOverrides["statusLine.leftSegments"]]);
	settings.set("statusLine.rightSegments", [...statusLineOverrides["statusLine.rightSegments"]]);
	const session = new AgentSession({
		agent: new Agent({
			initialState: { model, systemPrompt: ["Sticky viewport production capture"], tools: [], messages: [] },
		}),
		sessionManager: SessionManager.create(dir.path(), dir.path()),
		settings,
		modelRegistry: registry,
	});
	const mode = new InteractiveMode(session, "sticky-viewport", undefined, undefined, undefined, undefined, undefined, {
		platform: process.platform === "darwin" ? "win32" : "darwin",
	});
	const terminal = new VirtualTerminal(entry.viewport.columns, entry.viewport.rows, { isProcessTerminal: true });
	// TUI owns the transport through this public runtime field; replacing it before start preserves the real root assembly.
	(mode.ui as unknown as { terminal: VirtualTerminal }).terminal = terminal;
	return {
		mode,
		terminal,
		async dispose() {
			mode.stop();
			await session.dispose();
			auth.close();
			await dir.remove();
			resetSettingsForTest();
		},
	};
}

export async function renderStickyViewportShowcase(
	entry: StickyViewportShowcaseEntry,
): Promise<StickyViewportShowcaseRender> {
	const oldLevel = chalk.level;
	chalk.level = entry.renderMode === "ascii-no-color" ? 0 : 3;
	await initTheme(false, entry.renderMode === "ascii-no-color" ? "ascii" : "unicode", false, "red-claw", "red-claw");
	const harness = await createMode(entry);
	const { mode, terminal } = harness;
	try {
		for (let i = 0; i < (entry.stateId === "narrow-cjk" ? 3 : 48); i++) {
			harness.mode.sessionManager.appendMessage({
				role: "user",
				content: `assistant ${i}: transcript output remains selectable`,
				timestamp: i,
			});
		}
		if (entry.stateId === "narrow-cjk") {
			for (const phrase of CJK_BOUNDARIES) {
				harness.mode.sessionManager.appendMessage({
					role: "user",
					content: phrase,
					timestamp: 100 + phrase.length,
				});
			}
		}
		mode.rebuildChatFromMessages("replace-identity");
		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(true);
		mode.toggleIrcSidebar();
		mode.pendingMessagesContainer.addChild(new Text("pending: queued composer input", 0, 0));
		mode.statusContainer.addChild(new Text("statusContainer: rendering production assembly", 0, 0));
		mode.btwContainer.addChild(new Text("BTW: production viewport evidence", 0, 0));
		mode.hookWidgetContainerAbove.addChild(new Text("hook: ready", 0, 0));
		const capacityReservation =
			entry.stateId === "capacity-one"
				? Math.max(0, entry.viewport.rows - 6)
				: entry.stateId === "capacity-zero"
					? Math.max(0, entry.viewport.rows - 5)
					: 0;
		if (capacityReservation > 0) {
			mode.hookWidgetContainerBelow.addChild(
				new Text(
					Array.from({ length: capacityReservation }, (_, index) => `reserved suffix row ${index + 1}`).join("\n"),
					0,
					0,
				),
			);
		}
		const editorText =
			entry.stateId === "multiline-editor-hooks-pet"
				? "first composer line\nsecond composer line"
				: entry.stateId === "capacity-many"
					? "capacity-many composer"
					: entry.stateId === "capacity-one"
						? "capacity-one composer"
						: entry.stateId === "capacity-zero"
							? "capacity-zero composer"
							: entry.stateId === "selection-boundary"
								? "selection-boundary composer"
								: entry.stateId === "manual-history"
									? "manual-history composer"
									: "capture cursor";
		mode.editor.setText(editorText);
		mode.editor.setUseTerminalCursor(true);
		await mode.init();
		mode.ui.setFocus(mode.editor);
		mode.ui.requestRender(true);
		await terminal.waitForRender();
		const resizeProbes: Record<string, unknown>[] = [];
		terminal.resize(80, 24);
		mode.ircLedger.reset();
		mode.ui.requestResizeRender();
		await terminal.waitForRender();
		const visibleEmptyIrcFrame = captureFrame(terminal, entry.renderMode);
		for (const probe of PROBES) {
			terminal.resize(probe.columns, probe.rows);
			mode.ircLedger.reset();
			mode.setTodos(
				probe.columns === 64
					? []
					: ([
							{
								name: "triage",
								tasks: [
									{ content: "verify production todo", status: "completed" },
									{ content: "expanded production todo", status: "in_progress" },
								],
							},
							{
								name: "implementation",
								tasks: [{ content: "long todo 混合日本語 mixed Latin", status: "pending" }],
							},
						] as never),
			);
			if (probe.columns >= 80 && !mode.todoExpanded) mode.toggleTodoExpansion();
			if (probe.columns === 65 && mode.todoExpanded) mode.toggleTodoExpansion();
			if (probe.columns >= 65)
				mode.ircLedger.observe(
					{
						observationId: `${entry.key}-${probe.columns}-${resizeProbes.length}`,
						kind: "incoming",
						from: "worker",
						to: "you",
						text:
							probe.columns >= 80
								? "long IRC observation 混合日本語 mixed Latin ".repeat(8)
								: "streaming IRC observation 混合日本語",
						timestamp: 1,
					},
					true,
				);
			mode.ui.requestResizeRender();
			await terminal.waitForRender();
			const frame = captureFrame(terminal, entry.renderMode);
			const sidebarVisible = probe.columns >= 65;
			const layout = computeIrcWorkLaneWidths(probe.columns, sidebarVisible);
			resizeProbes.push({
				columns: probe.columns,
				rows: probe.rows,
				effective_lane: sidebarVisible ? "split" : "transcript",
				left_width: layout.leftWidth,
				right_width: layout.rightWidth,
				separator_width: layout.separatorWidth,
				irc_records: mode.ircLedger.getSidebarRecords().length,
				todo_rows: mode.todoContainer.children.length,
				todo_expanded: mode.todoExpanded,
				frame,
			});
		}
		terminal.resize(entry.viewport.columns, entry.viewport.rows);
		mode.ui.requestResizeRender();
		await terminal.waitForRender();
		if (entry.stateId === "capacity-one") {
			const anchor = mode.ui.getViewportAnchorSnapshot()?.anchors.find(candidate => candidate !== null);
			if (!anchor || !mode.ui.revealViewportAnchor(anchor.id, "top"))
				throw new Error("capacity-one anchor unavailable");
			await terminal.waitForRender();
		} else if (entry.stateId !== "live-overflow" && entry.stateId !== "capacity-zero") {
			mode.ui.scrollViewportBy(-3, { pin: "stable" });
			mode.ui.scrollViewportPages(-1);
		}
		if (entry.stateId === "manual-new-output") {
			mode.chatContainer.addChild(new Text("agent output after manual scroll", 0, 0));
			mode.recordVisibleTranscriptMutation();
		}
		if (entry.stateId === "selection-boundary") {
			mode.ui.requestRender(true);
			await terminal.waitForRender();
			const beforeSelection = mode.ui.getViewportObservation();
			if (!beforeSelection || beforeSelection.transcriptCapacity < 2)
				throw new Error("selection boundary lacks two painted transcript rows");
			mode.ui.setViewportSelection(
				{ line: beforeSelection.transcriptCapacity - 1, column: 1 },
				{ line: beforeSelection.transcriptCapacity, column: 17 },
			);
			await terminal.waitForRender();
			if (mode.ui.getViewportObservation()?.selection !== null)
				throw new Error("selection crossed into the pinned row");
			mode.ui.setViewportSelection(
				{ line: beforeSelection.transcriptCapacity - 2, column: 1 },
				{ line: beforeSelection.transcriptCapacity - 1, column: 17 },
			);
		}
		mode.ui.requestRender(true);
		await terminal.waitForRender();
		let observation = mode.ui.getViewportObservation();
		if (!observation) throw new Error("renderer produced no viewport observation");
		if (observation.semanticAnchor === null && observation.transcriptCapacity > 0) {
			const anchor = mode.ui.getViewportAnchorSnapshot()?.anchors.find(candidate => candidate !== null);
			if (!anchor || !mode.ui.revealViewportAnchor(anchor.id, "top"))
				throw new Error("renderer produced no visible semantic anchor");
			await terminal.waitForRender();
			observation = mode.ui.getViewportObservation();
			if (!observation) throw new Error("renderer produced no viewport observation");
		}
		const frame = terminal.getViewportAnsi();
		const pinIndex = mode.ui.children.indexOf(mode.statusLine);
		const retainedFrame = frame;
		// `ascii-no-color` must be genuinely escape-free on every host. `chalk.level = 0`
		// cannot deliver that: theme.ts emits SGR directly (`fgAnsi`/`bgAnsi`) without
		// consulting chalk, and its color form depends on `detectColorMode()` — truecolor
		// when COLORTERM=truecolor, indexed `38;5;N` when TERM is dumb/empty/linux (CI).
		// Stripping here keeps the artifact host-independent instead of encoding whichever
		// color form the capture host happened to negotiate. Every consumer below — the
		// persisted ANSI payload and the recorded cursor frame digest — must use this one
		// value, or the verifier's `cursor.frame_sha256 !== hash(ansi)` check rejects it.
		const canonicalAnsi = entry.renderMode === "ascii-no-color" ? Bun.stripANSI(retainedFrame) : retainedFrame;
		const canonicalText = Bun.stripANSI(retainedFrame);
		const frameSha256 = new Bun.CryptoHasher("sha256").update(canonicalAnsi).digest("hex");
		const rootOrder = semanticRootIds(mode);
		const focused = mode.ui.getFocusedComponent();
		const cursor = observation.cursor;
		const anchor = observation.semanticAnchor;
		if (cursor === null) throw new Error("renderer produced no editor cursor");
		if (anchor === null && observation.transcriptCapacity > 0)
			throw new Error("renderer produced no visible semantic anchor");
		return {
			terminalText: canonicalText,
			terminalAnsiText: canonicalAnsi,
			sourceRevision: "production-tui-virtual-terminal-v3",
			outputRevision:
				observation.outputRevision ??
				(() => {
					throw new Error("renderer produced no output revision");
				})(),
			cjkPhraseBoundaries: entry.stateId === "narrow-cjk" ? CJK_BOUNDARIES : [],
			state: {
				manual: observation.manualHistory,
				notice: observation.newOutputNoticeVisible,
				observed_output_revision: observation.outputRevision,
				transcript_capacity: observation.transcriptCapacity,
				composer_visible: focused === mode.editor,
				resize_probes: resizeProbes,
				visible_empty_irc_frame: visibleEmptyIrcFrame,
				root_order: rootOrder,
				pin_boundary: {
					component: "status-line",
					index: pinIndex,
					row: observation.pinBoundary.row,
					pinned: observation.pinBoundary.pinned,
				},
				focused_component: focused === mode.editor && observation.focused ? "editor" : null,
				cursor: {
					...cursor,
					frame_sha256: frameSha256,
					blink: mode.editor.focused,
				},
				selection: observation.selection
					? {
							start: {
								row: observation.selection.start.line,
								col: observation.selection.start.column,
							},
							end: {
								row: observation.selection.end.line,
								col: observation.selection.end.column,
							},
						}
					: null,
				semantic_anchor: anchor
					? (() => {
							// `anchor.id` embeds a per-run session entry id, so persisting it raw
							// makes the required metadata artifact differ between two captures on
							// the SAME host. Keep the semantic namespace and replace the volatile
							// suffix with a domain-separated digest that binds this entry, the
							// painted anchor row, the complete geometry, and the committed frame —
							// so the bundle stays reproducible while distinct anchors stay
							// distinguishable and no id is transplantable to another entry.
							const rows = canonicalText.split("\n");
							const rowText = rows[anchor.frameRow];
							if (rowText === undefined) throw new Error("semantic anchor frame row is outside the paint");
							// Semantic identity must not move with the host's color encoding. The
							// ANSI frame digest differs between indexed and truecolor hosts while the
							// stripped paint is identical, so the preimage binds the stripped text and
							// `frame_sha256` stays as a separate artifact-binding field.
							const frameTextSha256 = new Bun.CryptoHasher("sha256")
								.update(Bun.stripANSI(canonicalText))
								.digest("hex");
							const namespace = semanticAnchorNamespace(anchor.id);
							if (!namespace) throw new Error("semantic anchor id carries no namespace");
							return {
								domain: SEMANTIC_ANCHOR_DOMAIN,
								id: `${namespace}:${semanticAnchorDigest({
									entryKey: entry.key,
									namespace,
									rowText,
									graphemeStart: anchor.graphemeStart,
									graphemeEnd: anchor.graphemeEnd,
									cellStart: anchor.cellStart,
									cellEnd: anchor.cellEnd,
									frameRow: anchor.frameRow,
									frameTextSha256: frameTextSha256,
								})}`,
								namespace,
								grapheme_start: anchor.graphemeStart,
								grapheme_end: anchor.graphemeEnd,
								cell_start: anchor.cellStart,
								cell_end: anchor.cellEnd,
								frame_start_row: anchor.frameRow,
								row_text_sha256: new Bun.CryptoHasher("sha256").update(rowText).digest("hex"),
								frame_sha256: frameSha256,
								frame_text_sha256: frameTextSha256,
							};
						})()
					: null,
				cjk_contiguous_semantics: CJK_BOUNDARIES,
				coverage: STICKY_VIEWPORT_SHOWCASE_COVERAGE,
			},
		};
	} finally {
		await harness.dispose();
		chalk.level = oldLevel;
	}
}
