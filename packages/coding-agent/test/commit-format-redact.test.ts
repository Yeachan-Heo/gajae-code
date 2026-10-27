import { describe, expect, it } from "bun:test";
import { formatCommitMessage } from "../src/commit/message";
import type { ConventionalAnalysis } from "../src/commit/types";

const GITHUB_PAT = "github_pat_11ABCDEFG0hijklmnopq_RSTUVWXYZ0123456789abcdefghij";
const SK = "sk-ant-GJCCANARY-commitfmt-9f3c1d7a2b6e";

function analysis(details: string[], scope: string | null = "commit"): ConventionalAnalysis {
	return {
		type: "fix",
		scope,
		details: details.map(text => ({ text, userVisible: true })),
		issueRefs: [],
	};
}

describe("formatCommitMessage credential text", () => {
	it("redacts a github_pat_ or sk- token in the summary", () => {
		const message = formatCommitMessage(
			analysis([`body keeps ${GITHUB_PAT}`, ` body keeps ${SK} `]),
			`document ${GITHUB_PAT} and ${SK}`,
		);

		expect(message).not.toContain(GITHUB_PAT);
		expect(message).not.toContain(SK);
		expect(message).toContain("[REDACTED_TOKEN]");
		expect(message).toBe(
			[
				"fix(commit): document [REDACTED_TOKEN] and [REDACTED_TOKEN]",
				"",
				"- body keeps [REDACTED_TOKEN]",
				"- body keeps [REDACTED_TOKEN]",
			].join("\n"),
		);

		const [header = "", , ...body] = message.split("\n");
		const again = formatCommitMessage(
			analysis(body.map(line => line.slice(2))),
			header.replace(/^fix\(commit\): /, ""),
		);
		expect(again).toBe(message);

		const scoped = formatCommitMessage(analysis(["note the config"], GITHUB_PAT), "update the config");
		expect(scoped).toBe("fix([REDACTED_TOKEN]): update the config\n\n- note the config");
		expect(scoped).not.toContain(GITHUB_PAT);
		const scopedAgain = formatCommitMessage(analysis(["note the config"], "[REDACTED_TOKEN]"), "update the config");
		expect(scopedAgain).toBe(scoped);
	});

	it("keeps an ordinary summary, scope, and detail unchanged", () => {
		const message = formatCommitMessage(analysis(["keep the formatter"], "api"), "update the formatter");
		expect(message).toBe("fix(api): update the formatter\n\n- keep the formatter");
		const unscoped = formatCommitMessage(analysis(["keep the formatter"], null), "update the formatter");
		expect(unscoped).toBe("fix: update the formatter\n\n- keep the formatter");
	});
});
