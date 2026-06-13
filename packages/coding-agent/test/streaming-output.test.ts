import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	formatHeadTruncationNotice,
	formatMiddleElisionMarker,
	formatTailTruncationNotice,
	OutputSink,
	TailBuffer,
	truncateHead,
	truncateHeadBytes,
	truncateLine,
	truncateMiddle,
	truncateTail,
	truncateTailBytes,
} from "../src/session/streaming-output";

const createdTempDirs: string[] = [];
const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "streaming-output-test-"));
	createdTempDirs.push(dir);
	return dir;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

afterEach(async () => {
	for (const dir of createdTempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
	if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
	if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
});

describe("truncateTailBytes", () => {
	test("returns source when already under limit", () => {
		const text = "hello";
		expect(truncateTailBytes(text, 10)).toEqual({ text: "hello", bytes: 5 });
	});

	test("truncates from end without breaking UTF-8 boundaries", () => {
		const text = "a😀b";
		const result = truncateTailBytes(text, 4);
		expect(result).toEqual({ text: "b", bytes: 1 });
		expect(result.text).not.toContain("\uFFFD");
	});

	test("accepts Uint8Array input", () => {
		const bytes = new TextEncoder().encode("abc😀");
		const result = truncateTailBytes(bytes, 4);
		expect(result.text).toBe("😀");
		expect(result.bytes).toBe(4);
	});
});

describe("truncateHeadBytes", () => {
	test("returns source when already under limit", () => {
		const text = "hello";
		expect(truncateHeadBytes(text, 10)).toEqual({ text: "hello", bytes: 5 });
	});

	test("truncates from start without breaking UTF-8 boundaries", () => {
		const text = "a😀b";
		const result = truncateHeadBytes(text, 2);
		expect(result).toEqual({ text: "a", bytes: 1 });
		expect(result.text).not.toContain("\uFFFD");
	});

	test("returns empty when maxBytes is zero", () => {
		const result = truncateHeadBytes("abc", 0);
		expect(result).toEqual({ text: "", bytes: 0 });
	});
});

describe("truncateHead", () => {
	test("returns unmodified content when within limits", () => {
		const content = "a\nb";
		const result = truncateHead(content, { maxLines: 10, maxBytes: 20 });
		expect(result.truncated).toBeUndefined();
		expect(result.content).toBe(content);
		expect(result.truncatedBy).toBeUndefined();
	});

	test("handles first line exceeding byte limit", () => {
		const result = truncateHead("abcdef\nnext", { maxBytes: 3, maxLines: 10 });
		expect(result.content).toBe("");
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("bytes");
		expect(result.firstLineExceedsLimit).toBe(true);
	});

	test("includes first line when text fits exact byte budget", () => {
		const result = truncateHead("abc\nx", { maxBytes: 3, maxLines: 10 });
		expect(result.content).toBe("abc");
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("bytes");
		expect(result.firstLineExceedsLimit).toBe(false);
		expect(result.outputBytes).toBe(byteLength("abc"));
	});
	test("truncates by line count", () => {
		const result = truncateHead("l1\nl2\nl3", { maxLines: 2, maxBytes: 100 });
		expect(result.content).toBe("l1\nl2");
		expect(result.truncatedBy).toBe("lines");
		expect(result.outputLines).toBe(2);
	});

	test("truncates by byte budget using complete lines", () => {
		const result = truncateHead("12345\nabc\nz", { maxLines: 10, maxBytes: 7 });
		expect(result.content).toBe("12345");
		expect(result.truncatedBy).toBe("bytes");
		expect(result.lastLinePartial).toBe(false);
		expect(result.outputBytes).toBe(byteLength("12345"));
	});
});

describe("truncateTail", () => {
	test("returns unmodified content when within limits", () => {
		const content = "a\nb";
		const result = truncateTail(content, { maxLines: 10, maxBytes: 20 });
		expect(result.truncated).toBeUndefined();
		expect(result.content).toBe(content);
		expect(result.truncatedBy).toBeUndefined();
	});

	test("truncates by line count", () => {
		const result = truncateTail("l1\nl2\nl3", { maxLines: 2, maxBytes: 100 });
		expect(result.content).toBe("l2\nl3");
		expect(result.truncatedBy).toBe("lines");
		expect(result.outputLines).toBe(2);
	});

	test("truncates by byte budget while preserving line boundaries", () => {
		const result = truncateTail("aaa\nbbbb\ncc", { maxLines: 10, maxBytes: 6 });
		expect(result.content).toBe("cc");
		expect(result.truncatedBy).toBe("bytes");
		expect(result.lastLinePartial).toBe(false);
	});

	test("returns partial single line when last line exceeds byte limit", () => {
		const result = truncateTail("abcdefghij", { maxLines: 10, maxBytes: 4 });
		expect(result.content).toBe("ghij");
		expect(result.truncatedBy).toBe("bytes");
		expect(result.lastLinePartial).toBe(true);
	});
});

describe("truncateLine", () => {
	test("does not truncate short lines", () => {
		expect(truncateLine("hello", 10)).toEqual({ text: "hello", wasTruncated: false });
	});

	test("truncates long lines with ellipsis", () => {
		expect(truncateLine("abcdefgh", 5)).toEqual({ text: "abcde…", wasTruncated: true });
	});
});

describe("TailBuffer", () => {
	test("keeps trailing bytes under budget", () => {
		const tail = new TailBuffer(5);
		tail.append("abc");
		tail.append("def");
		expect(tail.text()).toBe("bcdef");
		expect(tail.bytes()).toBe(5);
	});

	test("handles multibyte data and empty appends", () => {
		const tail = new TailBuffer(4);
		tail.append("");
		tail.append("😀");
		tail.append("x");
		expect(tail.text()).toBe("x");
		expect(tail.bytes()).toBe(1);
	});
});

describe("OutputSink", () => {
	test("tracks totals and adds notice in dump", async () => {
		const sink = new OutputSink();
		await sink.push("hello\nworld");
		const dumped = await sink.dump("notice");

		expect(dumped.output).toBe("[notice]\nhello\nworld");
		expect(dumped.truncated).toBe(false);
		expect(dumped.totalLines).toBe(2);
		expect(dumped.totalBytes).toBe(byteLength("hello\nworld"));
		expect(dumped.outputLines).toBe(2);
		expect(dumped.outputBytes).toBe(byteLength("hello\nworld"));
	});

	test("counts lines correctly when chunks contain no newlines", async () => {
		const sink = new OutputSink();
		await sink.push("abc");
		await sink.push("def");
		const dumped = await sink.dump();

		expect(dumped.totalLines).toBe(1);
		expect(dumped.outputLines).toBe(1);
	});

	test("counts all newline boundaries across chunk splits", async () => {
		const sink = new OutputSink();
		await sink.push("a\n");
		await sink.push("b\n\n");
		await sink.push("c");
		const dumped = await sink.dump();

		expect(dumped.output).toBe("a\nb\n\nc");
		expect(dumped.totalLines).toBe(4);
		expect(dumped.outputLines).toBe(4);
	});
	test("invokes onChunk callback with sanitized text", async () => {
		const chunks: string[] = [];
		const sink = new OutputSink({ onChunk: chunk => chunks.push(chunk) });
		await sink.push("abc");
		await sink.push("def");
		expect(chunks).toEqual(["abc", "def"]);
	});

	test("preserves SIXEL chunks when passthrough gates are enabled", async () => {
		const sixel = "\x1bPqabc\x1b\\";
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const chunks: string[] = [];
		const sink = new OutputSink({ onChunk: chunk => chunks.push(chunk) });
		await sink.push(`before\n${sixel}\nafter`);
		const dumped = await sink.dump();
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toContain(sixel);
		expect(dumped.output).toContain(sixel);
	});

	test("strips SIXEL chunks when passthrough gates are disabled", async () => {
		const sixel = "\x1bPqabc\x1b\\";
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		const sink = new OutputSink();
		await sink.push(sixel);
		const dumped = await sink.dump();
		expect(dumped.output).not.toContain("\x1bPq");
		expect(dumped.output).toBe("");
	});

	test("truncates in-memory output when spill threshold is exceeded", async () => {
		const sink = new OutputSink({ spillThreshold: 5 });
		await sink.push("abc");
		await sink.push("def");

		const dumped = await sink.dump();
		expect(dumped.truncated).toBe(true);
		expect(dumped.output).toBe("bcdef");
		expect(dumped.totalBytes).toBe(6);
		expect(dumped.outputBytes).toBe(5);
	});

	test("spills full output to artifact file when artifact path is provided", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "output.log");
		const sink = new OutputSink({
			artifactPath,
			artifactId: "artifact-1",
			spillThreshold: 5,
		});

		await sink.push("abc");
		await sink.push("def");
		const dumped = await sink.dump();
		const artifactText = await Bun.file(artifactPath).text();

		expect(dumped.truncated).toBe(true);
		expect(dumped.artifactId).toBe("artifact-1");
		expect(artifactText).toBe("abcdef");
		expect(dumped.output).toBe("bcdef");
	});

	test("artifact mirror keeps raw ANSI controls and sixel bytes while metadata stays stable", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "raw-output.log");
		const sixel = '\x1bPq"1;1;1;1#0;2;0;0;0#0!4~\x1b\\';
		const input = `head\n\x1b[31mred\x1b[0m\x00\x07${sixel}\n${"M".repeat(200)}\ntail`;
		const sink = new OutputSink({
			artifactPath,
			artifactId: "artifact-raw",
			spillThreshold: 24,
			headBytes: 12,
			maxColumns: 8,
		});

		for (let offset = 0; offset < input.length; offset += 17) {
			sink.push(input.slice(offset, offset + 17));
		}
		const dumped = await sink.dump();
		const artifactText = await Bun.file(artifactPath).text();

		expect(artifactText).toBe(input);
		expect(dumped.artifactId).toBe("artifact-raw");
		expect(dumped.truncated).toBe(true);
		expect(dumped.totalBytes).toBe(byteLength(input));
		expect(dumped.totalLines).toBe(4);
		expect(dumped.outputBytes).toBe(byteLength(dumped.output));
		expect(dumped.elidedBytes).toBeUndefined();
		expect(dumped.elidedLines).toBeUndefined();
		expect(dumped.columnDroppedBytes).toBe(204);
		expect(dumped.columnTruncatedLines).toBe(2);
		expect(dumped.output).not.toContain("\x1bPq");
		expect(dumped.output).not.toContain("\x00");
	});

	test("column-capped streams force raw artifact persistence before tail overflow", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "column-capped.log");
		const input = `${"x".repeat(64)}\n${"y".repeat(64)}\n`;
		const sink = new OutputSink({
			artifactPath,
			artifactId: "column-capped",
			maxColumns: 4,
			spillThreshold: 1024,
		});

		for (let offset = 0; offset < input.length; offset += 8) sink.push(input.slice(offset, offset + 8));
		const dumped = await sink.dump();

		expect(dumped.truncated).toBe(true);
		expect(dumped.artifactId).toBe("column-capped");
		expect(dumped.columnTruncatedLines).toBe(2);
		expect(await Bun.file(artifactPath).text()).toBe(input);
	});

	test("post-dump push cannot reopen or overwrite a finalized artifact", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "finalized.log");
		const sink = new OutputSink({ artifactPath, artifactId: "finalized", spillThreshold: 4 });

		sink.push("abcdef");
		const first = await sink.dump();
		const before = await Bun.file(artifactPath).text();
		sink.push("LATE");
		const second = await sink.dump();
		const after = await Bun.file(artifactPath).text();

		expect(first.artifactId).toBe("finalized");
		expect(second.artifactId).toBe("finalized");
		expect(before).toBe("abcdef");
		expect(after).toBe(before);
	});

	test("post-dump dump remains cumulative like the HEAD lifecycle oracle", async () => {
		const sink = new OutputSink({ spillThreshold: 5, headBytes: 4 });
		sink.push("abcdef");
		const first = await sink.dump();
		sink.push("ghi");
		const second = await sink.dump();

		expect(first.output).toBe("abcdef");
		expect(second.output).toBe("abcdefghi");
		expect(second.totalBytes).toBe(byteLength("abcdefghi"));
		expect(second.truncated).toBe(false);
	});

	test("raw replay survives a non-finalized dump so a later spill yields a cumulative artifact", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "cumulative.log");
		// spillThreshold large enough that the first small push never opens the sink.
		const sink = new OutputSink({ artifactPath, artifactId: "cumulative", spillThreshold: 32 });

		sink.push("small-");
		const first = await sink.dump(); // no artifact yet: sink never opened
		expect(first.artifactId).toBeUndefined();

		const large = "X".repeat(64); // crosses the spill threshold post-dump
		sink.push(large);
		const second = await sink.dump();

		expect(second.artifactId).toBe("cumulative");
		// The artifact must contain the CUMULATIVE raw stream, including the
		// chunk pushed before the non-finalized dump.
		expect(await Bun.file(artifactPath).text()).toBe(`small-${large}`);
	});

	test("artifact late-open replay remains byte-correct after tail trimming", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "late-open.log");
		const sink = new OutputSink({ artifactPath, artifactId: "late-open", spillThreshold: 10, headBytes: 4 });
		const input = `HEAD-${"m".repeat(64)}-TAIL`;

		for (let offset = 0; offset < input.length; offset += 7) sink.push(input.slice(offset, offset + 7));
		await sink.dump();

		expect(await Bun.file(artifactPath).text()).toBe(input);
	});

	test("artifact write failure retries from the raw replay queue without duplicating bytes", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "retry.log");
		const originalFile = Bun.file;
		let writes = 0;
		let failed = false;
		try {
			Bun.file = ((filePath: string | URL, ...args: unknown[]) => {
				const file = originalFile(filePath, ...(args as []));
				if (String(filePath) !== artifactPath) return file;
				return new Proxy(file, {
					get(target, prop, _receiver) {
						if (prop !== "writer") return Reflect.get(target, prop, target);
						return () => {
							const sink = target.writer();
							return new Proxy(sink, {
								get(sinkTarget, sinkProp, _sinkReceiver) {
									if (sinkProp === "end") return sinkTarget.end.bind(sinkTarget);
									if (sinkProp !== "write") return Reflect.get(sinkTarget, sinkProp, sinkTarget);
									return (chunk: string | Uint8Array) => {
										writes++;
										if (!failed && writes === 2) {
											failed = true;
											throw new Error("simulated write failure");
										}
										return sinkTarget.write.call(sinkTarget, chunk as string);
									};
								},
							});
						};
					},
				});
			}) as typeof Bun.file;

			const sink = new OutputSink({ artifactPath, artifactId: "retry", spillThreshold: 5 });
			const input = "abcde" + "fghij" + "klmno";
			for (let offset = 0; offset < input.length; offset += 5) sink.push(input.slice(offset, offset + 5));
			await sink.dump();

			Bun.file = originalFile;
			expect(await Bun.file(artifactPath).text()).toBe(input);
		} finally {
			Bun.file = originalFile;
		}
	});

	test("artifact abort writes a clean raw prefix", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "abort.log");
		const input = `prefix-${"x".repeat(128)}-suffix`;
		const sink = new OutputSink({ artifactPath, artifactId: "abort", spillThreshold: 12 });

		for (let offset = 0; offset < 73; offset += 11)
			sink.push(input.slice(offset, Math.min(input.length, offset + 11)));
		await sink.dump();

		const artifactText = await Bun.file(artifactPath).text();
		expect(input.startsWith(artifactText)).toBe(true);
		expect(artifactText).toBe(input.slice(0, 77));
	});

	test("createInput decodes streamed UTF-8 chunks correctly", async () => {
		const sink = new OutputSink();
		const writer = sink.createInput().getWriter();
		const bytes = new TextEncoder().encode("😀X");

		await writer.write(bytes.subarray(0, 2));
		await writer.write(bytes.subarray(2));
		await writer.close();

		const dumped = await sink.dump();
		expect(dumped.output).toBe("😀X");
		expect(dumped.totalBytes).toBe(byteLength("😀X"));
	});
});

describe("truncation notice formatting", () => {
	test("formatTailTruncationNotice returns empty string for non-truncated results", () => {
		const truncation = truncateTail("a\nb", { maxLines: 10, maxBytes: 50 });
		expect(formatTailTruncationNotice(truncation)).toBe("");
	});

	test("formatTailTruncationNotice supports partial-line and complete-line notices", () => {
		const partialLineTruncation = truncateTail("abcdefghij", { maxLines: 10, maxBytes: 4 });
		const partialLineNotice = formatTailTruncationNotice(partialLineTruncation, {
			fullOutputPath: "/tmp/full.log",
			originalContent: "abcdefghij",
			suffix: " [suffix]",
		});
		expect(partialLineNotice).toBe(
			"\n\n[Showing last 4B of line 1 (line is 10B). Full output: /tmp/full.log [suffix]]",
		);

		const lineTruncation = truncateTail("l1\nl2\nl3", { maxLines: 2, maxBytes: 100 });
		expect(formatTailTruncationNotice(lineTruncation)).toBe("\n\n[Showing lines 2-3 of 3]");

		const byteTruncation = truncateTail("aaa\nbbbb\ncc", { maxLines: 10, maxBytes: 6 });
		expect(formatTailTruncationNotice(byteTruncation)).toBe("\n\n[Showing lines 3-3 of 3]");
	});

	test("formatHeadTruncationNotice returns empty string for non-truncated results", () => {
		const truncation = truncateHead("a\nb", { maxLines: 10, maxBytes: 50 });
		expect(formatHeadTruncationNotice(truncation)).toBe("");
	});

	test("formatHeadTruncationNotice formats head truncation range", () => {
		const lineTruncation = truncateHead("l1\nl2\nl3", { maxLines: 2, maxBytes: 100 });
		expect(formatHeadTruncationNotice(lineTruncation)).toBe("\n\n[Showing lines 1-2 of 3. Use :3 to continue]");

		const byteTruncation = truncateHead("12345\nabc\nz", { maxLines: 10, maxBytes: 7 });
		expect(
			formatHeadTruncationNotice(byteTruncation, {
				startLine: 100,
				totalFileLines: 500,
			}),
		).toBe("\n\n[Showing lines 100-100 of 500. Use :101 to continue]");
	});
});

describe("truncateMiddle", () => {
	test("returns content unchanged when within budget", () => {
		const result = truncateMiddle("a\nb\nc", { maxBytes: 100, maxLines: 10 });
		expect(result.truncated).toBeFalsy();
		expect(result.content).toBe("a\nb\nc");
	});

	test("keeps head and tail with marker for byte-overflow content", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n");
		const result = truncateMiddle(lines, {
			maxBytes: 24, // 12 bytes head + 12 bytes tail
			maxLines: 12,
			maxHeadBytes: 12,
			maxHeadLines: 3,
		});
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("middle");
		// Must contain first line and last line, plus the elision marker.
		expect(result.content.startsWith("line-1\n")).toBe(true);
		expect(result.content.endsWith("line-12")).toBe(true);
		expect(result.content).toContain("elided");
		expect(result.content).not.toContain("line-7"); // a middle line
		expect(result.elidedLines).toBeGreaterThan(0);
		expect(result.elidedBytes).toBeGreaterThan(0);
	});

	test("falls back to tail-only when head budget cannot accept the first line", () => {
		const giantFirstLine = `${"x".repeat(200)}\nshort-2\nshort-3`;
		const result = truncateMiddle(giantFirstLine, {
			maxBytes: 40,
			maxLines: 10,
			maxHeadBytes: 8, // first line is 200 bytes — exceeds head budget
			maxHeadLines: 1,
		});
		expect(result.truncated).toBe(true);
		// Should not contain the elision marker; it's a regular tail truncation.
		expect(result.content).not.toContain("elided");
	});

	test("formatMiddleElisionMarker pluralises and formats bytes", () => {
		expect(formatMiddleElisionMarker(1, 100)).toBe("[… 1 line elided (100B) …]");
		expect(formatMiddleElisionMarker(123, 4096)).toBe("[… 123 lines elided (4.0KB) …]");
	});
});

describe("OutputSink head-retain mode", () => {
	test("middle elision splices head, marker, and tail", async () => {
		const sink = new OutputSink({ spillThreshold: 6, headBytes: 6 });
		// Total 36 bytes: head ~6, tail ~6, middle ~24 elided.
		const lines = Array.from({ length: 12 }, (_, i) => `L${i}`).join("\n");
		await sink.push(lines);

		const dumped = await sink.dump();
		expect(dumped.truncated).toBe(true);
		expect(dumped.elidedBytes ?? 0).toBeGreaterThan(0);
		expect(dumped.elidedLines ?? 0).toBeGreaterThan(0);
		expect(dumped.output.startsWith("L0\n")).toBe(true);
		expect(dumped.output.endsWith("L11")).toBe(true);
		expect(dumped.output).toContain("elided");
		expect(dumped.totalBytes).toBe(byteLength(lines));
	});

	test("disabled (headBytes=0) preserves tail-only behavior", async () => {
		const sink = new OutputSink({ spillThreshold: 5, headBytes: 0 });
		await sink.push("abc");
		await sink.push("def");

		const dumped = await sink.dump();
		expect(dumped.truncated).toBe(true);
		expect(dumped.output).toBe("bcdef");
		expect(dumped.elidedBytes).toBeUndefined();
	});

	test("head fills cleanly across chunks without elision when total fits", async () => {
		const sink = new OutputSink({ spillThreshold: 50, headBytes: 4 });
		await sink.push("abcdefgh");
		const dumped = await sink.dump();
		expect(dumped.output).toBe("abcdefgh");
		expect(dumped.truncated).toBe(false);
		expect(dumped.elidedBytes).toBeUndefined();
	});

	test("replace + push appends to tail and emits no elision marker", async () => {
		// Simulates the bash-minimizer flow: large raw stream is replaced with a
		// short minimized text, then an artifact-link line is pushed. The push
		// must land at the END of the buffer (after the minimized text), and the
		// stale pre-replace totals must NOT trigger the middle-elision branch in
		// dump().
		const sink = new OutputSink({ spillThreshold: 1024, headBytes: 64 });
		// Feed a long original stream so #totalBytes/#totalLines climb high.
		const noisy = Array.from({ length: 50 }, (_, i) => `noise line ${i}`).join("\n");
		await sink.push(noisy);

		sink.replace("OK\n");
		await sink.push("[raw output: artifact://8]\n");

		const dumped = await sink.dump();
		expect(dumped.output).toBe("OK\n[raw output: artifact://8]\n");
		expect(dumped.output).not.toContain("elided");
		expect(dumped.elidedBytes).toBeUndefined();
		expect(dumped.elidedLines).toBeUndefined();
		expect(dumped.truncated).toBe(false);
		// Counters realign to the authoritative buffer + the subsequent push.
		expect(dumped.totalBytes).toBe(byteLength("OK\n[raw output: artifact://8]\n"));
	});
});

describe("OutputSink maxColumns (per-line cap)", () => {
	test("truncates a single overlong line with an ellipsis and drops the rest", async () => {
		const sink = new OutputSink({ maxColumns: 8, spillThreshold: 1000 });
		await sink.push(`short\n${"x".repeat(50)}\nfooter`);

		const dumped = await sink.dump();
		expect(dumped.truncated).toBe(true);
		expect(dumped.output).toContain("short\n");
		expect(dumped.output).toContain("\nfooter");
		expect(dumped.output).toContain("…");
		// The wide line shouldn't appear verbatim.
		expect(dumped.output).not.toContain("x".repeat(50));
		expect(dumped.columnTruncatedLines).toBe(1);
		expect(dumped.columnDroppedBytes ?? 0).toBeGreaterThan(0);
		// totalBytes still reflects the raw stream, not the post-cap view.
		expect(dumped.totalBytes).toBe(byteLength(`short\n${"x".repeat(50)}\nfooter`));
	});

	test("persists per-line state across chunk boundaries", async () => {
		const sink = new OutputSink({ maxColumns: 4, spillThreshold: 1000 });
		await sink.push("ab"); // 2 bytes into the current line
		await sink.push("cd"); // 4 bytes total — still within cap
		await sink.push("efgh"); // tips over → ellipsis once, then drop rest
		await sink.push("ijkl\n");
		await sink.push("next");

		const dumped = await sink.dump();
		const lines = dumped.output.split("\n");
		expect(lines[0]).toMatch(/^(abcd)?…$|^abcd…$/);
		expect(lines[1]).toBe("next");
		expect(dumped.columnTruncatedLines).toBe(1);
	});

	test("disabled by default — maxColumns: 0 is a passthrough", async () => {
		const sink = new OutputSink({ spillThreshold: 4000 });
		const wide = "y".repeat(2000);
		await sink.push(wide);
		const dumped = await sink.dump();
		expect(dumped.output).toBe(wide);
		expect(dumped.columnTruncatedLines).toBeUndefined();
		expect(dumped.columnDroppedBytes).toBeUndefined();
	});

	test("middle elision math subtracts column-dropped bytes", async () => {
		// Head + tail buffers are tiny; the wide middle line gets column-capped,
		// so its dropped bytes shouldn't be double-counted as "elided from middle".
		const sink = new OutputSink({
			maxColumns: 4,
			spillThreshold: 6,
			headBytes: 6,
		});
		const wideMiddle = "M".repeat(200);
		const input = `head\n${wideMiddle}\ntail`;
		await sink.push(input);
		const dumped = await sink.dump();
		const elided = dumped.elidedBytes ?? 0;
		const dropped = dumped.columnDroppedBytes ?? 0;
		expect(dropped).toBeGreaterThan(0);
		// elided + dropped + kept ≤ totalBytes (with a small slack for the marker/newlines).
		expect(elided + dropped).toBeLessThan(dumped.totalBytes);
	});

	test("middle-elided single overlong line matches HEAD column-cap oracle", async () => {
		const input = `0123456789${"x".repeat(80)}TAIL`;
		const sink = new OutputSink({ maxColumns: 8, spillThreshold: 12, headBytes: 10 });
		await sink.push(input);
		const dumped = await sink.dump();

		expect(dumped.output).toBe("01234…");
		expect(dumped.columnDroppedBytes).toBe(89);
		expect(dumped.columnTruncatedLines).toBe(1);
		expect(dumped.elidedBytes).toBeUndefined();
		expect(dumped.totalBytes).toBe(byteLength(input));
	});
});
