import { describe, expect, it } from "bun:test";
import * as connectionManager from "../../src/ssh/connection-manager";

describe("buildRemoteCommand", () => {
	it("includes -n and OpenSSH ControlMaster options on Unix-like platforms", async () => {
		const args = await connectionManager.buildRemoteCommand(
			{
				name: "host",
				host: "192.168.3.146",
			},
			"ls -la",
			{ platform: "linux" },
		);

		expect(args[0]).toBe("-n");
		expect(args).toContain("ControlMaster=auto");
		expect(args.at(-2)).toBe("192.168.3.146");
		expect(args.at(-1)).toBe("ls -la");
	});

	it("omits OpenSSH ControlMaster options on Windows", async () => {
		const args = await connectionManager.buildRemoteCommand(
			{
				name: "host",
				host: "192.168.3.146",
			},
			"ls -la",
			{ platform: "win32" },
		);

		expect(args[0]).toBe("-n");
		expect(args).not.toContain("ControlMaster=auto");
		expect(args.some(arg => arg.startsWith("ControlPath="))).toBe(false);
		expect(args).not.toContain("ControlPersist=3600");
		expect(args).toContain("BatchMode=yes");
		expect(args.at(-2)).toBe("192.168.3.146");
		expect(args.at(-1)).toBe("ls -la");
	});

	it("preserves valid SSH destination forms on Windows", async () => {
		const destinations = [
			{ host: "example.test", target: "example.test" },
			{ host: "192.0.2.10", target: "192.0.2.10" },
			{ host: "[2001:db8::1]", target: "[2001:db8::1]" },
			{ host: "build_alias", username: "deploy-user", target: "deploy-user@build_alias" },
		];
		for (const destination of destinations) {
			const args = await connectionManager.buildRemoteCommand(
				{ name: "host", host: destination.host, username: destination.username },
				"pwd",
				{ platform: "win32" },
			);
			expect(args.at(-2)).toBe(destination.target);
		}
	});

	it("rejects option-like and control-character destinations on Windows", async () => {
		for (const host of ["-invalid", "example.test\0invalid", "example.test\rinvalid", "example.test\ninvalid"]) {
			await expect(
				connectionManager.buildRemoteCommand({ name: "host", host }, "pwd", { platform: "win32" }),
			).rejects.toThrow("Invalid SSH destination");
		}
		await expect(
			connectionManager.buildRemoteCommand({ name: "host", host: "example.test", username: "-invalid" }, "pwd", {
				platform: "win32",
			}),
		).rejects.toThrow("Invalid SSH destination");
	});
});

describe("supportsSshControlMaster", () => {
	it("disables OpenSSH connection multiplexing on native Windows", () => {
		expect(connectionManager.supportsSshControlMaster("win32")).toBe(false);
	});

	it("keeps OpenSSH connection multiplexing on Unix-like platforms", () => {
		expect(connectionManager.supportsSshControlMaster("linux")).toBe(true);
		expect(connectionManager.supportsSshControlMaster("darwin")).toBe(true);
	});
});
