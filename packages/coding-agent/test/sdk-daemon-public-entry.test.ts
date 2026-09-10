import { describe, expect, it } from "bun:test";
import { scanPublicCommand } from "../src/cli/public-command-entry";

const id = "a".repeat(32);
const sha256 = "b".repeat(64);

describe("inert public command entry scanner", () => {
	it("resolves deepest exact paths and leaves operation IDs as operands", () => {
		const result = scanPublicCommand("sdk", [
			"session",
			"raw",
			"query",
			"session-id",
			"--query",
			"session.inspect",
			"--json",
		]);
		expect(result.kind).toBe("operation");
		expect(result.descriptor.command).toEqual(["sdk", "session", "raw", "query"]);
		expect(result.args).toEqual({ sessionId: "session-id" });
		expect(result.flags.query).toBe("session.inspect");
		expect(result.operationArgv).toEqual(["session", "raw", "query", "session-id", "--query", "session.inspect"]);
	});

	it("does not infer help or JSON from operands, equals values or tokens after --", () => {
		for (const value of ["--json", "--help", "-h"]) {
			const result = scanPublicCommand("sdk", ["session", "send", "s", `--text=${value}`]);
			expect(result.kind).toBe("operation");
			expect(result.mode).toBe("text");
			expect(result.flags.text).toBe(value);
		}
		const positional = scanPublicCommand("sdk", ["guides", "show", "--", "--json"]);
		expect(positional.kind).toBe("operation");
		expect(positional.mode).toBe("text");
		expect(positional.args.guideId).toBe("--json");
		const prompt = scanPublicCommand("sdk", ["session", "send", "s", "--text", "words --json --help"]);
		expect(prompt.kind).toBe("operation");
		expect(prompt.mode).toBe("text");
	});

	it("finds exact JSON and help tokens after malformed options without guessing unknown arity", () => {
		for (const argv of [
			["spawn", "--prompt", "--json", "--help"],
			["spawn", "--unknown-private-secret", "--json", "--help"],
			["session", "private-secret", "--json"],
		]) {
			const result = scanPublicCommand("sdk", argv);
			expect(result.kind).toBe("usage");
			expect(result.mode).toBe("json");
			expect(JSON.stringify(result.issues)).not.toContain("private-secret");
		}
	});

	it("renders leaf discovery without operation requirements but rejects malformed syntax", () => {
		expect(scanPublicCommand("sdk", ["spawn", "-h"]).kind).toBe("help");
		expect(scanPublicCommand("sdk", ["serve", "--help"]).kind).toBe("help");
		expect(scanPublicCommand("sdk", ["spawn", "--prompt", "--help"]).kind).toBe("usage");
		expect(scanPublicCommand("sdk", ["session", "inspect", "s", "--scope", "all"]).kind).toBe("usage");
		expect(
			scanPublicCommand("sdk", ["session", "status", "s"]).issues.some(issue => issue.code === "missing-argument"),
		).toBe(true);
	});

	it("handles local short clusters, default daemon action and exact aliases", () => {
		const result = scanPublicCommand("daemon", ["status", "-vh", "--json"]);
		expect(result.kind).toBe("help");
		expect(result.operationArgv).toEqual(["status", "-v"]);
		expect(scanPublicCommand("daemon", []).kind).toBe("operation");
		expect(scanPublicCommand("daemon", ["reload", "discord"]).descriptor.canonicalCommand).toEqual([
			"daemon",
			"restart",
		]);
		expect(scanPublicCommand("daemon", ["status", "telegram", "invalid-kind"]).kind).toBe("operation");
		expect(scanPublicCommand("daemon", ["worker", "--json"]).kind).toBe("operation");
	});

	it("leaves unknown daemon kinds to runtime while rejecting invalid timeout input", () => {
		for (const flag of ["--graceful-timeout-ms", "--kill-timeout-ms"]) {
			const argv = ["restart", "unknown-kind", flag, "2500"];
			const result = scanPublicCommand("daemon", argv);
			expect(result.kind).toBe("operation");
			expect(result.operationArgv).toEqual(argv);
			expect(result.args.kind).toEqual(["unknown-kind"]);
			expect(result.issues).toEqual([]);
			for (const value of ["0", "22junk", "9007199254740992"]) {
				const invalid = scanPublicCommand("daemon", ["restart", "unknown-kind", flag, value]);
				expect(invalid.kind).toBe("usage");
				expect(invalid.issues.some(issue => issue.code === "invalid-value")).toBe(true);
			}
		}
	});

	it("validates local enums, integers, transport exclusivity and JSON sources", () => {
		for (const argv of [
			["search", "--limit", "101"],
			["search", "--limit", "1.5"],
			["search", "--scope", "all"],
			["serve"],
			["serve", "--stdio", "--socket", "sock"],
			["serve", "--socket=sock"],
			["serve", "--stdio", "--stdio"],
			["serve", "--stdio", "--pending-ceiling", "262143"],
			["session", "send", "s", "--json-input", "{}", "--json-input-stdin"],
		])
			expect(scanPublicCommand("sdk", argv).kind).toBe("usage");
		expect(scanPublicCommand("sdk", ["search", "--limit=100"]).flags.limit).toBe(100);
		expect(scanPublicCommand("sdk", ["serve", "--stdio", "--pending-ceiling", "262144"]).kind).toBe("operation");
	});

	it("parses root retrieval selectors without operation argv", () => {
		const result = scanPublicCommand("sdk", [
			`--error-ref=${id}`,
			"--error-sha256",
			sha256,
			"--error-page=2",
			"--error-agent-dir",
			"custom",
			"--json",
		]);
		expect(result.kind).toBe("retrieval");
		expect(result.mode).toBe("json");
		expect(result.retrieval).toEqual({ id, sha256, page: 2, agentDir: "custom" });
		expect(result.operationArgv).toEqual([]);
	});

	it("rejects unpaired, duplicate, invalid, non-root and mixed retrieval selectors", () => {
		const selectors = ["--error-ref", id, "--error-sha256", sha256];
		for (const argv of [
			["--error-ref", id],
			["--error-page", "1"],
			["--error-agent-dir", "custom"],
			[...selectors, "--error-page=0"],
			[...selectors, "--error-page=9007199254740992"],
			[...selectors, "--error-ref", id],
			[...selectors, "--help"],
			[...selectors, "--all"],
			[...selectors, "status"],
			["status", ...selectors],
			[...selectors, "--", "--json"],
			["--error-ref", "BAD", "--error-sha256", sha256],
		])
			expect(scanPublicCommand("daemon", argv).kind).toBe("usage");
	});

	it("validates help selectors and strips them while retaining operation operands", () => {
		const result = scanPublicCommand("sdk", [
			"session",
			"inspect",
			"s",
			"--help",
			"--help-section=options",
			"--help-page",
			"2",
			"--help-revision",
			sha256,
		]);
		expect(result.kind).toBe("help");
		expect(result.help).toEqual({ section: "options", page: 2, revision: sha256 });
		expect(result.operationArgv).toEqual(["session", "inspect", "s"]);
		for (const argv of [
			["--help-page", "2"],
			["--help", "--help-section=bad"],
			["--help", "--help-page=1e2"],
			["--help", "--help-revision=bad"],
		]) {
			expect(scanPublicCommand("sdk", argv).kind).toBe("usage");
		}
	});
});
