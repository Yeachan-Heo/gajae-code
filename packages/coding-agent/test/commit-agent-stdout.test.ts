import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@gajae-code/ai";
import { sanitizeText } from "@gajae-code/utils";
import { runCommitAgentSession } from "../src/commit/agentic/agent";
import * as toolsModule from "../src/commit/agentic/tools";
import { Settings } from "../src/config/settings";
import { initTheme } from "../src/modes/theme/theme";
import type { CreateAgentSessionResult } from "../src/sdk";
import * as sdkModule from "../src/sdk";

const SEED = 349;
const PROPERTY_INPUTS = 64;
const PREVIEW = "hi\x1b[2A\x1b]0;PWN\x07X";
const HOSTILE = "hello\x1b[2A\x1b]0;PWNED_TITLE\x07\x1b]8;;https://evil.example\x1b\\click\x1b]8;;\x1b\\\x07";

type Emit = (event: Record<string, unknown>) => void;

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function propertyInputs(): string[] {
	const rand = mulberry32(SEED);
	const alphabet = "abc ./_\n\t\x00\x07\x1b[";
	const inputs = [HOSTILE];
	while (inputs.length < PROPERTY_INPUTS) {
		const length = 1 + Math.floor(rand() * 24);
		let value = "";
		for (let index = 0; index < length; index += 1) {
			value += alphabet[Math.floor(rand() * alphabet.length)] ?? "a";
		}
		inputs.push(value);
	}
	return inputs;
}

async function captureStdout(emit: (handler: Emit) => void): Promise<string[]> {
	let handler: Emit = () => {};
	let emitted = false;
	const session = {
		prompt: async () => {
			if (emitted) return;
			emitted = true;
			emit(handler);
		},
		subscribe: (cb: Emit) => {
			handler = cb;
			return () => {};
		},
		dispose: async () => {},
	};
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as unknown as CreateAgentSessionResult);
	vi.spyOn(toolsModule, "createCommitTools").mockReturnValue([]);

	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 model to exist");
	}

	const chunks: string[] = [];
	const stdout = process.stdout;
	const previousWrite = stdout.write;
	const previousTty = stdout.isTTY;
	stdout.isTTY = true;
	stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof stdout.write;
	try {
		await runCommitAgentSession({
			cwd: "repo",
			model,
			settings: Settings.isolated(),
			modelRegistry: {
				withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
			} as never,
			authStorage: {} as never,
			changelogTargets: [],
			requireChangelog: false,
		});
		return chunks;
	} finally {
		stdout.write = previousWrite;
		stdout.isTTY = previousTty;
	}
}

describe("commit agent stdout", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops ESC, CSI, OSC, and BEL from commit agent stdout", async () => {
		const chunks = await captureStdout(handler => {
			handler({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: PREVIEW }] },
			});
			handler({
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: HOSTILE,
					content: [{ type: "text", text: HOSTILE }],
				},
			});
			handler({
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: HOSTILE,
				args: { note: HOSTILE },
			});
			handler({
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: HOSTILE,
				isError: false,
			});
		});
		const raw = chunks.join("");
		const visible = Bun.stripANSI(raw);
		expect(raw.includes("\x1b[2A")).toBe(false);
		expect(raw.includes("\x1b]0;")).toBe(false);
		expect(raw.includes("\x1b]8;;")).toBe(false);
		expect(raw.includes("\x07")).toBe(false);
		expect(raw.includes("PWNED_TITLE")).toBe(false);
		expect(visible).toContain("hiX");
		expect(visible).toContain("helloclick");
	});

	it("still allows ordinary commit agent preview, error, assistant text, and tool args", async () => {
		const chunks = await captureStdout(handler => {
			handler({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "Review parser changes." }] },
			});
			handler({
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: "provider timed out",
					content: [{ type: "text", text: "Review parser changes.\nKeep the public helper." }],
				},
			});
			handler({
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "read_file",
				args: { path: "src/\tapp.ts" },
			});
			handler({
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "read_file",
				isError: false,
			});
		});
		const raw = chunks.join("");
		const visible = Bun.stripANSI(raw);
		expect(visible).toContain("Review parser changes.");
		expect(visible).toContain("Keep the public helper.");
		expect(visible).toContain("ReadFile");
		expect(visible).toContain("src/\tapp.ts");
		expect(raw).toContain("● Error: provider timed out\n");
	});

	it("property: commit agent error line matches sanitizeText, seed 349, 64 inputs", async () => {
		const inputs = propertyInputs();
		expect(inputs).toHaveLength(PROPERTY_INPUTS);
		const chunks = await captureStdout(handler => {
			for (const input of inputs) {
				handler({
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: "error",
						errorMessage: input,
						content: [],
					},
				});
			}
		});
		const errors = chunks.filter(chunk => chunk.startsWith("● Error:"));
		expect(errors).toHaveLength(PROPERTY_INPUTS);
		for (let index = 0; index < inputs.length; index += 1) {
			expect(errors[index]).toBe(`● Error: ${sanitizeText(inputs[index] ?? "")}\n`);
		}
	});
});
