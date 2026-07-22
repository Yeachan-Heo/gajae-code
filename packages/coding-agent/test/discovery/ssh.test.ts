import { afterEach, describe, expect, it, vi } from "bun:test";
import { getSSHConfigPath, logger, TempDir } from "@gajae-code/utils";
import { reset as resetCapabilities } from "../../src/capability";
import type { SSHHost } from "../../src/capability/ssh";
import { sshCapability } from "../../src/capability/ssh";
import { loadCapability } from "../../src/discovery";

describe("SSH discovery destination validation", () => {
	const tempDirs: TempDir[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		resetCapabilities();
		for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
	});

	it("omits unsafe project entries and logs a warning", async () => {
		const tempDir = TempDir.createSync("gjc-ssh-discovery-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const configPath = getSSHConfigPath("project", cwd);
		await Bun.write(
			configPath,
			JSON.stringify({
				hosts: {
					"g024-safe-dns": { host: "example.test" },
					"g024-safe-ipv4": { host: "192.0.2.10" },
					"g024-safe-ipv6": { host: "[2001:db8::1]" },
					"g024-safe-alias": { host: "build_alias", username: "deploy-user" },
					"g024-leading-dash": { host: "-invalid" },
					"g024-line-break": { host: "example.test\ninvalid" },
				},
			}),
		);
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const result = await loadCapability<SSHHost>(sshCapability.id, { cwd, providers: ["ssh-json"] });
		const names = result.items.map(item => item.name);

		expect(names).toEqual(
			expect.arrayContaining(["g024-safe-dns", "g024-safe-ipv4", "g024-safe-ipv6", "g024-safe-alias"]),
		);
		expect(names).not.toContain("g024-leading-dash");
		expect(names).not.toContain("g024-line-break");
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining("g024-leading-dash"),
				expect.stringContaining("g024-line-break"),
			]),
		);
		expect(warn).toHaveBeenCalledWith(
			"Ignoring SSH entry with invalid destination",
			expect.objectContaining({ name: "g024-leading-dash", path: expect.stringContaining(configPath) }),
		);
	});
});
