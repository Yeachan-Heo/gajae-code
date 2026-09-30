import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, getSSHConfigPath, setProjectDir } from "@gajae-code/utils";
import { SSHCommandController } from "../src/modes/controllers/ssh-command-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";

const originalProjectDir = getProjectDir();
let projectDir = "";

beforeAll(() => initTheme());

beforeEach(() => {
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-ssh-add-port-"));
	setProjectDir(projectDir);
});

afterEach(() => {
	setProjectDir(originalProjectDir);
	fs.rmSync(projectDir, { recursive: true, force: true });
});

function controller(): { run: (text: string) => Promise<void>; errors: string[] } {
	const errors: string[] = [];
	const ctx = {
		showError: (message: string) => errors.push(message),
		session: { refreshSshTool: async () => {} },
		chatContainer: { addChild: () => {} },
		ui: { requestRender: () => {} },
	} as unknown as InteractiveModeContext;
	const instance = new SSHCommandController(ctx);
	return { run: text => instance.handle(text), errors };
}

describe("/ssh add --port in interactive mode", () => {
	it("refuses a port with trailing or non-digit characters instead of saving a truncated port", async () => {
		const { run, errors } = controller();

		// Given ports that Number.parseInt would truncate or coerce to a valid number.
		for (const port of ["22oops", "2222.5", "+22", "0x16"]) {
			// When the interactive /ssh add parses them.
			await run(`/ssh add box --host example.com --port ${port}`);
		}

		// Then each is refused and no project SSH config is written.
		expect(errors).toEqual(Array(4).fill("Invalid --port value. Must be an integer between 1 and 65535."));
		expect(fs.existsSync(getSSHConfigPath("project", projectDir))).toBe(false);
	});

	it("still saves a plain decimal port", async () => {
		const { run, errors } = controller();

		await run("/ssh add box --host example.com --port 2222");

		expect(errors).toEqual([]);
		const config = JSON.parse(fs.readFileSync(getSSHConfigPath("project", projectDir), "utf8"));
		expect(JSON.stringify(config)).toContain('"port":2222');
	});
});
