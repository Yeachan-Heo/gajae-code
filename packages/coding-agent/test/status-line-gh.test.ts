import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Subprocess } from "bun";
import { lookupCurrentPr } from "../src/modes/components/status-line/gh";
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

	it("accepts enterprise hosts over HTTP(S)", async () => {
		const urls = [
			"https://ghe.internal.example.com/teams/cli/pull/3354",
			"http://ghe.internal.example.com/teams/cli/pull/3354",
		];
		for (const url of urls) {
			const runGh: RunGh = async () => ({
				exitCode: 0,
				stdout: JSON.stringify({ number: 3354, url }),
				stderr: "",
				timedOut: false,
			});

			await expect(lookupCurrentPr(runGh)).resolves.toEqual({
				number: 3354,
				url,
			});
		}
	});

	it("rejects PR URLs containing C0/C1 control characters", async () => {
		const runGh: RunGh = async () => ({
			exitCode: 0,
			stdout: '{"number":3354,"url":"https://github.com/Yeachan-Heo/gajae-code/pull/3354\\u001f"}',
			stderr: "",
			timedOut: false,
		});

		await expect(lookupCurrentPr(runGh)).resolves.toBeNull();
	});

	it("rejects malformed PR number and protocol boundaries", async () => {
		const malformed = [
			'{"number":0,"url":"https://github.com/Yeachan-Heo/gajae-code/pull/3354"}',
			`{"number":${Number.MAX_SAFE_INTEGER + 1},"url":"https://github.com/Yeachan-Heo/gajae-code/pull/3354"}`,
			'{"number":3354,"url":"ftp://github.com/Yeachan-Heo/gajae-code/pull/3354"}',
		];

		for (const stdout of malformed) {
			const runGh: RunGh = async () => ({ exitCode: 0, stdout, stderr: "", timedOut: false });

			await expect(lookupCurrentPr(runGh)).resolves.toBeNull();
		}
	});
});
