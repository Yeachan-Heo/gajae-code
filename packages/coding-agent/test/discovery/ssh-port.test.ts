import { afterEach, describe, expect, it } from "bun:test";
import { getSSHConfigPath, TempDir } from "@gajae-code/utils";
import { reset as resetCapabilities } from "../../src/capability";
import type { SSHHost } from "../../src/capability/ssh";
import { sshCapability } from "../../src/capability/ssh";
import { loadCapability } from "../../src/discovery";

describe("SSH discovery port validation", () => {
	const tempDirs: TempDir[] = [];

	afterEach(() => {
		resetCapabilities();
		for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
	});

	async function loadHosts(hosts: Record<string, unknown>) {
		const tempDir = TempDir.createSync("gjc-ssh-port-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		await Bun.write(getSSHConfigPath("project", cwd), JSON.stringify({ hosts }));
		const result = await loadCapability<SSHHost>(sshCapability.id, { cwd, providers: ["ssh-json"] });
		const ports = Object.fromEntries(result.items.map(item => [item.name, item.port]));
		return { ports, warnings: result.warnings ?? [] };
	}

	it("given malformed ports, when ssh.json loads, then the port is dropped with a warning", async () => {
		const malformed: Record<string, unknown> = {
			"trailing-garbage": "22oops",
			"fractional-string": "2222.5",
			"signed-string": "+22",
			"fractional-number": 2222.5,
			zero: 0,
			"too-large": 70000,
			"too-large-string": "65536",
			array: [2222],
			boolean: true,
		};
		const hosts = Object.fromEntries(
			Object.entries(malformed).map(([name, port]) => [name, { host: "example.test", port }]),
		);

		const { ports, warnings } = await loadHosts(hosts);

		for (const name of Object.keys(malformed)) {
			expect(ports).toHaveProperty(name, undefined);
			const warning = `Invalid port for SSH entry ${name}: ${String(malformed[name])}`;
			expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining(warning)]));
		}
	});

	it("given valid ports, when ssh.json loads, then they are kept without warnings", async () => {
		const { ports, warnings } = await loadHosts({
			"number-port": { host: "example.test", port: 2222 },
			"string-port": { host: "example.test", port: "2200" },
			"max-port": { host: "example.test", port: 65535 },
			"no-port": { host: "example.test" },
		});

		expect(ports).toEqual({ "number-port": 2222, "string-port": 2200, "max-port": 65535, "no-port": undefined });
		expect(warnings).toEqual([]);
	});
});
