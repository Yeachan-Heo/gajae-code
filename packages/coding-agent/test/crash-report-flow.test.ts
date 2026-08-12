import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendCrashEvent, computeCrashFingerprint, formatCrashRecordMarker } from "@gajae-code/utils";
import { type CrashStatePaths, compactCrashIndex, readCrashIndex } from "../src/crash/index-store";
import {
	buildPrefillUrl,
	CRASH_REPORT_REPO,
	type CrashReportIo,
	isCanonicalIssueUrl,
	runCrashReportFlow,
} from "../src/crash/report";
import type { GhResult, RunGh } from "../src/utils/gh";

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);
const ENVIRONMENT = { platform: "Linux", gjcVersion: "0.13.1", bunVersion: "1.3.14" };
const STACK = [
	"Error: shared topic authority unavailable",
	"    at resolveTopic (/opt/gjc/packages/coding-agent/src/sdk/bus/topics.ts:412:19)",
].join("\n");
const FINGERPRINT = computeCrashFingerprint({
	name: "Error",
	message: "shared topic authority unavailable",
	stack: STACK,
}).fingerprint;
const RECORD_ID = "abcdef0123456789";
const ISSUE_URL = `https://github.com/${CRASH_REPORT_REPO}/issues/4321`;

interface Harness {
	paths: CrashStatePaths;
	snapshotDir: string;
	output: string[];
	ghCalls: string[][];
}

async function harness(options: { withRecord?: boolean } = {}): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-crash-flow-"));
	const paths: CrashStatePaths = {
		index: path.join(dir, "gjc-crash-index.json"),
		events: path.join(dir, "gjc-crash-events.jsonl"),
		crashLog: path.join(dir, "gjc-crash.log"),
	};
	appendCrashEvent(
		{
			kind: "occurrence",
			fingerprint: FINGERPRINT,
			fpv: 1,
			recordId: RECORD_ID,
			at: NOW - 1000,
			errorName: "Error",
			messageClass: "shared topic authority unavailable",
		},
		paths.events,
	);
	if (options.withRecord !== false) {
		await fs.writeFile(
			paths.crashLog,
			`2026-08-11T11:59:59.000Z pid=4242 [Uncaught Exception] Error: shared topic authority unavailable\n` +
				`${STACK}\n${formatCrashRecordMarker(FINGERPRINT, 1, RECORD_ID)}\n\n`,
		);
	}
	return { paths, snapshotDir: dir, output: [], ghCalls: [] };
}

function scriptedIo(
	harness: Harness,
	script: { selects: (number | undefined)[]; confirms: boolean[]; inputs?: string[] },
): CrashReportIo {
	const selects = [...script.selects];
	const confirms = [...script.confirms];
	const inputs = [...(script.inputs ?? [])];
	return {
		print: text => {
			harness.output.push(text);
		},
		select: async () => selects.shift(),
		confirm: async () => confirms.shift() ?? false,
		input: async () => inputs.shift() ?? "",
	};
}

function gh(harness: Harness, responses: Record<string, GhResult>): RunGh {
	return async args => {
		harness.ghCalls.push(args);
		const key = `${args[0]} ${args[1]}`;
		return responses[key] ?? { exitCode: 1, stdout: "", stderr: `unstubbed gh call: ${args.join(" ")}` };
	};
}

const IDENTITY: GhResult = { exitCode: 0, stdout: "octocat\n", stderr: "" };
const NO_DUPLICATE: GhResult = { exitCode: 0, stdout: "[]", stderr: "" };
const CREATED: GhResult = { exitCode: 0, stdout: `${ISSUE_URL}\n`, stderr: "" };

describe("runCrashReportFlow — consent ordering", () => {
	it("never touches gh before the digest-confirmed consent gate", async () => {
		const h = await harness();
		const seenBeforeConsent: string[][] = [];
		let consented = false;
		const io = scriptedIo(h, { selects: [0, 0], confirms: [true], inputs: ["steps", "expected", "", "", ""] });
		const trackingIo: CrashReportIo = {
			...io,
			confirm: async prompt => {
				// Every gh call recorded up to this point happened pre-consent.
				seenBeforeConsent.push(...h.ghCalls);
				consented = true;
				return io.confirm(prompt);
			},
		};
		const outcome = await runCrashReportFlow({
			io: trackingIo,
			paths: h.paths,
			snapshotDir: h.snapshotDir,
			runGh: gh(h, { "api user": IDENTITY, "issue list": NO_DUPLICATE, "issue create": CREATED }),
			interactive: true,
			environment: ENVIRONMENT,
			now: () => new Date(NOW),
		});

		expect(consented).toBe(true);
		expect(seenBeforeConsent).toEqual([]);
		expect(outcome).toEqual({ status: "created", url: ISSUE_URL });
		expect(h.ghCalls[0]?.slice(0, 2)).toEqual(["api", "user"]);
		// Every gh invocation is pinned to the canonical repository.
		for (const call of h.ghCalls.filter(call => call[0] === "issue")) {
			expect(call).toContain("--repo");
			expect(call[call.indexOf("--repo") + 1]).toBe(CRASH_REPORT_REPO);
		}
		expect((await readCrashIndex(h.paths)).signatures[FINGERPRINT]?.reportedIssueUrl).toBe(ISSUE_URL);
	});

	it("transmits nothing when the preview is declined", async () => {
		const h = await harness();
		const outcome = await runCrashReportFlow({
			io: scriptedIo(h, { selects: [0, 0], confirms: [false], inputs: ["", "", "", "", ""] }),
			paths: h.paths,
			snapshotDir: h.snapshotDir,
			runGh: gh(h, {}),
			interactive: true,
			environment: ENVIRONMENT,
			now: () => new Date(NOW),
		});
		expect(outcome.status).toBe("cancelled");
		expect(h.ghCalls).toEqual([]);
	});

	it("refuses when the snapshot changed after it was confirmed", async () => {
		const h = await harness();
		const io = scriptedIo(h, { selects: [0, 0], confirms: [true], inputs: ["", "", "", "", ""] });
		const tamperingIo: CrashReportIo = {
			...io,
			confirm: async prompt => {
				const snapshot = (await fs.readdir(h.snapshotDir)).find(name => name.startsWith("crash-report-"));
				if (snapshot) await fs.writeFile(path.join(h.snapshotDir, snapshot), "tampered");
				return io.confirm(prompt);
			},
		};
		const outcome = await runCrashReportFlow({
			io: tamperingIo,
			paths: h.paths,
			snapshotDir: h.snapshotDir,
			runGh: gh(h, { "api user": IDENTITY }),
			interactive: true,
			environment: ENVIRONMENT,
			now: () => new Date(NOW),
		});
		expect(outcome).toEqual({ status: "refused", reason: "snapshot digest mismatch" });
		expect(h.ghCalls).toEqual([]);
	});
});

describe("runCrashReportFlow — duplicate handling", () => {
	const CANDIDATE: GhResult = {
		exitCode: 0,
		stdout: JSON.stringify([{ url: ISSUE_URL, title: "crash: Error in topics.ts", author: { login: "someone" } }]),
		stderr: "",
	};

	it("stops at the existing issue by default", async () => {
		const h = await harness();
		const outcome = await runCrashReportFlow({
			io: scriptedIo(h, { selects: [0, 0, 0], confirms: [true], inputs: ["", "", "", "", ""] }),
			paths: h.paths,
			snapshotDir: h.snapshotDir,
			runGh: gh(h, { "api user": IDENTITY, "issue list": CANDIDATE }),
			interactive: true,
			environment: ENVIRONMENT,
			now: () => new Date(NOW),
		});
		expect(outcome).toEqual({ status: "duplicate", url: ISSUE_URL });
		expect(h.ghCalls.some(call => call[1] === "create")).toBe(false);
	});

	it("comments once and never again from the same install", async () => {
		const h = await harness();
		const deps = {
			paths: h.paths,
			snapshotDir: h.snapshotDir,
			runGh: gh(h, {
				"api user": IDENTITY,
				"issue list": CANDIDATE,
				"issue comment": { exitCode: 0, stdout: "", stderr: "" },
			}),
			interactive: true,
			environment: ENVIRONMENT,
			now: () => new Date(NOW),
		};
		const first = await runCrashReportFlow({
			...deps,
			io: scriptedIo(h, { selects: [0, 0, 1], confirms: [true, true], inputs: ["", "", "", "", ""] }),
		});
		expect(first).toEqual({ status: "commented", url: ISSUE_URL });

		const second = await runCrashReportFlow({
			...deps,
			io: scriptedIo(h, { selects: [0, 0, 1], confirms: [true, true], inputs: ["", "", "", "", ""] }),
		});
		expect(second).toEqual({ status: "duplicate", url: ISSUE_URL });
		expect(h.ghCalls.filter(call => call[1] === "comment")).toHaveLength(1);
	});

	it("refuses to create when the duplicate search is inconclusive and the user declines the override", async () => {
		const h = await harness();
		const outcome = await runCrashReportFlow({
			io: scriptedIo(h, { selects: [0, 0], confirms: [true, false], inputs: ["", "", "", "", ""] }),
			paths: h.paths,
			snapshotDir: h.snapshotDir,
			runGh: gh(h, {
				"api user": IDENTITY,
				"issue list": { exitCode: 1, stdout: "", stderr: "HTTP 401", timedOut: false },
			}),
			interactive: true,
			environment: ENVIRONMENT,
			now: () => new Date(NOW),
		});
		expect(outcome.status).toBe("refused");
		expect(h.ghCalls.some(call => call[1] === "create")).toBe(false);
	});

	it("rejects a duplicate hit whose URL is not on the canonical repository", async () => {
		const h = await harness();
		const outcome = await runCrashReportFlow({
			io: scriptedIo(h, { selects: [0, 0], confirms: [true, false], inputs: ["", "", "", "", ""] }),
			paths: h.paths,
			snapshotDir: h.snapshotDir,
			runGh: gh(h, {
				"api user": IDENTITY,
				"issue list": {
					exitCode: 0,
					stdout: JSON.stringify([{ url: "https://evil.example/issues/1", title: "x", author: { login: "y" } }]),
					stderr: "",
				},
			}),
			interactive: true,
			environment: ENVIRONMENT,
			now: () => new Date(NOW),
		});
		expect(outcome.status).toBe("refused");
	});
});

describe("runCrashReportFlow — degraded environments", () => {
	it("falls back to a snapshot path and a bounded prefill URL without gh", async () => {
		const h = await harness();
		const outcome = await runCrashReportFlow({
			io: scriptedIo(h, { selects: [0, 0], confirms: [true], inputs: ["", "", "", "", ""] }),
			paths: h.paths,
			snapshotDir: h.snapshotDir,
			runGh: gh(h, {}),
			interactive: true,
			environment: ENVIRONMENT,
			now: () => new Date(NOW),
		});
		expect(outcome.status).toBe("manual");
		if (outcome.status !== "manual") return;
		expect(await fs.readFile(outcome.snapshotPath, "utf8")).toContain("gjc-crash-fp.v1:");
		expect(outcome.prefillUrl).toContain(`https://github.com/${CRASH_REPORT_REPO}/issues/new?`);
		expect(outcome.prefillUrl).not.toContain("topic+authority");
	});

	it("refuses submission in a non-interactive invocation and prints a report path", async () => {
		const h = await harness();
		const outcome = await runCrashReportFlow({
			io: scriptedIo(h, { selects: [], confirms: [] }),
			paths: h.paths,
			snapshotDir: h.snapshotDir,
			runGh: gh(h, {}),
			interactive: false,
			environment: ENVIRONMENT,
			now: () => new Date(NOW),
		});
		expect(outcome.status).toBe("non-interactive");
		expect(h.ghCalls).toEqual([]);
		expect(h.output.join("")).toContain("nothing was transmitted");
	});

	it("refuses to report a legacy record with no identity line", async () => {
		const h = await harness({ withRecord: false });
		await fs.writeFile(
			h.paths.crashLog,
			"2026-08-02T17:05:35.948Z pid=2557873 [Uncaught Exception] Error: shared topic authority unavailable\n",
		);
		const outcome = await runCrashReportFlow({
			io: scriptedIo(h, { selects: [0, 0], confirms: [] }),
			paths: h.paths,
			snapshotDir: h.snapshotDir,
			runGh: gh(h, {}),
			interactive: true,
			environment: ENVIRONMENT,
			now: () => new Date(NOW),
		});
		expect(outcome).toEqual({ status: "unmatchable", fingerprint: FINGERPRINT });
		expect(h.ghCalls).toEqual([]);
	});

	it("dismissing a signature stamps an acknowledgement without any gh call", async () => {
		const h = await harness();
		const outcome = await runCrashReportFlow({
			io: scriptedIo(h, { selects: [0, 1], confirms: [] }),
			paths: h.paths,
			snapshotDir: h.snapshotDir,
			runGh: gh(h, {}),
			interactive: true,
			environment: ENVIRONMENT,
			now: () => new Date(NOW),
		});
		expect(outcome.status).toBe("acknowledged");
		expect(h.ghCalls).toEqual([]);
		const index = await compactCrashIndex({ paths: h.paths, now: NOW });
		expect(index.signatures[FINGERPRINT]?.acknowledgedAt).toBe(NOW);
	});
});

describe("report body and URL guards", () => {
	it("emits every required bug_report.yml field with explicit prompts for what is not captured", async () => {
		const h = await harness();
		await runCrashReportFlow({
			io: scriptedIo(h, { selects: [0, 0], confirms: [false], inputs: ["", "", "", "", ""] }),
			paths: h.paths,
			snapshotDir: h.snapshotDir,
			runGh: gh(h, {}),
			interactive: true,
			environment: ENVIRONMENT,
			now: () => new Date(NOW),
		});
		const body = h.output.join("");
		for (const heading of [
			"## Description",
			"## Steps to Reproduce",
			"## Expected Behavior",
			"## Error Output",
			"## Platform",
			"## gjc version",
			"## Bun version",
		]) {
			expect(body).toContain(heading);
		}
		expect(body).toContain("not captured — please fill in");
		expect(body).toContain(`gjc-crash-fp.v1:${FINGERPRINT}`);
		expect(body).not.toContain("pid=4242");
		expect(body).not.toContain("/opt/gjc/packages");
	});

	it("validates issue URLs against the canonical repository", () => {
		expect(isCanonicalIssueUrl(ISSUE_URL)).toBe(true);
		expect(isCanonicalIssueUrl("https://github.com/evil/gajae-code/issues/1")).toBe(false);
		expect(isCanonicalIssueUrl(`https://github.com/${CRASH_REPORT_REPO}/issues/abc`)).toBe(false);
		expect(isCanonicalIssueUrl("not a url")).toBe(false);
	});

	it("builds a prefill URL only from bounded-grammar fields", () => {
		expect(buildPrefillUrl("crash: Error in topics.ts", FINGERPRINT, "0.13.1")).toContain("template=bug_report.yml");
		expect(buildPrefillUrl("crash: `rm -rf`", FINGERPRINT, "0.13.1")).toBeUndefined();
		expect(buildPrefillUrl("crash: Error", "not-a-fingerprint", "0.13.1")).toBeUndefined();
		expect(buildPrefillUrl("crash: Error", FINGERPRINT, "nightly")).toBeUndefined();
	});
});
