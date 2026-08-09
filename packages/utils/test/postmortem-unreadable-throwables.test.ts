import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { recordFatalCrash } from "../src/postmortem";

/**
 * The crash reader is the only place this module turns an unknown throwable
 * into text, so it is the only place that has to be unbreakable. Producers are
 * unbounded — an `Error` with a lazily computed `message`, a hostile `Proxy`, a
 * cross-realm object, a plain record, a primitive — and hardening them one at a
 * time is what left a sibling path unguarded on every previous attempt.
 *
 * So this table is written against the consumer: whatever the throwable is, the
 * record exists and carries every field that could be read.
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

interface Throwables {
	/** Case name, also the assertion failure label. */
	readonly what: string;
	readonly build: () => unknown;
	/** Fragments the record must keep: everything readable, plus a marker for everything not. */
	readonly keeps: readonly string[];
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
		what: "plain record thrown instead of an Error",
		build: () => ({ phase: "startup", reason: "broker-spawn", message: "record fatal" }),
		// No `name`, so this is payload rather than an error shape: the whole
		// record is kept instead of collapsing to `[object Object]`.
		keeps: ['{"phase":"startup","reason":"broker-spawn","message":"record fatal"}'],
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
	for (const { what, build, keeps } of throwables) {
		it(`records a fatal from a ${what}`, () => {
			const target = crashLogTarget();

			// A throw out of here is the failure this whole table exists for: the
			// crash reader must never be the reason a crash goes unrecorded.
			expect(recordFatalCrash(LABEL, build(), { path: target, now: RECORDED_AT })).toBe(target);

			const contents = fs.readFileSync(target, "utf8");
			for (const fragment of keeps) expect(contents).toContain(fragment);
			// Whatever it was, the record says something: never an empty diagnostic.
			expect(diagnosticOf(contents)).not.toBe("");
			expect(diagnosticOf(contents)).not.toBe("(no message)");
		});
	}

	it("reads each field of a throwable exactly once, even when a sibling refuses", () => {
		const reads: string[] = [];
		const reason = {
			get name(): string {
				reads.push("name");
				return "CountedFailure";
			},
			get message(): string {
				reads.push("message");
				throw new Error("message getter always throws");
			},
			get stack(): string {
				reads.push("stack");
				return "CountedFailureStack";
			},
		};

		const target = crashLogTarget();
		expect(recordFatalCrash(LABEL, reason, { path: target, now: RECORDED_AT })).toBe(target);

		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("CountedFailure: [unreadable]");
		expect(contents).toContain("CountedFailureStack");
		// A second observation is the hazard a stateful accessor uses to throw
		// after passing a shape check, so there is no second observation.
		expect(reads).toEqual(["name", "message", "stack"]);
	});
});
