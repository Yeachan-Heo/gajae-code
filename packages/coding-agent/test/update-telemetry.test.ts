import { describe, expect, it } from "bun:test";
import { runUpdateCommand } from "../src/cli/update-cli";

const release = {
	tag: "v999.0.0",
	version: "999.0.0",
	registry: "https://github.com/Yeachan-Heo/gajae-code",
	warnings: [],
};

const target = { method: "binary" as const, path: "/tmp/gjc" };

describe("update telemetry lifecycle", () => {
	it("flushes asynchronous check-failure telemetry before exiting", async () => {
		const events: string[] = [];
		let transportReached = false;
		let exitCode: number | undefined;
		const recordTelemetryEvent = async (event: string, details: { result?: string }) => {
			await Bun.sleep(0);
			transportReached = true;
			events.push(`${event}:${details.result ?? ""}`);
		};

		await expect(
			runUpdateCommand(
				{ force: false, check: false, channel: "stable" },
				{
					resolveUpdateTarget: async () => {
						throw new Error("target unavailable");
					},
					recordTelemetryEvent,
					exit: code => {
						exitCode = code;
						if (!transportReached) throw new Error("exit raced telemetry");
						throw new Error("exit");
					},
				},
			),
		).rejects.toThrow("exit");

		expect(exitCode).toBe(1);
		expect(events).toEqual(["update_check_started:", "update_check_completed:failed"]);
	});

	it("bounds a failed telemetry recorder without changing the update exit", async () => {
		let exitCode: number | undefined;
		const startedAt = performance.now();

		await expect(
			runUpdateCommand(
				{ force: false, check: false, channel: "stable" },
				{
					resolveUpdateTarget: async () => {
						throw new Error("target unavailable");
					},
					recordTelemetryEvent: () => new Promise<void>(() => undefined),
					exit: code => {
						exitCode = code;
						throw new Error("exit");
					},
				},
			),
		).rejects.toThrow("exit");

		expect(exitCode).toBe(1);
		expect(performance.now() - startedAt).toBeLessThan(5500);
	}, 6000);

	it("records a bounded allowlisted check lifecycle without changing update behavior", async () => {
		const events: string[] = [];
		await runUpdateCommand(
			{ force: false, check: true, channel: "stable" },
			{
				resolveUpdateTarget: async () => target,
				getLatestRelease: async () => release,
				recordTelemetryEvent: (event, details) => events.push(`${event}:${details.result ?? ""}`),
			},
		);
		expect(events).toEqual([
			"update_check_started:",
			"update_check_completed:available",
			"update_install_completed:skipped",
		]);
	});

	it("records install success after the verified update path completes", async () => {
		const events: string[] = [];
		await runUpdateCommand(
			{ force: false, check: false, channel: "nightly" },
			{
				resolveUpdateTarget: async () => target,
				getLatestRelease: async () => ({ ...release, version: "999.0.1" }),
				performUpdate: async () => ({ ok: true, path: "/tmp/gjc" }),
				runPostUpdateRecovery: async () => undefined,
				refreshInstalledDefaultSkills: async () => undefined,
				recordTelemetryEvent: (event, details) => events.push(`${event}:${details.result ?? ""}`),
			},
		);
		expect(events).toEqual([
			"update_check_started:",
			"update_check_completed:available",
			"update_install_started:",
			"update_install_completed:installed",
		]);
	});
});
