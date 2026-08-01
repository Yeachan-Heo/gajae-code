import { afterEach, describe, expect, test, vi } from "bun:test";
import * as appServerRuntimeModule from "../app-server/create-app-server";
import AppServer from "./app-server";

const cliConfig = {
	bin: "gjc",
	version: "0.0.0-test",
	commands: new Map(),
};

const originalExitCode = process.exitCode;

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = originalExitCode ?? 0;
});

async function runFailureInjectedShutdown(listen: string, label: string): Promise<void> {
	const cleanupError = new Error(`${label} cleanup failed`);
	const aggregate = new AggregateError([cleanupError], `${label} cleanup aggregate`);
	const close = vi.fn().mockRejectedValue(aggregate);
	vi.spyOn(appServerRuntimeModule, "createAppServerRuntime").mockReturnValue({ close } as never);

	const stop = vi.fn();
	vi.spyOn(Bun, "serve").mockImplementation((() => ({ stop })) as never);

	const running = new AppServer(["--listen", listen], cliConfig).run();
	await Bun.sleep(0);
	const shutdown = process.listeners("SIGTERM").at(-1);
	if (!shutdown) throw new Error("app-server did not install a SIGTERM shutdown handler");
	(shutdown as () => void)();

	await expect(running).rejects.toBe(aggregate);
	expect(close).toHaveBeenCalledTimes(1);
	expect(stop).toHaveBeenCalledTimes(1);
	expect(process.exitCode).toBe(1);
}

describe("app-server listener shutdown", () => {
	test("websocket shutdown rejects the aggregated cleanup failure", async () => {
		await runFailureInjectedShutdown("ws://127.0.0.1:12345", "websocket");
	});

	test("unix shutdown rejects the aggregated cleanup failure", async () => {
		await runFailureInjectedShutdown("unix:///tmp/gjc-app-server-shutdown-test.sock", "unix");
	});
});
