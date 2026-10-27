import { describe, expect, it } from "bun:test";
import { closeFootprintSampler, decodeRusageV4, sampleProcess } from "../bench/multisession/footprint";
import { observeProcessIncarnation } from "../src/sdk/broker/process-incarnation";

describe("multi-session footprint sampler", () => {
	it("decodes v4 unsigned fields at the specified offsets and honors DataView byteOffset", () => {
		const storage = new ArrayBuffer(296 + 37);
		const view = new DataView(storage, 19, 296);
		view.setBigUint64(64, 0x1234_5678_9abcn, true);
		view.setBigUint64(72, 0x2234_5678_9abcn, true);

		expect(decodeRusageV4(view)).toEqual({ rss: 0x1234_5678_9abcn, physFootprint: 0x2234_5678_9abcn });
	});

	it("distinguishes absence, inconclusive reads, and a raced PID incarnation", () => {
		let readCount = 0;
		const absent = sampleProcess(10, {
			observeProcessIncarnation: () => ({ status: "absent" }),
			readRusage: () => {
				readCount++;
				return { rc: 0, rss: 1, physFootprint: 2 };
			},
		});
		expect(absent).toEqual({ status: "absent", pid: 10 });
		expect(readCount).toBe(0);

		const unknown = sampleProcess(11, {
			observeProcessIncarnation: () => ({ status: "unknown", reasonCode: "permission_denied" }),
			readRusage: () => ({ rc: 0, rss: 1, physFootprint: 2 }),
		});
		expect(unknown.status).toBe("unresolved");

		let observations = 0;
		const raced = sampleProcess(12, {
			observeProcessIncarnation: () => {
				observations++;
				return { status: "present", incarnation: observations === 1 ? "darwin:1:1" : "darwin:2:1" };
			},
			readRusage: () => ({ rc: 0, rss: 1, physFootprint: 2 }),
		});
		expect(raced).toEqual({ status: "raced", pid: 12, reason: "process-incarnation-changed-during-read" });
	});

	it("rejects failed and non-exact BigInt conversions instead of emitting measurements", () => {
		const failed = sampleProcess(13, {
			observeProcessIncarnation: () => ({ status: "present", incarnation: "darwin:1:1" }),
			readRusage: () => ({ rc: 5 }),
		});
		expect(failed.status).toBe("unresolved");

		const overflow = sampleProcess(14, {
			observeProcessIncarnation: () => ({ status: "present", incarnation: "darwin:1:1" }),
			readRusage: () => ({ rc: 0, rss: Number.MAX_SAFE_INTEGER + 1, physFootprint: 2 }),
		});
		expect(overflow.status).toBe("unresolved");
	});

	it.skipIf(process.platform !== "darwin")("samples self footprint within 25% of /usr/bin/footprint", async () => {
		try {
			expect(sampleProcess(process.pid).status).toBe("ok");
			await Bun.sleep(20);
			const command = Bun.spawnSync(["/usr/bin/footprint", "-p", String(process.pid)], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(command.exitCode).toBe(0);
			const output = Buffer.from(command.stdout).toString("utf8");
			const match = /phys_footprint:\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB)?/i.exec(output);
			expect(match).not.toBeNull();
			if (!match) throw new Error(`Could not parse phys_footprint from /usr/bin/footprint output: ${output}`);
			const unit = (match[2] ?? "B").toUpperCase();
			const scale = unit === "GB" ? 1024 ** 3 : unit === "MB" ? 1024 ** 2 : unit === "KB" ? 1024 : 1;
			const expected = Number(match[1]) * scale;
			const actual = sampleProcess(process.pid);
			expect(actual.status).toBe("ok");
			if (actual.status !== "ok") throw new Error(`Self footprint read was ${actual.status}`);
			expect(Math.abs(actual.physFootprint - expected) / expected).toBeLessThanOrEqual(0.25);
		} finally {
			closeFootprintSampler();
		}
	});

	it.skipIf(process.platform !== "darwin")("reports an exited child as absent rather than unresolved", async () => {
		const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		await child.exited;
		expect(observeProcessIncarnation(child.pid).status).toBe("absent");
		expect(sampleProcess(child.pid)).toEqual({ status: "absent", pid: child.pid });
	});
});
