import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { loadInstallationHostId, loadLegacyInstallationHostId } from "../src/config/machine-identity";

const GUID = "12345678-1234-1234-1234-123456789abc";
const SECRET = Buffer.alloc(32, 0xab).toString("hex");

function stubSpawnSync() {
	return spyOn(Bun, "spawnSync").mockImplementation((() => ({
		exitCode: 0,
		stdout: new TextEncoder().encode(`    MachineGuid    REG_SZ    ${GUID}\r\n`),
		stderr: new Uint8Array(),
		success: true,
	})) as unknown as typeof Bun.spawnSync);
}

describe("machine identity Windows probe", () => {
	afterEach(() => {
		(Bun.spawnSync as unknown as { mockRestore?: () => void }).mockRestore?.();
	});

	// The broker is a console-less detached process on Windows; a child console program that is not
	// created hidden flashes a visible terminal window at every probe.
	it("runs the registry query without a visible console window", async () => {
		const spawn = stubSpawnSync();
		await loadInstallationHostId({ platform: "win32", installationSecret: SECRET });
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn.mock.calls[0]?.[1]).toMatchObject({ windowsHide: true });
	});

	it("hides the console window for the legacy identity probe too", async () => {
		const spawn = stubSpawnSync();
		await loadLegacyInstallationHostId({ platform: "win32" });
		expect(spawn.mock.calls[0]?.[1]).toMatchObject({ windowsHide: true });
	});
});
