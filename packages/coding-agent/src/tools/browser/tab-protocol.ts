import type { ImageContent, TextContent } from "@gajae-code/ai";

export type Transferable = Bun.Transferable;

export interface ObservationEntry {
	id: number;
	role: string;
	name?: string;
	value?: string | number;
	description?: string;
	keyshortcuts?: string;
	states: string[];
}

export interface Observation {
	url: string;
	title?: string;
	viewport: { width: number; height: number; deviceScaleFactor?: number };
	scroll: {
		x: number;
		y: number;
		width: number;
		height: number;
		scrollWidth: number;
		scrollHeight: number;
	};
	elements: ObservationEntry[];
}

export interface ScreenshotResult {
	dest: string;
	mimeType: string;
	bytes: number;
	width: number;
	height: number;
}

export interface SessionSnapshot {
	cwd: string;
	browserScreenshotDir?: string;
}

export type WorkerInitPayload =
	| {
			mode: "headless";
			browserWSEndpoint: string;
			safeDir: string;
			viewport?: { width: number; height: number; deviceScaleFactor?: number };
			dialogs?: "accept" | "dismiss";
			url?: string;
			waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
			timeoutMs: number;
	  }
	| {
			mode: "attach";
			browserWSEndpoint: string;
			safeDir: string;
			targetId: string;
			dialogs?: "accept" | "dismiss";
	  };

export type ToolReply = { ok: true; value: unknown } | { ok: false; error: RunErrorPayload };

export type WorkerInbound =
	| { type: "init"; payload: WorkerInitPayload }
	| { type: "run"; id: string; name: string; code: string; timeoutMs: number; session: SessionSnapshot }
	| { type: "abort"; id: string }
	| { type: "tool-reply"; id: string; reply: ToolReply }
	| { type: "close" };

/** Backend-neutral tab info shared by native and Aside drivers (no CDP concepts). */
export interface BrowserTabInfo {
	url: string;
	title?: string;
	viewport: { width: number; height: number; deviceScaleFactor?: number };
}

/** Native (Puppeteer/CDP) readiness info: backend-neutral info plus the CDP target id. */
export interface NativeReadyInfo extends BrowserTabInfo {
	targetId: string;
}

/**
 * Native worker readiness payload. Aliased to NativeReadyInfo so the CDP `targetId`
 * stays native-only; Aside never produces a fake targetId (it uses BrowserTabInfo).
 */
export type ReadyInfo = NativeReadyInfo;

export interface RunResultOk {
	displays: Array<TextContent | ImageContent>;
	returnValue: unknown;
	screenshots: ScreenshotResult[];
}

export interface RunErrorPayload {
	name: string;
	message: string;
	stack?: string;
	isToolError: boolean;
	isAbort: boolean;
}

export type WorkerOutbound =
	| { type: "ready"; info: ReadyInfo }
	| { type: "init-failed"; error: RunErrorPayload }
	| { type: "result"; id: string; ok: true; payload: RunResultOk }
	| { type: "result"; id: string; ok: false; error: RunErrorPayload }
	| { type: "tool-call"; id: string; runId: string; name: string; args: unknown }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> }
	| { type: "closed" };

export interface Transport {
	send(msg: WorkerOutbound | WorkerInbound, transferList?: Transferable[]): void;
	onMessage(handler: (msg: WorkerOutbound | WorkerInbound) => void): () => void;
	close(): void;
}
