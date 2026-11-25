/**
 * Per-write attribution for the ownership write-path detector (single-owner design §12, before G1).
 *
 * Spies on the detector itself and, in order, on the write primitives listed below when they
 * target a transcript (`*.jsonl`). Each commit must follow a detector call made since the previous
 * commit, so a writer that makes one checked write and one that goes around the detector is caught
 * even though the operation as a whole was seen. Explicit destinations are checked when the persist
 * writer opens, so the open is the commit and the lines written through that handle are not
 * counted again.
 *
 * Spied: SessionStorage writes, renames, exact replaces and writer opens; staged-writer publishes;
 * the managed store's publish, replace, append and move; the natives' no-replace rename and link;
 * `node:fs` sync, callback and promise writes, renames, links, copies, truncates, write opens and
 * write streams; `Bun.write` and `Bun.file().writer()`.
 *
 * Not spied, so a write through them is caught only by the inventory's per-transcript byte check
 * ("unspied"), which sees that a transcript changed but not which write changed it: other native
 * writes, writes from child processes or workers, and writes through a descriptor opened before the
 * ledger was installed. No production code writes a transcript through these today.
 *
 * Transcripts are keyed by full path. A rename or move commits to its target and vacates its
 * source; a later commit that puts the vacated transcript back (the same file renamed back from
 * where it went, or the exact bytes a managed removal took, republished) is a restore, such as a
 * failed move's rollback, and needs no check of its own. Removals are recorded, so the byte check
 * sees them, but are not commits: deletes are outside G1 (design §12, "Before G1" item 4).
 *
 * Also outside G1: directory-level renames that carry a transcript inside them (a fork's private
 * staging directory, an explicit staged child's commit). Their target is a directory, not a
 * `*.jsonl` path.
 *
 * Primitives call each other and `node:fs` underneath; a nested call that targets the transcript an
 * outer primitive is already committing is merged into it. Spies are restored by
 * `vi.restoreAllMocks()`.
 */

import { vi } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@gajae-code/natives";
import type { BunFile } from "bun";
import { ManagedSessionDescendantStore } from "../../src/session/internal/managed-session-storage";
import { SessionClaimSet } from "../../src/session/internal/session-claim-set";
import {
	FileSessionStorage,
	type SessionStorageWriter,
	type StagedStreamingWriter,
} from "../../src/session/session-storage";

export interface TranscriptWriteLedger {
	/** Ordered `check <site>` and `<primitive> <basename>` events, for failure messages. */
	readonly events: string[];
	/** Commits no detector call covered, as `<primitive> <basename>`. */
	readonly uncovered: string[];
	/** Full paths of transcripts a spied primitive committed to, vacated or removed. */
	readonly written: Set<string>;
	/** Detector calls that had no session id to check, so they returned without looking. */
	readonly unbound: string[];
	/** Directories whose `*.jsonl` files are not session transcripts, with the reason. */
	readonly exempt: Map<string, string>;
	/** Forget events so far; writer handles opened earlier keep their attribution. */
	reset(): void;
}

type Method = (...args: never[]) => unknown;
type Around = (call: () => unknown, args: unknown[], self: unknown) => unknown;

/** Spy on `owner[name]`, calling through. */
function wrap(owner: object, name: string, around: Around): void {
	const record = owner as Record<string, Method>;
	const original = record[name]!;
	vi.spyOn(record, name).mockImplementation(function (this: unknown, ...args: never[]) {
		return around(() => original.apply(this, args), args, this);
	} as never);
}

function writeFlags(flags: unknown): boolean {
	if (typeof flags === "string") return /[wax+]/.test(flags);
	if (typeof flags === "number") return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0;
	return false;
}

function transcriptPath(target: unknown, self?: unknown): string | undefined {
	if (typeof target !== "string" || !target.endsWith(".jsonl")) return undefined;
	// Managed-store paths are relative to the store's directory.
	const base = self instanceof ManagedSessionDescendantStore ? self.dir : undefined;
	return base === undefined ? path.resolve(target) : path.resolve(base, target);
}

/** What a vacated transcript held: the bytes a managed removal took, or where a rename moved it. */
type Vacated = { readonly kind: "renamed"; readonly to: string } | { readonly kind: "removed"; readonly bytes: Buffer };

export function spyOnTranscriptWrites(): TranscriptWriteLedger {
	const ledger = {
		events: [] as string[],
		uncovered: [] as string[],
		written: new Set<string>(),
		unbound: [] as string[],
		exempt: new Map<string, string>(),
		reset() {
			ledger.events.length = 0;
			ledger.uncovered.length = 0;
			ledger.written.clear();
			ledger.unbound.length = 0;
			vacated.clear();
			pending = false;
		},
	};
	let pending = false;
	const inFlight = new Map<string, number>();
	const vacated = new Map<string, Vacated>();

	const checkWrite = SessionClaimSet.prototype.checkWrite;
	vi.spyOn(SessionClaimSet.prototype, "checkWrite").mockImplementation(function (
		this: SessionClaimSet,
		site: string,
		sessionId?: string,
	) {
		if ((sessionId ?? this.currentSessionId) === undefined) ledger.unbound.push(site);
		else pending = true;
		ledger.events.push(`check ${site}`);
		return checkWrite.call(this, site, sessionId);
	});

	const exempt = (file: string) =>
		[...ledger.exempt.keys()].some(directory => file.startsWith(`${directory}${path.sep}`));

	/** Run `call` as the outermost primitive on `file`; nested primitives on the same file merge into it. */
	const outermost = (file: string, record: () => void, call: () => unknown): unknown => {
		if (!inFlight.has(file)) record();
		inFlight.set(file, (inFlight.get(file) ?? 0) + 1);
		const done = () => {
			const left = (inFlight.get(file) ?? 1) - 1;
			if (left === 0) inFlight.delete(file);
			else inFlight.set(file, left);
		};
		let result: unknown;
		try {
			result = call();
		} catch (error) {
			done();
			throw error;
		}
		if (result instanceof Promise) return result.finally(done);
		done();
		return result;
	};

	/**
	 * Record a commit to `target` and run it. `source` is what a rename moves away; `restores` says
	 * whether this commit puts back what an earlier primitive vacated.
	 */
	const commit = (
		primitive: string,
		target: unknown,
		call: () => unknown,
		options: { self?: unknown; source?: unknown; restores?: (gone: Vacated, from?: string) => boolean } = {},
	): unknown => {
		const file = transcriptPath(target, options.self);
		const source = transcriptPath(options.source, options.self);
		if (file === undefined || exempt(file)) return call();
		return outermost(
			file,
			() => {
				const name = path.basename(file);
				ledger.written.add(file);
				const gone = vacated.get(file);
				if (gone && options.restores?.(gone, source)) {
					ledger.events.push(`restore ${primitive} ${name}`);
					vacated.delete(file);
				} else {
					ledger.events.push(`${primitive} ${name}`);
					if (pending) pending = false;
					else ledger.uncovered.push(`${primitive} ${name}`);
				}
				if (source !== undefined) {
					ledger.written.add(source);
					vacated.set(source, { kind: "renamed", to: file });
				}
			},
			call,
		);
	};

	/** A removal changes the transcript's bytes but is not a commit; a managed one keeps what it took. */
	const remove = (primitive: string, target: unknown, call: () => unknown, self?: unknown, bytes?: unknown) => {
		const file = transcriptPath(target, self);
		if (file === undefined || exempt(file)) return call();
		return outermost(
			file,
			() => {
				ledger.events.push(`${primitive} ${path.basename(file)}`);
				ledger.written.add(file);
				if (bytes instanceof Uint8Array) vacated.set(file, { kind: "removed", bytes: Buffer.from(bytes) });
			},
			call,
		);
	};

	// Only the file that went away, coming back from where it went.
	const renamedBack = (gone: Vacated, from?: string) => gone.kind === "renamed" && gone.to === from;
	const republished = (bytes: unknown) => (gone: Vacated) =>
		gone.kind === "removed" && bytes instanceof Uint8Array && gone.bytes.equals(bytes);
	const at = (index: number) => (primitive: string) => (call: () => unknown, args: unknown[], self: unknown) =>
		commit(primitive, args[index], call, { self });
	const renameAt = (primitive: string) => (call: () => unknown, args: unknown[], self: unknown) =>
		commit(primitive, args[1], call, { self, source: args[0], restores: renamedBack });

	const storage = FileSessionStorage.prototype;
	for (const name of ["writeTextSync", "writeText"]) wrap(storage, name, at(0)(name));
	// The open is the commit; lines written through the handle land in the transcript it opened.
	wrap(storage, "openWriter", (call, args) => {
		const writer = commit("openWriter", args[0], call) as SessionStorageWriter;
		const file = transcriptPath(args[0]);
		if (file === undefined) return writer;
		for (const name of ["writeLine", "writeLineSync"] as const) {
			const write = writer[name].bind(writer) as (line: string) => unknown;
			(writer as unknown as Record<string, unknown>)[name] = (line: string) => {
				ledger.written.add(file);
				return write(line);
			};
		}
		return writer;
	});
	for (const name of ["renameSync", "rename"]) wrap(storage, name, renameAt(name));
	wrap(storage, "replaceExactSync", at(1)("replaceExactSync"));
	for (const name of ["unlinkSync", "unlink"]) wrap(storage, name, (call, args) => remove(name, args[0], call));
	// A staged writer commits when it publishes, not when it opens its temporary file.
	wrap(storage, "openStagedWriter", (call, args) => {
		const writer = call() as StagedStreamingWriter;
		const publish = writer.publishNoReplace.bind(writer);
		writer.publishNoReplace = () => {
			commit("stagedPublish", args[0], publish);
		};
		return writer;
	});

	const store = ManagedSessionDescendantStore.prototype;
	for (const name of ["publishNoReplace", "publishNoReplaceSync"])
		wrap(store, name, (call, args, self) =>
			commit(`store.${name}`, args[0], call, { self, restores: republished(args[1]) }),
		);
	for (const name of [
		"replace",
		"replaceSync",
		"replaceExpected",
		"replaceExpectedIdentitySync",
		"appendSync",
		"appendExpectedSync",
		"appendExpectedIdentitySync",
	])
		wrap(store, name, at(0)(`store.${name}`));
	wrap(store, "publishStagedFileNoReplace", at(1)("store.publishStagedFileNoReplace"));
	wrap(store, "moveFileNoReplace", renameAt("store.moveFileNoReplace"));
	wrap(store, "removeExpected", (call, args, self) =>
		remove("store.removeExpected", args[0], call, self, (args[1] as { bytes?: unknown } | undefined)?.bytes),
	);
	for (const name of ["remove", "removeIfExistsDescriptor"])
		wrap(store, name, (call, args, self) => remove(`store.${name}`, args[0], call, self));

	// Native no-replace renames and links: a cross-device-safe move goes through them.
	wrap(natives, "renameNoReplacePath", renameAt("natives.renameNoReplacePath"));
	wrap(natives, "linkNoReplacePath", at(1)("natives.linkNoReplacePath"));

	// Sync and callback forms. A write stream commits when it is created, like a writer open.
	for (const name of [
		"writeFileSync",
		"appendFileSync",
		"truncateSync",
		"writeFile",
		"appendFile",
		"truncate",
		"createWriteStream",
	])
		wrap(fs, name, at(0)(`fs.${name}`));
	for (const name of ["renameSync", "rename"]) wrap(fs, name, renameAt(`fs.${name}`));
	for (const name of ["linkSync", "copyFileSync", "link", "copyFile"]) wrap(fs, name, at(1)(`fs.${name}`));
	for (const name of ["unlinkSync", "unlink", "rmSync"])
		wrap(fs, name, (call, args) => remove(`fs.${name}`, args[0], call));
	wrap(fs, "openSync", (call, args) => (writeFlags(args[1]) ? commit("fs.openSync", args[0], call) : call()));
	wrap(fs, "open", (call, args) => (writeFlags(args[1]) ? commit("fs.open", args[0], call) : call()));

	// Bun's own writers: Bun.write, and a file's writer, which commits when it is created.
	const named = (target: unknown) =>
		typeof target === "string" ? target : (target as { name?: unknown } | null)?.name;
	wrap(Bun, "write", (call, args) => commit("Bun.write", named(args[0]), call));
	wrap(Bun, "file", call => {
		const file = call() as BunFile;
		if (transcriptPath(file.name) === undefined) return file;
		const writer = file.writer.bind(file);
		Object.defineProperty(file, "writer", {
			value: (...args: Parameters<typeof file.writer>) =>
				commit("Bun.file().writer", file.name, () => writer(...args)),
		});
		return file;
	});
	// `node:fs/promises` is its own module object, apart from `fs.promises`.
	for (const promises of new Set<object>([fs.promises, fsPromises])) {
		for (const name of ["writeFile", "appendFile", "truncate"]) wrap(promises, name, at(0)(`fs.promises.${name}`));
		wrap(promises, "rename", renameAt("fs.promises.rename"));
		for (const name of ["link", "copyFile"]) wrap(promises, name, at(1)(`fs.promises.${name}`));
		for (const name of ["unlink", "rm"])
			wrap(promises, name, (call, args) => remove(`fs.promises.${name}`, args[0], call));
		wrap(promises, "open", (call, args) =>
			writeFlags(args[1]) ? commit("fs.promises.open", args[0], call) : call(),
		);
	}
	return ledger;
}
