import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SttBackend, SttSession, SttStartOptions } from "../src/stt/backends/types";

interface FakeSessionScript {
	finalText?: string;
	failStart?: string;
}

class FakeSession implements SttSession {
	cancelled = false;
	stopped = false;
	options: SttStartOptions;
	#finalText: string;

	constructor(options: SttStartOptions, finalText: string) {
		this.options = options;
		this.#finalText = finalText;
	}

	async stop(): Promise<string> {
		this.stopped = true;
		return this.#finalText;
	}

	async cancel(): Promise<void> {
		this.cancelled = true;
	}
}

const script: FakeSessionScript = {};
let lastSession: FakeSession | null = null;

const fakeBackend: SttBackend = {
	id: "apple",
	streaming: true,
	async start(options: SttStartOptions): Promise<SttSession> {
		if (script.failStart) throw new Error(script.failStart);
		lastSession = new FakeSession(options, script.finalText ?? "");
		return lastSession;
	},
};

mock.module("../src/stt/backends", () => ({
	resolveSttBackend: async () => ({ backend: fakeBackend }),
}));

const { Settings } = await import("../src/config/settings");
await Settings.init({ inMemory: true });
const { STTController } = await import("../src/stt/stt-controller");

function harness() {
	const events: string[] = [];
	const inserted: string[] = [];
	const partials: Array<string | null> = [];
	const editor = { insertText: (text: string) => inserted.push(text) };
	const options = {
		showWarning: (msg: string) => events.push(`warn:${msg}`),
		showStatus: (msg: string) => events.push(`status:${msg}`),
		onStateChange: (state: string) => events.push(`state:${state}`),
		onPartial: (text: string | null) => partials.push(text),
		onLevel: (_level: number) => {},
	};
	return { events, inserted, partials, editor, options };
}

beforeEach(() => {
	script.finalText = undefined;
	script.failStart = undefined;
	lastSession = null;
});

describe("STTController", () => {
	test("toggle starts listening, second toggle inserts the final transcript", async () => {
		script.finalText = "fix the flaky test";
		const controller = new STTController();
		const { events, inserted, partials, editor, options } = harness();

		await controller.toggle(editor, options);
		expect(controller.state).toBe("recording");
		expect(events).toContain("state:recording");

		await controller.toggle(editor, options);
		expect(controller.state).toBe("idle");
		expect(inserted).toEqual(["fix the flaky test"]);
		// Ghost overlay is cleared exactly once at completion.
		expect(partials).toEqual([null]);
		expect(lastSession?.stopped).toBe(true);
	});

	test("streaming partials are forwarded as tail-shaped ghosts while recording", async () => {
		const controller = new STTController();
		const { partials, editor, options } = harness();
		await controller.toggle(editor, options);

		lastSession?.options.onPartial?.("hello world");
		expect(partials).toEqual(["hello world"]);

		// After cancel, late partials are dropped.
		controller.cancel(options);
		lastSession?.options.onPartial?.("late");
		expect(partials).toEqual(["hello world", null]);
	});

	test("cancel returns true only when a session is active and hard-cancels it", async () => {
		const controller = new STTController();
		const { editor, options, events } = harness();
		expect(controller.cancel(options)).toBe(false);

		await controller.toggle(editor, options);
		expect(controller.cancel(options)).toBe(true);
		expect(controller.state).toBe("idle");
		expect(lastSession?.cancelled).toBe(true);
		expect(events).toContain("status:Voice input cancelled.");
	});

	test("empty transcript reports 'No speech detected.' and inserts nothing", async () => {
		script.finalText = "   ";
		const controller = new STTController();
		const { events, inserted, editor, options } = harness();
		await controller.toggle(editor, options);
		await controller.toggle(editor, options);
		expect(inserted).toEqual([]);
		expect(events).toContain("status:No speech detected.");
		expect(controller.state).toBe("idle");
	});

	test("backend start failure warns and stays idle", async () => {
		script.failStart = "Speech recognition permission is denied.";
		const controller = new STTController();
		const { events, editor, options } = harness();
		await controller.toggle(editor, options);
		expect(controller.state).toBe("idle");
		expect(events.some(e => e.startsWith("warn:Speech recognition permission"))).toBe(true);
	});

	test("session error while listening resets to idle with a warning", async () => {
		const controller = new STTController();
		const { events, partials, editor, options } = harness();
		await controller.toggle(editor, options);
		lastSession?.options.onError?.("microphone disappeared");
		expect(controller.state).toBe("idle");
		expect(events).toContain("warn:microphone disappeared");
		expect(partials).toEqual([null]);
	});
});

describe("silent-input hint", () => {
	test("warns once after sustained all-zero levels, never after real signal", async () => {
		const { SILENT_INPUT_HINT } = await import("../src/stt/stt-controller");
		let clock = 0;
		const controller = new STTController({ now: () => clock });
		const { events, editor, options } = harness();
		await controller.toggle(editor, options);

		// Zero levels before the window elapses: no hint yet.
		lastSession?.options.onLevel?.(0);
		expect(events.filter(e => e === `status:${SILENT_INPUT_HINT}`)).toHaveLength(0);

		// Window elapses, then more zero levels: hint exactly once.
		clock = 4_000;
		lastSession?.options.onLevel?.(0);
		lastSession?.options.onLevel?.(0);
		expect(events.filter(e => e === `status:${SILENT_INPUT_HINT}`)).toHaveLength(1);

		controller.cancel(options);
	});

	test("no hint when the mic delivers signal", async () => {
		const { SILENT_INPUT_HINT } = await import("../src/stt/stt-controller");
		let clock = 0;
		const controller = new STTController({ now: () => clock });
		const { events, editor, options } = harness();
		await controller.toggle(editor, options);
		lastSession?.options.onLevel?.(0.4);
		clock = 10_000;
		lastSession?.options.onLevel?.(0);
		expect(events.filter(e => e === `status:${SILENT_INPUT_HINT}`)).toHaveLength(0);
		controller.cancel(options);
	});
});
