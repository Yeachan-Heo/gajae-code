import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Subprocess } from "bun";
import {
	clearCurrentPrCache,
	lookupCurrentPr,
	lookupCurrentPrCached,
} from "../src/modes/components/status-line/gh";
import type { RunGh } from "../src/utils/gh";

function textStream(text: string): ReadableStream<Uint8Array> {
	const stream = new Response(text).body;
	if (!stream) throw new Error("Failed to create response stream.");
	return stream;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("status-line GitHub PR lookup", () => {
	beforeEach(() => {
		clearCurrentPrCache();
	});

	it("detaches gh from TUI stdin", async () => {
		const ghPath = "/usr/bin/gh";
		vi.spyOn(Bun, "which").mockReturnValue(ghPath);
		const spawnSpy = vi.spyOn(Bun, "spawn").mockImplementation(
			() =>
				({
					stdout: textStream('{"number":3354,"url":"https://github.com/Yeachan-Heo/gajae-code/pull/3354"}'),
					stderr: textStream(""),
					exited: Promise.resolve(0),
					kill: () => {},
				}) as Subprocess,
		);

		await expect(lookupCurrentPr()).resolves.toEqual({
			number: 3354,
			url: "https://github.com/Yeachan-Heo/gajae-code/pull/3354",
		});
		expect(spawnSpy).toHaveBeenCalledWith([ghPath, "pr", "view", "--json", "number,url"], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
	});

	it("bounds the background lookup and rejects malformed output", async () => {
		let timeoutMs: number | undefined;
		const runGh: RunGh = async (_args, options) => {
			timeoutMs = options?.timeoutMs;
			return { exitCode: 0, stdout: '{"number":3354}', stderr: "", timedOut: false };
		};

		await expect(lookupCurrentPr(runGh)).resolves.toBeNull();
		expect(timeoutMs).toBe(5_000);
	});

	it("negative-caches failed lookups across callers", async () => {
		let calls = 0;
		const runGh: RunGh = async () => {
			calls += 1;
			return { exitCode: 1, stdout: "", stderr: "no pull requests found", timedOut: false };
		};

		await expect(lookupCurrentPrCached("/repo/.git/HEAD\0feature", runGh, () => 1_000)).resolves.toBeNull();
		await expect(lookupCurrentPrCached("/repo/.git/HEAD\0feature", runGh, () => 2_000)).resolves.toBeNull();
		expect(calls).toBe(1);
	});

	it("deduplicates concurrent lookups across callers", async () => {
		let calls = 0;
		let resolveLookup!: (value: Awaited<ReturnType<RunGh>>) => void;
		const result = new Promise<Awaited<ReturnType<RunGh>>>(resolve => {
			resolveLookup = resolve;
		});
		const runGh: RunGh = async () => {
			calls += 1;
			return result;
		};

		const first = lookupCurrentPrCached("/repo/.git/HEAD\0feature", runGh);
		const second = lookupCurrentPrCached("/repo/.git/HEAD\0feature", runGh);
		expect(calls).toBe(1);
		resolveLookup({ exitCode: 1, stdout: "", stderr: "no pull requests found", timedOut: false });
		await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
	});

	it("accepts canonical GitHub Enterprise PR URLs over HTTP(S)", async () => {
		for (const url of [
			"https://ghe.internal.example.com/teams/cli/pull/3354",
			"http://ghe.internal.example.com/teams/cli/pull/3354",
		]) {
			const runGh: RunGh = async () => ({
				exitCode: 0,
				stdout: JSON.stringify({ number: 3354, url }),
				stderr: "",
				timedOut: false,
			});

			await expect(lookupCurrentPr(runGh)).resolves.toEqual({ number: 3354, url });
		}
	});

	it("returns the parsed canonical URL", async () => {
		const runGh: RunGh = async () => ({
			exitCode: 0,
			stdout: JSON.stringify({ number: 3354, url: "HTTPS://GHE.INTERNAL.EXAMPLE.COM:443/teams/cli/pull/3354" }),
			stderr: "",
			timedOut: false,
		});

		await expect(lookupCurrentPr(runGh)).resolves.toEqual({
			number: 3354,
			url: "https://ghe.internal.example.com/teams/cli/pull/3354",
		});
	});

	it("rejects malformed PR numbers", async () => {
		for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3354"]) {
			const runGh: RunGh = async () => ({
				exitCode: 0,
				stdout: JSON.stringify({ number, url: "https://github.com/Yeachan-Heo/gajae-code/pull/3354" }),
				stderr: "",
				timedOut: false,
			});

			await expect(lookupCurrentPr(runGh)).resolves.toBeNull();
		}
	});

	it("rejects URLs that do not bind the returned PR identity", async () => {
		const malformed = [
			"ftp://github.com/Yeachan-Heo/gajae-code/pull/3354",
			"https://github.com/Yeachan-Heo/gajae-code/pull/9999",
			"https://github.com/Yeachan-Heo/gajae-code/security/advisories",
			"https://github.com@attacker.example/Yeachan-Heo/gajae-code/pull/3354",
			"https://github.com/Yeachan-Heo/gajae-code/pull/3354?redirect=1",
			"https://github.com/Yeachan-Heo/gajae-code/pull/3354#files",
			"https://github.com/Yeachan-Heo/gajae-code/pull/3354/",
			"https://github.com/pull/3354",
			"https://github.com/Yeachan-Heo/gajae-code/extra/pull/3354",
			"https://github.com/security/advisories/foo/pull/3354",
		];

		for (const url of malformed) {
			const runGh: RunGh = async () => ({
				exitCode: 0,
				stdout: JSON.stringify({ number: 3354, url }),
				stderr: "",
				timedOut: false,
			});

			await expect(lookupCurrentPr(runGh)).resolves.toBeNull();
		}
	});

	it("rejects every C0/C1 control character before URL parsing", async () => {
		const controls = [
			...Array.from({ length: 0x20 }, (_, value) => value),
			...Array.from({ length: 0x21 }, (_, value) => value + 0x7f),
		];

		for (const codePoint of controls) {
			const runGh: RunGh = async () => ({
				exitCode: 0,
				stdout: JSON.stringify({
					number: 3354,
					url: `https://github.com/Yeachan-Heo/gajae-code/pull/3354${String.fromCodePoint(codePoint)}`,
				}),
				stderr: "",
				timedOut: false,
			});

			await expect(lookupCurrentPr(runGh)).resolves.toBeNull();
		}
	});
});
