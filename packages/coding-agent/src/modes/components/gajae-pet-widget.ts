import {
	type AnimationRegistration,
	buildGajaePixelFrames,
	type Component,
	type Container,
	type GajaePixelFrameName,
	type GajaePixelFrames,
	getCellDimensions,
	ImageProtocol,
	PARA_PARA_STEPS,
	PET_SKINS,
	type PetMode,
	type PetSkinId,
	type PostRenderEmission,
	petBurstDurationMs,
	petBurstFrame,
	registerAnimationCallback,
	TERMINAL,
	type TerminalCleanupParticipant,
	type TUI,
} from "@gajae-code/tui";

import type { CustomEditor } from "./custom-editor";

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

interface PetCleanupCoordinator extends TerminalCleanupParticipant {
	active: GajaePetWidget | undefined;
	queueKitty(imageId: number, releaseReservation?: boolean): void;

	hasPendingKitty(imageId: number): boolean;
	queueSixel(footprint: SixelFootprint): void;
}

const petCleanupCoordinators = new WeakMap<TUI, PetCleanupCoordinator>();

function getPetCleanupCoordinator(ui: TUI): PetCleanupCoordinator {
	const existing = petCleanupCoordinators.get(ui);
	if (existing) return existing;
	const kittyDeletes = new Map<number, boolean>();

	const sixelFootprints: SixelFootprint[] = [];
	const coordinator: PetCleanupCoordinator = {
		active: undefined,
		queueKitty: (imageId, releaseReservation = false) => {
			kittyDeletes.set(imageId, (kittyDeletes.get(imageId) ?? false) || releaseReservation);
		},
		hasPendingKitty: imageId => kittyDeletes.has(imageId),

		queueSixel: footprint => {
			if (!sixelFootprints.some(current => sameFootprint(current, footprint))) sixelFootprints.push(footprint);
		},
		flush: () => {
			if (kittyDeletes.size === 0 && sixelFootprints.length === 0) return true;
			let payload = "";
			for (const imageId of kittyDeletes.keys()) payload += `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
			for (const footprint of sixelFootprints) payload += clearSixelFootprint(footprint);
			if (!ui.terminalAvailable || !ui.writeTerminalCleanup(`\x1b[?2026h\x1b7${payload}\x1b8\x1b[?2026l`)) {
				return false;
			}
			for (const [imageId, releaseReservation] of kittyDeletes) {
				if (releaseReservation) allocatedPetKittyImageIds.delete(imageId);
			}
			kittyDeletes.clear();
			sixelFootprints.length = 0;
			return true;
		},
		pendingDiagnostic: () =>
			kittyDeletes.size === 0 && sixelFootprints.length === 0
				? null
				: `Undeliverable Gajae Pet cleanup at terminal shutdown (Kitty images: ${kittyDeletes.size}, Sixel footprints: ${sixelFootprints.length}).`,
	};
	ui.registerTerminalCleanup(coordinator);
	petCleanupCoordinators.set(ui, coordinator);
	return coordinator;
}

function clearSixelFootprint(footprint: SixelFootprint): string {
	let out = "\x1b[0m";
	for (let row = 0; row < footprint.rows; row++) {
		out += `\x1b[${footprint.y + row + 1};${footprint.x + 1}H\x1b[${footprint.columns}X`;
	}
	return out;
}

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
 * - frame advances write the payload directly to the terminal, because the
 *   TUI skips writes entirely when no component line changed.
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
	#forcedProtocol: "sixel" | "kitty" | undefined;
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
	#cleanupCoordinator: PetCleanupCoordinator;
	#placementBlocked = false;

	constructor(options: {
		ui: TUI;
		editor: CustomEditor;
		editorContainer: Container;
		floorContainer: Container;
		isWorking: () => boolean;
		/** Rows rendered below the composer box (pet floor + hook widgets). */
		getComposerBottomOffset: () => number;
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
		this.#forcedProtocol = options.forcePixelProtocol;
		this.#autoFlexGapMs =
			options.autoFlexGapMs === undefined ? [AUTO_FLEX_MIN_GAP_MS, AUTO_FLEX_MAX_GAP_MS] : options.autoFlexGapMs;
		this.#cleanupCoordinator = getPetCleanupCoordinator(this.#ui);
	}

	/** Protocol available for the real-pixel pet, if any. */
	static pixelProtocol(): "sixel" | "kitty" | null {
		if (TERMINAL.imageProtocol === ImageProtocol.Kitty) return "kitty";
		if (TERMINAL.imageProtocol === ImageProtocol.Sixel) return "sixel";
		return null;
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
		// Serialize predecessor Sixel erasure before this widget can place a successor.
		const predecessorCleared = this.#cleanupCoordinator.active
			? this.#cleanupCoordinator.active.prepareSuccessor()
			: this.#cleanupCoordinator.flush();
		this.#placementBlocked = protocol === "sixel" && !predecessorCleared;
		this.#cleanupCoordinator.active = this;

		this.#ui.setPostRenderEmitter(() => this.#overlayPayload());
		petOverlayEmitterOwners.set(this.#ui, this);
		this.#animation ??= registerAnimationCallback(now => this.#tick(now), 80);
		this.#ui.requestRender(true);
	}

	/** (Re)build the encoded frames for the current terminal cell metrics. */
	#buildPixel(protocol: "sixel" | "kitty"): void {
		const cell = getCellDimensions();
		this.#builtCellW = cell.widthPx;
		this.#builtCellH = cell.heightPx;
		const skin: PetSkinId = this.#mode === "off" ? "red" : this.#mode;
		if (protocol === "kitty") {
			this.#kittyImageId ??= allocatePetKittyImageId();
			this.#kittyCleanupPending = true;
		}
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
		if (this.#disposed) {
			this.#cleanupCoordinator.flush();
			return;
		}
		this.#disposed = true;
		try {
			this.#writeImageCleanup(true);
		} finally {
			// A Kitty ID remains reserved until the coordinator confirms its exact-ID
			// delete; otherwise a successor could reuse it before stale cleanup arrives.
			if (this.#kittyImageId !== undefined && !this.#cleanupCoordinator.hasPendingKitty(this.#kittyImageId)) {
				allocatedPetKittyImageIds.delete(this.#kittyImageId);
			}
			this.#kittyImageId = undefined;
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
			// Disposal is also a recovery signal for coordinator-owned cleanup queued
			// by an earlier off-switch; it never reclaims widget-local authority.
			this.#cleanupCoordinator.flush();
		}
	}

	/** Clear the shared post-render slot only while this widget still owns it. */
	#releaseOverlayEmitter(): void {
		if (petOverlayEmitterOwners.get(this.#ui) === this) {
			this.#ui.setPostRenderEmitter(undefined);
			petOverlayEmitterOwners.delete(this.#ui);
		}
		if (this.#cleanupCoordinator.active === this) this.#cleanupCoordinator.active = undefined;
	}

	/** Queue visual cleanup before a successor takes this TUI's overlay authority. */
	prepareSuccessor(): boolean {
		this.#writeImageCleanup();
		return this.#cleanupCoordinator.flush();
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

	#scheduleAutoFlex(now: number): void {
		if (!this.#autoFlexGapMs) return;
		const [min, max] = this.#autoFlexGapMs;
		this.#nextAutoFlexAt = now + min + Math.random() * Math.max(0, max - min);
	}

	#tick(now: number): void {
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
		// Random show-off, both while idle and while working. Each skin's burst runs for
		// its own length (RedGajae a brief flex; BlueGajae a para-para cycle plus sob).
		if (this.#autoFlexGapMs && now >= this.#flexUntil) {
			if (this.#nextAutoFlexAt === 0) {
				this.#scheduleAutoFlex(now);
			} else if (now >= this.#nextAutoFlexAt) {
				const burstMs = petBurstDurationMs(PET_SKINS[this.#mode].burst);
				this.#flexUntil = now + burstMs;
				this.#scheduleAutoFlex(now + burstMs);
			}
		}
		const frame = this.#pickFrame(now);
		if (frame === this.#frame) return;
		this.#frame = frame;
		// Write directly: a frame swap changes no component line, so the TUI
		// would skip the render write (and with it the post-render emitter).
		const emission = this.#overlayPayload(true);
		if (emission && this.#ui.terminalAvailable) {
			if (this.#ui.writeTerminalCleanup(`\x1b[?2026h\x1b7${emission.payload}\x1b8\x1b[?2026l`)) {
				emission.onDelivered?.();
			}
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
		return clearSixelFootprint(footprint);
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
	 * Best-effort direct erase of the on-screen pet image. Cleanup authority is
	 * consumed only after the write is actually delivered: an unavailable
	 * terminal or a throwing write keeps the erase pending so a later mode
	 * switch or dispose can retry it.
	 */
	#writeImageCleanup(releaseKittyReservation = false): void {
		if (
			releaseKittyReservation &&
			this.#kittyImageId !== undefined &&
			this.#cleanupCoordinator.hasPendingKitty(this.#kittyImageId)
		) {
			// A stale owner may only upgrade the durable release metadata; it must
			// never emit or clear a successor's terminal resources itself.
			this.#cleanupCoordinator.queueKitty(this.#kittyImageId, true);
		}
		if (this.#cleanupCoordinator.active !== this) return;
		if (this.#kittyImageId !== undefined && (this.#kittyCleanupPending || releaseKittyReservation)) {
			this.#cleanupCoordinator.queueKitty(this.#kittyImageId, releaseKittyReservation);
			this.#kittyCleanupPending = false;
		}
		if (this.#lastSixelFootprint) {
			this.#cleanupCoordinator.queueSixel(this.#lastSixelFootprint);
			this.#lastSixelFootprint = undefined;
		}
		this.#cleanupCoordinator.flush();
	}

	/** Draw escape payload at the pet's absolute position. */
	#overlayPayload(clearPet = false): PostRenderEmission | null {
		if (this.#placementBlocked) {
			if (!this.#cleanupCoordinator.flush()) return null;
			this.#placementBlocked = false;
		}
		const pixel = this.#pixel;
		if (!pixel) return null;
		const pos = this.#petPosition();
		if (!pos) {
			const cleanup = this.#imageCleanupPayload();
			if (!cleanup) return null;
			return {
				payload: cleanup,
				onDelivered: () => this.#consumeCleanupAuthority(),
			};
		}
		const { x, y } = pos;
		let out = "";
		let sixelFootprint: SixelFootprint | undefined;

		if (pixel.protocol === "sixel") {
			sixelFootprint = {
				x,
				y,
				columns: pixel.columns,
				rows: pixel.rasterRows,
			};
			if (this.#lastSixelFootprint && !sameFootprint(this.#lastSixelFootprint, sixelFootprint)) {
				out += this.#clearSixelFootprint(this.#lastSixelFootprint);
			}
			if (clearPet) out += this.#clearSixelFootprint(sixelFootprint);
		}

		out += `\x1b[${y + 1};${x + 1}H${pixel.frames[this.#frame]}`;
		return {
			payload: out,
			onDelivered: () => {
				if (sixelFootprint) this.#lastSixelFootprint = sixelFootprint;
				else this.#kittyCleanupPending = true;
			},
		};
	}
}
