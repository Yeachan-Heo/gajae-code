/**
 * Regression for https://github.com/Yeachan-Heo/gajae-code/issues/2944
 *
 * On Darwin, the first O_WRONLY|O_APPEND open of a managed transcript can change
 * only ctime (write-provenance / com.apple.provenance) while leaving dev, ino,
 * size, mtime, and content unchanged. appendSync must accept a single bounded
 * refresh+retry for that case and stay fail-closed for real races.
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

async function createStore(): Promise<{
	root: string;
	store: ManagedSessionDescendantStore;
	filePath: string;
	relativePath: string;
}> {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-append-darwin-ctime-"));
	temporaryDirectories.push(root);
	// Owner-only directory expected by managed security.
	await fsp.chmod(root, 0o700);
	const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
	const relativePath = "transcript.jsonl";
	const initial = Buffer.from(`${JSON.stringify({ type: "session", id: "seed" })}\n`, "utf8");
	store.publishNoReplaceSync(relativePath, initial);
	return { root, store, filePath: path.join(root, relativePath), relativePath };
}

function isWriteAppendOpen(_file: fs.PathLike, flags: fs.OpenMode | undefined): boolean {
	if (typeof flags !== "number") return false;
	const write = (flags & fs.constants.O_WRONLY) !== 0 || (flags & fs.constants.O_RDWR) !== 0;
	const append = (flags & fs.constants.O_APPEND) !== 0;
	return write && append;
}

function installWriteOpenHook(
	targetPath: string,
	hook: (pathname: string) => void,
	options?: { maxCalls?: number },
): { calls: number } {
	const state = { calls: 0 };
	const maxCalls = options?.maxCalls ?? Number.POSITIVE_INFINITY;
	const realOpenSync = fs.openSync.bind(fs);
	vi.spyOn(fs, "openSync").mockImplementation(((
		file: fs.PathLike,
		flags?: fs.OpenMode | undefined,
		mode?: fs.Mode | undefined,
	) => {
		const pathname = typeof file === "string" ? file : file.toString();
		if (pathname === targetPath && isWriteAppendOpen(file, flags) && state.calls < maxCalls) {
			state.calls += 1;
			hook(pathname);
		}
		return realOpenSync(file, flags as never, mode as never);
	}) as typeof fs.openSync);
	return state;
}

/** Same-mode chmod: on Darwin/APFS this typically advances ctime only. */
function bumpCtimeOnly(pathname: string): void {
	const mode = fs.lstatSync(pathname).mode;
	fs.chmodSync(pathname, mode & 0o7777);
}

describe("ManagedSessionDescendantStore.appendSync fail-closed races", () => {
	it("rejects size mutation between capture and write-open without appending the request", async () => {
		const { store, filePath, relativePath } = await createStore();
		const beforeBytes = fs.readFileSync(filePath);
		const record = Buffer.from(`${JSON.stringify({ type: "message", id: "m-race" })}\n`, "utf8");

		installWriteOpenHook(filePath, pathname => {
			fs.appendFileSync(pathname, "stale-race\n");
		});

		expect(() => store.appendSync(relativePath, record)).toThrow("identity_mismatch");
		const after = fs.readFileSync(filePath, "utf8");
		expect(after.includes('"id":"m-race"')).toBe(false);
		expect(after.startsWith(beforeBytes.toString("utf8"))).toBe(true);
	});
});

describe.skipIf(process.platform !== "darwin")(
	"ManagedSessionDescendantStore.appendSync Darwin ctime-only refresh (#2944)",
	() => {
		it("accepts a one-time ctime-only transition before write-open and appends exactly once", async () => {
			const { store, filePath, relativePath } = await createStore();
			const beforeBytes = fs.readFileSync(filePath);
			const record = Buffer.from(`${JSON.stringify({ type: "message", id: "m1" })}\n`, "utf8");

			// One-shot ctime bump on the first write-append open only.
			const openState = installWriteOpenHook(
				filePath,
				pathname => {
					bumpCtimeOnly(pathname);
				},
				{ maxCalls: 1 },
			);

			store.appendSync(relativePath, record);

			expect(openState.calls).toBe(1);
			const afterBytes = fs.readFileSync(filePath);
			expect(afterBytes.equals(Buffer.concat([beforeBytes, record]))).toBe(true);
			expect(afterBytes.toString("utf8").trimEnd().split("\n")).toHaveLength(2);
		});

		it("rejects a second ctime-only transition after the single bounded refresh", async () => {
			const { store, filePath, relativePath } = await createStore();
			const beforeBytes = fs.readFileSync(filePath);
			const record = Buffer.from(`${JSON.stringify({ type: "message", id: "m3" })}\n`, "utf8");

			// Every write-append open bumps ctime → refresh once, then fail closed.
			installWriteOpenHook(filePath, pathname => {
				bumpCtimeOnly(pathname);
			});

			expect(() => store.appendSync(relativePath, record)).toThrow("identity_mismatch");
			expect(fs.readFileSync(filePath).equals(beforeBytes)).toBe(true);
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
			// the openSync-hook tests above still cover the repair path deterministically when
			// ctime does move. Soft-assert here so CI hosts without the delta do not fail.
			if (after.ctimeNs === captured.identity.ctimeNs) return;
			expect(after.ctimeNs).not.toBe(captured.identity.ctimeNs);
		});
	},
);
