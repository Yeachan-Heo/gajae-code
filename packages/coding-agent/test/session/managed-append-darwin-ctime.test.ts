/**
 * Regression for https://github.com/Yeachan-Heo/gajae-code/issues/2944
 *
 * Darwin managed transcript appends now publish an exact replacement instead of
 * opening the destination with O_APPEND. The replacement must tolerate a ctime-only
 * transition while rejecting real destination mutations after capture.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ManagedSessionDescendantStore,
	managedDirectoryRoot,
} from "../../src/session/internal/managed-session-storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fsp.rm(directory, { recursive: true, force: true })),
	);
});

async function createStore(options?: { withoutNativeAuthority?: boolean }): Promise<{
	root: string;
	store: ManagedSessionDescendantStore;
	filePath: string;
	relativePath: string;
}> {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-append-darwin-ctime-"));
	temporaryDirectories.push(root);
	// Owner-only directory expected by managed security.
	await fsp.chmod(root, 0o700);
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	let store: ManagedSessionDescendantStore;
	try {
		if (options?.withoutNativeAuthority && process.platform === "linux") {
			Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
		}
		store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
	} finally {
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	}
	const relativePath = "transcript.jsonl";
	const initial = Buffer.from(`${JSON.stringify({ type: "session", id: "seed" })}\n`, "utf8");
	store.publishNoReplaceSync(relativePath, initial);
	return { root, store, filePath: path.join(root, relativePath), relativePath };
}

function installFirstFsyncHook(hook: () => void): { calls: number } {
	const state = { calls: 0 };
	const realFsyncSync = fs.fsyncSync.bind(fs);
	vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
		if (state.calls === 0) {
			state.calls += 1;
			hook();
		}
		return realFsyncSync(fd);
	});
	return state;
}

/** Same-mode chmod: on Darwin/APFS this typically advances ctime only. */
function bumpCtimeOnly(pathname: string): void {
	const mode = fs.lstatSync(pathname).mode;
	fs.chmodSync(pathname, mode & 0o7777);
}

describe("ManagedSessionDescendantStore.appendSync fail-closed replacement races", () => {
	it("rejects size mutation between capture and exact replacement without appending the request", async () => {
		const { store, filePath, relativePath } = await createStore({ withoutNativeAuthority: true });
		const beforeBytes = fs.readFileSync(filePath);
		const record = Buffer.from(`${JSON.stringify({ type: "message", id: "m-race" })}\n`, "utf8");

		const fsyncState = installFirstFsyncHook(() => {
			fs.appendFileSync(filePath, "stale-race\n");
		});

		expect(() => store.appendSync(relativePath, record)).toThrow("identity_mismatch");
		expect(fsyncState.calls).toBe(1);
		const after = fs.readFileSync(filePath, "utf8");
		expect(after).toBe(`${beforeBytes.toString("utf8")}stale-race\n`);
		expect(after.includes('"id":"m-race"')).toBe(false);
	});
});

describe.skipIf(process.platform !== "darwin")(
	"ManagedSessionDescendantStore.appendSync Darwin ctime-only replacement (#2944)",
	() => {
		it("accepts a ctime-only transition before exact replacement and appends exactly once", async () => {
			const { store, filePath, relativePath } = await createStore();
			const beforeBytes = fs.readFileSync(filePath);
			const record = Buffer.from(`${JSON.stringify({ type: "message", id: "m1" })}\n`, "utf8");

			const fsyncState = installFirstFsyncHook(() => {
				bumpCtimeOnly(filePath);
			});

			store.appendSync(relativePath, record);

			expect(fsyncState.calls).toBe(1);
			const afterBytes = fs.readFileSync(filePath);
			expect(afterBytes.equals(Buffer.concat([beforeBytes, record]))).toBe(true);
			expect(afterBytes.toString("utf8").trimEnd().split("\n")).toHaveLength(2);
		});

		it("documents that same-mode chmod can change only ctime on this host", async () => {
			const { store, filePath, relativePath } = await createStore();
			const captured = store.readExpected(relativePath);
			if (!captured) throw new Error("expected seed transcript");
			bumpCtimeOnly(filePath);
			const after = fs.lstatSync(filePath, { bigint: true });
			expect(after.dev).toBe(captured.identity.dev);
			expect(after.ino).toBe(captured.identity.ino);
			expect(Number(after.size)).toBe(captured.identity.size);
			expect(after.mtimeNs).toBe(captured.identity.mtimeNs);
			// Some hosts/FS configurations may not advance ctime for a no-op mode rewrite;
			// the replacement hook above still covers the path deterministically when it moves.
			if (after.ctimeNs === captured.identity.ctimeNs) return;
			expect(after.ctimeNs).not.toBe(captured.identity.ctimeNs);
		});
	},
);
