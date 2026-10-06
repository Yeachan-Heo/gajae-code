import { vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
	captureManagedFileNoFollow,
	type ManagedDirectoryRoot,
	ManagedSessionDescendantStore,
	prepareManagedDirectoryRoot,
	publishManagedFileNoReplace,
	replaceManagedFileSync,
} from "../../src/session/internal/managed-session-storage";

interface WriterInput {
	readonly profileRoot: string;
	readonly ownerRoot: string;
	readonly filename: string;
	readonly ready: string;
	readonly release: string;
	readonly phase: "staging" | "replacement";
}

function parseInput(value: unknown): WriterInput {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("task_owner_writer_input_invalid");
	const record = value as Record<string, unknown>;
	if (
		typeof record.profileRoot !== "string" ||
		typeof record.ownerRoot !== "string" ||
		typeof record.filename !== "string" ||
		path.basename(record.filename) !== record.filename ||
		typeof record.ready !== "string" ||
		typeof record.release !== "string" ||
		(record.phase !== "staging" && record.phase !== "replacement")
	)
		throw new Error("task_owner_writer_input_invalid");
	return {
		profileRoot: record.profileRoot,
		ownerRoot: record.ownerRoot,
		filename: record.filename,
		ready: record.ready,
		release: record.release,
		phase: record.phase,
	};
}

const inputValue: unknown = JSON.parse(process.env.GJC_TASK_OWNER_ACCESS_WRITER_INPUT ?? "null");
const input = parseInput(inputValue);
const securityPolicy = process.platform === "win32" ? "windows-existing-verify-first" : "default";
const ownerStat = fs.lstatSync(input.ownerRoot, { bigint: true });
if (!ownerStat.isDirectory() || ownerStat.isSymbolicLink()) throw new Error("task_owner_writer_owner_invalid");
const expectedOwner: ManagedDirectoryRoot = {
	canonicalPath: path.resolve(input.ownerRoot),
	dev: BigInt.asUintN(64, ownerStat.dev),
	ino: BigInt.asUintN(64, ownerStat.ino),
};
const store = new ManagedSessionDescendantStore(
	prepareManagedDirectoryRoot(input.profileRoot, securityPolicy),
	input.ownerRoot,
	undefined,
	securityPolicy,
	input.profileRoot,
	expectedOwner,
);

function publishReady(phase: WriterInput["phase"], markerPath: string, dev: bigint, ino: bigint): void {
	const fd = fs.openSync(input.ready, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
	try {
		fs.writeSync(
			fd,
			Buffer.from(
				JSON.stringify({
					pid: process.pid,
					phase,
					marker: path.basename(markerPath),
					dev: dev.toString(),
					ino: ino.toString(),
				}),
				"utf8",
			),
		);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function waitForReleaseSync(): void {
	const deadline = Date.now() + 10_000;
	const wait = new Int32Array(new SharedArrayBuffer(4));
	while (!fs.existsSync(input.release)) {
		if (Date.now() >= deadline) throw new Error("task_owner_writer_release_timeout");
		Atomics.wait(wait, 0, 0, 10);
	}
}

async function waitForRelease(): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!fs.existsSync(input.release)) {
		if (Date.now() >= deadline) throw new Error("task_owner_writer_release_timeout");
		await Bun.sleep(10);
	}
}

try {
	if (input.phase === "replacement") {
		let held = false;
		const write = new Proxy(fs.writeSync, {
			apply(target, receiver: unknown, args: unknown[]): unknown {
				const fd = args[0];
				if (!held && typeof fd === "number") {
					const descriptor = fs.fstatSync(fd, { bigint: true });
					const replacement = fs.readdirSync(input.ownerRoot).find(name => {
						if (!name.endsWith(".replacement")) return false;
						const named = fs.lstatSync(path.join(input.ownerRoot, name), { bigint: true });
						return named.dev === descriptor.dev && named.ino === descriptor.ino;
					});
					if (replacement) {
						held = true;
						publishReady("replacement", path.join(input.ownerRoot, replacement), descriptor.dev, descriptor.ino);
						waitForReleaseSync();
					}
				}
				return Reflect.apply(target, receiver, args);
			},
		});
		const spy = vi.spyOn(fs, "writeSync").mockImplementation(write);
		try {
			const destination = path.join(input.ownerRoot, input.filename);
			const predecessor = captureManagedFileNoFollow(destination);
			replaceManagedFileSync(
				destination,
				Buffer.from("independent-managed-replacement", "utf8"),
				expectedOwner,
				securityPolicy,
				undefined,
				predecessor.identity,
			);
			if (!held) throw new Error("task_owner_writer_replacement_boundary_missing");
		} finally {
			spy.mockRestore();
		}
	} else {
		const originalOpen = fsp.open.bind(fsp);
		let held = false;
		const open = vi.spyOn(fsp, "open").mockImplementation(async (pathname, flags, mode) => {
			const handle = await originalOpen(pathname, flags, mode);
			if (
				!held &&
				typeof pathname === "string" &&
				path.dirname(pathname) === input.ownerRoot &&
				path.basename(pathname).endsWith(".staging")
			) {
				held = true;
				const descriptor = await handle.stat({ bigint: true });
				const delayedWrite = new Proxy(handle.write, {
					apply(target, receiver: unknown, args: unknown[]): Promise<unknown> {
						publishReady("staging", pathname, descriptor.dev, descriptor.ino);
						return waitForRelease().then(() => Reflect.apply(target, receiver, args));
					},
				});
				vi.spyOn(handle, "write").mockImplementation(delayedWrite);
			}
			return handle;
		});
		try {
			// Retained Linux stores publish natively without the path API's .staging window.
			// Exercise the actual managed path publisher on every platform; no native authority is mocked.
			await publishManagedFileNoReplace(
				path.join(input.ownerRoot, input.filename),
				Buffer.from("independent-managed-staging", "utf8"),
				undefined,
				expectedOwner,
				securityPolicy,
			);
			if (!held) throw new Error("task_owner_writer_staging_boundary_missing");
		} finally {
			open.mockRestore();
		}
	}
	process.stdout.write(`${JSON.stringify({ pid: process.pid, phase: input.phase, status: "acknowledged" })}\n`);
} finally {
	store.close();
}
