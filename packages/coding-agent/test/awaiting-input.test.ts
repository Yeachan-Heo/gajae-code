import { describe, expect, test } from "bun:test";
import { AwaitingInputDetector, type AwaitingInputSignal, classifyAwaitingInput } from "../src/tools/awaiting-input";

const TAILSCALE = "\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/1a2b3c4d5e6f\n\n";
const AZ_DEVICE =
	"To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD12345 to authenticate.\n";
const AWS_SSO =
	"Attempting to automatically open the SSO authorization page in your default browser.\nIf the browser does not open or you wish to use a different device to authorize this request, open the following URL:\n\nhttps://device.sso.us-east-1.amazonaws.com/\n\nThen enter the code:\n\nWXYZ-ABCD\n";
const GCLOUD =
	"Go to the following link in your browser:\n\n    https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=x\n\n";
const GH_DEVICE = "! First copy your one-time code: 1A2B-3C4D\nPress Enter to open github.com in your browser... ";

/** Manual scheduler: callbacks run only when the test advances time. */
function manualClock() {
	let now = 1_000;
	let pending: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
	return {
		now: () => now,
		schedule: (callback: () => void, ms: number) => {
			const entry = { at: now + ms, callback, cancelled: false };
			pending.push(entry);
			return () => {
				entry.cancelled = true;
			};
		},
		advance(ms: number) {
			now += ms;
			const due = pending.filter(entry => !entry.cancelled && entry.at <= now);
			pending = pending.filter(entry => !due.includes(entry));
			for (const entry of due) entry.callback();
		},
	};
}

function detector(quietMs = 3_000) {
	const clock = manualClock();
	const signals: AwaitingInputSignal[] = [];
	const instance = new AwaitingInputDetector({
		onDetect: signal => signals.push(signal),
		quietMs,
		schedule: clock.schedule,
		now: clock.now,
	});
	return { clock, signals, instance };
}

describe("classifyAwaitingInput", () => {
	test.each([
		["tailscale", TAILSCALE, "browser_auth"],
		["gcloud", GCLOUD, "browser_auth"],
		["az device code", AZ_DEVICE, "device_code"],
		["aws sso", AWS_SSO, "device_code"],
		["gh one-time code", GH_DEVICE, "device_code"],
	] as const)("classifies %s prompt", (_name, output, kind) => {
		expect(classifyAwaitingInput(output)).toBe(kind);
	});

	test("ignores ANSI styling around the prompt", () => {
		expect(
			classifyAwaitingInput(
				`\u001b[1mTo authenticate, visit:\u001b[0m\n\u001b[4mhttps://login.tailscale.com/a/x\u001b[0m`,
			),
		).toBe("browser_auth");
	});

	test("requires a URL for browser-auth phrasing", () => {
		expect(classifyAwaitingInput("To authenticate, visit: the admin console\n")).toBeUndefined();
	});

	test("ignores ordinary output", () => {
		expect(
			classifyAwaitingInput("Compiling crate v0.1.0\nhttps://docs.rs/crate\n   Finished release\n"),
		).toBeUndefined();
	});
});

describe("AwaitingInputDetector", () => {
	test("fires once after the quiet window following a prompt", () => {
		const { clock, signals, instance } = detector();
		instance.push(TAILSCALE);
		clock.advance(2_999);
		expect(signals).toEqual([]);
		clock.advance(1);
		expect(signals).toEqual([{ kind: "browser_auth", detectedAt: 4_000 }]);
		instance.push(TAILSCALE);
		clock.advance(10_000);
		expect(signals).toHaveLength(1);
	});

	test("matches a prompt split across chunks", () => {
		const { clock, signals, instance } = detector();
		instance.push("To authenti");
		instance.push("cate, visit:\n\n\thttps://login.tailscale.com/a/abc\n");
		clock.advance(3_000);
		expect(signals.map(signal => signal.kind)).toEqual(["browser_auth"]);
	});

	test("continued output restarts the quiet window (doc text printed by a busy command)", () => {
		const { clock, signals, instance } = detector();
		instance.push(AZ_DEVICE);
		clock.advance(2_000);
		instance.push("more documentation lines\n");
		clock.advance(2_000);
		expect(signals).toEqual([]);
		clock.advance(1_000);
		expect(signals.map(signal => signal.kind)).toEqual(["device_code"]);
	});

	test("does not fire once the prompt scrolls out of the recent tail", () => {
		const { clock, signals, instance } = detector();
		instance.push(TAILSCALE);
		instance.push(`${"x".repeat(4_096)}\n`);
		clock.advance(10_000);
		expect(signals).toEqual([]);
	});

	test("dispose before the quiet window elapses suppresses the signal (command exited)", () => {
		const { clock, signals, instance } = detector();
		instance.push(GCLOUD);
		clock.advance(1_000);
		instance.dispose();
		clock.advance(10_000);
		instance.push(GCLOUD);
		clock.advance(10_000);
		expect(signals).toEqual([]);
	});
});

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function pick<T>(random: () => number, items: readonly T[]): T {
	return items[Math.floor(random() * items.length)]!;
}

/** Complete lines of ordinary build/test/log output; none contains a sign-in phrase. */
const UNRELATED_LINES = [
	"   Compiling serde v1.0.210",
	"    Finished `release` profile [optimized] target(s) in 41.2s",
	"error[E0308]: mismatched types",
	"See https://docs.rs/serde/latest/serde/ for details",
	"GET http://localhost:3000/health 200 3ms",
	"PASS test/awaiting.test.ts (12 tests)",
	"warning: unused variable: `code`",
	"Downloading 12.5 MiB/s [=====>    ] 54%",
	"Please open an issue at https://github.com/org/repo/issues",
	"Visit https://example.com/docs to learn more",
	"Login succeeded",
	"Device /dev/sda1 mounted",
	"日本語のログ出力です",
	"한글 로그 출력입니다",
	"",
];

/** Sign-in vocabulary as lone words; phrases never span a line break. */
const SIGN_IN_WORDS = ["enter", "the", "code", "to", "authenticate", "visit", "open", "url", "one-time", "login"];

const PROMPTS = [
	[TAILSCALE, "browser_auth"],
	[GCLOUD, "browser_auth"],
	[AZ_DEVICE, "device_code"],
	[AWS_SSO, "device_code"],
	[GH_DEVICE, "device_code"],
] as const;

const SGR = ["\u001b[0m", "\u001b[1m", "\u001b[4m", "\u001b[32m", "\u001b[1;31m", "\u001b[38;5;208m", "\u001b[K"];

function unrelatedText(random: () => number): string {
	const lines: string[] = [];
	const count = 1 + Math.floor(random() * 24);
	for (let index = 0; index < count; index++) lines.push(pick(random, UNRELATED_LINES));
	return lines.join("\n");
}

function scatteredSignInWords(random: () => number): string {
	const lines: string[] = [];
	const count = 1 + Math.floor(random() * 30);
	for (let index = 0; index < count; index++)
		lines.push(random() < 0.5 ? pick(random, SIGN_IN_WORDS) : pick(random, UNRELATED_LINES));
	return lines.join("\n");
}

/** Insert SGR escapes at random character positions. */
function decorate(random: () => number, text: string): string {
	let out = "";
	for (const char of text) {
		if (random() < 0.08) out += pick(random, SGR);
		out += char;
	}
	return out;
}

/** Split text into 1..12 chunks at random boundaries. */
function chunked(random: () => number, text: string): string[] {
	const cuts = new Set<number>();
	const count = Math.floor(random() * 12);
	for (let index = 0; index < count; index++) cuts.add(1 + Math.floor(random() * Math.max(1, text.length - 1)));
	const sorted = [...cuts].filter(cut => cut < text.length).sort((a, b) => a - b);
	const chunks: string[] = [];
	let start = 0;
	for (const cut of sorted) {
		chunks.push(text.slice(start, cut));
		start = cut;
	}
	chunks.push(text.slice(start));
	return chunks;
}

describe("awaiting-input properties", () => {
	test("unrelated output never classifies (seed 0x6852a001)", () => {
		const random = seededRandom(0x6852a001);
		for (let caseIndex = 0; caseIndex < 300; caseIndex++) {
			const text = unrelatedText(random);
			expect({ text, kind: classifyAwaitingInput(text) }).toEqual({ text, kind: undefined });
		}
	});

	test("sign-in words on separate lines never classify (seed 0x6852a005)", () => {
		const random = seededRandom(0x6852a005);
		for (let caseIndex = 0; caseIndex < 300; caseIndex++) {
			const text = scatteredSignInWords(random);
			expect({ text, kind: classifyAwaitingInput(text) }).toEqual({ text, kind: undefined });
		}
	});

	test("ANSI decoration preserves classification (seed 0x6852a002)", () => {
		const random = seededRandom(0x6852a002);
		for (let caseIndex = 0; caseIndex < 200; caseIndex++) {
			const [prompt, kind] = pick(random, PROMPTS);
			const decorated = decorate(random, prompt);
			expect({ decorated, kind: classifyAwaitingInput(decorated) }).toEqual({ decorated, kind });
		}
	});

	test("arbitrary chunk boundaries yield the same single signal (seed 0x6852a003)", () => {
		const random = seededRandom(0x6852a003);
		for (let caseIndex = 0; caseIndex < 200; caseIndex++) {
			const [prompt, kind] = pick(random, PROMPTS);
			const text = `${unrelatedText(random).slice(0, 400)}\n${prompt}`;
			const chunks = chunked(random, text);
			const { clock, signals, instance } = detector();
			for (const chunk of chunks) instance.push(chunk);
			clock.advance(3_000);
			instance.push(prompt);
			clock.advance(3_000);
			expect({ chunks, kinds: signals.map(signal => signal.kind) }).toEqual({ chunks, kinds: [kind] });
		}
	});

	test("nothing is emitted after disposal, whatever arrives next (seed 0x6852a004)", () => {
		const random = seededRandom(0x6852a004);
		for (let caseIndex = 0; caseIndex < 200; caseIndex++) {
			const [prompt] = pick(random, PROMPTS);
			const { clock, signals, instance } = detector();
			const before = chunked(random, prompt);
			const disposeAt = Math.floor(random() * (before.length + 1));
			before.forEach((chunk, index) => {
				if (index === disposeAt) instance.dispose();
				instance.push(chunk);
			});
			if (disposeAt === before.length) instance.dispose();
			for (const chunk of chunked(random, prompt)) instance.push(chunk);
			clock.advance(10_000);
			expect({ before, disposeAt, signals }).toEqual({ before, disposeAt, signals: [] });
		}
	});
});
