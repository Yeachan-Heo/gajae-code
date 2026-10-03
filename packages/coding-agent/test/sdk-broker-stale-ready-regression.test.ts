import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as lifecycle from "../src/sdk/broker/lifecycle";

test("launch cleanup retires an exited id pair regardless of age or ready marker contents", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-stale-ready-launch-"));
	const sdk = path.join(root, "sdk");
	const id = "stale-resume";
	const markerPath = path.join(sdk, `${id}.lifecycle.json`);
	const readyPath = path.join(sdk, `${id}.lifecycle.ready.json`);
	try {
		await fs.mkdir(sdk, { recursive: true });
		await fs.writeFile(markerPath, JSON.stringify({ pid: 999_999_999, effectMarker: "old", incarnation: "old" }));
		await fs.writeFile(
			readyPath,
			JSON.stringify({ pid: 999_999_998, effectMarker: "different", incarnation: "different" }),
		);

		const retire = (
			lifecycle as typeof lifecycle & {
				retireExitedLifecycleMarkerPair?: (root: string, id: string) => Promise<boolean>;
			}
		).retireExitedLifecycleMarkerPair;
		expect(retire).toBeFunction();
		await expect(retire?.(root, id)).resolves.toBe(true);
		await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(readyPath)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("marker sweep counts only lifecycle marker candidates against its inspection limit", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-stale-ready-limit-"));
	const sdk = path.join(root, "sdk");
	const id = "expired-marker";
	const markerPath = path.join(sdk, `${id}.lifecycle.json`);
	try {
		await fs.mkdir(sdk, { recursive: true });
		await fs.writeFile(path.join(sdk, "unrelated.txt"), "unrelated");
		const marker = { pid: 999_999_999, effectMarker: "old", incarnation: "old" };
		await fs.writeFile(path.join(sdk, `${id}.lifecycle.ready.json`), JSON.stringify(marker));
		await fs.writeFile(markerPath, JSON.stringify(marker));
		const expiredAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await fs.utimes(markerPath, expiredAt, expiredAt);

		await expect(lifecycle.reapDeadLifecycleMarkers(root, 1)).resolves.toBe(1);
		await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("published ready marker exposes revocation for detached host shutdown", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-stale-ready-revoke-"));
	const id = "detached-ready";
	const effectMarker = "detached-ready-effect";
	let revoke: (() => Promise<boolean>) | undefined;
	try {
		await lifecycle.writeSessionLifecycleReady(root, id, effectMarker, () => true, callback => {
			revoke = callback;
		});
		const readyPath = path.join(root, "sdk", `${id}.lifecycle.ready.json`);
		await expect(fs.stat(readyPath)).resolves.toBeDefined();
		expect(revoke).toBeFunction();
		await expect(revoke?.()).resolves.toBe(true);
		await expect(fs.stat(readyPath)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
