// Private-PTY worker used by tty-write.ts. The parent sends a monotonic start
// timestamp over the control pipe immediately before each operation; this worker
// echoes it with the expected UTF-8 output size after writing through the public
// ProcessTerminal API. The parent ends the sample only after draining those bytes.
import { existsSync, createReadStream, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";

const treeRoot = resolve(import.meta.dir, "../../..");
const { ProcessTerminal } = await import(join(treeRoot, "packages/tui/src/terminal.ts"));
const writerPath = join(treeRoot, "packages/tui/src/terminal-writer.ts");
let flushTerminalOutput: ((timeoutMs?: number) => boolean) | undefined;
if (existsSync(writerPath)) {
	const writerModule = await import(writerPath);
	flushTerminalOutput = writerModule.flushTerminalOutput;
}

const commandFd = Number(process.env.TTY_WRITE_COMMAND_FD);
const replyFd = Number(process.env.TTY_WRITE_REPLY_FD);
if (!Number.isInteger(commandFd) || commandFd < 3 || !Number.isInteger(replyFd) || replyFd < 3) {
	throw new Error("tty-write control descriptors were not provided");
}
if (!process.stdout.isTTY) throw new Error("tty-write child stdout is not attached to a PTY");

const terminal = new ProcessTerminal();
const input = createReadStream(null, { fd: commandFd, autoClose: false });
input.setEncoding("utf8");
const lines = createInterface({ input, crlfDelay: Infinity });
const lineIterator = lines[Symbol.asyncIterator]();

function sendControlMessage(value: Record<string, unknown>): void {
	writeSync(replyFd, Buffer.from(`${JSON.stringify(value)}\n`));
}

async function nextControlMessage(): Promise<Record<string, unknown>> {
	const next = await lineIterator.next();
	if (next.done) throw new Error("tty-write parent closed the command pipe");
	const value: unknown = JSON.parse(next.value);
	if (typeof value !== "object" || value === null) throw new Error("tty-write control message must be an object");
	return value as Record<string, unknown>;
}

const columns = 120;
const rows = 40;
const colors = [39, 45, 51, 75, 81, 111, 117, 153];
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz-_=+";
const frame = [
	"\x1b[?25l",
	...Array.from({ length: rows }, (_, row) => {
		const cells = Array.from({ length: columns }, (_, column) => alphabet[(row * columns + column) % alphabet.length]!).join("");
		const segments = Array.from({ length: columns / 24 }, (_, index) => {
			const color = colors[(row + index) % colors.length]!;
			return `\x1b[38;5;${color}m${cells.slice(index * 24, (index + 1) * 24)}\x1b[0m`;
		}).join("");
		return `\x1b[${row + 1};1H${segments}\x1b[K`;
	}),
	"\x1b[0m\x1b[?25h",
].join("");
const manyWrites = Array.from({ length: 200 }, (_, index) => {
	const row = (index % rows) + 1;
	const column = ((index * 7) % 100) + 1;
	const color = colors[index % colors.length]!;
	const text = `w${index.toString().padStart(3, "0")} update`;
	return `\x1b[${row};${column}H\x1b[38;5;${color}m${text}\x1b[0m`;
});

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

sendControlMessage({ type: "ready" });
while (true) {
	const command = await nextControlMessage();
	if (command.type === "stop") {
		sendControlMessage({ type: "stopped" });
		break;
	}
	if (command.type !== "run" || typeof command.id !== "number") {
		sendControlMessage({ type: "error", error: "invalid tty-write command" });
		continue;
	}
	if (command.caseId !== "W01" && command.caseId !== "W02") {
		sendControlMessage({ type: "error", id: command.id, error: `unknown tty-write case ${String(command.caseId)}` });
		continue;
	}

	try {
		sendControlMessage({ type: "start", id: command.id });
		const go = await nextControlMessage();
		if (go.type !== "go" || go.id !== command.id || typeof go.startedNs !== "string") {
			throw new Error("invalid tty-write start timestamp");
		}
		let expectedBytes: number;
		if (command.caseId === "W01") {
			terminal.write(frame);
			expectedBytes = byteLength(frame);
		} else {
			expectedBytes = 0;
			for (const data of manyWrites) {
				terminal.write(data);
				expectedBytes += byteLength(data);
			}
		}
		if (!terminal.available) throw new Error("ProcessTerminal became unavailable while writing");
		if (flushTerminalOutput && !flushTerminalOutput(10_000)) {
			throw new Error("flushTerminalOutput timed out before PTY delivery");
		}
		sendControlMessage({ type: "done", id: command.id, startedNs: go.startedNs, expectedBytes });
	} catch (error) {
		sendControlMessage({ type: "error", id: command.id, error: error instanceof Error ? error.message : String(error) });
	}
}

lines.close();
input.destroy();
