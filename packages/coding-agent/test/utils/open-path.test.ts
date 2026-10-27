import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Subprocess } from "bun";
import { openPath } from "../../src/utils/open";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

function restorePlatform(): void {
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
}

function fakeProcess(): Subprocess {
	return { pid: 0, kill: () => true, unref() {} } as unknown as Subprocess;
}

function spySpawn(): string[][] {
	const calls: string[][] = [];
	vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
		calls.push([...cmd]);
		return fakeProcess();
	}) as unknown as typeof Bun.spawn);
	return calls;
}

function openerArgv(platform: NodeJS.Platform, target: string): string[] {
	if (platform === "darwin") return ["open", target];
	if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler", target];
	return ["xdg-open", target];
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function hasAsciiControl(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function spawnedIsSafe(argv: string[]): boolean {
	const bin = argv[0];
	if (bin !== "open" && bin !== "xdg-open" && bin !== "rundll32") return false;
	if (bin === "rundll32" && argv[1] !== "url.dll,FileProtocolHandler") return false;
	const target = argv[argv.length - 1] ?? "";
	if (target.length === 0 || hasAsciiControl(target) || target.startsWith("-")) return false;
	if (/^[A-Za-z]:[\\/]/.test(target)) return true;
	try {
		const url = new URL(target);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target);
	}
}

afterEach(() => {
	restorePlatform();
	vi.restoreAllMocks();
});

const STABLE = [
	"https://example.com/oauth",
	"http://127.0.0.1:9/dashboard",
	"http://[::1]:8080/",
	"http://localhost/dashboard",
	"http://example.com/callback",
	"/tmp/work-profile.svg",
	"/",
	"report.html",
	String.raw`C:\Users\Public\report.html`,
	"C:/Users/Public/report.html",
	String.raw`\\server\share\report.html`,
	"/tmp/report ",
	" report.html ",
	"\u200Breport.html",
	"report.html\u200B",
	" \u200B/tmp/report \u200B",
	"//srv/share",
	"/tmp/report/",
	"~/report.html",
	"report.html;id",
	String.raw` C:\Users\Public\report.html`,
];

describe("openPath", () => {
	it("still allows https urls http urls and local paths", () => {
		const calls = spySpawn();
		for (const input of STABLE) {
			calls.length = 0;
			openPath(input);
			expect(calls).toEqual([openerArgv(process.platform, input)]);
		}
	});

	it("still allows https urls on darwin win32 and linux openers", () => {
		const target = "https://example.com/oauth";
		for (const platform of ["darwin", "win32", "linux"] as const) {
			vi.restoreAllMocks();
			const calls = spySpawn();
			setPlatform(platform);
			openPath(target);
			expect(calls).toEqual([openerArgv(platform, target)]);
		}
	});

	it("normalizes http urls the parser already accepts", () => {
		const calls = spySpawn();
		const cases: Array<[string, string]> = [
			[" https://example.com ", "https://example.com/"],
			["http://localhost:3000", "http://localhost:3000/"],
			["http://localhost:80/", "http://localhost/"],
			["https://example.com:443/a", "https://example.com/a"],
		];
		for (const [input, href] of cases) {
			calls.length = 0;
			openPath(input);
			expect(calls).toEqual([openerArgv(process.platform, href)]);
		}
	});

	it("nested padding does not hide a scheme or a flag", () => {
		const calls = spySpawn();
		const unit = String.fromCharCode(0x200b, 32);
		for (const layers of [7, 8, 9, 16, 64]) {
			for (const core of ["--help", "javascript:alert(1)", ""]) {
				calls.length = 0;
				openPath(`${unit.repeat(layers)}${core}`);
				expect(calls).toEqual([]);
			}
			const path = `${unit.repeat(layers)}/tmp/report`;
			calls.length = 0;
			openPath(path);
			expect(calls).toEqual([openerArgv(process.platform, path)]);
		}
	});

	it("non-http schemes stay out of opener argv", () => {
		const calls = spySpawn();
		const attacks = [
			"javascript:alert(1)",
			"JavaScript:alert(1)",
			" javascript:alert(1)",
			"\u200Bjavascript:alert(1)",
			"\u00A0javascript:alert(1)",
			"file:///etc/passwd",
			"FILE:///etc/passwd",
			"file://localhost/etc/passwd",
			"custom://x",
			"data:text/html,hi",
			"mailto:a@b.com",
			"ms-msdt:id",
			"note:draft",
			"https://example.com%00",
			"foo:bar",
			"C:name",
			"\u200B \u200Bjavascript:alert(1)",
			"\u200Bhttps://example.com/a",
		];
		for (const input of attacks) {
			calls.length = 0;
			openPath(input);
			expect(calls).toEqual([]);
		}
		for (const platform of ["darwin", "win32", "linux"] as const) {
			setPlatform(platform);
			calls.length = 0;
			openPath("javascript:alert(1)");
			openPath("file:///etc/passwd");
			openPath("custom://x");
			expect(calls).toEqual([]);
		}
	});

	it("control characters and dash flags stay out of opener argv", () => {
		const calls = spySpawn();
		for (const input of [
			"--help",
			"--version",
			"-a",
			"https://example.com/\u0007",
			"https://example.com\u001b\\",
			"\u0007https://example.com",
			"https://example.com\n",
			"java\nscript:alert(1)",
			"",
			"   ",
			"\u200B --help",
			" --help",
			" \u200B \u200B --help \u200B ",
		]) {
			calls.length = 0;
			openPath(input);
			expect(calls).toEqual([]);
		}
	});

	it("property open target seed 439 64 inputs", () => {
		const random = mulberry32(439);
		const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-._~:/?#[]@!$&'()*+,;=%";
		const schemes = ["javascript:", "file:///", "custom://", "data:", "mailto:", "ms-msdt:"];
		const generated: string[] = [];
		for (let i = 0; i < 64; i++) {
			const roll = random();
			if (roll < 0.25) {
				const scheme = schemes[Math.floor(random() * schemes.length)] ?? "javascript:";
				generated.push(`${scheme}x${i}`);
			} else if (roll < 0.5) {
				const host = random() < 0.5 ? "example.com" : "127.0.0.1";
				const proto = random() < 0.5 ? "https" : "http";
				generated.push(`${proto}://${host}/p${i}`);
			} else if (roll < 0.7) {
				generated.push(`/tmp/artifact-${i}.svg`);
			} else if (roll < 0.85) {
				const len = 1 + Math.floor(random() * 12);
				let token = "";
				for (let n = 0; n < len; n++) token += alphabet[Math.floor(random() * alphabet.length)] ?? "a";
				generated.push(token);
			} else {
				const pads = [" ", "\u200B", " \u200B", "\u200B "];
				const cores = ["/tmp/report", "report.html", "--help", "javascript:alert(1)"];
				const pad = pads[Math.floor(random() * pads.length)] ?? " ";
				const core = cores[Math.floor(random() * cores.length)] ?? "report.html";
				generated.push(`${pad}${core}${pad}`);
			}
		}
		expect(generated).toHaveLength(64);
		const calls = spySpawn();
		for (const input of STABLE) {
			calls.length = 0;
			openPath(input);
			expect(calls).toEqual([openerArgv(process.platform, input)]);
		}
		for (const input of ["javascript:alert(1)", "file:///etc/passwd", "--help", "https://example.com/\u0007"]) {
			calls.length = 0;
			openPath(input);
			expect(calls).toEqual([]);
		}
		for (const input of ["\u200B --help", " --help", "\u200B \u200Bjavascript:alert(1)"]) {
			calls.length = 0;
			openPath(input);
			expect(calls).toEqual([]);
		}
		for (const input of generated) {
			calls.length = 0;
			openPath(input);
			expect(calls.length).toBeLessThanOrEqual(1);
			if (calls.length !== 1) continue;
			const argv = calls[0] ?? [];
			expect(spawnedIsSafe(argv)).toBe(true);
			const target = argv[argv.length - 1] ?? "";
			calls.length = 0;
			openPath(target);
			expect(calls).toEqual([openerArgv(process.platform, target)]);
		}
	});
});
