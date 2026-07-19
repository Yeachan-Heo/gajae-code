/**
 * Debug command handler with interactive menu.
 *
 * Provides tools for debugging, bug report generation, and system diagnostics.
 */
import * as fs from "node:fs/promises";
import * as url from "node:url";
import { getWorkProfile } from "@gajae-code/natives";
import { Container, Loader, type SelectItem, SelectList, Spacer, Text } from "@gajae-code/tui";
import { getSessionsDir } from "@gajae-code/utils";
import { DynamicBorder } from "../modes/components/dynamic-border";
import { getSelectListTheme, getSymbolTheme, theme } from "../modes/theme/theme";
import type { InteractiveModeContext } from "../modes/types";
import { formatBytes } from "../tools/render-utils";
import { openPath } from "../utils/open";
import { DebugLogViewerComponent } from "./log-viewer";
import { generateHeapSnapshotData, type ProfilerSession, startCpuProfile } from "./profiler";
import { RawSseViewerComponent } from "./raw-sse";
import { resolveRawSseDebugBuffer } from "./raw-sse-buffer";
import { clearArtifactCache, createDebugLogSource, createReportBundle, getArtifactCacheStats } from "./report-bundle";
import { collectSystemInfo, formatSystemInfo } from "./system-info";

/** Debug menu options */
const DEBUG_MENU_ITEMS: SelectItem[] = [
	{ value: "open-artifacts", label: "Open: artifact folder", description: "Open session artifacts in file manager" },
	{ value: "performance", label: "Report: performance issue", description: "Profile CPU, reproduce, then bundle" },
	{ value: "work", label: "Profile: work scheduling", description: "Open flamegraph of last 30s" },
	{ value: "dump", label: "Report: dump session", description: "Create report bundle immediately" },
	{ value: "memory", label: "Report: memory issue", description: "Heap snapshot + bundle" },
	{ value: "logs", label: "View: recent logs", description: "Show last 50 log entries" },
	{ value: "system", label: "View: system info", description: "Show environment details" },
	{ value: "raw-sse", label: "View: raw SSE stream", description: "Show live provider SSE frames" },
	{
		value: "transcript",
		label: "Export: TUI transcript",
		description: "Write visible TUI conversation to a temp txt",
	},
	{ value: "clear-cache", label: "Clear: artifact cache", description: "Remove old session artifacts" },
];

const formatFileHyperlink = (path: string): string => {
	const fileUrl = url.pathToFileURL(path).href;
	return `\x1b]8;;${fileUrl}\x07${path}\x1b]8;;\x07`;
};

/**
 * Debug selector component.
 */
export class DebugSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(
		private ctx: InteractiveModeContext,
		onDone: () => void,
	) {
		super();

		// Title
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "Debug Tools")), 1, 0));
		this.addChild(new Spacer(1));

		// Select list
		this.#selectList = new SelectList(DEBUG_MENU_ITEMS, 7, getSelectListTheme());

		this.#selectList.onSelect = item => {
			onDone();
			void this.#handleSelection(item.value);
		};

		this.#selectList.onCancel = () => {
			onDone();
		};

		this.addChild(this.#selectList);
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		this.#selectList.handleInput(keyData);
	}

	async #handleSelection(value: string): Promise<void> {
		switch (value) {
			case "open-artifacts":
				await this.#handleOpenArtifacts();
				break;
			case "performance":
				await this.#handlePerformanceReport();
				break;
			case "work":
				await this.#handleWorkReport();
				break;
			case "dump":
				await this.#handleDumpReport();
				break;
			case "memory":
				await this.#handleMemoryReport();
				break;
			case "logs":
				await this.#handleViewLogs();
				break;
			case "raw-sse":
				await this.#handleViewRawSse();
				break;
			case "system":
				await this.#handleViewSystemInfo();
				break;
			case "transcript":
				await this.#handleTranscriptExport();
				break;
			case "clear-cache":
				await this.#handleClearCache();
				break;
		}
	}

	async #handlePerformanceReport(): Promise<void> {
		// Start profiling
		let session: ProfilerSession;
		try {
			session = await startCpuProfile();
		} catch (err) {
			this.ctx.showError(`Failed to start profiler: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		// Show message and wait for keypress
		this.ctx.chatContainer.addChild(new Spacer(1));
		this.ctx.chatContainer.addChild(new Text(theme.fg("accent", `${theme.status.info} CPU profiling started`), 1, 0));
		this.ctx.chatContainer.addChild(new Spacer(1));
		this.ctx.chatContainer.addChild(
			new Text(theme.fg("muted", "Reproduce the performance issue, then press Enter to stop profiling."), 1, 0),
		);
		this.ctx.ui.requestRender();

		// Wait for Enter keypress
		const { promise, resolve } = Promise.withResolvers<void>();
		const originalOnEscape = this.ctx.editor.onEscape;
		const originalOnSubmit = this.ctx.editor.onSubmit;

		this.ctx.editor.onSubmit = () => {
			this.ctx.editor.onEscape = originalOnEscape;
			this.ctx.editor.onSubmit = originalOnSubmit;
			resolve();
		};

		this.ctx.editor.onEscape = () => {
			this.ctx.editor.onEscape = originalOnEscape;
			this.ctx.editor.onSubmit = originalOnSubmit;
			resolve();
		};

		await promise;

		// Stop profiling and create report
		const loader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			"Generating report...",
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(loader);
		this.ctx.ui.requestRender();

		try {
			const cpuProfile = await session.stop();
			const workProfile = getWorkProfile(30);
			const result = await createReportBundle({
				sessionFile: this.ctx.sessionManager.getSessionFile(),
				settings: this.#getResolvedSettings(),
				cpuProfile,
				workProfile,
			});

			loader.stop();
			this.ctx.statusContainer.clear();

			this.ctx.chatContainer.addChild(new Spacer(1));
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("success", `${theme.status.success} Performance report saved`), 1, 0),
			);
			this.ctx.chatContainer.addChild(new Text(theme.fg("dim", formatFileHyperlink(result.path)), 1, 0));
			this.ctx.chatContainer.addChild(new Text(theme.fg("dim", `Files: ${result.files.length}`), 1, 0));
		} catch (err) {
			loader.stop();
			this.ctx.statusContainer.clear();
			this.ctx.showError(`Failed to create report: ${err instanceof Error ? err.message : String(err)}`);
		}

		this.ctx.ui.requestRender();
	}

	async #handleWorkReport(): Promise<void> {
		try {
			const workProfile = getWorkProfile(30);

			if (!workProfile.svg) {
				this.ctx.showWarning(`No work profile data (${workProfile.sampleCount} samples)`);
				return;
			}

			// Write SVG to temp file and open in browser
			const tmpPath = `/tmp/work-profile-${Date.now()}.svg`;
			await Bun.write(tmpPath, workProfile.svg);

			openPath(tmpPath);

			this.ctx.chatContainer.addChild(new Spacer(1));
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("dim", `Opened flamegraph (${workProfile.sampleCount} samples)`), 1, 0),
			);
		} catch (err) {
			this.ctx.showError(`Failed to open profile: ${err instanceof Error ? err.message : String(err)}`);
		}

		this.ctx.ui.requestRender();
	}

	async #handleDumpReport(): Promise<void> {
		const loader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			"Creating report bundle...",
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(loader);
		this.ctx.ui.requestRender();

		try {
			const result = await createReportBundle({
				sessionFile: this.ctx.sessionManager.getSessionFile(),
				settings: this.#getResolvedSettings(),
			});

			loader.stop();
			this.ctx.statusContainer.clear();

			this.ctx.chatContainer.addChild(new Spacer(1));
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("success", `${theme.status.success} Report bundle saved`), 1, 0),
			);
			this.ctx.chatContainer.addChild(new Text(theme.fg("dim", formatFileHyperlink(result.path)), 1, 0));
			this.ctx.chatContainer.addChild(new Text(theme.fg("dim", `Files: ${result.files.length}`), 1, 0));
		} catch (err) {
			loader.stop();
			this.ctx.statusContainer.clear();
			this.ctx.showError(`Failed to create report: ${err instanceof Error ? err.message : String(err)}`);
		}

		this.ctx.ui.requestRender();
	}

	async #handleMemoryReport(): Promise<void> {
		const loader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			"Generating heap snapshot...",
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(loader);
		this.ctx.ui.requestRender();

		try {
			const heapSnapshot = generateHeapSnapshotData();
			loader.setText("Creating report bundle...");

			const result = await createReportBundle({
				sessionFile: this.ctx.sessionManager.getSessionFile(),
				settings: this.#getResolvedSettings(),
				heapSnapshot,
			});

			loader.stop();
			this.ctx.statusContainer.clear();

			this.ctx.chatContainer.addChild(new Spacer(1));
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("success", `${theme.status.success} Memory report saved`), 1, 0),
			);
			this.ctx.chatContainer.addChild(new Text(theme.fg("dim", formatFileHyperlink(result.path)), 1, 0));
			this.ctx.chatContainer.addChild(new Text(theme.fg("dim", `Files: ${result.files.length}`), 1, 0));
		} catch (err) {
			loader.stop();
			this.ctx.statusContainer.clear();
			this.ctx.showError(`Failed to create report: ${err instanceof Error ? err.message : String(err)}`);
		}

		this.ctx.ui.requestRender();
	}

	async #handleViewLogs(): Promise<void> {
		try {
			const logSource = await createDebugLogSource();
			const logs = await logSource.getInitialText();
			if (!logs && !logSource.hasOlderLogs()) {
				this.ctx.showWarning("No log entries found for today.");
				return;
			}

			const viewer = new DebugLogViewerComponent({
				logs,
				terminalRows: this.ctx.ui.terminal.rows,
				onExit: () => this.ctx.showDebugSelector(),
				onStatus: message => this.ctx.showStatus(message, { dim: true }),
				onError: message => this.ctx.showError(message),
				onUpdate: () => this.ctx.ui.requestRender(),
				logSource,
			});

			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(viewer);
			this.ctx.ui.setFocus(viewer);
		} catch (err) {
			this.ctx.showError(`Failed to read logs: ${err instanceof Error ? err.message : String(err)}`);
		}

		this.ctx.ui.requestRender();
	}

	async #handleViewRawSse(): Promise<void> {
		const viewer = new RawSseViewerComponent({
			buffer: resolveRawSseDebugBuffer(this.ctx.session),
			terminalRows: this.ctx.ui.terminal.rows,
			onExit: () => this.ctx.showDebugSelector(),
			onStatus: message => this.ctx.showStatus(message, { dim: true }),
			onUpdate: () => this.ctx.ui.requestRender(),
		});

		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(viewer);
		this.ctx.ui.setFocus(viewer);
		this.ctx.ui.requestRender();
	}

	async #handleViewSystemInfo(): Promise<void> {
		try {
			const info = await collectSystemInfo();
			const formatted = formatSystemInfo(info);

			this.ctx.chatContainer.addChild(new Spacer(1));
			this.ctx.chatContainer.addChild(new DynamicBorder());
			this.ctx.chatContainer.addChild(new Text(formatted, 1, 0));
			this.ctx.chatContainer.addChild(new DynamicBorder());
		} catch (err) {
			this.ctx.showError(`Failed to collect system info: ${err instanceof Error ? err.message : String(err)}`);
		}

		this.ctx.ui.requestRender();
	}

	async #handleTranscriptExport(): Promise<void> {
		await this.ctx.handleDebugTranscriptCommand();
	}
	async #handleOpenArtifacts(): Promise<void> {
		const sessionFile = this.ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			this.ctx.showWarning("No active session file.");
			return;
		}

		const artifactsDir = sessionFile.slice(0, -6);

		try {
			const stat = await fs.stat(artifactsDir);
			if (!stat.isDirectory()) {
				this.ctx.showWarning("Artifact folder does not exist yet.");
				return;
			}
		} catch {
			this.ctx.showWarning("Artifact folder does not exist yet.");
			return;
		}

		openPath(artifactsDir);
		this.ctx.showStatus(`Opened: ${artifactsDir}`);
	}

	async #handleClearCache(): Promise<void> {
		const sessionsDir = getSessionsDir();

		// Get stats first
		const stats = await getArtifactCacheStats(sessionsDir);

		if (stats.count === 0) {
			this.ctx.showStatus("Artifact cache is empty.");
			return;
		}

		const sizeStr = formatBytes(stats.totalSize);
		const oldestStr = stats.oldestDate ? stats.oldestDate.toLocaleDateString() : "unknown";

		// Show confirmation
		const confirmed = await this.ctx.showHookConfirm(
			"Clear Artifact Cache",
			`Found ${stats.count} artifact files (${sizeStr})\nOldest: ${oldestStr}\n\nRemove artifacts older than 30 days?`,
		);

		if (!confirmed) {
			this.ctx.showStatus("Cache clear cancelled.");
			return;
		}

		// Clear cache
		const loader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			"Clearing artifact cache...",
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(loader);
		this.ctx.ui.requestRender();

		try {
			const result = await clearArtifactCache(sessionsDir, 30);

			loader.stop();
			this.ctx.statusContainer.clear();

			this.ctx.chatContainer.addChild(new Spacer(1));
			this.ctx.chatContainer.addChild(
				new Text(
					theme.fg("success", `${theme.status.success} Cleared ${result.removed} artifact directories`),
					1,
					0,
				),
			);
		} catch (err) {
			loader.stop();
			this.ctx.statusContainer.clear();
			this.ctx.showError(`Failed to clear cache: ${err instanceof Error ? err.message : String(err)}`);
		}

		this.ctx.ui.requestRender();
	}

	#getResolvedSettings(): Record<string, unknown> {
		// Extract key settings for the report
		return {
			model: this.ctx.session.model?.id,
			thinkingLevel: this.ctx.session.thinkingLevel,
			planModeEnabled: this.ctx.planModeController.enabled,
			toolOutputExpanded: this.ctx.toolOutputExpanded,
			hideThinkingBlock: this.ctx.hideThinkingBlock,
		};
	}
}

/**
 * Show the debug selector.
 */
export function showDebugSelector(ctx: InteractiveModeContext, done: () => void): DebugSelectorComponent {
	const selector = new DebugSelectorComponent(ctx, done);
	return selector;
}
