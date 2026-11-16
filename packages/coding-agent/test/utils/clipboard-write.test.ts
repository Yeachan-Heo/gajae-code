import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as native from "@gajae-code/natives";
import type { Subprocess } from "bun";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { copyToClipboard } from "../../src/utils/clipboard";

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;
type SpawnCall = { cmd: string[]; options: SpawnOptions };

function emptyStream(): ReadableStream<Uint8Array> {
	const body = new Response("").body;
	if (!body) throw new Error("Failed to create response stream.");
	return body;
}

function fakeProcess(exitCode: number): Subprocess {
	return {
		pid: 1,
		stdout: emptyStream(),
		stderr: emptyStream(),
		exitCode,
		exited: Promise.resolve(exitCode),
		kill: () => true,
	} as unknown as Subprocess;
}

function spySpawn(calls: SpawnCall[], exitCode = 0) {
	function mockSpawn(opts: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], opts?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
		const cmd = Array.isArray(first) ? first : first.cmd;
		const options = Array.isArray(first) ? (second ?? ({} as SpawnOptions)) : (first as SpawnOptions);
		calls.push({ cmd, options });
		return fakeProcess(exitCode);
	}
	return vi.spyOn(Bun, "spawn").mockImplementation(mockSpawn);
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
let savedTermux: string | undefined;

beforeEach(async () => {
	savedTermux = process.env.TERMUX_VERSION;
	process.env.TERMUX_VERSION = "0.118";
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	if (savedTermux === undefined) delete process.env.TERMUX_VERSION;
	else process.env.TERMUX_VERSION = savedTermux;
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	if (isTTYDescriptor) Object.defineProperty(process.stdout, "isTTY", isTTYDescriptor);
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("Termux write path", () => {
	it("spawns termux-clipboard-set asynchronously and skips native on success", async () => {
		const calls: SpawnCall[] = [];
		spySpawn(calls);
		const nativeSpy = vi.spyOn(native, "copyToClipboard").mockImplementation(() => {});

		await copyToClipboard("hello");

		expect(calls.map(call => call.cmd)).toEqual([["termux-clipboard-set"]]);
		expect(nativeSpy).not.toHaveBeenCalled();
	});

	it("falls back to the native write when termux-clipboard-set fails", async () => {
		const calls: SpawnCall[] = [];
		spySpawn(calls, 1);
		const nativeSpy = vi.spyOn(native, "copyToClipboard").mockImplementation(() => {});

		await copyToClipboard("hello");

		expect(calls.map(call => call.cmd)).toEqual([["termux-clipboard-set"]]);
		expect(nativeSpy).toHaveBeenCalledWith("hello");
	});
});
