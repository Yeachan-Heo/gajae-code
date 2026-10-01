import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, getSSHConfigPath, setProjectDir, TempDir } from "@gajae-code/utils";
import { runSSHCommand } from "../../src/cli/ssh-cli";

const originalProjectDir = getProjectDir();
let tempDir: TempDir | null = null;
let stdout: string[] = [];
let writeSpy: ReturnType<typeof spyOn<typeof process.stdout, "write">> | undefined;

beforeEach(() => {
	tempDir = TempDir.createSync(path.join(os.tmpdir(), "gjc-ssh-cli-port-"));
	setProjectDir(tempDir.path());
	stdout = [];
	writeSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
		stdout.push(String(chunk));
		return true;
	});
});

afterEach(() => {
	writeSpy?.mockRestore();
	writeSpy = undefined;
	process.exitCode = 0;
	setProjectDir(originalProjectDir);
	tempDir?.removeSync();
	tempDir = null;
});

async function addHost(port: string): Promise<void> {
	await runSSHCommand({
		action: "add",
		args: ["box"],
		flags: { host: "example.test", port, scope: "project" },
	});
}

describe("gjc ssh add --port", () => {
	for (const port of ["22oops", "2222.5", "+22", " 22", "1e3", "0x16", "", "0", "65536"]) {
		it(`rejects ${JSON.stringify(port)} without writing ssh.json`, async () => {
			await addHost(port);

			expect(process.exitCode).toBe(1);
			expect(stdout.join("")).toContain("Port must be an integer between 1 and 65535");
			expect(fs.existsSync(getSSHConfigPath("project"))).toBe(false);
		});
	}

	it("stores a plain integer port", async () => {
		await addHost("2222");

		expect(process.exitCode).not.toBe(1);
		const config = JSON.parse(fs.readFileSync(getSSHConfigPath("project"), "utf8"));
		expect(config.hosts.box).toMatchObject({ host: "example.test", port: 2222 });
	});
});
