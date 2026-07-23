import {
	type AnimationRegistration,
	buildGajaePixelFrames,
	burstTimeline,
	type CellRect,
	type Component,
	type Container,
	type GajaePixelFrameName,
	type GajaePixelFrames,
	getCellDimensions,
	getGajaePetGifCached,
	idleTimeline,
	PARA_PARA_STEPS,
	PET_SKINS,
	type PetMode,
	type PetSkinId,
	petBurstDurationMs,
	petBurstFrame,
	type RasterLeaseToken,
	registerAnimationCallback,
	type TUI,
	workingTimeline,
	wrapITerm2RecordForTmux,
} from "@gajae-code/tui";
import type { CustomEditor } from "./custom-editor";
import { getItermPetUnavailableReason, getPetPixelProtocol, getVerifiedItermPetAvailability } from "./pet-capability";

/** Re-exported from the tui skin registry so widget-relative imports stay valid. */
export type { PetMode, PetSkinId };

/**
 * Empty columns on each side of the pet: an explicit inset from the right edge,
 * with the composer's own right gutter (setRightGutterWidth(1)) as the left gap.
 */
const PET_SIDE_MARGIN = 1;
/** Sub-cell drop after the one-row safety lift, preserving a small bottom gap. */
const PET_SIXEL_DROP_PX = 9;
/**
 * Kitty sub-cell drop below the one-row safety lift, as a fraction of the live cell
 * height so it scales with the font. `floor` keeps it inside the cell; the value is
 * clamped to the cell height.
 */
const KITTY_DROP_FRACTION = 0.45;
const petKittyDropPx = (cellHeightPx: number): number =>
	Math.min(Math.max(0, cellHeightPx - 1), Math.floor(cellHeightPx * KITTY_DROP_FRACTION));
const PET_RAISE_ROWS = 1;
const allocatedPetKittyImageIds = new Set<number>();

function allocatePetKittyImageId(): number {
	let id = 0;
	while (id === 0 || allocatedPetKittyImageIds.has(id)) {
		id = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
	}
	allocatedPetKittyImageIds.add(id);
	return id;
}

interface SixelFootprint {
	x: number;
	y: number;
	columns: number;
	rows: number;
}

function sameFootprint(left: SixelFootprint, right: SixelFootprint): boolean {
	return left.x === right.x && left.y === right.y && left.columns === right.columns && left.rows === right.rows;
}

/**
 * Which widget currently owns each TUI's single shared post-render emitter
 * slot. A stale or repeated dispose (or off-switch) of a predecessor widget
 * must never clear a successor's overlay authority.
 */
const petOverlayEmitterOwners = new WeakMap<TUI, GajaePetWidget>();

/** Working animation: the shared para-para beats looped end to end. */
const WORK_LOOP_TOTAL = PARA_PARA_STEPS.reduce((sum, [, ms]) => sum + ms, 0);
/** Random gap between automatic claw flexes (fires while idle AND working). */
const AUTO_FLEX_MIN_GAP_MS = 12_000;
const AUTO_FLEX_MAX_GAP_MS = 40_000;
// Deterministic idle loop: gaze around with a rare visor flicker.
const IDLE_LOOP: Array<[GajaePixelFrameName, number]> = [
	["base", 1100],
	["gazeL", 350],
	["base", 500],
	["gazeR", 350],
	["base", 800],
	["flicker", 150],
];
const IDLE_LOOP_TOTAL = IDLE_LOOP.reduce((sum, [, ms]) => sum + ms, 0);

/**
 * Selector preview: fire the first burst this soon after a skin is previewed, so the
 * pet shows one idle eye-roll (base -> gazeL -> base -> gazeR) and then its signature
 * flex/cry. Live use keeps the random AUTO_FLEX gap; only preview forces this demo.
 */
const PREVIEW_INTRO_MS = 2300;

/**
 * Wraps the composer editor, reserving a right-side area beside it where the
 * real-pixel pet is drawn. The editor just renders narrower; the pet pixels
 * are emitted separately as an absolute-positioned overlay.
 */
export class PetFramedEditor implements Component {
	#editor: CustomEditor;
	#reserve = 0;

	constructor(editor: CustomEditor) {
		this.#editor = editor;
	}

	setReserve(columns: number): void {
		this.#reserve = columns;
	}

	canFit(width: number): boolean {
		return this.#reserve > 0 && width > this.#reserve + 8;
	}

	invalidate(): void {
		this.#editor.invalidate?.();
	}

	render(width: number): string[] {
		if (!this.canFit(width)) {
			return this.#editor.render(width);
		}
		return this.#editor.render(width - this.#reserve);
	}
}

/**
 * The gajae pet: a 16x16 real-pixel sprite living in a reserved area beside
 * the composer. It is nearest-neighbor scaled to the two terminal rows occupied
 * by an empty one-line composer and lifted one row so its feet meet the input
 * box's bottom edge.
 *
 * Rendering has two paths that share one payload builder:
 * - a post-render emitter re-draws the sprite after every TUI write (line
 *   renders clear the pet cells, so the overlay must be re-applied), and
 * - frame advances queue the payload through the TUI because a frame swap
 *   changes no component line.
 *
 *
 * Requires a sixel- or kitty-graphics terminal (`pixelProtocol()`).
 */
export class GajaePetWidget {
	#ui: TUI;
	#editor: CustomEditor;
	#editorContainer: Container;
	#floorContainer: Container;
	#framedEditor: PetFramedEditor;
	#isWorking: () => boolean;
	#getComposerBottomOffset: () => number;
	#mode: PetMode = "off";
	#pixel: GajaePixelFrames | undefined;
	#frame: GajaePixelFrameName = "base";
	#animation: AnimationRegistration | undefined;
	#flexUntil = 0;
	#nextAutoFlexAt = 0;
	#autoFlexGapMs: [number, number] | null;
	#forcedProtocol: "sixel" | "kitty" | "iterm" | undefined;
	/** Cell metrics the current frames were built for; a change triggers a rebuild. */
	#builtCellW = 0;
	#builtCellH = 0;
	#kittyImageId: number | undefined;
	/** True while a kitty placement may exist on screen; cleared only after the delete escape is delivered. */
	#kittyCleanupPending = false;
	/** Last emitted Sixel raster position; retained until an erase is actually delivered. */
	#lastSixelFootprint: SixelFootprint | undefined;
	/** Terminal state: a disposed widget never touches the TUI or shared slots again. */
	#disposed = false;
	/**
	 * True while the previous overlay frame carried the cleanup payload. The
	 * TUI writes the frame after the emitter returns, so delivery is
	 * acknowledged only on the next emitter pass — and only while the terminal
	 * stayed available, since a failed render write drops availability.
	 */
	#frameCleanupAwaitingAck = false;
	#itermLease: RasterLeaseToken | undefined;
	#disposePromise: Promise<void> | undefined;
	#itermProtocol = false;
	#itermLastSemantic = "";
	#itermOwner = `gajae-pet-${Math.random().toString(36).slice(2)}`;
	#itermGeneration = 0;
	#itermSubmitPending = false;
	#syncManagedItermCursor: (row: number, column: number) => Promise<boolean>;

	constructor(options: {
		ui: TUI;
		editor: CustomEditor;
		editorContainer: Container;
		floorContainer: Container;
		isWorking: () => boolean;
		/** Rows rendered below the composer box (pet floor + hook widgets). */
		getComposerBottomOffset: () => number;
		syncManagedItermCursor: (row: number, column: number) => Promise<boolean>;
		forcePixelProtocol?: "sixel" | "kitty";
		/** Random [min, max] ms between auto-flexes; null disables. */
		autoFlexGapMs?: [number, number] | null;
	}) {
		this.#ui = options.ui;
		this.#editor = options.editor;
		this.#editorContainer = options.editorContainer;
		this.#floorContainer = options.floorContainer;
		this.#framedEditor = new PetFramedEditor(options.editor);
		this.#isWorking = options.isWorking;
		this.#getComposerBottomOffset = options.getComposerBottomOffset;
		this.#syncManagedItermCursor = options.syncManagedItermCursor;
		this.#forcedProtocol = options.forcePixelProtocol;
		this.#autoFlexGapMs =
			options.autoFlexGapMs === undefined ? [AUTO_FLEX_MIN_GAP_MS, AUTO_FLEX_MAX_GAP_MS] : options.autoFlexGapMs;
	}

	/** Protocol available for the real-pixel pet, if any. */
	static pixelProtocol(): "sixel" | "kitty" | "iterm" | null {
		return getPetPixelProtocol();
	}

	get mode(): PetMode {
		return this.#mode;
	}

	get isFlexing(): boolean {
		return performance.now() < this.#flexUntil;
	}

	setMode(mode: PetMode): void {
		this.#applyMode(mode, true);
	}

	/**
	 * Suspend iTerm rendering after capability loss without changing the saved/user mode.
	 * A later verified availability emission can resume rendering in the same mode.
	 */
	async suspendItermCapability(): Promise<void> {
		if (this.#disposed) return;
		this.#itermGeneration++;
		const lease = this.#itermLease;
		this.#itermLease = undefined;
		this.#itermLastSemantic = "";
		if (lease) await this.#ui.invalidateRasterLease({ token: lease, cause: "capability-loss" });
		this.#ui.requestRender(true);
	}

	/** Live preview during a selector: change the sprite without re-mounting the
	 *  composer editor (that would tear down the open overlay). After a short idle
	 *  eye-roll it fires the signature burst once (RedGajae flex, BlueGajae para-para
	 *  then sob) so the selector demos the animation instead of waiting the random gap. */
	previewMode(mode: PetMode): void {
		this.#applyMode(mode, false);
		if (mode !== "off" && this.#autoFlexGapMs) {
			this.#nextAutoFlexAt = performance.now() + PREVIEW_INTRO_MS;
		}
	}

	commitPreviewMode(mode: PetMode): void {
		this.#applyMode(mode, false);
	}

	#applyMode(mode: PetMode, mountComposer: boolean): void {
		if (this.#disposed || mode === this.#mode) return;

		if (mode === "off") {
			this.#itermGeneration++;
			if (this.#itermLease) {
				void this.#ui.invalidateRasterLease({ token: this.#itermLease, cause: "mode-off" });
				this.#itermLease = undefined;
			}
			this.#itermLastSemantic = "";
			this.#itermProtocol = false;
			this.#writeImageCleanup();
			this.#mode = "off";
			this.#animation?.unregister();
			this.#animation = undefined;
			this.#releaseOverlayEmitter();
			this.#floorContainer.clear();
			this.#pixel = undefined;
			this.#framedEditor.setReserve(0);
			if (mountComposer) this.#mountEditor(false);
			this.#ui.requestRender(true);
			return;
		}

		const protocol = this.#forcedProtocol ?? GajaePetWidget.pixelProtocol();
		if (!protocol) return;
		this.#itermGeneration++;
		if (this.#itermLease) {
			void this.#ui.invalidateRasterLease({ token: this.#itermLease, cause: "explicit" });
			this.#itermLease = undefined;
		}
		this.#itermLastSemantic = "";
		if (this.#mode !== "off") this.#writeImageCleanup();
		this.#mode = mode;
		this.#frame = "base";
		this.#flexUntil = 0;
		this.#nextAutoFlexAt = 0;
		this.#buildPixel(protocol);
		if (mountComposer) this.#mountEditor(true);
		// The pet overlays the composer's bottom rows; no floor row is reserved, so
		// the composer stays pinned to the terminal bottom.
		this.#floorContainer.clear();
		this.#ui.setPostRenderEmitter(() => this.#overlayPayload());
		petOverlayEmitterOwners.set(this.#ui, this);
		this.#animation ??= registerAnimationCallback(now => this.#tick(now), 80);
		this.#ui.requestRender(true);
	}

	/** (Re)build the encoded frames for the current terminal cell metrics. */
	#buildPixel(protocol: "sixel" | "kitty" | "iterm"): void {
		const cell = getCellDimensions();
		this.#builtCellW = cell.widthPx;
		this.#builtCellH = cell.heightPx;
		const skin: PetSkinId = this.#mode === "off" ? "red" : this.#mode;
		if (protocol === "kitty") {
			this.#kittyImageId ??= allocatePetKittyImageId();
			this.#kittyCleanupPending = true;
		}
		if (protocol === "iterm") {
			this.#itermProtocol = true;
			this.#pixel = undefined;
			this.#framedEditor.setReserve(Math.max(1, Math.ceil((2 * cell.heightPx) / cell.widthPx)) + PET_SIDE_MARGIN);
			return;
		}
		this.#itermProtocol = false;
		this.#pixel = buildGajaePixelFrames({
			protocol,
			skin,
			cellWidthPx: cell.widthPx,
			cellHeightPx: cell.heightPx,
			targetRows: 2,
			sixelTopPaddingPx: protocol === "sixel" ? PET_SIXEL_DROP_PX : 0,
			kittyCellYOffsetPx: protocol === "kitty" ? petKittyDropPx(cell.heightPx) : 0,
			kittyImageId: protocol === "kitty" ? this.#kittyImageId : undefined,
		});
		this.#framedEditor.setReserve(this.#pixel.columns + PET_SIDE_MARGIN);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#itermGeneration++;
		if (this.#itermLease) {
			void this.#ui.invalidateRasterLease({ token: this.#itermLease, cause: "dispose" });
			this.#itermLease = undefined;
		}
		const kittyImageId = this.#kittyImageId;
		const cleanupPayload = this.#imageCleanupPayload();
		try {
			if (cleanupPayload) {
				this.#ui.queueTerminalCleanup(
					`\x1b[?2026h\x1b7${cleanupPayload}\x1b8\x1b[?2026l`,
					kittyImageId === undefined ? undefined : () => allocatedPetKittyImageIds.delete(kittyImageId),
				);
			} else if (kittyImageId !== undefined) {
				allocatedPetKittyImageIds.delete(kittyImageId);
			}
			this.#consumeCleanupAuthority();
			this.#kittyImageId = undefined;
		} finally {
			this.#animation?.unregister();
			this.#animation = undefined;
			this.#releaseOverlayEmitter();
			this.#mode = "off";
			this.#pixel = undefined;
			this.#floorContainer.clear();
			this.#framedEditor.setReserve(0);
			// Restore the plain composer only while our framed wrapper is still
			// mounted; a successor widget may already own the editor container.
			if (this.#editorContainer.children.includes(this.#framedEditor)) {
				this.#mountEditor(false);
			}
		}
	}
	async disposeAsync(): Promise<void> {
		if (!this.#disposePromise) {
			this.dispose();
			this.#disposePromise = this.#ui
				.notifyTerminalLifecycle({
					kind: "explicit-cleanup",
					source: "interactive-mode",
					terminalGeneration: this.#ui.terminalGeneration,
				})
				.then(() => undefined);
		}
		await this.#disposePromise;
	}

	/** Clear the shared post-render slot only while this widget still owns it. */
	#releaseOverlayEmitter(): void {
		if (petOverlayEmitterOwners.get(this.#ui) === this) {
			this.#ui.setPostRenderEmitter(undefined);
			petOverlayEmitterOwners.delete(this.#ui);
		}
	}

	#mountEditor(framed: boolean): void {
		this.#editorContainer.clear();
		this.#editorContainer.addChild(framed ? this.#framedEditor : this.#editor);
	}

	/** Re-mount the composer editor (framed when a skin is active) after an overlay. */
	remountComposer(): void {
		this.#mountEditor(this.#mode !== "off");
	}

	#pickFrame(now: number): GajaePixelFrameName {
		const mode = this.#mode;
		if (mode === "off") return "base";
		// Random idle burst → the skin's own animation, driven by its burst descriptor
		// (RedGajae holds a flex; BlueGajae dances the para-para then sobs).
		if (now < this.#flexUntil) {
			const burst = PET_SKINS[mode].burst;
			const elapsed = now - (this.#flexUntil - petBurstDurationMs(burst));
			return petBurstFrame(burst, elapsed, now);
		}
		// Working → loop the shared para-para beats.
		if (this.#isWorking()) {
			let d = now % WORK_LOOP_TOTAL;
			for (const [frame, ms] of PARA_PARA_STEPS) {
				if (d < ms) return frame;
				d -= ms;
			}
			return "base";
		}
		let t = now % IDLE_LOOP_TOTAL;
		for (const [frame, ms] of IDLE_LOOP) {
			if (t < ms) return frame;
			t -= ms;
		}
		return "base";
	}

	#tickIterm(now: number): void {
		const cell = getCellDimensions();
		const pixelColumns = Math.max(1, Math.ceil((2 * cell.heightPx) / cell.widthPx));
		const pixelRows = 2;
		let metricsChanged = false;
		if (cell.widthPx !== this.#builtCellW || cell.heightPx !== this.#builtCellH) {
			metricsChanged = true;
			this.#itermGeneration++;
			const lease = this.#itermLease;
			this.#itermLease = undefined;
			this.#itermLastSemantic = "";
			if (lease) void this.#ui.invalidateRasterLease({ token: lease, cause: "resize" });
			this.#builtCellW = cell.widthPx;
			this.#builtCellH = cell.heightPx;
			this.#framedEditor.setReserve(pixelColumns + PET_SIDE_MARGIN);
		}
		// iTerm uses the same framed-editor invariant as the other pixel protocols.
		if (!this.#framedEditor.canFit(this.#ui.terminal.columns)) {
			if (!metricsChanged) {
				this.#itermGeneration++;
				const lease = this.#itermLease;
				this.#itermLease = undefined;
				if (lease) void this.#ui.invalidateRasterLease({ token: lease, cause: "resize" });
			}
			this.#itermLastSemantic = "";
			return;
		}
		// iTerm advances its inline-image cursor past the image. Align to the
		// composer's bottom edge only when rows below the composer leave room for
		// that advance; otherwise retain one safety row to prevent a viewport scroll.
		const terminalRows = this.#ui.terminal.rows;
		const composerBottom = terminalRows - this.#getComposerBottomOffset();
		const desiredRow = composerBottom - pixelRows;
		const maxSafeRow = terminalRows - pixelRows - PET_RAISE_ROWS;
		const rect: CellRect = {
			column: Math.max(0, this.#ui.terminal.columns - pixelColumns - PET_SIDE_MARGIN),
			row: Math.max(0, Math.min(desiredRow, maxSafeRow)),
			width: pixelColumns,
			height: pixelRows,
		};
		const availability = getVerifiedItermPetAvailability();
		if (!availability?.available || getItermPetUnavailableReason() || !this.#ui.terminalAvailable) return;
		const semantic = `${this.#mode}:${this.#isWorking()}:${this.#flexUntil > now}:${rect.column},${rect.row}:${cell.widthPx},${cell.heightPx}:${this.#ui.terminal.columns},${this.#ui.terminal.rows}`;
		if (this.#itermSubmitPending || (semantic === this.#itermLastSemantic && this.#itermLease)) return;
		this.#itermLastSemantic = semantic;
		this.#itermSubmitPending = true;
		const generation = this.#itermGeneration;
		void this.#submitIterm(rect, now, generation, availability.epoch, availability.mode, semantic).finally(() => {
			this.#itermSubmitPending = false;
			if (!this.#itermLease) this.#itermLastSemantic = "";
		});
	}
	async #submitIterm(
		rect: CellRect,
		now: number,
		generation: number,
		epoch: number,
		mode: "direct" | "managed",
		semantic: string,
	): Promise<void> {
		const current = () => {
			const availability = getVerifiedItermPetAvailability();
			return (
				!this.#disposed &&
				generation === this.#itermGeneration &&
				availability?.available === true &&
				availability.epoch === epoch &&
				availability.mode === mode &&
				this.#framedEditor.canFit(this.#ui.terminal.columns)
			);
		};
		let token = this.#itermLease;
		if (
			token &&
			(token.rect.column !== rect.column ||
				token.rect.row !== rect.row ||
				token.rect.width !== rect.width ||
				token.rect.height !== rect.height)
		) {
			await this.#ui.invalidateRasterLease({ token, cause: "resize" });
			if (this.#itermLease === token) this.#itermLease = undefined;
			token = undefined;
		}
		if (!current()) return;
		if (!token) {
			const acquired = await this.#ui.acquireRasterLease({
				ownerId: this.#itermOwner,
				rect,
				erase: {
					type: "raster-erase",
					bytes: new TextEncoder().encode(
						Array.from(
							{ length: rect.height },
							(_, row) => `\x1b[${rect.row + row + 1};${rect.column + 1}H\x1b[${rect.width}X`,
						).join(""),
					),
				},
				onInvalidated: notice => {
					if (this.#itermLease === notice.token) {
						this.#itermLease = undefined;
						this.#itermLastSemantic = "";
					}
				},
			});
			if (!current() || acquired.status !== "acquired") {
				if (acquired.status === "acquired")
					await this.#ui.invalidateRasterLease({ token: acquired.token, cause: "capability-loss" });
				return;
			}
			token = acquired.token;
			this.#itermLease = token;
		}
		this.#itermLastSemantic = semantic;
		const working = this.#isWorking();
		const frames =
			this.#flexUntil > now
				? burstTimeline(this.#mode === "off" ? "red" : this.#mode)
				: working
					? workingTimeline()
					: idleTimeline();
		const cell = getCellDimensions();
		const gif = getGajaePetGifCached({
			skin: this.#mode === "off" ? "red" : this.#mode,
			timeline: frames,
			cellWidthPx: cell.widthPx,
			cellHeightPx: cell.heightPx,
			targetRows: 2,
			rectangle: { width: rect.width * cell.widthPx, height: rect.height * cell.heightPx },
			// Cell units match Kitty placement sizing and avoid Retina pixel-unit shrinkage.
			displaySize: { width: rect.width, height: rect.height },
		});
		const cursorPosition = `\x1b[${rect.row + 1};${rect.column + 1}H`;
		const cursorRestore =
			mode === "managed" ? `${wrapITerm2RecordForTmux("\x1b8\x1b[?2026l")}\x1b8` : "\x1b8\x1b[?2026l";
		const encodedRecords = (mode === "managed" ? gif.tmuxDcs : gif.multipart).map(record =>
			new TextEncoder().encode(record),
		);
		const submit = await this.#ui.submitTerminalOutput({
			token,
			operation: {
				type: "raster-multipart-batch",
				// Keep iTerm's hardware and IME cursor visually anchored while the inline
				// image protocol temporarily uses the terminal cursor for placement.
				prefix: new TextEncoder().encode(
					mode === "managed"
						? `${wrapITerm2RecordForTmux("\x1b[?2026h\x1b7\x1b[?25l")}\x1b7${cursorPosition}`
						: `\x1b[?2026h\x1b7\x1b[?25l${cursorPosition}`,
				),
				afterPrefix: mode === "managed" ? () => this.#syncManagedItermCursor(rect.row, rect.column) : undefined,
				replayPrefix: mode === "managed" ? new TextEncoder().encode(cursorPosition) : undefined,
				records: encodedRecords,
				suffix: new TextEncoder().encode(cursorRestore),
				abortSuffix: mode === "managed" ? new TextEncoder().encode(cursorRestore) : undefined,
				restoreCursorVisibility: true,
			},
		});
		if (!current() || submit.status !== "written") {
			await this.#ui.invalidateRasterLease({ token, cause: "capability-loss" });
			if (this.#itermLease === token) this.#itermLease = undefined;
		}
	}
	#scheduleAutoFlex(now: number): void {
		if (!this.#autoFlexGapMs) return;
		const [min, max] = this.#autoFlexGapMs;
		this.#nextAutoFlexAt = now + min + Math.random() * Math.max(0, max - min);
	}

	#tick(now: number): void {
		// Random show-off, both while idle and while working. Each skin's burst runs for
		// its own length (RedGajae a brief flex; BlueGajae a para-para cycle plus sob).
		if (this.#autoFlexGapMs && now >= this.#flexUntil) {
			if (this.#nextAutoFlexAt === 0) {
				this.#scheduleAutoFlex(now);
			} else if (now >= this.#nextAutoFlexAt) {
				const skin = this.#mode === "off" ? "red" : this.#mode;
				const burstMs = petBurstDurationMs(PET_SKINS[skin].burst);
				this.#flexUntil = now + burstMs;
				this.#scheduleAutoFlex(now + burstMs);
			}
		}
		if (this.#itermProtocol) {
			this.#tickIterm(now);
			return;
		}
		if (this.#mode === "off" || !this.#pixel) return;
		// A font/zoom change resizes the terminal cells; rebuild the frames so the
		// kitty image and its sub-cell drop match the new cell metrics.
		const cell = getCellDimensions();
		if (cell.widthPx !== this.#builtCellW || cell.heightPx !== this.#builtCellH) {
			const protocol = this.#forcedProtocol ?? GajaePetWidget.pixelProtocol();
			if (protocol) {
				this.#buildPixel(protocol);
				this.#mountEditor(true);
				this.#ui.requestRender(true);
			}
		}
		const frame = this.#pickFrame(now);
		if (frame === this.#frame) return;
		this.#frame = frame;
		// Queue frame swaps through TUI so they share ordering with generic renders.
		const payload = this.#overlayPayload(true) ?? "";
		if (payload && this.#ui.terminalAvailable) {
			void this.#ui.queueTerminalOutput(`\x1b[?2026h\x1b7${payload}\x1b8\x1b[?2026l`);
		}
	}

	#petPosition(): { x: number; y: number } | null {
		const pixel = this.#pixel;
		if (!pixel) return null;
		const columns = this.#ui.terminal.columns;
		if (!this.#framedEditor.canFit(columns)) return null;
		const rows = this.#ui.terminal.rows;
		// The sprite is lifted one safety row above the scrolling edge, then dropped
		// back onto the composer's bottom border per protocol (sixel via transparent
		// top padding, kitty via a sub-cell Y offset baked into the frames).
		const composerBottom = rows - this.#getComposerBottomOffset();
		const y = composerBottom - pixel.rows - PET_RAISE_ROWS;
		const x = columns - pixel.columns - PET_SIDE_MARGIN;
		if (y < 0 || x < 0) return null;
		return { x, y };
	}

	#clearSixelFootprint(footprint: SixelFootprint): string {
		let out = "\x1b[0m";
		for (let row = 0; row < footprint.rows; row++) {
			out += `\x1b[${footprint.y + row + 1};${footprint.x + 1}H\x1b[${footprint.columns}X`;
		}
		return out;
	}

	/** Pending on-screen image cleanup. Pure: authority is consumed separately, on delivery. */
	#imageCleanupPayload(): string {
		let out = "";
		if (this.#kittyCleanupPending && this.#kittyImageId !== undefined) {
			out += `\x1b_Ga=d,d=I,i=${this.#kittyImageId},q=2\x1b\\`;
		}
		if (this.#lastSixelFootprint) {
			out += this.#clearSixelFootprint(this.#lastSixelFootprint);
		}
		return out;
	}

	#consumeCleanupAuthority(): void {
		this.#kittyCleanupPending = false;
		this.#lastSixelFootprint = undefined;
	}

	/**
	 * Queue erase/delete through TUI and consume cleanup authority only on written acknowledgement.
	 */
	#writeImageCleanup(): void {
		if (!this.#ui.terminalAvailable) return;
		const payload = this.#imageCleanupPayload();
		if (!payload) return;
		void this.#ui.queueTerminalOutput(`\x1b[?2026h\x1b7${payload}\x1b8\x1b[?2026l`).then(ack => {
			if (ack.status === "written") this.#consumeCleanupAuthority();
		});
	}

	/** Draw escape payload at the pet's absolute position. */
	#overlayPayload(clearPet = false): string | null {
		const pixel = this.#pixel;
		if (!pixel) return null;
		const pos = this.#petPosition();
		if (!pos) {
			// Deferred delivery acknowledgement: the TUI writes the frame after
			// this emitter returns, and that write can fail. Consume the cleanup
			// authority only once a later pass observes the terminal survived
			// the frame that carried the payload; otherwise retain it so a later
			// lifecycle cleanup retries the erase/delete.
			if (this.#frameCleanupAwaitingAck && this.#ui.terminalAvailable) {
				this.#consumeCleanupAuthority();
			}
			this.#frameCleanupAwaitingAck = false;
			if (!this.#ui.terminalAvailable) return null;
			const cleanup = this.#imageCleanupPayload();
			if (!cleanup) return null;
			this.#frameCleanupAwaitingAck = true;
			return cleanup;
		}
		// A full frame supersedes any cleanup-only frame still awaiting ack.
		this.#frameCleanupAwaitingAck = false;
		const { x, y } = pos;
		let out = "";

		if (pixel.protocol === "sixel") {
			const footprint = { x, y, columns: pixel.columns, rows: pixel.rasterRows };
			if (this.#lastSixelFootprint && !sameFootprint(this.#lastSixelFootprint, footprint)) {
				out += this.#clearSixelFootprint(this.#lastSixelFootprint);
			}
			if (clearPet) out += this.#clearSixelFootprint(footprint);
			this.#lastSixelFootprint = footprint;
		} else {
			// A kitty frame emitted below (re)places the image, so cleanup is
			// pending again even if a narrow-terminal pass consumed it earlier.
			this.#kittyCleanupPending = true;
		}

		out += `\x1b[${y + 1};${x + 1}H${pixel.frames[this.#frame]}`;
		return out;
	}
}
