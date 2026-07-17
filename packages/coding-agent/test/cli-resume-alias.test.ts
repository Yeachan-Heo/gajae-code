import { describe, expect, it } from "bun:test";
import { normalizeResumeAlias, routeRootArgv } from "../src/cli";
import { parseArgs } from "../src/cli/args";

describe("resume CLI alias", () => {
	it("normalizes only the exact raw resume alias", () => {
		expect(normalizeResumeAlias(["resume"])).toEqual(["--resume"]);
		expect(normalizeResumeAlias(["resume", "session-id"])).toEqual(["resume", "session-id"]);
		expect(normalizeResumeAlias(["Resume"])).toEqual(["Resume"]);
		expect(normalizeResumeAlias(["--help"])).toEqual(["--help"]);
		expect(parseArgs(["resume", "session-id"])).toMatchObject({ messages: ["resume", "session-id"] });
	});

	it("routes the exact alias through launch as value-less resume without changing resume payloads", () => {
		expect(routeRootArgv(["resume"])).toEqual(["launch", "--resume"]);
		expect(parseArgs(routeRootArgv(["resume"]).slice(1)).resume).toBe(true);
		expect(routeRootArgv(["resume", "x"])).toEqual(["launch", "resume", "x"]);
		expect(parseArgs(routeRootArgv(["resume", "x"]).slice(1)).messages).toEqual(["resume", "x"]);
	});

	it("preserves root command and fast-path routing precedence", () => {
		expect(routeRootArgv(["stats"])).toEqual(["stats"]);
		expect(routeRootArgv(["unknown-command"])).toEqual(["launch", "unknown-command"]);
		expect(routeRootArgv(["--help"])).toEqual(["--help"]);
		expect(routeRootArgv(["--version"])).toEqual(["--version"]);
	});

	it("preserves explicit, value-less, equals, and flag-followed resume parsing", () => {
		expect(parseArgs(["--resume"]).resume).toBe(true);
		expect(parseArgs(["-r"]).resume).toBe(true);
		expect(parseArgs(["--session"]).resume).toBe(true);
		expect(parseArgs(["--resume", "session-id"]).resume).toBe("session-id");
		expect(parseArgs(["-r", "/sessions/session.jsonl"]).resume).toBe("/sessions/session.jsonl");
		expect(parseArgs(["--session=session-id"]).resume).toBe("session-id");
		expect(parseArgs(["--resume=session-id"]).resume).toBe("session-id");
		expect(parseArgs(["--session", "session-id"]).resume).toBe("session-id");
		expect(parseArgs(["-r", "--continue"])).toMatchObject({ resume: true, continue: true });
		const followedByFlag = parseArgs(["--resume", "--no-session"]);
		expect(followedByFlag.resume).toBe(true);
		expect(followedByFlag.noSession).toBe(true);
	});
});
