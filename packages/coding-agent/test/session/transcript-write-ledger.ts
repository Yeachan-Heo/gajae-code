/**
 * Per-write attribution for the ownership write-path detector (single-owner design §12, before G1).
 *
 * Spies on the detector itself and, in order, on the write primitives listed below when they
 * target a transcript (`*.jsonl`). Each commit must follow a detector call for the same session,
 * made since that session's previous commit, so a writer that makes one checked write and one that
 * goes around the detector is caught even though the operation as a whole was seen, and a check
 * for one session never covers a write to another. Explicit destinations are checked when the
 * persist writer opens, so the open is the commit and the lines written through that handle are
 * not counted again.
 *
 * A commit's session is the id in the session header (the first line, `type: "session"`) of the
 * transcript at its target path, read once the commit has landed: when a promise settles, a sync
 * call returns, or a callback form's callback fires (before the caller's callback runs). A commit
 * that did not land (it threw, rejected, called back with an error, or was a native no-replace
 * result that did not commit) is not attributed and uses up no check. One rule covers an append, a
 * rewrite, a rename or publish of a new file, and a fork's new transcript. It is enforced, not
 * assumed:
 * - When a transcript was already at the target, the commit must leave the same session's header
 *   there; otherwise it is uncovered as `(header changed)` (a restore excepted).
 * - A commit whose session cannot be determined is uncovered as `(no session header)`.
 * - A commit that lands before its header exists (an open whose bytes follow through the handle)
 *   moves the checks pending then into a reservation, and is decided once its header can be read:
 *   at the next check, at the next commit that lands, or when the ledger is read. It is covered
 *   only by a reserved check for its own session. Reading the ledger settles a deferred commit
 *   whose header is already readable; one whose header is still missing is reported as
 *   `(no session header)` without being settled.
 * A check's session is the id it names, or the manager's bound id.
 *
 * Spied: SessionStorage writes, renames, exact replaces and writer opens; staged-writer publishes;
 * the managed store's publish, replace, append and move; the natives' no-replace rename and link;
 * `node:fs` sync, callback and promise writes, renames, links, copies, truncates, write opens and
 * write streams; `Bun.write`, `Bun.file().write()` and `Bun.file().writer()`.
 *
 * Not spied, so a write through them is caught only by the inventory's per-transcript byte check
 * ("unspied"), which sees that a transcript changed but not which write changed it: other native
 * writes, writes from child processes or workers, and writes through a descriptor opened before the
 * ledger was installed. No production code writes a transcript through these today.
 *
 * Transcripts are keyed by full path. A rename or move commits to its target and vacates its
 * source; a later commit that puts the vacated transcript back (the same file renamed back from
 * where it went, or the exact bytes a managed removal took, republished), still carrying the same
 * session id, is a restore, such as a failed move's rollback, and needs no check of its own. Any
 * other commit that lands at a vacated path ends that vacancy.
 * Removals are recorded, so the byte check sees them, but are not commits: deletes are outside G1
 * (design §12, "Before G1" item 4).
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
	/**
	 * Ordered events, for failure messages: `check <site> <id>` (`(no id)` when the check had none),
	 * `<primitive> <basename>` when a commit or removal starts, and `restore <primitive> <basename>`
	 * when a commit lands as a restore.
	 */
	readonly events: string[];
	/**
	 * Commits no check for their own session covered, as `<primitive> <basename>`, ending in
	 * ` (no session header)` when the session could not be read, or ` (header changed)` when the
	 * commit replaced another session's transcript at that path.
	 */
	readonly uncovered: string[];
	/** The full paths of the `uncovered` commits, in the same order. */
	readonly uncoveredFiles: string[];
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

/** The session id in a transcript's header line, or undefined when there is none to read. */
function headerId(bytes: Uint8Array | undefined): string | undefined {
	if (bytes === undefined) return undefined;
	const text = Buffer.from(bytes).toString("utf8");
	const end = text.indexOf("\n");
	try {
		const header = JSON.parse(end < 0 ? text : text.slice(0, end)) as { type?: unknown; id?: unknown };
		return header.type === "session" && typeof header.id === "string" ? header.id : undefined;
	} catch {
		return undefined;
	}
}

function readHeaderId(file: string): string | undefined {
	try {
		return headerId(fs.readFileSync(file));
	} catch {
		return undefined;
	}
}

/**
 * What a vacated transcript held, and its session id: the bytes a managed removal took, or where a
 * rename moved the file.
 */
type Vacated =
	| { readonly kind: "renamed"; readonly to: string; readonly id: string | undefined }
	| { readonly kind: "removed"; readonly bytes: Buffer; readonly id: string | undefined };

/**
 * Whether a primitive's write landed: it did not throw or reject, and a native no-replace result's
 * mutation committed.
 */
function landed(result: unknown): boolean {
	const state = (result as { mutationState?: unknown } | null)?.mutationState;
	return state === undefined || state === "committed";
}

export function spyOnTranscriptWrites(): TranscriptWriteLedger {
	const uncoveredEntries: { readonly label: string; readonly file: string }[] = [];
	const ledger = {
		events: [] as string[],
		/**
		 * Read through getters, which settle each deferred commit whose header is already readable,
		 * and report each one still waiting as uncovered without settling it.
		 */
		get uncovered(): string[] {
			return reported().map(entry => entry.label);
		},
		get uncoveredFiles(): string[] {
			return reported().map(entry => entry.file);
		},
		written: new Set<string>(),
		unbound: [] as string[],
		exempt: new Map<string, string>(),
		reset() {
			ledger.events.length = 0;
			uncoveredEntries.length = 0;
			deferred.length = 0;
			ledger.written.clear();
			ledger.unbound.length = 0;
			vacated.clear();
			pending.clear();
		},
	};
	/** Session ids checked since the last commit to each. */
	const pending = new Set<string>();
	const inFlight = new Map<string, number>();
	const vacated = new Map<string, Vacated>();

	const checkWrite = SessionClaimSet.prototype.checkWrite;
	vi.spyOn(SessionClaimSet.prototype, "checkWrite").mockImplementation(function (
		this: SessionClaimSet,
		site: string,
		sessionId?: string,
	) {
		const id = sessionId ?? this.currentSessionId;
		resolveDeferred();
		if (id === undefined) ledger.unbound.push(site);
		else pending.add(id);
		ledger.events.push(`check ${site} ${id ?? "(no id)"}`);
		return checkWrite.call(this, site, sessionId);
	});

	const exempt = (file: string) =>
		[...ledger.exempt.keys()].some(directory => file.startsWith(`${directory}${path.sep}`));

	/**
	 * Run `call` as the outermost primitive on `file`. A primitive called on the same file while the
	 * outer one is still running synchronously (a storage method calling `node:fs` underneath) merges
	 * into it; once the outer call has returned, any other call is its own commit, even while the
	 * outer one's promise or callback is still pending. `record` runs before the call and returns
	 * what to do once it has completed, with whether the write landed. For a callback form
	 * (`callbackArgs`, the arguments `call` passes on), it completes when its callback fires, before
	 * the caller's callback runs; an error there means the write did not land.
	 */
	const outermost = (
		file: string,
		record: () => (didLand: boolean) => void,
		call: () => unknown,
		callbackArgs?: unknown[],
	): unknown => {
		const finish = inFlight.has(file) ? undefined : record();
		let ended = false;
		const done = (didLand: boolean) => {
			if (ended) return;
			ended = true;
			finish?.(didLand);
		};
		const last = callbackArgs === undefined ? -1 : callbackArgs.length - 1;
		const callback = callbackArgs?.[last];
		const viaCallback = callbackArgs !== undefined && typeof callback === "function";
		if (viaCallback) {
			const caller = callback as (error: unknown, ...rest: unknown[]) => unknown;
			callbackArgs[last] = (error: unknown, ...rest: unknown[]) => {
				done(!error);
				return caller(error, ...rest);
			};
		}
		inFlight.set(file, (inFlight.get(file) ?? 0) + 1);
		let result: unknown;
		try {
			result = call();
		} catch (error) {
			done(false);
			throw error;
		} finally {
			const left = (inFlight.get(file) ?? 1) - 1;
			if (left === 0) inFlight.delete(file);
			else inFlight.set(file, left);
		}
		if (viaCallback) return result;
		if (result instanceof Promise)
			return result.then(
				value => {
					done(landed(value));
					return value;
				},
				error => {
					done(false);
					throw error;
				},
			);
		done(landed(result));
		return result;
	};

	const flag = (label: string, file: string) => uncoveredEntries.push({ label, file });

	/** A commit to the transcript of `id` is covered by a pending check for that id, which it uses up. */
	const attribute = (label: string, file: string, id: string | undefined) => {
		if (id !== undefined && pending.delete(id)) return;
		flag(id === undefined ? `${label} (no session header)` : label, file);
	};

	/**
	 * Commits whose transcript had no header yet when they landed: an open whose bytes follow
	 * through the handle. Each takes the checks pending when it landed out of `pending`, reserving
	 * them, and is decided once its header can be read: at the next check, at the next commit that
	 * lands, or when the ledger is read. It is covered only by a reserved check for its own session,
	 * which it uses up; the reserved checks it did not use go back to `pending`. One whose header
	 * never appears is reported uncovered.
	 */
	const deferred: { readonly label: string; readonly file: string; readonly reserved: Set<string> }[] = [];
	/** Decide the deferred commits whose header can now be read. */
	const resolveDeferred = () => {
		for (const entry of [...deferred]) {
			const id = readHeaderId(entry.file);
			if (id === undefined) continue;
			deferred.splice(deferred.indexOf(entry), 1);
			if (!entry.reserved.delete(id)) flag(entry.label, entry.file);
			for (const unused of entry.reserved) pending.add(unused);
		}
	};
	const reported = () => {
		resolveDeferred();
		return [
			...uncoveredEntries,
			...deferred.map(entry => ({ label: `${entry.label} (no session header)`, file: entry.file })),
		];
	};

	/**
	 * Record a commit to `target` and run it. `source` is what a rename moves away; `restores` says
	 * whether this commit puts back what an earlier primitive vacated. The commit is attributed once
	 * it lands, to the session id in the header of the transcript it produced.
	 */
	const commit = (
		primitive: string,
		target: unknown,
		call: () => unknown,
		options: {
			self?: unknown;
			source?: unknown;
			restores?: (gone: Vacated, from?: string) => boolean;
			callbackArgs?: unknown[];
		} = {},
	): unknown => {
		const file = transcriptPath(target, options.self);
		const source = transcriptPath(options.source, options.self);
		if (file === undefined || exempt(file)) return call();
		return outermost(
			file,
			() => {
				const name = path.basename(file);
				ledger.written.add(file);
				if (source !== undefined) ledger.written.add(source);
				// The session whose transcript is there now, if any; the write must not change it.
				const before = readHeaderId(file);
				ledger.events.push(`${primitive} ${name}`);
				return didLand => {
					if (!didLand) return;
					resolveDeferred();
					const label = `${primitive} ${name}`;
					const id = readHeaderId(file);
					// A restore puts back the same session's transcript, from where it went.
					const gone = vacated.get(file);
					const restoring = gone !== undefined && options.restores?.(gone, source) === true && gone.id === id;
					// Whatever lands at a vacated path ends what a later restore could put back.
					vacated.delete(file);
					if (restoring) ledger.events.push(`restore ${label}`);
					else if (before !== undefined && id !== before) flag(`${label} (header changed)`, file);
					else if (id === undefined) {
						deferred.push({ label, file, reserved: new Set(pending) });
						pending.clear();
					} else attribute(label, file, id);
					// Only a rename that moved the file vacates its source.
					if (source !== undefined) vacated.set(source, { kind: "renamed", to: file, id });
				};
			},
			call,
			options.callbackArgs,
		);
	};

	/** A removal changes the transcript's bytes but is not a commit; a managed one keeps what it took. */
	const remove = (
		primitive: string,
		target: unknown,
		call: () => unknown,
		self?: unknown,
		bytes?: unknown,
		callbackArgs?: unknown[],
	) => {
		const file = transcriptPath(target, self);
		if (file === undefined || exempt(file)) return call();
		return outermost(
			file,
			() => {
				ledger.events.push(`${primitive} ${path.basename(file)}`);
				ledger.written.add(file);
				return didLand => {
					if (didLand && bytes instanceof Uint8Array)
						vacated.set(file, { kind: "removed", bytes: Buffer.from(bytes), id: headerId(bytes) });
				};
			},
			call,
			callbackArgs,
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

	// Sync forms. A write stream commits when it is created, like a writer open.
	for (const name of ["writeFileSync", "appendFileSync", "truncateSync", "createWriteStream"])
		wrap(fs, name, at(0)(`fs.${name}`));
	wrap(fs, "renameSync", renameAt("fs.renameSync"));
	for (const name of ["linkSync", "copyFileSync"]) wrap(fs, name, at(1)(`fs.${name}`));
	for (const name of ["unlinkSync", "rmSync"]) wrap(fs, name, (call, args) => remove(`fs.${name}`, args[0], call));
	wrap(fs, "openSync", (call, args) => (writeFlags(args[1]) ? commit("fs.openSync", args[0], call) : call()));
	// Callback forms return before they write; each lands when its callback fires.
	for (const name of ["writeFile", "appendFile", "truncate"])
		wrap(fs, name, (call, args) => commit(`fs.${name}`, args[0], call, { callbackArgs: args }));
	wrap(fs, "rename", (call, args) =>
		commit("fs.rename", args[1], call, { source: args[0], restores: renamedBack, callbackArgs: args }),
	);
	for (const name of ["link", "copyFile"])
		wrap(fs, name, (call, args) => commit(`fs.${name}`, args[1], call, { callbackArgs: args }));
	wrap(fs, "unlink", (call, args) => remove("fs.unlink", args[0], call, undefined, undefined, args));
	wrap(fs, "open", (call, args) =>
		writeFlags(args[1]) ? commit("fs.open", args[0], call, { callbackArgs: args }) : call(),
	);

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
		const write = file.write.bind(file);
		Object.defineProperty(file, "write", {
			value: (...args: Parameters<typeof file.write>) => commit("Bun.file().write", file.name, () => write(...args)),
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
