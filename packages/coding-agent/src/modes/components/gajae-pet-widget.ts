import {
	type AnimationRegistration,
	buildGajaePixelFrames,
	type CellRect,
	type Component,
	type Container,
	type GajaeGifFrame,
	type GajaeGifTimeline,
	type GajaePixelFrames,
	getCellDimensions,
	getGajaePetGifCached,
	PET_SKINS,
	type PetBurst,
	type PetFrameName,
	type PetMode,
	type PetSkinId,
	petBurstDurationMs,
	petBurstFrame,
	type RasterLeaseToken,
	registerAnimationCallback,
	type TUI,
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
const PET_ART_ROWS = 2;
const ITERM_CANVAS_ROWS = PET_ART_ROWS + 1;
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

type PetOverlayEmission = {
	payload: string;
	onWritten?: () => void;
};

/**
 * Which widget currently owns each TUI's single shared post-render emitter
 * slot. A stale or repeated dispose (or off-switch) of a predecessor widget
 * must never clear a successor's overlay authority.
 */
const petOverlayEmitterOwners = new WeakMap<TUI, GajaePetWidget>();
const petOverlayOwnershipEpochs = new WeakMap<TUI, number>();

/** Random gap between automatic claw flexes while work is active. */
const AUTO_FLEX_MIN_GAP_MS = 12_000;
const AUTO_FLEX_MAX_GAP_MS = 40_000;
function animationFrameAt(
	steps: ReadonlyArray<readonly [PetFrameName, number]>,
	now: number,
	fallback: PetFrameName,
): PetFrameName {
	const total = steps.reduce((sum, [, ms]) => sum + ms, 0);
	if (total <= 0) return fallback;
	let elapsed = now % total;
	for (const [frame, ms] of steps) {
		if (elapsed < ms) return frame;
		elapsed -= ms;
	}
	return fallback;
}

function animationFrameAtElapsed(
	steps: ReadonlyArray<readonly [PetFrameName, number]>,
	elapsed: number,
	fallback: PetFrameName,
): PetFrameName {
	for (const [frame, ms] of steps) {
		if (elapsed < ms) return frame;
		elapsed -= ms;
	}
	return fallback;
}

function animationDuration(steps: ReadonlyArray<readonly [PetFrameName, number]>): number {
	return steps.reduce((sum, [, ms]) => sum + ms, 0);
}

function gifTimeline(steps: ReadonlyArray<readonly [PetFrameName, number]>): GajaeGifFrame[] {
	return steps.map(([name, delayMs]) => ({ name, delayMs }));
}

function burstGifTimeline(burst: PetBurst): GajaeGifTimeline {
	const frames = gifTimeline(burst.intro);
	const tail = burst.tail;
	if (!tail || tail.frames.length === 0) return frames;
	for (let elapsed = 0; elapsed < tail.ms; elapsed += tail.stepMs) {
		frames.push({
			name: tail.frames[Math.floor(elapsed / tail.stepMs) % tail.frames.length]!,
			delayMs: Math.min(tail.stepMs, tail.ms - elapsed),
		});
	}
	return frames;
}

function timelineSignature(frames: GajaeGifTimeline): string {
	return frames.map(({ name, delayMs }) => `${name}:${delayMs}`).join(",");
}

interface WorkTransition {
	startedAt: number;
	steps: ReadonlyArray<readonly [PetFrameName, number]>;
}

const OUROBOROS_WORK_BURST_MIN_GAP_MS = 14_000;
const OUROBOROS_WORK_BURST_MAX_GAP_MS = 30_000;

/** Selector preview: fire the first burst this soon after a skin is previewed. */
const PREVIEW_INTRO_MS = 2300;

/** Reserve a right-side area beside the composer where the pixel pet is drawn. */
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
		if (!this.canFit(width)) return this.#editor.render(width);
		return this.#editor.render(width - this.#reserve);
	}
}

/** The gajae pet pixel sprite and protocol-specific rendering lifecycle. */
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
	#frame: PetFrameName = "base";
	#animation: AnimationRegistration | undefined;
	#flexUntil = 0;
	#activeBurst: PetBurst | undefined;
	#nextAutoFlexAt = 0;
	#working = false;
	#workTransition: WorkTransition | undefined;
	#nextWorkBurstAt = 0;
	#workBurstIndex = 0;
	#flexSource: "preview" | "working" | undefined;
	#previewFlexAt = 0;
	#autoFlexGapMs: [number, number] | null;
	#forcedProtocol: "sixel" | "kitty" | "iterm" | undefined;
	#builtCellW = 0;
	#builtCellH = 0;
	#kittyImageId: number | undefined;
	#kittyCleanupPending = false;
	#kittyCleanupGeneration = 0;
	#lastSixelFootprint: SixelFootprint | undefined;
	#disposed = false;
	#ownedOverlayEpoch = 0;
	#itermLease: RasterLeaseToken | undefined;
	#disposePromise: Promise<void> | undefined;
	#disposeRasterBarrier: Promise<void> = Promise.resolve();
	#disposeNeedsLifecycle = false;
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
		getComposerBottomOffset: () => number;
		syncManagedItermCursor: (row: number, column: number) => Promise<boolean>;
		forcePixelProtocol?: "sixel" | "kitty";
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

	async suspendItermCapability(): Promise<void> {
		if (!this.#isActiveOwner()) return;
		this.#itermGeneration++;
		const lease = this.#itermLease;
		this.#itermLease = undefined;
		this.#itermLastSemantic = "";
		if (lease) await this.#ui.invalidateRasterLease({ token: lease, cause: "capability-loss" });
		this.#ui.requestRender(true);
	}

	previewMode(mode: PetMode): void {
		if (this.#disposed) return;
		this.#applyMode(mode, false);
		if (!this.#isActiveOwner() || mode === "off" || !this.#autoFlexGapMs) return;
		this.#previewFlexAt = performance.now() + PREVIEW_INTRO_MS;
	}

	commitPreviewMode(mode: PetMode): void {
		this.#applyMode(mode, false);
	}

	#applyMode(mode: PetMode, mountComposer: boolean): void {
		if (this.#disposed || mode === this.#mode) return;
		if (mode === "off") {
			if (!this.#canMutateSharedUi()) return;
			this.#itermGeneration++;
			if (this.#itermLease) {
				void this.#ui.invalidateRasterLease({ token: this.#itermLease, cause: "mode-off" });
				this.#itermLease = undefined;
			}
			this.#itermLastSemantic = "";
			this.#itermProtocol = false;
			this.#queueImageCleanup(true);
			this.#mode = "off";
			this.#animation?.unregister();
			this.#animation = undefined;
			this.#releaseOverlayEmitter();
			this.#floorContainer.clear();
			this.#pixel = undefined;
			this.#activeBurst = undefined;
			this.#workTransition = undefined;
			this.#nextWorkBurstAt = 0;
			this.#framedEditor.setReserve(0);
			if (mountComposer) this.#mountEditor(false);
			this.#ui.requestRender(true);
			return;
		}

		const protocol = this.#forcedProtocol ?? GajaePetWidget.pixelProtocol();
		const ownershipEpoch = petOverlayOwnershipEpochs.get(this.#ui) ?? 0;
		if (!protocol || (this.#ownedOverlayEpoch !== 0 && this.#ownedOverlayEpoch < ownershipEpoch)) return;
		const predecessor = petOverlayEmitterOwners.get(this.#ui);
		if (predecessor && predecessor !== this) predecessor.#retireForSuccessor();
		this.#itermGeneration++;
		if (this.#itermLease) {
			void this.#ui.invalidateRasterLease({ token: this.#itermLease, cause: "explicit" });
			this.#itermLease = undefined;
		}
		this.#itermLastSemantic = "";
		if (this.#mode !== "off") {
			const releasesKittyImage = this.#pixel?.protocol === "kitty" && protocol !== "kitty";
			this.#queueImageCleanup(releasesKittyImage);
		}
		this.#mode = mode;
		this.#frame = PET_SKINS[mode].baseFrame;
		this.#flexUntil = 0;
		this.#activeBurst = undefined;
		this.#flexSource = undefined;
		this.#working = this.#isWorking();
		this.#workTransition = undefined;
		this.#nextWorkBurstAt = 0;
		this.#workBurstIndex = 0;
		this.#previewFlexAt = 0;
		this.#nextAutoFlexAt = 0;
		this.#buildPixel(protocol);
		if (mountComposer) this.#mountEditor(true);
		this.#floorContainer.clear();
		this.#ui.setPostRenderEmitter(() => this.#overlayEmission());
		this.#ownedOverlayEpoch = ownershipEpoch + 1;
		petOverlayOwnershipEpochs.set(this.#ui, this.#ownedOverlayEpoch);
		petOverlayEmitterOwners.set(this.#ui, this);
		this.#animation ??= registerAnimationCallback(now => this.#tick(now), 80);
		this.#ui.requestRender(true);
	}

	#isActiveOwner(): boolean {
		return !this.#disposed && petOverlayEmitterOwners.get(this.#ui) === this;
	}

	#canMutateSharedUi(): boolean {
		const owner = petOverlayEmitterOwners.get(this.#ui);
		return (
			owner === this ||
			(owner === undefined &&
				this.#ownedOverlayEpoch !== 0 &&
				this.#ownedOverlayEpoch === (petOverlayOwnershipEpochs.get(this.#ui) ?? 0))
		);
	}

	#retireForSuccessor(): void {
		this.dispose();
	}

	#buildPixel(protocol: "sixel" | "kitty" | "iterm"): void {
		const cell = getCellDimensions();
		this.#builtCellW = cell.widthPx;
		this.#builtCellH = cell.heightPx;
		const skin: PetSkinId = this.#mode === "off" ? "red" : this.#mode;
		if (protocol === "kitty") {
			this.#kittyImageId ??= allocatePetKittyImageId();
			this.#kittyCleanupGeneration++;
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
		const canMutateSharedUi = this.#canMutateSharedUi();
		this.#disposeNeedsLifecycle = canMutateSharedUi;
		this.#disposed = true;
		this.#itermGeneration++;
		const lease = this.#itermLease;
		this.#itermLease = undefined;
		if (lease)
			this.#disposeRasterBarrier = this.#ui
				.invalidateRasterLease({ token: lease, cause: "dispose" })
				.then(() => undefined);
		const cleanupBarrier = canMutateSharedUi ? this.#queueImageCleanup(true) : this.#queueImageCleanup(true, false);
		this.#disposeRasterBarrier = Promise.all([this.#disposeRasterBarrier, cleanupBarrier]).then(() => undefined);
		this.#animation?.unregister();
		this.#animation = undefined;
		this.#releaseOverlayEmitter();
		this.#mode = "off";
		this.#pixel = undefined;
		this.#activeBurst = undefined;
		this.#workTransition = undefined;
		this.#nextWorkBurstAt = 0;
		if (canMutateSharedUi) {
			this.#floorContainer.clear();
			this.#framedEditor.setReserve(0);
			if (this.#editorContainer.children.includes(this.#framedEditor)) this.#mountEditor(false);
		}
	}

	async disposeAsync(): Promise<void> {
		if (!this.#disposePromise) {
			this.dispose();
			if (!this.#disposeNeedsLifecycle) return;
			this.#disposePromise = this.#disposeRasterBarrier
				.then(() =>
					this.#ui.notifyTerminalLifecycle({
						kind: "explicit-cleanup",
						source: "interactive-mode",
						terminalGeneration: this.#ui.terminalGeneration,
					}),
				)
				.then(() => undefined);
		}
		await this.#disposePromise;
	}

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

	remountComposer(): void {
		if (this.#canMutateSharedUi()) this.#mountEditor(this.#mode !== "off");
	}

	#syncWorkingState(now: number): PetSkinId | undefined {
		if (this.#mode === "off") return undefined;
		const skin = PET_SKINS[this.#mode];
		const working = this.#isWorking();
		if (working !== this.#working) {
			this.#working = working;
			this.#flexUntil = 0;
			this.#activeBurst = undefined;
			this.#nextWorkBurstAt = 0;
			const steps = working ? skin.workEnter : skin.workExit;
			this.#workTransition = steps?.length ? { startedAt: now, steps } : undefined;
		}
		return this.#mode;
	}

	#pickFrame(now: number): PetFrameName {
		const mode = this.#mode;
		if (mode === "off") return "base";
		const skin = PET_SKINS[mode];
		this.#syncWorkingState(now);
		if (this.#workTransition) {
			const elapsed = now - this.#workTransition.startedAt;
			const duration = animationDuration(this.#workTransition.steps);
			if (elapsed < duration) return animationFrameAtElapsed(this.#workTransition.steps, elapsed, skin.baseFrame);
			this.#workTransition = undefined;
		}
		if (now < this.#flexUntil) {
			const burst = this.#activeBurst ?? skin.burst;
			const elapsed = now - (this.#flexUntil - petBurstDurationMs(burst));
			return petBurstFrame(burst, elapsed, now);
		}
		return this.#isWorking()
			? animationFrameAt(skin.work, now, skin.baseFrame)
			: animationFrameAt(skin.idle, now, skin.baseFrame);
	}

	#itermTimeline(now: number, working: boolean, flexing: boolean): GajaeGifTimeline {
		if (this.#mode === "off") return gifTimeline([]);
		this.#syncWorkingState(now);
		const skin = PET_SKINS[this.#mode];
		if (flexing) return burstGifTimeline(this.#activeBurst ?? skin.burst);
		if (this.#workTransition) {
			const elapsed = now - this.#workTransition.startedAt;
			if (elapsed < animationDuration(this.#workTransition.steps)) return gifTimeline(this.#workTransition.steps);
			this.#workTransition = undefined;
		}
		return gifTimeline(working ? skin.work : skin.idle);
	}

	#tickIterm(now: number): void {
		if (!this.#ui.isRunning || !this.#isActiveOwner() || this.#ui.manualViewportActive) return;
		const cell = getCellDimensions();
		const pixelColumns = Math.max(1, Math.ceil((PET_ART_ROWS * cell.heightPx) / cell.widthPx));
		const pixelRows = ITERM_CANVAS_ROWS;
		let metricsChanged = false;
		if (cell.widthPx !== this.#builtCellW || cell.heightPx !== this.#builtCellH) {
			metricsChanged = true;
			this.#itermGeneration++;
			const lease = this.#itermLease;
			this.#itermLease = undefined;
			if (lease) void this.#ui.invalidateRasterLease({ token: lease, cause: "resize" });
			this.#itermLastSemantic = "";
			this.#builtCellW = cell.widthPx;
			this.#builtCellH = cell.heightPx;
			this.#framedEditor.setReserve(pixelColumns + PET_SIDE_MARGIN);
			this.#ui.requestRender(true);
		}
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
		const terminalRows = this.#ui.terminal.rows;
		if (terminalRows < ITERM_CANVAS_ROWS + PET_RAISE_ROWS) {
			if (!metricsChanged) {
				this.#itermGeneration++;
				const lease = this.#itermLease;
				this.#itermLease = undefined;
				if (lease) void this.#ui.invalidateRasterLease({ token: lease, cause: "resize" });
			}
			this.#itermLastSemantic = "";
			return;
		}
		const composerBottom = terminalRows - this.#getComposerBottomOffset();
		const desiredRow = composerBottom - pixelRows;
		const maxSafeRow =
			terminalRows === ITERM_CANVAS_ROWS + PET_RAISE_ROWS
				? terminalRows - pixelRows - PET_RAISE_ROWS
				: terminalRows - pixelRows;
		const rect: CellRect = {
			column: Math.max(0, this.#ui.terminal.columns - pixelColumns - PET_SIDE_MARGIN),
			row: Math.max(0, Math.min(desiredRow, maxSafeRow)),
			width: pixelColumns,
			height: pixelRows,
		};
		const availability = getVerifiedItermPetAvailability();
		if (!availability?.available || getItermPetUnavailableReason() || !this.#ui.terminalAvailable) return;
		this.#syncWorkingState(now);
		const working = this.#isWorking();
		const flexing = this.#flexUntil > now;
		const frames = this.#itermTimeline(now, working, flexing);
		const semantic = `${this.#mode}:${availability.mode}:${availability.epoch}:${working}:${flexing}:${timelineSignature(frames)}:${rect.column},${rect.row}:${cell.widthPx},${cell.heightPx}:${this.#ui.terminal.columns},${this.#ui.terminal.rows}`;
		if (this.#itermSubmitPending || (semantic === this.#itermLastSemantic && this.#itermLease)) return;
		this.#itermLastSemantic = semantic;
		this.#itermSubmitPending = true;
		const generation = this.#itermGeneration;
		void this.#submitIterm(
			rect,
			generation,
			availability.epoch,
			availability.mode,
			semantic,
			working,
			flexing,
			frames,
			{
				columns: this.#ui.terminal.columns,
				rows: terminalRows,
				cellWidthPx: cell.widthPx,
				cellHeightPx: cell.heightPx,
			},
			this.#getComposerBottomOffset(),
		).finally(() => {
			this.#itermSubmitPending = false;
			if (!this.#itermLease) this.#itermLastSemantic = "";
		});
	}

	async #submitIterm(
		rect: CellRect,
		generation: number,
		epoch: number,
		mode: "direct" | "managed",
		semantic: string,
		working: boolean,
		flexing: boolean,
		frames: GajaeGifTimeline,
		geometry: Readonly<{ columns: number; rows: number; cellWidthPx: number; cellHeightPx: number }>,
		composerBottomOffset: number,
	): Promise<void> {
		const current = () => {
			const availability = getVerifiedItermPetAvailability();
			const flexingNow = this.#flexUntil > performance.now();
			const terminal = this.#ui.terminal;
			const cell = getCellDimensions();
			const liveComposerBottomOffset = this.#getComposerBottomOffset();
			const liveComposerBottom = terminal.rows - liveComposerBottomOffset;
			const liveMaxSafeRow =
				terminal.rows === ITERM_CANVAS_ROWS + PET_RAISE_ROWS
					? terminal.rows - rect.height - PET_RAISE_ROWS
					: terminal.rows - rect.height;
			const expectedColumn = Math.max(0, terminal.columns - rect.width - PET_SIDE_MARGIN);
			const expectedRow = Math.max(0, Math.min(liveComposerBottom - rect.height, liveMaxSafeRow));
			return (
				this.#ui.isRunning &&
				this.#isActiveOwner() &&
				generation === this.#itermGeneration &&
				availability?.available === true &&
				availability.epoch === epoch &&
				availability.mode === mode &&
				!this.#ui.manualViewportActive &&
				this.#isWorking() === working &&
				flexingNow === flexing &&
				timelineSignature(this.#itermTimeline(performance.now(), this.#isWorking(), flexingNow)) ===
					timelineSignature(frames) &&
				this.#framedEditor.canFit(terminal.columns) &&
				terminal.columns === geometry.columns &&
				terminal.rows === geometry.rows &&
				cell.widthPx === geometry.cellWidthPx &&
				cell.heightPx === geometry.cellHeightPx &&
				liveComposerBottomOffset === composerBottomOffset &&
				rect.column === expectedColumn &&
				rect.row === expectedRow &&
				rect.column + rect.width <= terminal.columns &&
				rect.row + rect.height <= terminal.rows
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
						`\x1b[0m${Array.from({ length: rect.height }, (_, row) => `\x1b[${rect.row + row + 1};${rect.column + 1}H\x1b[${rect.width}X`).join("")}`,
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
					await this.#ui.invalidateRasterLease({
						token: acquired.token,
						cause: this.#ui.manualViewportActive ? "manual-viewport" : "capability-loss",
					});
				return;
			}
			token = acquired.token;
			this.#itermLease = token;
		}
		this.#itermLastSemantic = semantic;
		const cell = getCellDimensions();
		const gif = getGajaePetGifCached({
			skin: this.#mode === "off" ? "red" : this.#mode,
			timeline: frames,
			targetRows: PET_ART_ROWS,
			rectangle: { width: rect.width * cell.widthPx, height: rect.height * cell.heightPx },
			contentInset: { topPx: Math.floor(cell.heightPx / 2), bottomPx: Math.ceil(cell.heightPx / 2) },
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
				prefix: new TextEncoder().encode(
					mode === "managed"
						? `${wrapITerm2RecordForTmux("\x1b[?2026h\x1b7\x1b[?25l")}\x1b7${cursorPosition}`
						: `\x1b[?2026h\x1b7\x1b[?25l${cursorPosition}`,
				),
				afterPrefix:
					mode === "managed"
						? async () => (current() ? await this.#syncManagedItermCursor(rect.row, rect.column) : false)
						: undefined,
				replayPrefix: mode === "managed" ? new TextEncoder().encode(cursorPosition) : undefined,
				records: encodedRecords,
				suffix: new TextEncoder().encode(cursorRestore),
				abortSuffix: mode === "managed" ? new TextEncoder().encode(cursorRestore) : undefined,
				restoreCursorVisibility: true,
				shouldWrite: current,
			},
		});
		if (!current() || submit.status !== "written") {
			await this.#ui.invalidateRasterLease({ token, cause: "capability-loss" });
			if (this.#itermLease === token) this.#itermLease = undefined;
		}
	}

	#scheduleWorkBurst(now: number): void {
		this.#nextWorkBurstAt =
			now +
			OUROBOROS_WORK_BURST_MIN_GAP_MS +
			Math.random() * (OUROBOROS_WORK_BURST_MAX_GAP_MS - OUROBOROS_WORK_BURST_MIN_GAP_MS);
	}

	#scheduleAutoFlex(now: number): void {
		if (!this.#autoFlexGapMs) return;
		const [min, max] = this.#autoFlexGapMs;
		this.#nextAutoFlexAt = now + min + Math.random() * Math.max(0, max - min);
	}

	#tick(now: number): void {
		if (!this.#isActiveOwner()) return;
		const skin = this.#mode === "off" ? undefined : PET_SKINS[this.#mode];
		this.#syncWorkingState(now);
		const working = this.#isWorking();
		if (!working) {
			this.#nextAutoFlexAt = 0;
			if (this.#flexSource === "working") {
				this.#flexUntil = 0;
				this.#flexSource = undefined;
			}
		}
		if (now >= this.#flexUntil) {
			this.#flexUntil = 0;
			this.#flexSource = undefined;
			if (this.#previewFlexAt !== 0 && now >= this.#previewFlexAt && skin) {
				this.#activeBurst = skin.burst;
				this.#flexUntil = now + petBurstDurationMs(skin.burst);
				this.#flexSource = "preview";
				this.#previewFlexAt = 0;
			} else if (this.#autoFlexGapMs && working && skin && !skin.workBursts?.length) {
				if (this.#nextAutoFlexAt === 0) this.#scheduleAutoFlex(now);
				else if (now >= this.#nextAutoFlexAt) {
					this.#activeBurst = skin.burst;
					const burstMs = petBurstDurationMs(skin.burst);
					this.#flexUntil = now + burstMs;
					this.#flexSource = "working";
					this.#scheduleAutoFlex(now + burstMs);
				}
			}
		}
		if (working && skin?.workBursts?.length && !this.#workTransition && now >= this.#flexUntil) {
			if (this.#nextWorkBurstAt === 0) this.#scheduleWorkBurst(now);
			else if (now >= this.#nextWorkBurstAt) {
				const burst = skin.workBursts[this.#workBurstIndex % skin.workBursts.length];
				this.#workBurstIndex++;
				this.#activeBurst = burst;
				this.#flexUntil = now + petBurstDurationMs(burst);
				this.#flexSource = "working";
				this.#scheduleWorkBurst(this.#flexUntil);
			}
		}
		if (this.#itermProtocol) {
			this.#tickIterm(now);
			return;
		}
		if (this.#mode === "off" || !this.#pixel) return;
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
		const pixel = this.#pixel;
		const mode = this.#mode;
		const position = this.#petPosition();
		const terminalColumns = this.#ui.terminal.columns;
		const terminalRows = this.#ui.terminal.rows;
		const queuedCell = getCellDimensions();
		const emission = this.#overlayEmission(true);
		if (emission && pixel && this.#ui.terminalAvailable) {
			void this.#ui.queueTerminalOutput(`\x1b[?2026h\x1b7${emission.payload}\x1b8\x1b[?2026l`, {
				shouldWrite: () => {
					const currentPosition = this.#petPosition();
					const currentCell = getCellDimensions();
					return (
						this.#isActiveOwner() &&
						this.#mode === mode &&
						this.#pixel === pixel &&
						this.#frame === frame &&
						this.#ui.terminal.columns === terminalColumns &&
						this.#ui.terminal.rows === terminalRows &&
						currentCell.widthPx === queuedCell.widthPx &&
						currentCell.heightPx === queuedCell.heightPx &&
						(position === null
							? currentPosition === null
							: currentPosition?.x === position.x && currentPosition.y === position.y)
					);
				},
				onWritten: emission.onWritten,
			});
		}
	}

	#petPosition(): { x: number; y: number } | null {
		const pixel = this.#pixel;
		if (!pixel) return null;
		const columns = this.#ui.terminal.columns;
		if (!this.#framedEditor.canFit(columns)) return null;
		const rows = this.#ui.terminal.rows;
		const composerBottom = rows - this.#getComposerBottomOffset();
		const y = composerBottom - pixel.rows - PET_RAISE_ROWS;
		const x = columns - pixel.columns - PET_SIDE_MARGIN;
		if (y < 0 || x < 0) return null;
		return { x, y };
	}

	#clearSixelFootprint(footprint: SixelFootprint): string {
		let out = "\x1b[0m";
		for (let row = 0; row < footprint.rows; row++)
			out += `\x1b[${footprint.y + row + 1};${footprint.x + 1}H\x1b[${footprint.columns}X`;
		return out;
	}

	#imageCleanupPayload(): string {
		let out = "";
		if (this.#kittyCleanupPending && this.#kittyImageId !== undefined)
			out += `\x1b_Ga=d,d=I,i=${this.#kittyImageId},q=2\x1b\\`;
		if (this.#lastSixelFootprint) out += this.#clearSixelFootprint(this.#lastSixelFootprint);
		return out;
	}

	#consumeCleanupAuthority(): void {
		this.#kittyCleanupPending = false;
		this.#lastSixelFootprint = undefined;
	}

	#queueImageCleanup(releaseKittyImage = false, includeSixel = true): Promise<void> {
		const sixelFootprint = includeSixel ? this.#lastSixelFootprint : undefined;
		const kittyImageId = this.#kittyCleanupPending ? this.#kittyImageId : undefined;
		const deliveredKittyImageId = releaseKittyImage && kittyImageId === undefined ? this.#kittyImageId : undefined;
		if (deliveredKittyImageId !== undefined) {
			this.#kittyImageId = undefined;
			allocatedPetKittyImageIds.delete(deliveredKittyImageId);
		}
		let payload = "";
		if (kittyImageId !== undefined) payload += `\x1b_Ga=d,d=I,i=${kittyImageId},q=2\x1b\\`;
		if (sixelFootprint) payload += this.#clearSixelFootprint(sixelFootprint);
		if (!payload) return Promise.resolve();
		const kittyCleanupGeneration = kittyImageId === undefined ? undefined : ++this.#kittyCleanupGeneration;
		if (releaseKittyImage && kittyImageId !== undefined && this.#kittyImageId === kittyImageId)
			this.#kittyImageId = undefined;
		return this.#ui.queueTerminalCleanup(`\x1b[?2026h\x1b7${payload}\x1b8\x1b[?2026l`, () => {
			if (sixelFootprint && this.#lastSixelFootprint && sameFootprint(this.#lastSixelFootprint, sixelFootprint))
				this.#lastSixelFootprint = undefined;
			if (
				kittyImageId !== undefined &&
				kittyCleanupGeneration === this.#kittyCleanupGeneration &&
				(this.#kittyImageId === kittyImageId || this.#kittyImageId === undefined)
			)
				this.#kittyCleanupPending = false;
			if (kittyImageId !== undefined && releaseKittyImage) allocatedPetKittyImageIds.delete(kittyImageId);
		});
	}

	#overlayEmission(clearPet = false): PetOverlayEmission | null {
		if (!this.#isActiveOwner()) return null;
		const pixel = this.#pixel;
		if (!pixel) return null;
		const pos = this.#petPosition();
		if (!pos) {
			const cleanup = this.#imageCleanupPayload();
			if (!cleanup) return null;
			return {
				payload: cleanup,
				onWritten: () => {
					if (this.#isActiveOwner()) this.#consumeCleanupAuthority();
				},
			};
		}
		const { x, y } = pos;
		let out = "";
		let onWritten: (() => void) | undefined;
		if (pixel.protocol === "sixel") {
			const footprint = { x, y, columns: pixel.columns, rows: pixel.rasterRows };
			const previous = this.#lastSixelFootprint;
			if (previous && !sameFootprint(previous, footprint)) out += this.#clearSixelFootprint(previous);
			if (clearPet) out += this.#clearSixelFootprint(footprint);
			onWritten = () => {
				if (this.#isActiveOwner()) this.#lastSixelFootprint = footprint;
			};
		} else {
			onWritten = () => {
				if (this.#isActiveOwner()) this.#kittyCleanupPending = true;
			};
		}
		out += `\x1b[${y + 1};${x + 1}H${pixel.frames[this.#frame]}`;
		return { payload: out, onWritten };
	}
}
