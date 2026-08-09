import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { CRASH_RECORD_MAX_BYTES, recordFatalCrash } from "../src/postmortem";
import { NonZeroExitError } from "../src/ptree";

/**
 * The crash reader is the only place this module turns an unknown throwable
 * into text, so it is the only place that has to be unbreakable. Producers are
 * unbounded — an `Error` with a lazily computed `message`, a hostile `Proxy`, a
 * cross-realm object, a plain record, a primitive — and hardening them one at a
 * time is what left a sibling path unguarded on every previous attempt.
 *
 * So this table is written against the consumer: every throwable produces a
 * useful record, while arbitrary request data is excluded and retained context
 * is redacted and bounded.
 */
const LABEL = "Uncaught Exception";
const RECORDED_AT = new Date("2026-01-01T00:00:00.000Z");

const refusingAccessor = (field: string): PropertyDescriptor => ({
	configurable: true,
	get(): never {
		throw new Error(`${field} getter always throws`);
	},
});

/** A same-realm `Error` whose named fields refuse to answer; `instanceof Error` still holds. */
function errorRefusing(fields: readonly ("name" | "message" | "stack")[]): Error {
	const error = new Error("this message is never readable");
	error.name = "LazyFailure";
	for (const field of fields) Object.defineProperty(error, field, refusingAccessor(field));
	return error;
}

function missingFileError(): unknown {
	try {
		fs.readFileSync("/definitely/not/here");
	} catch (error) {
		return error;
	}
	throw new Error("missing-file probe unexpectedly succeeded");
}

interface Throwables {
	/** Case name, also the assertion failure label. */
	readonly what: string;
	readonly build: () => unknown;
	/** Fragments the record must keep. */
	readonly keeps: readonly string[];
	/** Fragments excluded by the diagnostic-context policy. */
	readonly omits?: readonly string[];
	readonly after?: (contents: string) => void;
}

const throwables: readonly Throwables[] = [
	{
		what: "same-realm Error whose message getter throws",
		build: () => errorRefusing(["message"]),
		// The name and the trace answered, so they survive; only `message` is lost.
		keeps: ["LazyFailure: [unreadable]", "postmortem-unreadable-throwables.test.ts"],
	},
	{
		what: "same-realm Error whose name refuses while stack remains readable",
		build: () => {
			const error = new Error("discarded message");
			Object.defineProperty(error, "name", refusingAccessor("name"));
			Object.defineProperty(error, "message", { configurable: true, value: undefined });
			error.stack = "Error\n    at load-bearing-frame";
			return error;
		},
		keeps: ["[unreadable]: (no message)", "load-bearing-frame"],
	},
	{
		what: "same-realm Error whose name, message and stack getters all throw",
		build: () => errorRefusing(["name", "message", "stack"]),
		// Nothing answered. Reported as unreadable, which is a fact; serializing
		// an `Error` instead yields `{}`, which is silence.
		keeps: ["[unreadable]: [unreadable]"],
	},
	{
		what: "Proxy that throws from its getPrototypeOf trap",
		build: () =>
			new Proxy(
				{},
				{
					getPrototypeOf(): never {
						throw new Error("getPrototypeOf trap always throws");
					},
					get(_target, property): unknown {
						if (property === "name") return "HostileFailure";
						if (property === "message") return "hostile fatal survives";
						throw new Error("get trap always throws");
					},
				},
			),
		keeps: ["HostileFailure: hostile fatal survives", "\n[unreadable]\n"],
	},
	{
		what: "Proxy that answers nothing at all",
		build: () =>
			new Proxy(
				{},
				{
					getPrototypeOf(): never {
						throw new Error("getPrototypeOf trap always throws");
					},
					get(): never {
						throw new Error("get trap always throws");
					},
					ownKeys(): never {
						throw new Error("ownKeys trap always throws");
					},
				},
			),
		keeps: ["[unreadable]: [unreadable]"],
	},
	{
		what: "cross-realm error-like object",
		build: () =>
			vm.runInNewContext(
				"(() => { const error = new Error('cross-realm boom'); error.stack = 'CrossRealmStack'; return error; })()",
			),
		keeps: ["Error: cross-realm boom", "CrossRealmStack"],
	},
	{
		what: "Node system error with enumerable context and a real stack",
		build: missingFileError,
		keeps: ["ENOENT", '"code":"ENOENT"', "/definitely/not/here", "postmortem-unreadable-throwables.test.ts"],
	},
	{
		what: "NonZeroExitError with own fields and a load-bearing stack",
		build: () => {
			const error = new NonZeroExitError(7, "child stderr survives");
			error.stack = `${error.name}: ${error.message}\n    at load-bearing-nonzero-frame`;
			return error;
		},
		keeps: [
			"NonZeroExitError: Process exited with code 7:",
			"load-bearing-nonzero-frame",
			'"exitCode":7',
			'"stderr":"child stderr survives"',
		],
	},
	{
		what: "plain record thrown instead of an Error",
		build: () => ({ phase: "startup", reason: "broker-spawn", message: "record fatal" }),
		keeps: ["Error: record fatal", '{"phase":"startup","reason":"broker-spawn"}'],
	},
	{
		what: "plain record carrying a readable stack and crash context",
		build: () => ({
			phase: "startup",
			reason: "broker-spawn",
			exitCode: 7,
			stack: "at spawnBroker (broker.ts:1:1)",
		}),
		keeps: ["spawnBroker (broker.ts:1:1)", '{"phase":"startup","reason":"broker-spawn","exitCode":7}'],
	},
	{
		what: "named error record carrying HTTP response context",
		build: () => ({
			name: "HttpError",
			message: "502 Bad Gateway",
			status: 502,
			url: "https://api/x",
			body: "upstream",
		}),
		keeps: ["HttpError: 502 Bad Gateway", '{"status":502,"url":"https://api/x"}'],
		omits: ['"body"', "upstream"],
	},
	((): Throwables => {
		const reads: string[] = [];
		return {
			what: "record whose error fields must not be re-read during payload serialization",
			build: () => {
				reads.length = 0;
				return {
					get name(): number {
						reads.push("name");
						return 17;
					},
					get message(): null {
						reads.push("message");
						return null;
					},
					get stack(): boolean {
						reads.push("stack");
						return false;
					},
					phase: "readable context survives",
				};
			},
			keeps: ["17: null", '{"phase":"readable context survives"}'],
			after: () => expect(reads).toEqual(["name", "message", "stack"]),
		};
	})(),
	{
		what: "NonZeroExitError whose 20KB stderr must not evict exitCode",
		build: () => new NonZeroExitError(7, "E".repeat(20 * 1024)),
		keeps: ['"exitCode":7', '"stderr":"', "[field truncated]"],
		after: contents => expect(Buffer.byteLength(contents, "utf8")).toBeLessThanOrEqual(CRASH_RECORD_MAX_BYTES),
	},
	{
		what: "credential-shaped request fields on an Error",
		build: () =>
			Object.assign(new Error("upstream refused the connection"), {
				config: { headers: { authorization: "Bearer sk-abcdefghijklmnopqrstuvwxyz012345" } },
				body: "Y".repeat(200_000),
			}),
		keeps: ["upstream refused the connection", "postmortem-unreadable-throwables.test.ts"],
		omits: ["Bearer sk-", '"config"', '"body"', "Y".repeat(1024)],
		after: contents => expect(Buffer.byteLength(contents, "utf8")).toBeLessThanOrEqual(CRASH_RECORD_MAX_BYTES),
	},
	{
		what: "credential inside a retained diagnostic field",
		build: () =>
			Object.assign(new Error("child failed"), {
				exitCode: 7,
				stderr: "Authorization=Bearer sk-abcdefghijklmnopqrstuvwxyz012345",
			}),
		keeps: ['"exitCode":7', '"stderr":"Authorization=«redacted»"'],
		omits: ["Bearer sk-", "abcdefghijklmnopqrstuvwxyz012345"],
	},
	{
		what: "named record with an explicitly empty stack",
		build: () => ({ name: "E", message: "m", stack: "", other: 1 }),
		keeps: ["E: m"],
		omits: ['"stack"', '"other"'],
		after: contents => expect(contents.match(/E: m/g)).toHaveLength(1),
	},
	{
		what: "own context field that references the throwable",
		build: () => {
			const reads: string[] = [];
			const throwable: Record<string, unknown> = {
				get name() {
					if (reads.push("name") > 1) throw new Error("name read twice");
					return "E";
				},
				get message() {
					if (reads.push("message") > 2) throw new Error("message read twice");
					return "m";
				},
			};
			throwable.reason = throwable;
			return throwable;
		},
		keeps: ["E: m", '"reason":"[object Object]"'],
	},
	{
		what: "own diagnostic field whose value is undefined",
		build: () => ({ message: "undefined context survives", phase: undefined }),
		keeps: ["Error: undefined context survives", '"phase":"[undefined]"'],
	},
	{
		what: "record whose symbol message must not disappear",
		build: () => ({ message: Symbol("lost") }),
		keeps: ["Error: Symbol(lost)"],
	},
	{
		what: "record whose function message must not disappear",
		build: () => ({ message: () => "x" }),
		keeps: ['Error: () => "x"'],
	},
	{
		what: "thrown string primitive",
		build: () => "plain string boom",
		keeps: ["Error: plain string boom"],
	},
	{
		what: "thrown symbol primitive",
		build: () => Symbol("symbol boom"),
		keeps: ["Error: Symbol(symbol boom)"],
	},
	{
		what: "thrown null",
		build: () => null,
		keeps: ["Error: null"],
	},
];

const crashLogTarget = (): string =>
	path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-unreadable-")), "gjc-crash.log");

/** The diagnostic the record actually carries: the header line minus timestamp, pid and label. */
function diagnosticOf(contents: string): string {
	const header = contents.split("\n")[0] ?? "";
	return header.slice(header.indexOf(`[${LABEL}] `) + LABEL.length + 3).trim();
}

describe("crash recording of throwables that refuse to be read", () => {
	for (const { what, build, keeps, omits, after } of throwables) {
		it(`records a fatal from a ${what}`, () => {
			const target = crashLogTarget();

			// A throw out of here is the failure this whole table exists for: the
			// crash reader must never be the reason a crash goes unrecorded.
			expect(recordFatalCrash(LABEL, build(), { path: target, now: RECORDED_AT })).toBe(target);

			const contents = fs.readFileSync(target, "utf8");
			for (const fragment of keeps) expect(contents).toContain(fragment);
			for (const fragment of omits ?? []) expect(contents).not.toContain(fragment);
			after?.(contents);
			// Whatever it was, the record says something: never an empty diagnostic.
			expect(diagnosticOf(contents)).not.toBe("");
			expect(diagnosticOf(contents)).not.toBe("(no message)");
		});
	}
});
