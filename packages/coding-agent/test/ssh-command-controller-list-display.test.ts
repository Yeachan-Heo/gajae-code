import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Text } from "@gajae-code/tui";
import { getAgentDir, getProjectDir, getSSHConfigPath, setAgentDir, setProjectDir } from "@gajae-code/utils";
import fc from "fast-check";
import { SSHCommandController } from "../src/modes/controllers/ssh-command-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";

const OSC0 = "\x1b]0;Google Security\x07";
const OSC8 = "\x1b]8;;https://attacker.invalid/track\x07";
const OSC52 = "\x1b]52;c;bWFsaWNpb3Vz\x07";
const CSI2K = "\x1b[2K";
const originalProjectDir = getProjectDir();
const originalAgentDir = getAgentDir();

let projectDir = "";
let agentDir = "";

beforeAll(() => initTheme());

beforeEach(() => {
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-ssh-list-"));
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-ssh-agent-"));
	setProjectDir(projectDir);
	setAgentDir(agentDir);
});

afterEach(() => {
	setProjectDir(originalProjectDir);
	setAgentDir(originalAgentDir);
	fs.rmSync(projectDir, { recursive: true, force: true });
	fs.rmSync(agentDir, { recursive: true, force: true });
});

function writeHosts(scope: "project" | "user", hosts: Record<string, unknown>): void {
	const file = getSSHConfigPath(scope, projectDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ hosts }));
}

function panel(): { run: () => Promise<void>; errors: string[]; text: () => string } {
	const errors: string[] = [];
	const rendered: unknown[] = [];
	const ctx = {
		showError: (message: string) => errors.push(message),
		session: { refreshSshTool: async () => {} },
		chatContainer: { addChild: (child: unknown) => rendered.push(child) },
		ui: { requestRender: () => {} },
	} as unknown as InteractiveModeContext;
	const instance = new SSHCommandController(ctx);
	return {
		run: () => instance.handle("/ssh list"),
		errors,
		text: () =>
			rendered
				.filter((child): child is Text => child instanceof Text)
				.map(child => child.getText())
				.join("\n"),
	};
}

function expectNoTerminalControls(text: string): void {
	expect(text.includes("\x1b]")).toBe(false);
	expect(text.includes("\x1b[2K")).toBe(false);
	expect(text.includes("\x9d")).toBe(false);
	expect(text).not.toContain("attacker.invalid");
	expect(text).not.toContain("Google Security");
	expect(text).not.toContain("bWFsaWNpb3Vz");
}

describe("/ssh list display", () => {
	it("strips osc from project and user ssh list fields", async () => {
		const hostileName = `prod${OSC0}${OSC52}${CSI2K}\nINJECT`;
		writeHosts("project", {
			[hostileName]: {
				host: `example.com${OSC8}`,
				username: `deploy${OSC0}`,
				port: 2222,
			},
			box: { host: "10.0.0.5", username: "root", port: `2222${OSC52}` },
		});
		writeHosts("user", {
			[`user${OSC8}`]: { host: "127.0.0.1", username: "me", port: 2200 },
		});

		const { run, errors, text } = panel();
		await run();
		const shown = text();

		expect(errors).toEqual([]);
		expectNoTerminalControls(shown);
		expect(shown).toContain("prod INJECT");
		expect(shown).toContain("[example.com, user=deploy, port=2222]");
		expect(shown).toContain("[10.0.0.5, user=root, port=2222]");
		expect(shown).toContain("user");
		expect(shown).toContain("[127.0.0.1, user=me, port=2200]");
		expect(shown.includes("prod\nINJECT")).toBe(false);
	});

	it("still allows ordinary ssh list fields with case, whitespace, ipv6, and the default port", async () => {
		writeHosts("project", {
			"Prod.Web_1": { host: "EXAMPLE.COM.", username: "Deploy", port: 2222 },
			" plain ": { host: "[::1]", username: " ops ", port: 22 },
			bare: { host: "localhost" },
			"spaced-host": { host: " example.com ", username: "deploy", port: " 2222" },
		});
		writeHosts("user", {
			User_Host: { host: "user.example", username: "me", port: 2200 },
		});

		const { run, errors, text } = panel();
		await run();
		const shown = text();
		const ipv6Line = shown.split("\n").find(line => line.includes("[::1]"));

		expect(errors).toEqual([]);
		expect(shown).toContain("Prod.Web_1");
		expect(shown).toContain("[EXAMPLE.COM., user=Deploy, port=2222]");
		expect(shown).toContain(" plain ");
		expect(shown).toContain("user= ops ");
		expect(ipv6Line).toBeDefined();
		expect(ipv6Line).not.toContain("port=");
		expect(shown).toContain("bare");
		expect(shown).toContain("[localhost]");
		expect(shown).toContain("[ example.com , user=deploy, port= 2222]");
		expect(shown).toContain("User_Host");
		expect(shown).toContain("[user.example, user=me, port=2200]");
	});

	it("still allows a numeric host and username beside an ordinary host", async () => {
		writeHosts("project", {
			plain: { host: "example.com", username: "deploy", port: 2222 },
			numUser: { host: "localhost", username: 123 },
			numHost: { host: 123, username: "deploy" },
			strNeighbor: { host: "123", username: "123" },
		});

		const { run, errors, text } = panel();
		await run();
		const shown = text();

		expect(errors).toEqual([]);
		expect(shown).toContain("[example.com, user=deploy, port=2222]");
		expect(shown).toContain("[localhost, user=123]");
		expect(shown).toContain("[123, user=deploy]");
		expect(shown).toContain("[123, user=123]");
	});

	it("property ssh list terminal label seed 692202610", async () => {
		const imported = await import("../src/modes/controllers/ssh-command-controller");
		const sshListTerminalLabel = imported.sshListTerminalLabel;
		if (typeof sshListTerminalLabel !== "function") throw new Error("sshListTerminalLabel missing");
		const safe = fc
			.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-".split("")), {
				maxLength: 24,
			})
			.map(chars => chars.join(""));
		fc.assert(
			fc.property(safe, fc.string({ maxLength: 24 }), (label, noise) => {
				const shown = sshListTerminalLabel(noise);
				expect(shown).toBe(sshListTerminalLabel(shown));
				expect(shown).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u);
				expect(shown.includes("\n")).toBe(false);
				expect(shown.includes("\r")).toBe(false);
				expect(sshListTerminalLabel(label)).toBe(label);
				const wrapped = sshListTerminalLabel(`${label}${OSC0}${label}`);
				expect(wrapped.includes("\u001b")).toBe(false);
				expect(wrapped.startsWith(label)).toBe(true);
				expect(wrapped.endsWith(label)).toBe(true);
			}),
			{ seed: 692202610, numRuns: 64 },
		);
	});
});
