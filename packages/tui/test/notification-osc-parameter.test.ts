import { afterEach, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { NotifyProtocol, TerminalInfo } from "../src/terminal-capabilities.js";

const PROPERTY_SEED = 90211;
const PROPERTY_RUNS = 80;
const ST = "\x1b\\";

function terminal(protocol: NotifyProtocol): TerminalInfo {
	return new TerminalInfo("ghostty", null, true, true, protocol);
}

function hasParamControl(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

function parameter(frame: string, protocol: NotifyProtocol): string {
	expect(frame.startsWith(protocol)).toBe(true);
	expect(frame.endsWith(ST)).toBe(true);
	return frame.slice(protocol.length, -ST.length);
}

function captureNotification(protocol: NotifyProtocol, message: string): string {
	const previous = process.env.PI_NOTIFICATIONS;
	delete process.env.PI_NOTIFICATIONS;
	const chunks: string[] = [];
	const stdout = process.stdout;
	const original = stdout.write;
	stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof stdout.write;
	try {
		terminal(protocol).sendNotification(message);
	} finally {
		stdout.write = original;
		if (previous === undefined) delete process.env.PI_NOTIFICATIONS;
		else process.env.PI_NOTIFICATIONS = previous;
	}
	return chunks.join("");
}

describe("OSC notification parameters", () => {
	const previousNotifications = process.env.PI_NOTIFICATIONS;
	afterEach(() => {
		if (previousNotifications === undefined) delete process.env.PI_NOTIFICATIONS;
		else process.env.PI_NOTIFICATIONS = previousNotifications;
	});

	it("sendNotification writes one OSC 9 frame when the title contains other OSC commands", () => {
		const clip = Buffer.from("NOTE-BREAK").toString("base64");
		const message = [
			"notes: ",
			`\x1b]52;c;${clip}\x07`,
			"\x1b]0;taken\x07",
			"\x1b]8;;https://evil.example/x\x07",
			"link",
			"\x1b]8;;\x07",
			"\x9c",
			": Complete",
		].join("");
		const frame = captureNotification(NotifyProtocol.Osc9, message);
		expect(frame).toBe(terminal(NotifyProtocol.Osc9).formatNotification(message));
		expect(frame.startsWith(NotifyProtocol.Osc9)).toBe(true);
		expect(frame.endsWith(ST)).toBe(true);
		expect(frame.includes("\x1b]52")).toBe(false);
		expect(frame.includes("\x1b]0;")).toBe(false);
		expect(frame.includes("\x1b]8;;")).toBe(false);
		expect(frame.includes("\x07")).toBe(false);
		expect(frame.includes("\x9c")).toBe(false);
		expect(parameter(frame, NotifyProtocol.Osc9)).toContain("notes: ");
		expect(parameter(frame, NotifyProtocol.Osc9)).toContain("link");
		expect(parameter(frame, NotifyProtocol.Osc9)).toContain(": Complete");
		const commands = parseOsc(frame);
		expect(commands.map(command => command.code)).toEqual(["9"]);
	});

	it("keeps a printable title, an empty title, and Hangul byte for byte", () => {
		const title = "rename parser: Complete";
		expect(terminal(NotifyProtocol.Osc9).formatNotification(title)).toBe(`\x1b]9;${title}${ST}`);
		expect(terminal(NotifyProtocol.Osc99).formatNotification(title)).toBe(`\x1b]99;;${title}${ST}`);
		expect(terminal(NotifyProtocol.Osc9).formatNotification("")).toBe(`\x1b]9;${ST}`);
		expect(terminal(NotifyProtocol.Osc9).formatNotification("세션: Complete")).toBe(`\x1b]9;세션: Complete${ST}`);
		expect(terminal(NotifyProtocol.Osc9).formatNotification("  spaced  ")).toBe(`\x1b]9;  spaced  ${ST}`);
	});

	it("Bell notifications stay a single BEL for printable and hostile messages", () => {
		expect(terminal(NotifyProtocol.Bell).formatNotification("rename parser: Complete")).toBe("\x07");
		expect(terminal(NotifyProtocol.Bell).formatNotification("\x1b]52;c;QQ==\x07")).toBe("\x07");
		expect(captureNotification(NotifyProtocol.Bell, "rename parser: Complete")).toBe("\x07");
	});

	it("property: OSC notification parameter, fc.property seed 90211, numRuns 80", () => {
		const control = fc.integer({ min: 0x00, max: 0x9f }).filter(code => code <= 0x1f || code >= 0x7f);
		fc.assert(
			fc.property(
				fc.string({ maxLength: 40 }),
				fc.array(control, { minLength: 1, maxLength: 6 }),
				(noise, codes) => {
					const injected = codes.map(code => String.fromCharCode(code)).join("");
					const message = `${noise}\x1b]52;c;QQ==\x07${injected}`;
					for (const protocol of [NotifyProtocol.Osc9, NotifyProtocol.Osc99]) {
						const frame = terminal(protocol).formatNotification(message);
						const body = parameter(frame, protocol);
						expect(hasParamControl(body)).toBe(false);
						expect(body).toBe(message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""));
						expect(terminal(protocol).formatNotification(body)).toBe(frame);
						expect(frame.includes("\x1b]52")).toBe(false);
						expect(frame.includes("\x07")).toBe(false);
						expect([...frame].filter(char => char === "\x1b").length).toBe(2);
						const code = protocol === NotifyProtocol.Osc99 ? "99" : "9";
						expect(parseOsc(frame).map(command => command.code)).toEqual([code]);
					}
					expect(terminal(NotifyProtocol.Bell).formatNotification(message)).toBe("\x07");
				},
			),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});

	it("property: printable titles stay unchanged, fc.property seed 90211, numRuns 80", () => {
		const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 :._-/";
		fc.assert(
			fc.property(fc.string({ minLength: 0, maxLength: 48, unit: fc.constantFrom(...alphabet) }), message => {
				for (const protocol of [NotifyProtocol.Osc9, NotifyProtocol.Osc99]) {
					expect(terminal(protocol).formatNotification(message)).toBe(`${protocol}${message}${ST}`);
				}
			}),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});

	it("scans a long parameter once without opening a second OSC command", () => {
		const filler = "a".repeat(200_000);
		const message = `${filler}\x1b]52;c;QQ==\x07${filler}`;
		const frame = terminal(NotifyProtocol.Osc9).formatNotification(message);
		expect(parameter(frame, NotifyProtocol.Osc9)).toBe(`${filler}]52;c;QQ==${filler}`);
		expect(parseOsc(frame).map(command => command.code)).toEqual(["9"]);
		expect(frame.length).toBe(message.length - 2 + NotifyProtocol.Osc9.length + ST.length);
	});
});

function parseOsc(frame: string): Array<{ code: string }> {
	const commands: Array<{ code: string }> = [];
	let index = 0;
	while (index < frame.length) {
		if (frame[index] !== "\x1b") {
			index += 1;
			continue;
		}
		if (frame[index + 1] === "\\") {
			index += 2;
			continue;
		}
		expect(frame[index + 1]).toBe("]");
		index += 2;
		const start = index;
		while (index < frame.length) {
			const char = frame[index];
			if (char === "\x07" || char === "\x9c" || char === "\x1b") break;
			index += 1;
		}
		const raw = frame.slice(start, index);
		const semi = raw.indexOf(";");
		commands.push({ code: semi < 0 ? raw : raw.slice(0, semi) });
		if (frame[index] === "\x1b" && frame[index + 1] === "\\") index += 2;
		else if (index < frame.length) index += 1;
	}
	return commands;
}
