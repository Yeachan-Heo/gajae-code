import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import { TempDir } from "@gajae-code/utils";
import { $ } from "bun";
import {
	buildContributionPrepWorkerPrompt,
	prepareContributionPrep,
	redactContributionPrepText,
} from "../src/session/contribution-prep";
import { lookupBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";

const SYNTHETIC_AWS_ACCESS_KEY_ID = `AKIA${"0".repeat(16)}`;
const SYNTHETIC_AWS_TEMPORARY_KEY_ID = `ASIA${"1".repeat(16)}`;
const SYNTHETIC_AWS_SECRET_ACCESS_KEY = `SYNTHETIC_SECRET_ACCESS_KEY_${"2".repeat(20)}`;
const SYNTHETIC_AWS_SESSION_TOKEN = `SYNTHETIC_SESSION_TOKEN_${"3".repeat(20)}+/=`;

describe("contribution prep", () => {
	it("redacts secrets, private endpoints, cookies, auth headers, and home paths", () => {
		const text = [
			"Authorization: Bearer sk-testsecret123456789",
			"Cookie: sid=abc123; token=private",
			"OPENAI_API_KEY=sk-providersecret123456789",
			"callback http://127.0.0.1:8787/internal",
			"classic ghp_abcdefghijklmnopqrstuvwxyz123456",
			"oauth gho_abcdefghijklmnopqrstuvwxyz123456",
			"fine github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz1234567890",
			`${process.env.HOME ?? ""}/project/file.ts`,
		].join("\n");

		const redacted = redactContributionPrepText(text, process.cwd());

		expect(redacted).toContain("Authorization: [REDACTED_AUTH_HEADER]");
		expect(redacted).toContain("Cookie: [REDACTED_COOKIE]");
		expect(redacted).toContain("OPENAI_API_KEY=[REDACTED_SECRET]");
		expect(redacted).toContain("[REDACTED_PRIVATE_ENDPOINT]");
		expect(redacted).not.toContain("sk-testsecret123456789");
		expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
		expect(redacted).not.toContain("gho_abcdefghijklmnopqrstuvwxyz123456");
		expect(redacted).not.toContain("github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz1234567890");
		expect(redacted).not.toContain(process.env.HOME ?? "__missing_home__");
	});

	it("redacts every supported GitHub token prefix without changing near-misses", () => {
		const tokens = [
			"ghp_abcdefghijklmnopqrstuvwxyz123456",
			"gho_abcdefghijklmnopqrstuvwxyz123456",
			"ghs_abcdefghijklmnopqrstuvwxyz123456",
			"ghu_abcdefghijklmnopqrstuvwxyz123456",
			"ghr_abcdefghijklmnopqrstuvwxyz123456",
			"github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz1234567890",
		];
		const nearMisses = [
			"ghx_abcdefghijklmnopqrstuvwxyz123456",
			"ghs_abcdefghijk",
			"prefixghu_abcdefghijklmnopqrstuvwxyz123456",
			"ordinary prose remains visible",
		];
		const redacted = redactContributionPrepText([...tokens, ...nearMisses].join("\n"), process.cwd());

		expect(redacted).toBe([...tokens.map(() => "[REDACTED_TOKEN]"), ...nearMisses].join("\n"));
		expect(redactContributionPrepText("before (ghs_abcdefghijkl), after", process.cwd())).toBe(
			"before ([REDACTED_TOKEN]), after",
		);
	});

	it("redacts a complete AWS STS credential, not just the key id", () => {
		// An STS response carries three fields. The key id is the least sensitive of
		// them; `SecretAccessKey` and `SessionToken` are the credential itself, and
		// neither canonical field name is matched by the `ENV_*=value` rule, which
		// only sees the shell spelling `AWS_SECRET_ACCESS_KEY=`.
		const text = JSON.stringify({
			Credentials: {
				AccessKeyId: SYNTHETIC_AWS_TEMPORARY_KEY_ID,
				SecretAccessKey: SYNTHETIC_AWS_SECRET_ACCESS_KEY,
				SessionToken: SYNTHETIC_AWS_SESSION_TOKEN,
				"X-Amz-Security-Token": SYNTHETIC_AWS_SESSION_TOKEN,
			},
		});

		const redacted = redactContributionPrepText(text, process.cwd());
		const parsed = JSON.parse(redacted) as {
			Credentials: {
				AccessKeyId: string;
				SecretAccessKey: string;
				SessionToken: string;
				"X-Amz-Security-Token": string;
			};
		};

		expect(redacted).not.toContain(SYNTHETIC_AWS_TEMPORARY_KEY_ID);
		expect(redacted).not.toContain(SYNTHETIC_AWS_SECRET_ACCESS_KEY);
		expect(redacted).not.toContain(SYNTHETIC_AWS_SESSION_TOKEN);
		expect(parsed.Credentials).toEqual({
			AccessKeyId: "[REDACTED_AWS_KEY_ID]",
			SecretAccessKey: "[REDACTED_SECRET]",
			SessionToken: "[REDACTED_SECRET]",
			"X-Amz-Security-Token": "[REDACTED_SECRET]",
		});
	});

	it("redacts escaped AWS JSON fields and key ids without invalidating JSON", () => {
		const text = String.raw`{"\u0053ecretAccessKey":"${SYNTHETIC_AWS_SECRET_ACCESS_KEY}","Session\u0054oken":"${SYNTHETIC_AWS_SESSION_TOKEN}","AccessKeyId":"\u0041${SYNTHETIC_AWS_TEMPORARY_KEY_ID.slice(1)}"}`;

		const redacted = redactContributionPrepText(text, process.cwd());
		const parsed = JSON.parse(redacted) as {
			SecretAccessKey: string;
			SessionToken: string;
			AccessKeyId: string;
		};

		expect(parsed).toEqual({
			SecretAccessKey: "[REDACTED_SECRET]",
			SessionToken: "[REDACTED_SECRET]",
			AccessKeyId: "[REDACTED_AWS_KEY_ID]",
		});
		expect(redacted).not.toContain(SYNTHETIC_AWS_SECRET_ACCESS_KEY);
		expect(redacted).not.toContain(SYNTHETIC_AWS_SESSION_TOKEN);
		expect(redacted).not.toContain(SYNTHETIC_AWS_TEMPORARY_KEY_ID.slice(1));
	});

	it("redacts AWS credentials inside nested serialized JSON", () => {
		const inner = String.raw`{"Session\u0054oken":"${SYNTHETIC_AWS_SESSION_TOKEN}","AccessKeyId":"\u0041${SYNTHETIC_AWS_TEMPORARY_KEY_ID.slice(1)}"}`;
		const text = JSON.stringify({ payload: inner });

		const redacted = redactContributionPrepText(text, process.cwd());
		const outer = JSON.parse(redacted) as { payload: string };
		const payload = JSON.parse(outer.payload) as { SessionToken: string; AccessKeyId: string };

		expect(payload).toEqual({
			SessionToken: "[REDACTED_SECRET]",
			AccessKeyId: "[REDACTED_AWS_KEY_ID]",
		});
		expect(redacted).not.toContain(SYNTHETIC_AWS_SESSION_TOKEN);
		expect(redacted).not.toContain(SYNTHETIC_AWS_TEMPORARY_KEY_ID.slice(1));
	});

	it("fails closed at nested JSON depth and size limits", () => {
		let deeplyNested = JSON.stringify({ SessionToken: SYNTHETIC_AWS_SESSION_TOKEN });
		for (let depth = 0; depth < 5; depth++) deeplyNested = JSON.stringify({ payload: deeplyNested });
		const oversized = JSON.stringify({
			payload: JSON.stringify({
				padding: "x".repeat(60001),
				SecretAccessKey: SYNTHETIC_AWS_SECRET_ACCESS_KEY,
			}),
		});

		const redactedDeep = redactContributionPrepText(deeplyNested, process.cwd());
		const redactedOversized = redactContributionPrepText(oversized, process.cwd());
		const oversizedPayload = JSON.parse(redactedOversized) as { payload: string };

		expect(JSON.parse(redactedDeep)).toBeDefined();
		expect(JSON.parse(oversizedPayload.payload)).toEqual({
			padding: "x".repeat(60001),
			SecretAccessKey: "[REDACTED_SECRET]",
		});
		expect(redactedDeep).toContain("[REDACTED_NESTED_CONTENT]");
		expect(redactedDeep).not.toContain(SYNTHETIC_AWS_SESSION_TOKEN);
		expect(redactedOversized).not.toContain(SYNTHETIC_AWS_SECRET_ACCESS_KEY);
	});

	it("redacts escaped AWS fields inside long prefixed and suffixed log strings", () => {
		const longLog = `${"x".repeat(60001)} prefix ${String.raw`{"\u0053ecretAccessKey":"${SYNTHETIC_AWS_SECRET_ACCESS_KEY}"}`} suffix`;
		const text = JSON.stringify([{ type: "text", text: longLog }]);

		const redacted = redactContributionPrepText(text, process.cwd());

		expect(JSON.parse(redacted)).toBeDefined();
		expect(redacted).not.toContain(SYNTHETIC_AWS_SECRET_ACCESS_KEY);
		expect(redacted).toContain("[REDACTED_SECRET]");
	});

	it("fails closed when redaction input or JSON token counts exceed their budgets", () => {
		const manyFields = `{${Array.from(
			{ length: 10001 },
			(_, index) => `"field${index}":"${SYNTHETIC_AWS_ACCESS_KEY_ID}"`,
		).join(",")}}`;
		const manyReplacements = JSON.stringify(
			Array.from({ length: 10001 }, (_, index) => `${SYNTHETIC_AWS_ACCESS_KEY_ID}-${index}`),
		);
		const ordered = JSON.stringify([SYNTHETIC_AWS_ACCESS_KEY_ID, SYNTHETIC_AWS_TEMPORARY_KEY_ID]);

		expect(redactContributionPrepText("x".repeat(1_000_001), process.cwd())).toBe("[REDACTED_OVERSIZED_CONTENT]");
		expect(redactContributionPrepText(manyFields, process.cwd())).toBe("[REDACTED_OVERSIZED_CONTENT]");
		expect(redactContributionPrepText(manyReplacements, process.cwd())).toBe("[REDACTED_OVERSIZED_CONTENT]");
		expect(JSON.parse(redactContributionPrepText(ordered, process.cwd()))).toEqual([
			"[REDACTED_AWS_KEY_ID]",
			"[REDACTED_AWS_KEY_ID]",
		]);
	});

	it("handles AWS credential boundaries, label case, separators, and whitespace", () => {
		const text = [
			`long-term (${SYNTHETIC_AWS_ACCESS_KEY_ID})`,
			`"secret_access_key" \t: \t"${SYNTHETIC_AWS_SECRET_ACCESS_KEY}"`,
			`'SESSION-TOKEN' = '${SYNTHETIC_AWS_SESSION_TOKEN}'`,
			`AWS_SECRET_ACCESS_KEY = ${SYNTHETIC_AWS_SECRET_ACCESS_KEY}`,
			`aws_session_token=${SYNTHETIC_AWS_SESSION_TOKEN}`,
			`SecretAccessKey=$'${SYNTHETIC_AWS_SECRET_ACCESS_KEY}'`,
			`SessionToken=$"${SYNTHETIC_AWS_SESSION_TOKEN}"`,
			`SecretAccessKey=\`${SYNTHETIC_AWS_SECRET_ACCESS_KEY}\``,
			`?SessionToken=${SYNTHETIC_AWS_SESSION_TOKEN}&status=active`,
			`?X-Amz-Security-Token=${encodeURIComponent(SYNTHETIC_AWS_SESSION_TOKEN)}&X-Amz-Expires=900`,
		].join("\n");

		const redacted = redactContributionPrepText(text, process.cwd());

		for (const secret of [
			SYNTHETIC_AWS_ACCESS_KEY_ID,
			SYNTHETIC_AWS_SECRET_ACCESS_KEY,
			SYNTHETIC_AWS_SESSION_TOKEN,
		]) {
			expect(redacted).not.toContain(secret);
		}
		expect(redacted).toContain(`"secret_access_key" \t: \t"[REDACTED_SECRET]"`);
		expect(redacted).toContain(`'SESSION-TOKEN' = '[REDACTED_SECRET]'`);
		expect(redacted).toContain("SecretAccessKey=$'[REDACTED_SECRET]'");
		expect(redacted).toContain('SessionToken=$"[REDACTED_SECRET]"');
		expect(redacted).toContain("SecretAccessKey=`[REDACTED_SECRET]`");
		expect(redacted).toContain("?SessionToken=[REDACTED_SECRET]&status=active");
		expect(redacted).toContain("?X-Amz-Security-Token=[REDACTED_SECRET]&X-Amz-Expires=900");
	});

	it("redacts quoted and mixed-quote X-Amz-Security-Token logs without changing near-misses", () => {
		const positives = [
			`"X-Amz-Security-Token"="${SYNTHETIC_AWS_SESSION_TOKEN}"`,
			`'X-Amz-Security-Token'='${SYNTHETIC_AWS_SESSION_TOKEN}'`,
			`"X-Amz-Security-Token": '${SYNTHETIC_AWS_SESSION_TOKEN}'`,
			`'X-Amz-Security-Token': "${SYNTHETIC_AWS_SESSION_TOKEN}"`,
			`header 'X-Amz-Security-Token: ${SYNTHETIC_AWS_SESSION_TOKEN}'`,
		];
		const nearMisses = [
			`"X-Amz-Security-Token-Id"="${SYNTHETIC_AWS_SESSION_TOKEN}"`,
			`"X-Amz-Security-Tokens"="${SYNTHETIC_AWS_SESSION_TOKEN}"`,
			`prefixX-Amz-Security-Token=${SYNTHETIC_AWS_SESSION_TOKEN}`,
			'"X-Amz-Security-Token"="short"',
		];

		expect(redactContributionPrepText([...positives, ...nearMisses].join("\n"), process.cwd())).toBe(
			[
				'"X-Amz-Security-Token"="[REDACTED_SECRET]"',
				"'X-Amz-Security-Token'='[REDACTED_SECRET]'",
				`"X-Amz-Security-Token": '[REDACTED_SECRET]'`,
				`'X-Amz-Security-Token': "[REDACTED_SECRET]"`,
				"header 'X-Amz-Security-Token: [REDACTED_SECRET]'",
				...nearMisses,
			].join("\n"),
		);
	});

	it("redacts canonical AWS XML fields without changing the document structure", () => {
		const text = `<Credentials><AccessKeyId>${SYNTHETIC_AWS_TEMPORARY_KEY_ID}</AccessKeyId><SecretAccessKey>${SYNTHETIC_AWS_SECRET_ACCESS_KEY}</SecretAccessKey><sts:SessionToken>${SYNTHETIC_AWS_SESSION_TOKEN}</sts:SessionToken></Credentials>`;

		const redacted = redactContributionPrepText(text, process.cwd());

		expect(redacted).toBe(
			"<Credentials><AccessKeyId>[REDACTED_AWS_KEY_ID]</AccessKeyId><SecretAccessKey>[REDACTED_SECRET]</SecretAccessKey><sts:SessionToken>[REDACTED_SECRET]</sts:SessionToken></Credentials>",
		);
	});

	it("redacts pretty-printed AWS XML whose value sits on its own line", () => {
		// A real STS response is usually pretty-printed, so the value is separated
		// from its tags by a newline and indentation. Matching only same-line bodies
		// let the complete credential through while the compact form was redacted.
		const text = [
			"<Credentials>",
			`  <AccessKeyId>${SYNTHETIC_AWS_TEMPORARY_KEY_ID}</AccessKeyId>`,
			"  <SecretAccessKey>",
			`    ${SYNTHETIC_AWS_SECRET_ACCESS_KEY}`,
			"  </SecretAccessKey>",
			"  <sts:SessionToken>",
			`    ${SYNTHETIC_AWS_SESSION_TOKEN}`,
			"  </sts:SessionToken>",
			"</Credentials>",
		].join("\n");

		const redacted = redactContributionPrepText(text, process.cwd());

		expect(redacted).not.toContain(SYNTHETIC_AWS_SECRET_ACCESS_KEY);
		expect(redacted).not.toContain(SYNTHETIC_AWS_SESSION_TOKEN);
		expect(redacted).not.toContain(SYNTHETIC_AWS_TEMPORARY_KEY_ID);
		// The element names survive, so the artifact still records the shape.
		expect(redacted).toContain("<SecretAccessKey>");
		expect(redacted).toContain("</sts:SessionToken>");
	});

	it("does not let a multiline XML match swallow a following element", () => {
		const text = [
			"<SecretAccessKey>",
			`  ${SYNTHETIC_AWS_SECRET_ACCESS_KEY}`,
			"</SecretAccessKey>",
			"<Region>us-east-1</Region>",
		].join("\n");

		const redacted = redactContributionPrepText(text, process.cwd());

		expect(redacted).not.toContain(SYNTHETIC_AWS_SECRET_ACCESS_KEY);
		expect(redacted).toContain("<Region>us-east-1</Region>");
	});

	it("redacts pretty-printed XML credentials beyond the historical 4096-character boundary", () => {
		const exactBoundary = `SYNTHETIC_SESSION_TOKEN_${"4".repeat(4072)}`;
		const overBoundary = `SYNTHETIC_SESSION_TOKEN_${"5".repeat(5000)}`;
		const text = [
			"<Credentials>",
			`<SessionToken>\n${exactBoundary}\n</SessionToken>`,
			`<sts:SessionToken>\n${overBoundary}\n</sts:SessionToken>`,
			"<Region>us-east-1</Region>",
			"</Credentials>",
		].join("\n");

		const redacted = redactContributionPrepText(text, process.cwd());

		expect(redacted).not.toContain(exactBoundary);
		expect(redacted).not.toContain(overBoundary);
		expect(redacted).toContain("<SessionToken>[REDACTED_SECRET]</SessionToken>");
		expect(redacted).toContain("<sts:SessionToken>[REDACTED_SECRET]</sts:SessionToken>");
		expect(redacted).toContain("<Region>us-east-1</Region>");
	});

	it("leaves an empty or whitespace-only XML credential element unchanged", () => {
		const text = ["<SecretAccessKey></SecretAccessKey>", "<sts:SessionToken>\n\n</sts:SessionToken>"].join("\n");

		expect(redactContributionPrepText(text, process.cwd())).toBe(text);
	});

	it("leaves AWS-like prose and key-id near-misses unchanged", () => {
		const text = [
			"ASIAN markets rose",
			"AKIRA is a film",
			"the session token expired",
			"rotate the secret access key tomorrow",
			`prefix${SYNTHETIC_AWS_ACCESS_KEY_ID}`,
			`${SYNTHETIC_AWS_ACCESS_KEY_ID}suffix`,
		].join("\n");

		expect(redactContributionPrepText(text, process.cwd())).toBe(text);
	});

	it("preserves delimiters and existing token redaction behavior around AWS fields", () => {
		const githubToken = "ghs_abcdefghijklmnopqrstuvwxyz123456";
		const slackToken = "xoxb-abcdefghijklmnopqrstuvwxyz123456";
		const benignAssignments = [
			"notSecretAccessKey=SYNTHETIC_PUBLIC_VALUE",
			"not-SecretAccessKey=SYNTHETIC_PUBLIC_VALUE",
			'"not-SecretAccessKey":"SYNTHETIC_PUBLIC_VALUE"',
		];
		const text = [
			`trace_${SYNTHETIC_AWS_ACCESS_KEY_ID}_suffix`,
			`invoke(SessionToken=${SYNTHETIC_AWS_SESSION_TOKEN});`,
			`SecretAccessKey=${githubToken}`,
			`SessionToken=${slackToken}`,
			...benignAssignments,
		].join("\n");

		const redacted = redactContributionPrepText(text, process.cwd());

		expect(redacted).toContain("trace_[REDACTED_AWS_KEY_ID]_suffix");
		expect(redacted).toContain("invoke(SessionToken=[REDACTED_SECRET]);");
		expect(redacted).toContain("SecretAccessKey=[REDACTED_SECRET]");
		expect(redacted).toContain("SessionToken=[REDACTED_SECRET]");
		expect(redacted).not.toContain("[REDACTED_SECRET]]");
		expect(redacted).not.toContain(githubToken);
		expect(redacted).not.toContain(slackToken);
		for (const benignAssignment of benignAssignments) expect(redacted).toContain(benignAssignment);
	});

	it("redacts a complete git diff before applying the presentation cutoff", async () => {
		const tempDir = TempDir.createSync("@gjc-contribution-prep-cutoff-");
		try {
			const trackedPath = path.join(tempDir.path(), "tracked.txt");
			await Bun.write(trackedPath, "baseline\n");
			await $`git init`.cwd(tempDir.path()).quiet();
			await $`git add tracked.txt`.cwd(tempDir.path()).quiet();
			await $`git -c user.email=test@example.com -c user.name=Test commit -m initial`.cwd(tempDir.path()).quiet();

			const cutoffSecret = `SYNTHETIC_CUTOFF_SESSION_TOKEN_${"6".repeat(4096)}`;
			await Bun.write(
				trackedPath,
				`${"x".repeat(59_000)}<SessionToken>${cutoffSecret}</SessionToken>${"y".repeat(5_000)}\n`,
			);
			const result = await prepareContributionPrep(
				{ sessionId: "source-session", cwd: tempDir.path(), messages: [] },
				{
					artifactRoot: path.join(tempDir.path(), "artifacts"),
					now: new Date("2026-05-31T00:00:00.000Z"),
				},
			);
			const manifest = JSON.parse(await Bun.file(result.manifestPath).text()) as {
				artifacts: Array<{ path: string }>;
				redactions: string[];
			};
			const diffPath = manifest.artifacts.find(artifact => artifact.path === "git-diff.patch")?.path;
			expect(diffPath).toBeTruthy();
			const gitDiff = await Bun.file(path.join(result.artifactDir, diffPath ?? "")).text();

			expect(gitDiff).toContain("<SessionToken>[REDACTED_SECRET]</SessionToken>");
			expect(gitDiff).toContain("[truncated ");
			expect(gitDiff).not.toContain(cutoffSecret.slice(0, 256));
			expect(manifest.redactions).toContain("aws_keys");
		} finally {
			tempDir.remove();
		}
	});

	it("fails closed when a git diff exceeds the raw capture budget", async () => {
		const tempDir = TempDir.createSync("@gjc-contribution-prep-oversized-diff-");
		try {
			const trackedPath = path.join(tempDir.path(), "tracked.txt");
			await Bun.write(trackedPath, "baseline\n");
			await $`git init`.cwd(tempDir.path()).quiet();
			await $`git add tracked.txt`.cwd(tempDir.path()).quiet();
			await $`git -c user.email=test@example.com -c user.name=Test commit -m initial`.cwd(tempDir.path()).quiet();

			await Bun.write(
				trackedPath,
				`<SessionToken>${SYNTHETIC_AWS_SESSION_TOKEN}</SessionToken>${"z".repeat(1_010_000)}\n`,
			);
			const result = await prepareContributionPrep(
				{ sessionId: "source-session", cwd: tempDir.path(), messages: [] },
				{
					artifactRoot: path.join(tempDir.path(), "artifacts"),
					now: new Date("2026-05-31T00:00:00.000Z"),
				},
			);
			const manifest = JSON.parse(await Bun.file(result.manifestPath).text()) as {
				artifacts: Array<{ path: string }>;
				redactions: string[];
			};
			const diffPath = manifest.artifacts.find(artifact => artifact.path === "git-diff.patch")?.path;
			expect(diffPath).toBeTruthy();
			const gitDiff = await Bun.file(path.join(result.artifactDir, diffPath ?? "")).text();

			expect(gitDiff).toBe("[REDACTED_OVERSIZED_CONTENT]\n");
			expect(gitDiff).not.toContain(SYNTHETIC_AWS_SESSION_TOKEN);
			expect(manifest.redactions).toContain("oversized_content");
		} finally {
			tempDir.remove();
		}
	});

	it("writes a manifest with redacted file-pointer artifacts", async () => {
		const tempDir = TempDir.createSync("@gjc-contribution-prep-");
		try {
			await Bun.write(path.join(tempDir.path(), "tracked.txt"), "changed");
			await $`git init`.cwd(tempDir.path()).quiet();
			await $`git add tracked.txt`.cwd(tempDir.path()).quiet();
			await $`git -c user.email=test@example.com -c user.name=Test commit -m initial`.cwd(tempDir.path()).quiet();
			const tokenFilename = "ghs_abcdefghijklmnopqrstuvwxyz123456.txt";
			const awsFilename = `aws-${SYNTHETIC_AWS_ACCESS_KEY_ID}.txt`;
			const transcriptToken = "ghu_abcdefghijklmnopqrstuvwxyz123456";
			const instructionsToken = "ghr_abcdefghijklmnopqrstuvwxyz123456";
			await Bun.write(
				path.join(tempDir.path(), "tracked.txt"),
				`changed ghs_abcdefghijklmnopqrstuvwxyz123456 github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz1234567890 ${SYNTHETIC_AWS_TEMPORARY_KEY_ID} SecretAccessKey=${SYNTHETIC_AWS_SECRET_ACCESS_KEY}\n`,
			);
			await Bun.write(path.join(tempDir.path(), tokenFilename), "untracked");
			await Bun.write(path.join(tempDir.path(), awsFilename), "untracked");
			const messages: AgentMessage[] = [
				{
					role: "user",
					content: JSON.stringify({
						log: `Failure uses Authorization: Bearer ghp_secretsecretsecret and SessionToken: ${SYNTHETIC_AWS_SESSION_TOKEN}`,
						payload: JSON.stringify({
							SecretAccessKey: SYNTHETIC_AWS_SECRET_ACCESS_KEY,
							"X-Amz-Security-Token": SYNTHETIC_AWS_SESSION_TOKEN,
						}),
					}),
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "synthetic-aws-log",
					toolName: "read",
					content: [
						{
							type: "text",
							text: `SecretAccessKey="${SYNTHETIC_AWS_SECRET_ACCESS_KEY}" X-Amz-Security-Token=${SYNTHETIC_AWS_SESSION_TOKEN}`,
						},
					],
					isError: false,
					timestamp: 3,
				},
				{
					role: "toolResult",
					toolCallId: "synthetic-long-aws-log",
					toolName: "read",
					content: [
						{
							type: "text",
							text: `${"x".repeat(60001)} prefix ${String.raw`{"\u0053ecretAccessKey":"${SYNTHETIC_AWS_SECRET_ACCESS_KEY}"}`} suffix`,
						},
					],
					isError: false,
					timestamp: 4,
				},
				{
					role: "assistant",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-test",
					timestamp: 2,
					content: [{ type: "text", text: `Check http://192.168.0.10:3000/private with ${transcriptToken}` }],
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
				},
			];

			const result = await prepareContributionPrep(
				{
					sessionId: `session-${SYNTHETIC_AWS_ACCESS_KEY_ID}`,
					cwd: tempDir.path(),
					messages,
					sessionFile: path.join(tempDir.path(), "session.jsonl"),
				},
				{
					artifactRoot: path.join(tempDir.path(), "artifacts"),
					customInstructions: `Include ${instructionsToken}; AWS_SECRET_ACCESS_KEY=${SYNTHETIC_AWS_SECRET_ACCESS_KEY}`,
					now: new Date("2026-05-31T00:00:00.000Z"),
				},
			);

			const manifest = JSON.parse(await Bun.file(result.manifestPath).text()) as {
				schema_version: number;
				source_session_id: string;
				artifacts: Array<{ path: string; description: string }>;
				redactions: string[];
				recommended_output: string[];
				worker_prompt_path: string;
				changed_files: string[];
				cwd: string;
			};
			const transcriptPath = manifest.artifacts.find(artifact => artifact.path.endsWith("transcript.md"))?.path;
			expect(manifest.schema_version).toBe(1);
			expect(manifest.source_session_id).toBe("session-[REDACTED_AWS_KEY_ID]");
			expect(manifest.worker_prompt_path).toBe("worker-prompt.md");
			expect(manifest.cwd).toBe(path.basename(tempDir.path()));
			expect(manifest.artifacts.every(artifact => !path.isAbsolute(artifact.path))).toBe(true);
			expect(manifest.recommended_output).toContain("uncertainty / remaining risks");
			expect(manifest.redactions).toContain("auth_headers");
			expect(manifest.redactions).toContain("aws_keys");
			expect(manifest.redactions).toContain("private_endpoints");
			expect(manifest.changed_files).toContain("[REDACTED_TOKEN].txt");
			expect(manifest.changed_files).toContain("aws-[REDACTED_AWS_KEY_ID].txt");
			expect(manifest.changed_files).not.toContain(tokenFilename);
			expect(manifest.changed_files).not.toContain(awsFilename);
			expect(transcriptPath).toBeTruthy();
			const transcript = await Bun.file(path.join(result.artifactDir, transcriptPath ?? "")).text();
			expect(transcript).toContain("[REDACTED_AUTH_HEADER]");
			expect(transcript).toContain("[REDACTED_PRIVATE_ENDPOINT]");
			expect(transcript).not.toContain(transcriptToken);
			expect(transcript).not.toContain(SYNTHETIC_AWS_SESSION_TOKEN);
			const summaryPath = manifest.artifacts.find(artifact => artifact.path.endsWith("summary.md"))?.path;
			expect(summaryPath).toBeTruthy();
			const summary = await Bun.file(path.join(result.artifactDir, summaryPath ?? "")).text();
			expect(summary).not.toContain(instructionsToken);
			expect(summary).not.toContain(SYNTHETIC_AWS_SECRET_ACCESS_KEY);
			const diffPath = manifest.artifacts.find(artifact => artifact.path.endsWith("git-diff.patch"))?.path;
			expect(diffPath).toBeTruthy();
			const gitDiff = await Bun.file(path.join(result.artifactDir, diffPath ?? "")).text();
			expect(gitDiff).toContain("[REDACTED_TOKEN]");
			expect(gitDiff).not.toContain("ghs_abcdefghijklmnopqrstuvwxyz123456");
			expect(gitDiff).not.toContain("github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz1234567890");
			expect(gitDiff).not.toContain(SYNTHETIC_AWS_TEMPORARY_KEY_ID);
			expect(gitDiff).not.toContain(SYNTHETIC_AWS_SECRET_ACCESS_KEY);
			const outboundPaths = [
				result.manifestPath,
				result.workerPromptPath,
				...manifest.artifacts.map(artifact => path.join(result.artifactDir, artifact.path)),
			];
			for (const outboundPath of outboundPaths) {
				const outboundText = await Bun.file(outboundPath).text();
				for (const secret of [
					SYNTHETIC_AWS_ACCESS_KEY_ID,
					SYNTHETIC_AWS_TEMPORARY_KEY_ID,
					SYNTHETIC_AWS_SECRET_ACCESS_KEY,
					SYNTHETIC_AWS_SESSION_TOKEN,
				]) {
					expect(outboundText).not.toContain(secret);
				}
				expect(outboundText).not.toContain(tempDir.path());
			}
		} finally {
			tempDir.remove();
		}
	});

	it("rejects credential-shaped artifact paths without echoing them", async () => {
		const tempDir = TempDir.createSync("@gjc-contribution-prep-path-");
		try {
			const artifactRoot = path.join(tempDir.path(), `unsafe-${SYNTHETIC_AWS_ACCESS_KEY_ID}`);
			let error: Error | undefined;
			try {
				await prepareContributionPrep(
					{ sessionId: "source-session", cwd: tempDir.path(), messages: [] },
					{ artifactRoot, now: new Date("2026-05-31T00:00:00.000Z") },
				);
			} catch (caught) {
				error = caught instanceof Error ? caught : new Error(String(caught));
			}

			expect(error?.message).toBe("Contribution prep artifact path contains credential-like material.");
			expect(error?.message).not.toContain(SYNTHETIC_AWS_ACCESS_KEY_ID);
		} finally {
			tempDir.remove();
		}
	});

	it("worker prompt references the manifest instead of inlining transcript", () => {
		const prompt = buildContributionPrepWorkerPrompt("/tmp/context/manifest.json");

		expect(prompt).toContain("Manifest: manifest.json");
		expect(prompt).not.toContain("/tmp/context");
		expect(prompt).toContain("file pointers");
		expect(prompt).toContain("Do not create GitHub issues");
	});

	it("can prepare a worker spawn without mutating source-session identity", async () => {
		const tempDir = TempDir.createSync("@gjc-contribution-prep-spawn-");
		try {
			const spawns: Array<{ args: string[]; cwd: string }> = [];
			const result = await prepareContributionPrep(
				{ sessionId: "source-session", cwd: tempDir.path(), messages: [] },
				{
					artifactRoot: path.join(tempDir.path(), "artifacts"),
					spawnWorker: true,
					spawn: async (args, cwd) => {
						spawns.push({ args, cwd });
					},
				},
			);
			const manifest = JSON.parse(await Bun.file(result.manifestPath).text()) as { source_session_id: string };

			expect(result.spawned).toBe(true);
			expect(spawns).toHaveLength(1);
			expect(spawns[0]?.args).toContain("@worker-prompt.md");
			expect(spawns[0]?.args).not.toContain(`@${result.workerPromptPath}`);
			expect(spawns[0]?.args).toContain("--no-skills");
			expect(spawns[0]?.args[0]).toBeTruthy();
			expect(spawns[0]?.cwd).toBe(result.artifactDir);
			expect(manifest.source_session_id).toBe("source-session");
		} finally {
			tempDir.remove();
		}
	});

	it("resolves worker spawn argv through the GJC command and prompt file", async () => {
		const tempDir = TempDir.createSync("@gjc-contribution-prep-real-spawn-");
		try {
			const child = Bun.spawn({
				cmd: [process.execPath, "--version"],
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await child.exited;
			expect(exitCode).toBe(0);

			let observed: string[] = [];
			await prepareContributionPrep(
				{ sessionId: "source-session", cwd: tempDir.path(), messages: [] },
				{
					artifactRoot: path.join(tempDir.path(), "artifacts"),
					spawnWorker: true,
					spawn: async args => {
						observed = args;
						const probe = Bun.spawn({
							cmd: [args[0] ?? process.execPath, "--version"],
							stdout: "pipe",
							stderr: "pipe",
						});
						expect(await probe.exited).toBe(0);
					},
				},
			);

			expect(observed).toContain("--no-skills");
			expect(observed.some(arg => arg.startsWith("@") && arg.endsWith("worker-prompt.md"))).toBe(true);
		} finally {
			tempDir.remove();
		}
	});

	it("advertises the issue-approved contribute-pr slash command with legacy alias", () => {
		const command = lookupBuiltinSlashCommand("contribute-pr");
		const legacy = lookupBuiltinSlashCommand("contribution-prep");

		expect(command?.name).toBe("contribute-pr");
		expect(legacy).toBe(command);
	});
});
