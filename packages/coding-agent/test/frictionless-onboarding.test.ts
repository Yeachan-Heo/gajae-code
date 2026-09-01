import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getFrictionlessOnboardingCopy } from "../src/modes/components/frictionless-onboarding-selector";
import {
	analyzeOnboardingEvidence,
	createManualOnboardingProfile,
	deriveOnboardingProfile,
	detectOnboardingLanguage,
	discoverOnboardingRootPresence,
	hasCorroboratedRecentEvidence,
	NINETY_DAYS,
	projectOnboardingState,
	readOnboardingState,
	shouldCountOnboardingDirectoryFailure,
	shouldOfferAutomaticOnboarding,
	shouldPersistCompletion,
	writeOnboardingState,
} from "../src/setup/frictionless-onboarding";
import { executeBuiltinSlashCommand, lookupBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";

describe("frictionless onboarding", () => {
	test("projects only validated state fields", () => {
		const state = projectOnboardingState({
			version: 99,
			decision: "bad",
			roots: ["/private"],
			profile: {
				language: "en",
				sources: ["codex"],
				workflow: [],
				migrationMap: [],
				omissions: [],
				evidenceCount: 1,
				messages: ["secret"],
			},
		});
		expect(state.decision).toBeUndefined();
		expect(state.profile).toBeDefined();
		expect(JSON.stringify(state)).not.toContain("secret");
	});

	test("writes readable state and survives malformed input", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-onboarding-"));
		expect(
			await writeOnboardingState(
				{
					version: 1,
					decision: "completed",
					profile: {
						language: "en",
						sources: [],
						workflow: [],
						migrationMap: [],
						omissions: [],
						evidenceCount: 0,
					},
				},
				dir,
			),
		).toBe(true);
		expect((await readOnboardingState(dir)).decision).toBe("completed");
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("requires two providers and two signal families", () => {
		const now = 1_000_000;
		const evidence = [
			{ provider: "codex", activityAt: now, signals: ["agent-root", "installed-cli"] },
			{ provider: "claude", activityAt: now, signals: ["agent-root"] },
		];
		expect(hasCorroboratedRecentEvidence(evidence, now)).toBe(true);
		expect(hasCorroboratedRecentEvidence([evidence[0]], now)).toBe(false);
		expect(
			hasCorroboratedRecentEvidence(
				evidence.map(item => ({ ...item, activityAt: now - NINETY_DAYS - 1 })),
				now,
			),
		).toBe(false);
		expect(
			hasCorroboratedRecentEvidence(
				evidence.map(item => ({ ...item, activityAt: now + 1 })),
				now,
			),
		).toBe(false);
		expect(
			hasCorroboratedRecentEvidence(
				evidence.map(item => ({ ...item, signals: ["agent-root"] })),
				now,
			),
		).toBe(false);
	});

	test("language prefers dominant messages then locale", () => {
		expect(detectOnboardingLanguage(["파일 변경을 도와주세요", "파일을 변경해주세요"], "en-US")).toBe("ko");
		expect(detectOnboardingLanguage([], "fr-FR")).toBe("fr");
	});

	test("English messages are not misread as a Latin language sharing short function words", () => {
		const englishMessages = [
			"please handle the class in this file",
			"change the parser and help me later",
			"display the table, then modify the module",
		];
		expect(detectOnboardingLanguage(englishMessages, "ko-KR")).toBe("en");
		// A single weak match is not evidence; the locale still decides.
		expect(detectOnboardingLanguage(["fix the crash"], "ko-KR")).toBe("ko");
	});

	test("word evidence needs a clear leader, otherwise the OS locale decides", () => {
		// `la` belongs to both es and fr word lists: a tie must not pick a winner.
		expect(detectOnboardingLanguage(["la la"], "de-DE")).toBe("de");
		expect(detectOnboardingLanguage(["le fichier"], "en-US")).toBe("fr");
	});

	test("CJK scripts are detected by script, not by particle substrings", () => {
		expect(detectOnboardingLanguage(["ファイルを変更してください"], "en-US")).toBe("ja");
		expect(detectOnboardingLanguage(["请修改文件"], "en-US")).toBe("zh");
		expect(detectOnboardingLanguage(["파일 변경해줘"], "en-US")).toBe("ko");
	});
	test("script counts compete with word hits instead of winning unconditionally", () => {
		const englishWithQuotedKorean = [
			"please handle the class in this file",
			"change the parser and help me later",
			"display the table, then modify the module",
			"label: 한국어",
		];
		expect(detectOnboardingLanguage(englishWithQuotedKorean, "fr-FR")).toBe("en");
		expect(detectOnboardingLanguage(["please change the file 文件"], "ko-KR")).toBe("en");
		// Two Hangul syllables beat a single English article; equal scores fall back to locale.
		expect(detectOnboardingLanguage(["the 한글"], "fr-FR")).toBe("ko");
		expect(detectOnboardingLanguage(["the and 한글"], "fr-FR")).toBe("fr");
	});
	test("a stray Hangul glyph does not erase dominant Han evidence", () => {
		// One sub-threshold Hangul glyph is noise, not a Korean claim on the text;
		// an equal lone Hangul/kana pair is equally inconclusive.
		expect(detectOnboardingLanguage(["한文件文件文件 please change"], "en-US")).toBe("zh");
		expect(detectOnboardingLanguage(["한文件文件文件"], "en-US")).toBe("zh");
		expect(detectOnboardingLanguage(["한か漢漢漢漢"], "en-US")).toBe("zh");
		// A lone kana still claims mixed kanji as Japanese; kana over Hangul wins
		// outright, including the asymmetric boundary below the minimum.
		expect(detectOnboardingLanguage(["漢字か"], "zh-CN")).toBe("ja");
		expect(detectOnboardingLanguage(["かな漢한"], "ko-KR")).toBe("ja");
		expect(detectOnboardingLanguage(["かか漢漢漢漢"], "en-US")).toBe("ja");
		// And a Hangul count that reaches the minimum claims the mixed text.
		expect(detectOnboardingLanguage(["한한文件文件文件"], "en-US")).toBe("ko");
	});

	test("an explicit language preference outranks messages and locale", () => {
		expect(detectOnboardingLanguage(["le fichier merci"], "fr-FR", "ko")).toBe("ko");
		expect(detectOnboardingLanguage(["파일 변경해줘"], "ko-KR", "ja")).toBe("ja");
		expect(
			deriveOnboardingProfile(
				[
					{
						provider: "codex",
						activityAt: 1000,
						signals: ["supported-session"],
						sessionCount: 1,
						userMessages: ["le fichier merci modifier"],
					},
				],
				{ now: 1000, osLocale: "fr-FR", preferredLanguage: "ko" },
			).language,
		).toBe("ko");
		// An unsupported preference is ignored rather than silently accepted.
		expect(detectOnboardingLanguage([], "fr-FR", "xx")).toBe("fr");
	});

	test("profile derivation accepts injected time", () => {
		const profile = deriveOnboardingProfile(
			[
				{ provider: "codex", activityAt: 1000, signals: ["supported-session"], sessionCount: 1 },
				{ provider: "claude", activityAt: 1000, signals: ["supported-session"], sessionCount: 1 },
			],
			{ now: 1000, osLocale: "en-US" },
		);
		expect(profile.sources).toEqual(["codex", "claude"]);
	});

	test("uses one safely parsed supported session without fallback corroboration", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-onboarding-session-"));
		const sessions = path.join(home, ".codex", "sessions", "2026");
		await fs.mkdir(sessions, { recursive: true });
		const transcript = [
			JSON.stringify({
				timestamp: "2026-08-22T10:00:00.000Z",
				type: "session_meta",
				payload: { id: "session-1", cwd: home, timestamp: "2026-08-22T10:00:00.000Z" },
			}),
			JSON.stringify({
				timestamp: "2026-08-22T10:00:30.000Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Please fix this bug and add tests" }],
				},
			}),
			JSON.stringify({
				timestamp: "2026-08-22T10:01:00.000Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "파일 변경을 도와주세요" }],
				},
			}),
		].join("\n");
		await Bun.write(path.join(sessions, "session-1.jsonl"), `${transcript}\n`);
		await Bun.write(path.join(sessions, "malformed.jsonl"), "not-json\n");
		const presence = await discoverOnboardingRootPresence({ home });
		const evidence = await analyzeOnboardingEvidence(presence, { now: Date.parse("2026-08-23T00:00:00.000Z") });
		const codex = evidence.find(item => item.provider === "codex");
		expect(codex).toMatchObject({
			signals: ["supported-session"],
			sessionCount: 1,
			omittedSessions: 1,
			workflowCategories: ["testing", "debugging"],
		});
		const profile = deriveOnboardingProfile(evidence, {
			now: Date.parse("2026-08-23T00:00:00.000Z"),
			osLocale: "en-US",
		});
		expect(profile.sources).toEqual(["codex"]);
		expect(profile.language).toBe("ko");
		expect(profile.workflow).toEqual(["테스트 및 검증", "디버깅 및 수정"]);
		expect(profile.omissions.some(item => item.includes("1 세션 파일을 안전하게 제외함"))).toBe(true);
		await fs.rm(home, { recursive: true, force: true });
	});

	test("startup gate excludes input, images, and resume", () => {
		expect(
			shouldOfferAutomaticOnboarding({
				normalInteractive: true,
				initialMessage: undefined,
				initialMessages: [],
				resumeAction: undefined,
			}),
		).toBe(true);
		expect(
			shouldOfferAutomaticOnboarding({
				normalInteractive: true,
				initialMessage: "hi",
				initialMessages: [],
				resumeAction: undefined,
			}),
		).toBe(false);
		expect(
			shouldOfferAutomaticOnboarding({
				normalInteractive: true,
				automation: true,
				initialMessages: [],
				resumeAction: undefined,
			}),
		).toBe(false);
		expect(
			shouldOfferAutomaticOnboarding({
				normalInteractive: true,
				initialMessage: undefined,
				initialMessages: [],
				initialImages: [{}],
				resumeAction: undefined,
			}),
		).toBe(false);
	});

	test("rejects oversized persisted arrays", () => {
		const state = projectOnboardingState({
			version: 1,
			decision: "completed",
			profile: {
				language: "en",
				sources: Array.from({ length: 17 }, (_, index) => `source-${index}`),
				workflow: [],
				migrationMap: [],
				omissions: [],
				evidenceCount: 17,
			},
		});
		expect(state.profile).toBeUndefined();
	});

	test("rejects symlinked roots and marks unsupported real roots", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-onboarding-home-"));
		const external = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-onboarding-external-"));
		await fs.symlink(external, path.join(home, ".codex"));
		await fs.mkdir(path.join(home, ".claude"));
		await fs.mkdir(path.join(home, ".opencode"));
		const presence = await discoverOnboardingRootPresence({ home });
		expect(presence.find(item => item.provider === "codex")?.present).toBe(false);
		expect(presence.find(item => item.provider === "claude")).toMatchObject({ present: true, unsupported: false });
		expect(presence.find(item => item.provider === "opencode")).toMatchObject({ present: true, unsupported: true });
		await fs.rm(home, { recursive: true, force: true });
		await fs.rm(external, { recursive: true, force: true });
	});

	test("rejects a provider root replaced after disclosure", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-onboarding-root-swap-"));
		const original = path.join(home, ".codex");
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-onboarding-root-outside-"));
		await fs.mkdir(original);
		const presence = await discoverOnboardingRootPresence({ home });
		await fs.rename(original, path.join(home, ".codex-original"));
		await fs.symlink(outside, original);
		const evidence = await analyzeOnboardingEvidence(presence);
		expect(evidence.find(item => item.provider === "codex")?.signals).toEqual(["unavailable"]);
		await fs.rm(home, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	});

	test("treats depth-zero EACCES as unavailable instead of metadata fallback", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-onboarding-eacces-"));
		const sessions = path.join(home, ".codex", "sessions");
		await fs.mkdir(sessions, { recursive: true });
		const presence = await discoverOnboardingRootPresence({ home });
		const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
		const evidence = await analyzeOnboardingEvidence(presence, {
			openDirectory: async directoryPath => {
				if (path.resolve(directoryPath.toString()) === path.resolve(sessions)) throw permissionError;
				return fs.opendir(directoryPath);
			},
		});
		expect(shouldCountOnboardingDirectoryFailure(permissionError, 0)).toBe(true);
		expect(shouldCountOnboardingDirectoryFailure(Object.assign(new Error(), { code: "ENOENT" }), 0)).toBe(false);
		expect(evidence.find(item => item.provider === "codex")).toMatchObject({
			signals: ["unavailable"],
			omittedSessions: 1,
		});
		await fs.rm(home, { recursive: true, force: true });
	});

	test("falls back to English and presents a direct privacy-bounded question", () => {
		expect(detectOnboardingLanguage([], "xx-YY")).toBe("en");
		const copy = getFrictionlessOnboardingCopy("xx");
		expect(copy.title).toBe("Frictionless onboarding");
		expect(copy.manual.endsWith("?")).toBe(true);
		expect(copy.disclosure).toContain("only the derived profile and completion state are retained");
	});

	test("renders onboarding guidance for every supported interface language", () => {
		expect(getFrictionlessOnboardingCopy("en").title).toBe("Frictionless onboarding");
		expect(getFrictionlessOnboardingCopy("ko").title).toBe("간편 온보딩");
		expect(getFrictionlessOnboardingCopy("zh").title).toBe("轻松入门");
		expect(getFrictionlessOnboardingCopy("ja").title).toBe("簡単オンボーディング");
	});

	test("builds each manual answer as previewable command guidance", () => {
		expect(createManualOnboardingProfile("en", "migration")).toMatchObject({
			workflow: ["Map my existing workflow to GJC"],
			operations: ["learn-commands"],
		});
		expect(createManualOnboardingProfile("en", "commands").operations).toEqual(["learn-commands"]);
	});

	test("requires a selected operation and confirmation before completion", () => {
		expect(shouldPersistCompletion(undefined, true)).toBe(false);
		expect(shouldPersistCompletion("learn-commands", false)).toBe(false);
		expect(shouldPersistCompletion("learn-commands", true)).toBe(true);
	});

	test("fails soft when the onboarding state path is unwritable", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-onboarding-write-failure-"));
		await Bun.write(path.join(root, "onboarding"), "not a directory");
		expect(await writeOnboardingState({ version: 1, decision: "skipped" }, root)).toBe(false);
		await fs.rm(root, { recursive: true, force: true });
	});

	test("tutorial is registered and dispatches", async () => {
		expect(lookupBuiltinSlashCommand("tutorial")?.name).toBe("tutorial");
		let shown = false;
		const ctx = {
			editor: { setText: () => undefined },
			showFrictionlessOnboarding: async () => {
				shown = true;
			},
		} as never;
		await executeBuiltinSlashCommand("/tutorial", { ctx } as never);
		expect(shown).toBe(true);
	});
});
