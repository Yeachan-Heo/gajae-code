import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableValidators } from "../../protocol-source/schema-validators.generated";
import {
	disposeFsWatchers,
	fsCopyHandler,
	fsUnwatchHandler,
	fsWatchHandler,
	fsWatchHandlers,
	getFsWatchRegistrySize,
} from "../../suites/fs-watch-handlers";
import type { HandlerContext } from "../../suites/handlers";

type Notification = { method: string; params: Record<string, unknown> };

const tempDir = mkdtempSync(join(tmpdir(), "gjc-fs-watch-suite-"));

function contextFor(notifications: Notification[]): HandlerContext {
	return {
		connectionId: `fs-watch-test-${crypto.randomUUID()}`,
		emitTo: (_connectionId, method, params) => {
			if (typeof params === "object" && params !== null && !Array.isArray(params))
				notifications.push({ method, params: params as Record<string, unknown> });
		},
	} as HandlerContext;
}

// Recursive watch registration is asynchronous on macOS fsevents, so an early write can land
// before the watch is armed. Keep re-writing until the notification arrives.
async function waitForChange(predicate: () => boolean, rewrite: () => void, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) {
		rewrite();
		await Bun.sleep(25);
	}
	if (!predicate()) throw new Error("Timed out waiting for filesystem notification");
}

beforeEach(() => {
	expect(getFsWatchRegistrySize()).toBe(0);
});

afterEach(async () => {
	await disposeFsWatchers();
	expect(getFsWatchRegistrySize()).toBe(0);
});

afterAll(async () => {
	await disposeFsWatchers();
	expect(getFsWatchRegistrySize()).toBe(0);
	rmSync(tempDir, { recursive: true, force: true });
});

test("FS-001 fs/copy recursively copies a real file tree and overwrites existing files", async () => {
	const sourcePath = join(tempDir, "copy-source", crypto.randomUUID());
	const destinationPath = join(tempDir, "copy-destination", crypto.randomUUID());
	mkdirSync(join(sourcePath, "nested"), { recursive: true });
	mkdirSync(join(destinationPath, "nested"), { recursive: true });
	writeFileSync(join(sourcePath, "root.txt"), "root content");
	writeFileSync(join(sourcePath, "nested", "child.txt"), "new child content");
	writeFileSync(join(destinationPath, "nested", "child.txt"), "old child content");

	const params = { sourcePath, destinationPath, recursive: true };
	expect(stableValidators.clientRequestParams["fs/copy"]?.(params)).toBe(true);
	const result = await fsCopyHandler(params);
	expect(result).toEqual({ ok: true, result: {} });
	if (result.ok) expect(stableValidators.clientRequestResults["fs/copy"]?.(result.result)).toBe(true);
	expect(readFileSync(join(destinationPath, "root.txt"), "utf8")).toBe("root content");
	expect(readFileSync(join(destinationPath, "nested", "child.txt"), "utf8")).toBe("new child content");
});

test("FS-002 fs/watch emits a real fs/changed notification for a nested file write", async () => {
	const watchPath = join(tempDir, "watch-root", crypto.randomUUID());
	const nestedPath = join(watchPath, "nested");
	const changedPath = join(nestedPath, "watched.txt");
	mkdirSync(nestedPath, { recursive: true });
	writeFileSync(changedPath, "before");
	const notifications: Notification[] = [];
	const context = contextFor(notifications);
	const params = { watchId: "watch-one", path: watchPath };

	expect(stableValidators.clientRequestParams["fs/watch"]?.(params)).toBe(true);
	const result = await fsWatchHandler(params, context);
	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(stableValidators.clientRequestResults["fs/watch"]?.(result.result)).toBe(true);
		expect(result.result).toEqual({ path: watchPath });
	}
	expect(getFsWatchRegistrySize()).toBe(1);

	await waitForChange(
		() => notifications.some(notification => notification.method === "fs/changed"),
		() => writeFileSync(changedPath, `after ${Date.now()}`),
	);
	const changed = notifications.find(notification => notification.method === "fs/changed");
	expect(changed).toBeDefined();
	expect(stableValidators.serverNotificationParams["fs/changed"]?.(changed?.params)).toBe(true);
	expect(changed?.params).toMatchObject({ watchId: "watch-one" });
	expect(changed?.params.changedPaths).toEqual(
		expect.arrayContaining([expect.stringMatching(/(?:nested|watched\.txt)$/)]),
	);

	const countAfterFirstWrite = notifications.length;
	expect(await fsUnwatchHandler({ watchId: "watch-one" }, context)).toEqual({ ok: true, result: {} });
	expect(getFsWatchRegistrySize()).toBe(0);
	writeFileSync(changedPath, "after unwatch");
	await Bun.sleep(150);
	expect(notifications).toHaveLength(countAfterFirstWrite);
});

test("FS-003 fs/unwatch stops an unknown-id request with notFound", async () => {
	const context = contextFor([]);
	expect(await fsUnwatchHandler({ watchId: "missing" }, context)).toEqual({ ok: false, errorKey: "notFound" });
});

test("FS-004 fs/copy, fs/watch, and fs/unwatch reject malformed params with invalidParams", async () => {
	const context = contextFor([]);
	const destinationPath = join(tempDir, "invalid-destination", crypto.randomUUID());
	expect(await fsCopyHandler({ sourcePath: "relative/source", destinationPath, recursive: true })).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
	expect(await fsCopyHandler({ sourcePath: destinationPath, destinationPath, recursive: null })).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
	expect(await fsCopyHandler({ sourcePath: join(tempDir, "missing"), destinationPath, recursive: true })).toEqual({
		ok: false,
		errorKey: "notFound",
	});
	expect(await fsWatchHandler({ watchId: "bad" }, context)).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(await fsWatchHandler({ watchId: "bad", path: "relative/path" }, context)).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
	expect(await fsUnwatchHandler({}, context)).toEqual({ ok: false, errorKey: "invalidParams" });
});

test("FS-005 fsWatchHandlers exposes the complete fs watch lane", () => {
	expect(Object.keys(fsWatchHandlers).sort()).toEqual(["fs/copy", "fs/unwatch", "fs/watch"]);
});
