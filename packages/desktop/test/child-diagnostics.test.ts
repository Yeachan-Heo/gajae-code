import { describe, expect, test } from "bun:test";
import { childDiagnostics } from "../scripts/child-diagnostics";

const encoder = new TextEncoder();

describe("child diagnostics", () => {
	test("decodes split UTF-8 chunks and flushes an incomplete sequence at EOF", async () => {
		const bytes = encoder.encode("before 😀 after");
		const stderr = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.slice(0, 9));
				controller.enqueue(bytes.slice(9));
				controller.enqueue(new Uint8Array([0xe2, 0x82]));
				controller.close();
			},
		});
		expect(await childDiagnostics(stderr).wait(1000)).toBe("before 😀 after�");
	});

	test("redacts known tokens split across stderr chunks after decoding", async () => {
		const stderr = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("token=wrapper-"));
				controller.enqueue(encoder.encode("secret provider=fixture-"));
				controller.enqueue(encoder.encode("secret wrapper-secret"));
				controller.close();
			},
		});
		expect(await childDiagnostics(stderr, ["wrapper-secret", "fixture-secret"]).wait(1000)).toBe(
			"token=[REDACTED] provider=[REDACTED] [REDACTED]",
		);
	});

	test("waits for pending stderr after an immediately exiting child", async () => {
		const child = Bun.spawn([process.execPath, "-e", "process.stderr.write('exit diagnostic')"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		const diagnostics = childDiagnostics(child.stderr);
		expect(await child.exited).toBe(0);
		expect(await diagnostics.wait(1000)).toBe("exit diagnostic");
	});

	test("waits for stderr delivered after the exit observation", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const stderr = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
			},
		});
		const result = childDiagnostics(stderr).wait(1000);
		await Bun.sleep(10);
		controller.enqueue(encoder.encode("late diagnostic"));
		controller.close();
		expect(await result).toBe("late diagnostic");
	});

	test("retains only the last 4000 UTF-16 units of noisy output", async () => {
		const stderr = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("a".repeat(5000)));
				controller.enqueue(encoder.encode(`${"b".repeat(3998)}😀`));
				controller.close();
			},
		});
		expect(await childDiagnostics(stderr).wait(1000)).toBe(`${"b".repeat(3998)}😀`);
	});

	test("keeps the received tail when the drain rejects", async () => {
		const stderr = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("before error"));
			},
			pull(controller) {
				controller.error(new Error("pipe failed"));
			},
		});
		expect(await childDiagnostics(stderr).wait(1000)).toBe("before error");
	});

	test("flushes an incomplete scalar when cancellation never resolves", async () => {
		let cancelled = false;
		const cancellation = Promise.withResolvers<void>();
		const stderr = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("partial: "));
				controller.enqueue(new Uint8Array([0xe2, 0x82]));
			},
			cancel() {
				cancelled = true;
				return cancellation.promise;
			},
		});
		const started = Date.now();
		expect(await childDiagnostics(stderr).wait(20)).toBe("partial: �");
		expect(cancelled).toBe(true);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test("joins concurrent failure and shutdown waits on an inherited pipe", async () => {
		let cancellations = 0;
		const stderr = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("shutdown tail"));
			},
			cancel() {
				cancellations++;
			},
		});
		const diagnostics = childDiagnostics(stderr);
		const started = Date.now();
		const [failure, cleanup] = await Promise.all([diagnostics.wait(20), diagnostics.wait(20)]);
		expect(failure).toBe("shutdown tail");
		expect(cleanup).toBe("shutdown tail");
		expect(cancellations).toBe(1);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test("returns available stderr without waiting for a pipe that never closes", async () => {
		let cancelled = false;
		const stderr = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("inherited pipe"));
			},
			cancel() {
				cancelled = true;
			},
		});
		const started = Date.now();
		expect(await childDiagnostics(stderr).wait(20)).toBe("inherited pipe");
		expect(Date.now() - started).toBeLessThan(1000);
		expect(cancelled).toBe(true);
	});
});
