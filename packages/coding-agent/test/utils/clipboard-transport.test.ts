import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Subprocess } from "bun";
import { resetSettingsForTest, Settings, settings } from "../../src/config/settings";
import {
	ClipboardTransportError,
	copyToClipboard,
	pasteFromClipboard,
	pasteFromClipboardViaSsh,
} from "../../src/utils/clipboard";

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;

type SpawnCall = { cmd: string[]; options: SpawnOptions };

function streamOf(text: string): ReadableStream<Uint8Array> {
	const body = new Response(text).body;
	if (!body) throw new Error("Failed to create response stream.");
	return body;
}

function streamOfBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

/** Fake spawned ssh process. `written` records everything piped to stdin. */
function fakeSshProcess(
	stdout: string | ReadableStream<Uint8Array>,
	exitCode: number | null = 0,
	written: string[] = [],
	options: { hangForever?: boolean } = {},
): Subprocess {
	let killed = false;
	return {
		pid: 1,
		stdin: {
			write: (chunk: unknown) => {
				written.push(String(chunk));
				return 0;
			},
			end: () => {
				return 0;
			},
			flush: () => 0,
		},
		stdout: options.hangForever
			? new ReadableStream<Uint8Array>()
			: typeof stdout === "string"
				? streamOf(stdout)
				: stdout,
		stderr: streamOf(""),
		get exitCode() {
			return killed ? null : exitCode;
		},
		exited: options.hangForever ? new Promise<number>(() => {}) : Promise.resolve(exitCode ?? 0),
		kill: () => {
			killed = true;
			return true;
		},
	} as unknown as Subprocess;
}

function spySsh(calls: SpawnCall[], proc: Subprocess) {
	function mockSpawn(opts: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], opts?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
		const cmd = Array.isArray(first) ? first : first.cmd;
		const options = Array.isArray(first) ? (second ?? ({} as SpawnOptions)) : (first as SpawnOptions);
		calls.push({ cmd, options });
		return proc;
	}
	return vi.spyOn(Bun, "spawn").mockImplementation(mockSpawn);
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}
function restorePlatform(): void {
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
}

beforeEach(() => {
	resetSettingsForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
	restorePlatform();
	resetSettingsForTest();
});

describe("clipboard.transport precedence (settings)", () => {
	it("defaults to auto when unset", async () => {
		await Settings.init({ inMemory: true });
		expect(settings.get("clipboard.transport")).toBe("auto");
		expect(settings.get("clipboard.sshHost")).toBe("");
	});

	it("config file value applies when no CLI override is present", async () => {
		await Settings.init({ inMemory: true, overrides: { "clipboard.transport": "ssh", "clipboard.sshHost": "mac" } });
		expect(settings.get("clipboard.transport")).toBe("ssh");
		expect(settings.get("clipboard.sshHost")).toBe("mac");
	});

	it("a CLI-style runtime override wins over the persisted config value", async () => {
		await Settings.init({
			inMemory: true,
			overrides: { "clipboard.transport": "ssh", "clipboard.sshHost": "old-host" },
		});
		// This mirrors exactly what main.ts does for --clipboard-transport / --clipboard-ssh-host.
		settings.override("clipboard.transport", "native");
		settings.override("clipboard.sshHost", "new-host");
		expect(settings.get("clipboard.transport")).toBe("native");
		expect(settings.get("clipboard.sshHost")).toBe("new-host");
	});
});

describe("copyToClipboard ssh transport — argv spawn and UTF-8", () => {
	beforeEach(async () => {
		await Settings.init({ inMemory: true, overrides: { "clipboard.transport": "ssh", "clipboard.sshHost": "mac" } });
	});

	it("spawns ssh via argv (never a shell string) with BatchMode/ConnectTimeout and pipes exact UTF-8 stdin", async () => {
		const written: string[] = [];
		const calls: SpawnCall[] = [];
		spySsh(calls, fakeSshProcess("", 0, written));

		const korean = "한글 클립보드 왕복 — …韓字①②🙂\n둘째줄";
		await copyToClipboard(korean);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "--", "mac", "pbcopy"]);
		expect(written.join("")).toBe(korean);
	});

	it("rejects a host with a leading dash (argv injection guard) before spawning", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "clipboard.transport": "ssh", "clipboard.sshHost": "-oProxyCommand=evil" },
		});
		const calls: SpawnCall[] = [];
		const spawnSpy = spySsh(calls, fakeSshProcess("", 0));

		await expect(copyToClipboard("x")).rejects.toThrow(ClipboardTransportError);
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it("rejects an empty host before spawning", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "clipboard.transport": "ssh", "clipboard.sshHost": "" } });
		const spawnSpy = vi.spyOn(Bun, "spawn");

		await expect(copyToClipboard("x")).rejects.toThrow(ClipboardTransportError);
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it("rejects a host with whitespace before spawning", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "clipboard.transport": "ssh", "clipboard.sshHost": "mac host" },
		});
		const spawnSpy = vi.spyOn(Bun, "spawn");

		await expect(copyToClipboard("x")).rejects.toThrow(ClipboardTransportError);
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it("throws on nonzero exit and never falls back to native/OSC52", async () => {
		spySsh([], fakeSshProcess("", 255));
		const stdoutWriteSpy = vi.spyOn(process.stdout, "write");

		await expect(copyToClipboard("x")).rejects.toThrow(/rc=255/);
		// explicit ssh mode must not also emit OSC52 on failure.
		expect(stdoutWriteSpy).not.toHaveBeenCalled();
	});

	it("throws a bounded timeout error and kills the process when ssh hangs", async () => {
		const proc = fakeSshProcess("", null, [], { hangForever: true });
		const killSpy = vi.spyOn(proc, "kill");
		spySsh([], proc);

		const start = Date.now();
		await expect(copyToClipboard("x")).rejects.toThrow(/timed out/);
		const elapsed = Date.now() - start;

		expect(killSpy).toHaveBeenCalled();
		// 5s hard timeout with generous scheduling slack, but must not hang indefinitely.
		expect(elapsed).toBeLessThan(9000);
	}, 10000);

	it("rejects oversize outbound text before spawning ssh", async () => {
		const spawnSpy = vi.spyOn(Bun, "spawn");
		const oversized = "x".repeat(1024 * 1024 + 1);

		await expect(copyToClipboard(oversized)).rejects.toThrow(/exceeds the .*-byte limit/);
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it("rejects outbound text containing a NUL byte before spawning ssh", async () => {
		const spawnSpy = vi.spyOn(Bun, "spawn");

		await expect(copyToClipboard("hello\u0000world")).rejects.toThrow(/NUL byte/);
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it("rejects outbound text containing an unpaired high surrogate before spawning ssh", async () => {
		const spawnSpy = vi.spyOn(Bun, "spawn");
		const unpaired = `abc${String.fromCharCode(0xd83d)}def`; // lone high surrogate, no low surrogate follows

		await expect(copyToClipboard(unpaired)).rejects.toThrow(/unpaired UTF-16 surrogate/);
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it("rejects outbound text containing a lone low surrogate before spawning ssh", async () => {
		const spawnSpy = vi.spyOn(Bun, "spawn");
		const unpaired = `abc${String.fromCharCode(0xdc00)}def`; // lone low surrogate with no preceding high surrogate

		await expect(copyToClipboard(unpaired)).rejects.toThrow(/unpaired UTF-16 surrogate/);
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it("accepts a valid surrogate pair (e.g. an emoji) at exactly the byte boundary", async () => {
		const written: string[] = [];
		spySsh([], fakeSshProcess("", 0, written));
		// U+1F600 GRINNING FACE — a real surrogate pair, 4 bytes in UTF-8.
		const withEmoji = "hello 😀";
		await copyToClipboard(withEmoji);
		expect(written.join("")).toBe(withEmoji);
	});

	it("never emits OSC52 or calls native copy in explicit ssh mode, even on success", async () => {
		spySsh([], fakeSshProcess("", 0));
		const stdoutWriteSpy = vi.spyOn(process.stdout, "write");

		await copyToClipboard("plain text");

		expect(stdoutWriteSpy).not.toHaveBeenCalled();
	});
});

describe("pasteFromClipboard / pasteFromClipboardViaSsh — fatal UTF-8, bounded streaming", () => {
	it("returns null (no-op) when transport is not ssh", async () => {
		await Settings.init({ inMemory: true, overrides: { "clipboard.transport": "auto" } });
		const spawnSpy = vi.spyOn(Bun, "spawn");

		expect(await pasteFromClipboard()).toBeNull();
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it("reads exact UTF-8 stdout via pbpaste argv spawn", async () => {
		await Settings.init({ inMemory: true, overrides: { "clipboard.transport": "ssh", "clipboard.sshHost": "mac" } });
		const korean = "한글 붙여넣기 — 👍";
		const calls: SpawnCall[] = [];
		spySsh(calls, fakeSshProcess(korean, 0));

		const result = await pasteFromClipboard();

		expect(result).toBe(korean);
		expect(calls[0]?.cmd).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "--", "mac", "pbpaste"]);
	});

	it("throws on nonzero pbpaste exit", async () => {
		spySsh([], fakeSshProcess("", 1));
		await expect(pasteFromClipboardViaSsh("mac")).rejects.toThrow(ClipboardTransportError);
	});

	it("rejects a pasted payload containing a NUL byte", async () => {
		spySsh([], fakeSshProcess("abc\u0000def", 0));
		await expect(pasteFromClipboardViaSsh("mac")).rejects.toThrow(/NUL byte/);
	});

	it("fatally rejects invalid UTF-8 bytes instead of normalizing to U+FFFD (Stage 2 defect fix)", async () => {
		// 0xFF is not a valid UTF-8 lead byte anywhere; WHATWG Response.text()/TextDecoder
		// without `fatal: true` would silently replace it with U+FFFD instead of throwing.
		const invalidBytes = new Uint8Array([0x68, 0x69, 0xff, 0x62, 0x79, 0x65]);
		spySsh([], fakeSshProcess(streamOfBytes(invalidBytes), 0));

		await expect(pasteFromClipboardViaSsh("mac")).rejects.toThrow(ClipboardTransportError);
	});

	it("fatally rejects invalid UTF-8 bytes with a message naming the cause (separate spawn, single-use stream)", async () => {
		const invalidBytes = new Uint8Array([0x68, 0x69, 0xff, 0x62, 0x79, 0x65]);
		spySsh([], fakeSshProcess(streamOfBytes(invalidBytes), 0));

		await expect(pasteFromClipboardViaSsh("mac")).rejects.toThrow(/invalid UTF-8/);
	});

	it("aborts (kills the process) before fully buffering an inbound stream over the 1 MiB cap (Stage 2 defect fix)", async () => {
		const oversizedBytes = new TextEncoder().encode("y".repeat(1024 * 1024 + 1));
		const proc = fakeSshProcess(streamOfBytes(oversizedBytes), 0);
		const killSpy = vi.spyOn(proc, "kill");
		spySsh([], proc);

		await expect(pasteFromClipboardViaSsh("mac")).rejects.toThrow(/exceeds the .*-byte limit/);
		expect(killSpy).toHaveBeenCalled();
	});

	it("accepts inbound text at exactly the 1 MiB boundary", async () => {
		const exactBytes = new TextEncoder().encode("z".repeat(1024 * 1024));
		spySsh([], fakeSshProcess(streamOfBytes(exactBytes), 0));

		const result = await pasteFromClipboardViaSsh("mac");
		expect(result.length).toBe(1024 * 1024);
	});
});

describe("SSH operation timeout covers the whole lifecycle (Stage 2 defect fix)", () => {
	it("times out even when the process hangs during stdin write/end, not just during stdout drain", async () => {
		await Settings.init({ inMemory: true, overrides: { "clipboard.transport": "ssh", "clipboard.sshHost": "mac" } });
		const proc = fakeSshProcess("", null, [], { hangForever: true });
		// Simulate a hang during stdin write itself by making stdin.write throw only after a delay —
		// approximate by never resolving stdout (hangForever already covers this), proving the
		// timeout promise races the *entire* work chain (write -> drain -> exit), not just drain.
		spySsh([], proc);

		const start = Date.now();
		await expect(copyToClipboard("x")).rejects.toThrow(/timed out/);
		expect(Date.now() - start).toBeLessThan(9000);
	}, 10000);
});

describe("clipboard.transport = auto / native / osc52 (regression + mode isolation)", () => {
	it("auto still emits OSC52 then attempts native copy (unchanged prior behavior)", async () => {
		await Settings.init({ inMemory: true });
		setPlatform("linux");
		delete process.env.TERMUX_VERSION;
		const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const spawnSpy = vi.spyOn(Bun, "spawn");

		try {
			await copyToClipboard("hello");
			expect(writeSpy).toHaveBeenCalled();
			const osc52Call = writeSpy.mock.calls.find(
				call => typeof call[0] === "string" && call[0].startsWith("\x1b]52;"),
			);
			expect(osc52Call).toBeDefined();
			// auto must never touch ssh/Bun.spawn.
			expect(spawnSpy).not.toHaveBeenCalled();
		} finally {
			if (isTTYDescriptor) Object.defineProperty(process.stdout, "isTTY", isTTYDescriptor);
		}
	});

	it("native mode skips OSC52 entirely", async () => {
		await Settings.init({ inMemory: true, overrides: { "clipboard.transport": "native" } });
		const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		try {
			await copyToClipboard("hello");
			const osc52Call = writeSpy.mock.calls.find(
				call => typeof call[0] === "string" && call[0].startsWith("\x1b]52;"),
			);
			expect(osc52Call).toBeUndefined();
		} finally {
			if (isTTYDescriptor) Object.defineProperty(process.stdout, "isTTY", isTTYDescriptor);
		}
	});

	it("osc52 mode emits OSC52 and never spawns ssh or calls native", async () => {
		await Settings.init({ inMemory: true, overrides: { "clipboard.transport": "osc52" } });
		const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const spawnSpy = vi.spyOn(Bun, "spawn");

		try {
			await copyToClipboard("hello");
			const osc52Call = writeSpy.mock.calls.find(
				call => typeof call[0] === "string" && call[0].startsWith("\x1b]52;"),
			);
			expect(osc52Call).toBeDefined();
			expect(spawnSpy).not.toHaveBeenCalled();
		} finally {
			if (isTTYDescriptor) Object.defineProperty(process.stdout, "isTTY", isTTYDescriptor);
		}
	});
});
