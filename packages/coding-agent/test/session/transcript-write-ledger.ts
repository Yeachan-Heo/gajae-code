/**
 * Per-write attribution for the ownership write-path detector (single-owner design §12, before G1).
 *
 * Spies on the primitives that commit bytes to a transcript (`*.jsonl`) and on the detector itself,
 * in order. Each commit must follow a detector call made since the previous commit, so a writer
 * that makes one checked write and one that goes around the detector is caught even though the
 * operation as a whole was seen. Explicit destinations are checked when the persist writer opens,
 * so the open is the commit and the lines written through that handle are not counted again.
 *
 * Storage methods call `node:fs` underneath; a nested call that targets the transcript an outer
 * primitive is already committing is merged into it. The fs spies see module-private helpers that
 * no storage method covers. Spies are restored by `vi.restoreAllMocks()`.
 */
import { vi } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
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
	/** Basenames of transcripts a spied primitive committed to. */
	readonly written: Set<string>;
	/** Detector calls that had no session id to check, so they returned without looking. */
	readonly unbound: string[];
	/** Directories whose `*.jsonl` files are not session transcripts, with the reason. */
	readonly exempt: Map<string, string>;
	/** Forget events so far; writer handles opened earlier keep their attribution. */
	reset(): void;
}

type Method = (...args: never[]) => unknown;

/** Spy on `owner[name]`, calling through. */
function wrap(owner: object, name: string, around: (call: () => unknown, args: unknown[]) => unknown): void {
	const record = owner as Record<string, Method>;
	const original = record[name]!;
	vi.spyOn(record, name).mockImplementation(function (this: unknown, ...args: never[]) {
		return around(() => original.apply(this, args), args);
	} as never);
}

function writeFlags(flags: unknown): boolean {
	if (typeof flags === "string") return /[wax+]/.test(flags);
	if (typeof flags === "number") return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0;
	return false;
}

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
			pending = false;
		},
	};
	let pending = false;
	const inFlight = new Map<string, number>();

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

	/** Record a commit to `target` and run it; nested commits to the same transcript merge into it. */
	const commit = (primitive: string, target: unknown, call: () => unknown): unknown => {
		if (typeof target !== "string" || !target.endsWith(".jsonl")) return call();
		if ([...ledger.exempt.keys()].some(directory => target.startsWith(`${directory}${path.sep}`))) return call();
		const name = path.basename(target);
		if (!inFlight.has(name)) {
			ledger.events.push(`${primitive} ${name}`);
			ledger.written.add(name);
			if (pending) pending = false;
			else ledger.uncovered.push(`${primitive} ${name}`);
		}
		inFlight.set(name, (inFlight.get(name) ?? 0) + 1);
		const done = () => {
			const left = (inFlight.get(name) ?? 1) - 1;
			if (left === 0) inFlight.delete(name);
			else inFlight.set(name, left);
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
	const at = (index: number) => (primitive: string) => (call: () => unknown, args: unknown[]) =>
		commit(primitive, args[index], call);

	const storage = FileSessionStorage.prototype;
	for (const name of ["writeTextSync", "writeText"]) wrap(storage, name, at(0)(name));
	// The open is the commit; lines written through the handle land in the transcript it opened.
	wrap(storage, "openWriter", (call, args) => {
		const writer = commit("openWriter", args[0], call) as SessionStorageWriter;
		const target = args[0];
		if (typeof target !== "string" || !target.endsWith(".jsonl")) return writer;
		for (const name of ["writeLine", "writeLineSync"] as const) {
			const write = writer[name].bind(writer) as (line: string) => unknown;
			(writer as unknown as Record<string, unknown>)[name] = (line: string) => {
				ledger.written.add(path.basename(target));
				return write(line);
			};
		}
		return writer;
	});
	for (const name of ["renameSync", "rename", "replaceExactSync"]) wrap(storage, name, at(1)(name));
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
	for (const name of [
		"publishNoReplace",
		"publishNoReplaceSync",
		"replace",
		"replaceSync",
		"replaceExpected",
		"replaceExpectedIdentitySync",
		"appendSync",
		"appendExpectedSync",
		"appendExpectedIdentitySync",
	])
		wrap(store, name, at(0)(`store.${name}`));
	for (const name of ["publishStagedFileNoReplace", "moveFileNoReplace"]) wrap(store, name, at(1)(`store.${name}`));

	for (const name of ["writeFileSync", "appendFileSync"]) wrap(fs, name, at(0)(`fs.${name}`));
	for (const name of ["renameSync", "linkSync", "copyFileSync"]) wrap(fs, name, at(1)(`fs.${name}`));
	wrap(fs, "openSync", (call, args) => (writeFlags(args[1]) ? commit("fs.openSync", args[0], call) : call()));
	// `node:fs/promises` is its own module object, apart from `fs.promises`.
	for (const promises of new Set<object>([fs.promises, fsPromises])) {
		for (const name of ["writeFile", "appendFile"]) wrap(promises, name, at(0)(`fs.promises.${name}`));
		for (const name of ["rename", "link", "copyFile"]) wrap(promises, name, at(1)(`fs.promises.${name}`));
		wrap(promises, "open", (call, args) =>
			writeFlags(args[1]) ? commit("fs.promises.open", args[0], call) : call(),
		);
	}
	return ledger;
}
