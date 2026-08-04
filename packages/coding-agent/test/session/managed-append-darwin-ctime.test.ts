/**
 * Regression for https://github.com/Yeachan-Heo/gajae-code/issues/2944 and the
 * Darwin durability path from #3760.
 *
 * Platforms without a retained native root authority (Darwin today) no longer
 * append managed transcripts in place. `appendSync` replaces the exact captured
 * file so a short write cannot leave a malformed JSONL tail. That path must:
 * - fail closed when the destination mutates between capture and exchange
 * - tolerate ctime-only destination transitions (write provenance / chmod)
 * - never apply the request when identity verification rejects the predecessor
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

function isStagingCreateOpen(file: fs.PathLike, flags: fs.OpenMode | undefined): boolean {
	if (typeof flags !== "number") return false;
	const create = (flags & fs.constants.O_CREAT) !== 0;
	const exclusive = (flags & fs.constants.O_EXCL) !== 0;
	const write = (flags & fs.constants.O_WRONLY) !== 0 || (flags & fs.constants.O_RDWR) !== 0;
	const pathname = typeof file === "string" ? file : file.toString();
	return create && exclusive && write && path.basename(pathname).includes(".replacement");
}

/**
 * Mutate the destination while replace-based append is staging the successor.
 * Staging is created with O_CREAT|O_EXCL before exactReplace validates the
 * predecessor, which is the race window the durability path must fail closed on.
 */
function installStagingCreateHook(
	destinationPath: string,
	hook: (pathname: string) => void,
	options?: { maxCalls?: number },
): { calls: number } {
	const state = { calls: 0 };
	const maxCalls = options?.maxCalls ?? Number.POSITIVE_INFINITY;
	const realOpenSync = fs.openSync.bind(fs);
	const destinationDir = path.dirname(destinationPath);
	vi.spyOn(fs, "openSync").mockImplementation(((
		file: fs.PathLike,
		flags?: fs.OpenMode | undefined,
		mode?: fs.Mode | undefined,
	) => {
		const pathname = typeof file === "string" ? file : file.toString();
		if (path.dirname(pathname) === destinationDir && isStagingCreateOpen(file, flags) && state.calls < maxCalls) {
			state.calls += 1;
			hook(destinationPath);
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
	it("rejects size mutation between capture and replace without applying the request", async () => {
		const { store, filePath, relativePath } = await createStore({ withoutNativeAuthority: true });
		const beforeBytes = fs.readFileSync(filePath);
		const record = Buffer.from(`${JSON.stringify({ type: "message", id: "m-race" })}\n`, "utf8");

		const openState = installStagingCreateHook(
			filePath,
			pathname => {
				fs.appendFileSync(pathname, "stale-race\n");
			},
			{ maxCalls: 1 },
		);

		expect(() => store.appendSync(relativePath, record)).toThrow("identity_mismatch");
		expect(openState.calls).toBe(1);
		const after = fs.readFileSync(filePath, "utf8");
		expect(after).toBe(`${beforeBytes.toString("utf8")}stale-race\n`);
		expect(after.includes('"id":"m-race"')).toBe(false);
	});
});

describe.skipIf(process.platform !== "darwin")(
	"ManagedSessionDescendantStore.appendSync Darwin ctime-only tolerance (#2944/#3760)",
	() => {
		it("appends successfully when only ctime advanced before replace", async () => {
			const { store, filePath, relativePath } = await createStore();
			const beforeBytes = fs.readFileSync(filePath);
			const record = Buffer.from(`${JSON.stringify({ type: "message", id: "m1" })}\n`, "utf8");

			bumpCtimeOnly(filePath);
			store.appendSync(relativePath, record);

			const afterBytes = fs.readFileSync(filePath);
			expect(afterBytes.equals(Buffer.concat([beforeBytes, record]))).toBe(true);
			expect(afterBytes.toString("utf8").trimEnd().split("\n")).toHaveLength(2);
		});

		it("still fails closed when the destination mutates during staging", async () => {
			const { store, filePath, relativePath } = await createStore();
			const beforeBytes = fs.readFileSync(filePath);
			const record = Buffer.from(`${JSON.stringify({ type: "message", id: "m3" })}\n`, "utf8");

			installStagingCreateHook(filePath, pathname => {
				fs.appendFileSync(pathname, "ctime-cover-race\n");
			});

			expect(() => store.appendSync(relativePath, record)).toThrow("identity_mismatch");
			const after = fs.readFileSync(filePath, "utf8");
			expect(after.startsWith(beforeBytes.toString("utf8"))).toBe(true);
			expect(after.includes('"id":"m3"')).toBe(false);
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
			// the replace-path race tests still cover fail-closed mutation detection.
			if (after.ctimeNs === captured.identity.ctimeNs) return;
			expect(after.ctimeNs).not.toBe(captured.identity.ctimeNs);
		});
	},
);
