/**
 * Instruction builders for review sessions. Each webhook decision compiles to
 * ONE self-contained natural-language instruction executed by an embedded
 * agent session; the agent posts to GitHub itself (via the App-identity `gh`
 * wrapper) so reviews land as the bot with inline comments and verdicts.
 *
 * Hard-won prompt rules encoded here:
 * - shell redirects/heredocs/pipes are banned (the security guard blocks them
 *   mid-review); file payloads go through the write tool + `--input`/`--body-file`.
 * - completion runs through the idempotent complete helper, never a hand-rolled
 *   check-run PATCH.
 * - GraphQL author logins have NO `[bot]` suffix; REST logins DO.
 */
import type { RepoReviewConfig } from "./repo-config";

export interface InstructionContext {
	/** Command that runs `gh` with the App installation token (posting identity). */
	postCmd: string;
	/** Command that finishes a review run (check-run close, state release, drain). */
	completeCmd: string;
	/** Bot login without the `[bot]` suffix (GraphQL identity). */
	botLogin: string;
	/** Marker/tmp-file prefix, e.g. "gajae" → `<!-- gajae-summary -->`. */
	markerPrefix: string;
	/** Display name used in prose, e.g. "가재". */
	botDisplayName: string;
	/** First mention alias, e.g. "@gajae". */
	mention: string;
	/** Repos the bot must never act on (defense-in-depth inside chat turns). */
	ignoreRepos: string[];
}

export function summaryMarker(ctx: Pick<InstructionContext, "markerPrefix">): string {
	return `<!-- ${ctx.markerPrefix}-summary -->`;
}

export function prSummaryMarkers(ctx: Pick<InstructionContext, "markerPrefix">): { open: string; close: string } {
	return { open: `<!-- ${ctx.markerPrefix}-pr-summary -->`, close: `<!-- /${ctx.markerPrefix}-pr-summary -->` };
}

function ignoreClause(ctx: InstructionContext): string {
	if (ctx.ignoreRepos.length === 0) return "";
	return `다음 리포 관련이면 아무것도 하지 마라: ${ctx.ignoreRepos.join(", ")}.`;
}

export function helpText(ctx: InstructionContext): string {
	const m = ctx.mention;
	return (
		`🦞 **${ctx.botDisplayName} 명령어**\n` +
		`- \`${m} review\` — 지금 리뷰\n` +
		`- \`${m} summary\` — 요약(walkthrough) 갱신\n` +
		`- \`${m} fix <내용>\` — 수정을 committable suggestion 으로 제안\n` +
		`- \`${m} resolve\` — 봇 리뷰 스레드 정리\n` +
		`- \`${m} learn <규칙>\` — 프로젝트 규칙 학습(이후 리뷰 반영)\n` +
		`- \`${m} pause\` / \`${m} resume\` — 자동 리뷰 정지/재개\n` +
		`- \`${m} help\` — 도움말`
	);
}

function shellQuote(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Post ONE canned reply as the bot. 메시지를 명령에 인라인해서 애매함 제거. */
export function replyInstr(ctx: InstructionContext, repo: string, num: number, msg: string): string {
	const cmd = `${ctx.postCmd} pr comment ${num} --repo ${repo} --body ${shellQuote(msg)}`;
	return (
		"아래 gh 명령 **딱 하나만 그대로** 실행하고 즉시 종료해라. " +
		"판단·수정·추가 작업·되묻기 전부 금지. 그냥 이 명령만 실행:\n" +
		cmd
	);
}

/**
 * Upsert a marked walkthrough summary comment (+ conditional mermaid diagram,
 * + closing poem, + PR body summary block).
 */
export function summaryInstr(ctx: InstructionContext, repo: string, num: number, config?: RepoReviewConfig): string {
	const cfg = config ?? {};
	const marker = summaryMarker(ctx);
	const pb = prSummaryMarkers(ctx);
	const diagram =
		cfg.diagrams === false
			? ""
			: "변경이 흐름성(API 호출 체인·상태머신·이벤트 플로우)일 때만 mermaid 코드블록(```mermaid) 1개" +
				"(sequenceDiagram 또는 flowchart)를 표 아래 추가. **확신 없으면 생략**(틀린 다이어그램은 무보다 나쁨). ";
	const poem =
		cfg.poem === false
			? ""
			: "요약 맨 아래에 이번 변경 내용을 소재로 한 짧은 시 한 편(4~6줄, 한국어, 각 줄 끝 쉼표/느낌표 리듬, " +
				"라임보다 위트 우선)을 추가 — 형식: 🦞 이모지로 시작하는 인용 블록(각 줄 '> '), " +
				"마지막 줄에 어울리는 이모지 1~2개. 파일명·기능명을 자연스럽게 녹여라. ";
	const bodyStep =
		cfg.pr_summary === false
			? ""
			: `5) PR **본문**에도 요약 반영: B=$(gh pr view ${num} --repo ${repo} --json body --jq .body) 로 현재 본문 확보 → ` +
				`'${pb.open}' 마커 블록이 있으면 그 블록만 교체, 없으면 본문 **끝에** 추가` +
				`(작성자 원문은 절대 수정 금지. 블록 형식: 마커 줄 + '## 🦞 요약' + 2~4문장 + 마커 닫는 줄 '${pb.close}'). ` +
				`→ file 도구로 /tmp/${ctx.markerPrefix}-prbody-${num}.md 에 새 본문 전체 저장 후 ` +
				`${ctx.postCmd} api --method PATCH repos/${repo}/pulls/${num} -F body=@/tmp/${ctx.markerPrefix}-prbody-${num}.md\n`;
	return (
		`${repo} PR #${num} 의 walkthrough 요약을 upsert(있으면 갱신, 없으면 생성)한다. ` +
		"**shell 리다이렉트/heredoc/파이프(`>`,`<<`,`|`) 금지**(보안가드에 막힘):\n" +
		`1) gh pr diff ${num} --repo ${repo} 로 변경 파악.\n` +
		`2) 요약 본문(첫 줄 마커 '${marker}' 필수): ## 🦞 Walkthrough + 1~2문장 목적 + 파일별 표. ` +
		diagram +
		poem +
		`→ **file 도구로** /tmp/${ctx.markerPrefix}-summary-${num}.md 에 저장(terminal 아님).\n` +
		`3) 기존 요약 CID 찾기: CID=$(gh api repos/${repo}/issues/${num}/comments --jq 'map(select(.user.login=="${ctx.botLogin}[bot]" and (.body|contains("${marker}"))))[0].id // empty')\n` +
		`4) CID 있으면 갱신: ${ctx.postCmd} api --method PATCH repos/${repo}/issues/comments/$CID -F body=@/tmp/${ctx.markerPrefix}-summary-${num}.md\n` +
		`   없으면 생성:   ${ctx.postCmd} pr comment ${num} --repo ${repo} --body-file /tmp/${ctx.markerPrefix}-summary-${num}.md\n` +
		bodyStep
	);
}

const NOISE_RULES =
	"노이즈 규칙: 인라인 comments는 확신 높은 것만 최대 8개, nit·사소한 스타일은 comments에 넣지 말고 " +
	"body 끝 '<details><summary>Nitpicks</summary>' 접힘 블록으로. 수정 제안이 명확하면 그 comment body에 " +
	"committable suggestion(코드펜스 ```suggestion 열고 다음 줄 고친 코드 ``` 닫기, 해당 라인 정확 매핑 시).";

const REVIEW_JSON =
	'{"commit_id":"<COMMIT>","event":"COMMENT|REQUEST_CHANGES|APPROVE",' +
	'"body":"<한국어 요약>","comments":[{"path":"<file>","line":<diff 우측 new 라인>,' +
	'"side":"RIGHT","body":"<지적>"}]}';

/**
 * Final step: the single idempotent completion call (check-run close, state
 * release, pending/queued drain). Owned by code, not the LLM.
 */
export function closeLineFor(ctx: InstructionContext, repo: string, num: number, sha: string): string {
	const note = sha === "$SHA" ? " ($SHA 는 0)에서 확보한 값 리터럴로 치환)" : "";
	return (
		"마지막) **반드시**(리뷰 게시 성공/실패 무관) 완료 헬퍼 실행(terminal, 멱등):\n" +
		`   ${ctx.completeCmd} ${repo} ${num} ${sha} success${note}\n` +
		"   게시에 실패했으면 success 대신 failure. 체크런 닫기·상태 해제·대기 리뷰 재개를 " +
		"이 명령 하나가 다 처리한다. check-runs 를 손으로 PATCH 하지 마라.\n"
	);
}

export interface BuildReviewOptions {
	closeLine?: string;
	force?: boolean;
	incremental?: boolean;
	baseSha?: string;
	config?: RepoReviewConfig;
	learnings?: string;
}

/**
 * Deep review instruction (direct execution). incremental → only commits after
 * `baseSha` (push re-review). headSha="$SHA" → the agent resolves it.
 */
export function buildReview(
	ctx: InstructionContext,
	repo: string,
	num: number,
	headSha: string,
	options: BuildReviewOptions = {},
): string {
	const { closeLine = "", force = false, incremental = false, baseSha, learnings = "" } = options;
	const cfg = options.config ?? {};
	const jsonTemplate = REVIEW_JSON.replace("<COMMIT>", headSha);
	const fetch =
		headSha === "$SHA"
			? `0) head sha 확보: SHA=$(gh pr view ${num} --repo ${repo} --json headRefOid --jq .headRefOid) — JSON의 commit_id에 이 값(리터럴)을 넣어라.\n`
			: "";
	const inc = incremental && !!baseSha;
	const diffCmd = inc ? `gh api repos/${repo}/compare/${baseSha}...${headSha}` : `gh pr diff ${num} --repo ${repo}`;
	const scope = inc
		? `증분 리뷰: 지난 리뷰(${(baseSha as string).slice(0, 7)}) 이후 **새 커밋만** 본다. ` +
			"이미 지적했거나 안 바뀐 코드는 재지적 금지, 새로 생긴 이슈만."
		: "PR 전체를 리뷰한다.";
	const dedup =
		force || inc
			? ""
			: "1) 중복 방지: " +
				`gh api repos/${repo}/pulls/${num}/reviews --jq '[.[]|select(.user.login=="${ctx.botLogin}[bot]")]|length' ` +
				"→ 0이 아니면 아무것도 하지 말고 종료.\n";
	const core =
		`2) 리뷰를 **직접 수행**한다 (read-only, 로컬 파일 수정 금지, 리포 clone 금지). ${scope} ` +
		`${diffCmd} + 관련 파일로 아키텍처/버그/보안/회귀 점검. ` +
		`시크릿 스캔: diff를 **file 쓰기 도구로** /tmp/${ctx.markerPrefix}-diff-scan-${num}.txt 에 저장해 ` +
		`gitleaks detect --no-git --source /tmp/${ctx.markerPrefix}-diff-scan-${num}.txt 실행, ` +
		"발견 시 해당 라인을 인라인 지적 **최우선**으로 포함. " +
		`CI 컨텍스트: gh api repos/${repo}/commits/${headSha}/check-runs ` +
		`--jq '[.check_runs[]|select(.conclusion=="failure")|{name,summary:.output.summary}]' 로 ` +
		"실패 체크를 확인해 관련 원인 코드에 집중하되, CI 린터가 이미 잡은 항목은 재지적 금지. " +
		`리뷰 결과는 설명 없이 JSON 하나로 정리한다(게시는 3에서): ${jsonTemplate}. ` +
		`라인 앵커 불확실하면 comments에서 빼라. ${NOISE_RULES}\n`;
	let extras = "";
	if (learnings) extras += `이 리포 학습된 규칙(반드시 반영, 아래에 어긋나면 지적 말 것):\n${learnings}\n`;
	if (cfg.ignore_paths?.length) extras += `제외 경로(리뷰/코멘트 하지 마): ${cfg.ignore_paths.join(", ")}\n`;
	if (cfg.max_comments) extras += `인라인 코멘트는 최대 ${cfg.max_comments}개로 제한.\n`;
	if (cfg.tone) extras += `톤: ${cfg.tone}\n`;
	for (const pi of cfg.path_instructions ?? []) {
		if (pi?.path && pi.instructions) {
			extras += `경로별 지침 — \`${pi.path}\` 에 해당하는 파일: ${pi.instructions}\n`;
		}
	}
	const post =
		"3) 리뷰 JSON을 App 명의로 게시. **shell 리다이렉트/heredoc/파이프(`>`, `<<`, `|`, cat, echo) 전부 금지**" +
		"(보안 가드가 승인 대기로 막아 리뷰가 실패한다). 반드시 이 2단계로:\n" +
		`   ① **file 쓰기 도구(write)로** JSON을 /tmp/${ctx.markerPrefix}-review-${num}.json 에 저장 ` +
		"(terminal 아님! file 도구로 직접 write).\n" +
		`   ② terminal로 게시: ${ctx.postCmd} api --method POST repos/${repo}/pulls/${num}/reviews ` +
		`--input /tmp/${ctx.markerPrefix}-review-${num}.json\n` +
		"   JSON 깨졌으면 comments 빼고 body만이라도 반드시 게시.\n";
	const outdated = !inc
		? ""
		: "4.5) **해소된 이전 지적 정리**: 이번 diff 에서 변경/삭제된 라인의 봇 스레드만 GraphQL 로 resolve" +
			`(reviewThreads 조회 → isResolved=false + 작성자 login == "${ctx.botLogin}" ` +
			`(**GraphQL 은 \`[bot]\` 접미사가 없다** — "${ctx.botLogin}[bot]" 으로 비교하면 전부 미스난다) ` +
			"+ **해당 파일·라인이 이번 push 로 바뀐 것만** resolveReviewThread — 뮤테이션은 **반드시 일반 gh**(사용자 토큰)로, " +
			"App 토큰은 FORBIDDEN 난다). 애매하면 건드리지 마라.\n";
	const summary = `4) 게시 후 walkthrough 요약 upsert:\n${summaryInstr(ctx, repo, num, cfg)}`;
	return (
		`GitHub ${repo} PR #${num} 자동 코드리뷰 (head ${headSha}, ${inc ? "증분" : "전체"}). ` +
		"게시는 terminal로 직접, aside 금지. 인사말 없이 한국어로.\n" +
		"⚠️ 리포를 clone 하지 마라. `git clone`·`rm`·로컬 git 조작·파일 리다이렉트(`>`) 전부 금지" +
		"(보안 가드에 막혀 리뷰가 실패한다). 변경은 오직 `gh pr diff` / `gh api .../compare` 로만 본다.\n" +
		`${extras}\n${fetch}${dedup}${core}${post}${summary}${outdated}${closeLine}`
	);
}

/** Force a review from a command. sha="$SHA" → agent resolves it (fail-open). */
export function forceReviewInstr(ctx: InstructionContext, repo: string, num: number, sha = "$SHA"): string {
	return `지금 강제 리뷰한다(기존 봇 리뷰 있어도 무시).\n${buildReview(ctx, repo, num, sha, {
		closeLine: closeLineFor(ctx, repo, num, sha),
		force: true,
	})}`;
}

/** `<mention> fix` — 코드를 push/commit 하지 않고 committable suggestion 으로만 제안(안전). */
export function fixInstr(ctx: InstructionContext, repo: string, num: number, args: string): string {
	return (
		`'${ctx.mention} fix' 요청: "${args}". **절대 push/commit/브랜치 수정 금지 — suggestion 으로만** 처리(terminal):\n` +
		`0) SHA=$(gh pr view ${num} --repo ${repo} --json headRefOid --jq .headRefOid)\n` +
		`1) gh pr diff ${num} --repo ${repo} 로 코드 확인(read-only — 로컬 수정·게시 금지).\n` +
		"2) 수정을 committable suggestion 으로 게시(작성자 1클릭 커밋): " +
		`${ctx.postCmd} api --method POST repos/${repo}/pulls/${num}/reviews 로 ` +
		"event=COMMENT, commit_id=$SHA, comments 각 body 에 ```suggestion 블록(해당 라인). " +
		"suggestion 으로 표현 안 되면 코멘트로 설명+코드블록.\n" +
		`${ignoreClause(ctx)} 인사말 없이 한국어로.`
	);
}

/** `<mention> resolve` — 봇의 unresolved 리뷰 스레드를 GraphQL 로 정리. */
export function resolveInstr(ctx: InstructionContext, repo: string, num: number): string {
	const [owner, name] = repo.split("/");
	return (
		`이 PR #${num}의 ${ctx.botLogin}[bot] 리뷰 스레드를 정리(resolve)한다. terminal, GraphQL 로:\n` +
		`1) reviewThreads 조회: gh api graphql -f query='{ repository(owner:"${owner}",name:"${name}"){ pullRequest(number:${num})` +
		"{ reviewThreads(first:100){ nodes{ id isResolved comments(first:1){nodes{author{login}}} } } } } }'\n" +
		`2) isResolved=false 이고 첫 코멘트 author.login 이 "${ctx.botLogin}" 인 thread 마다` +
		`(**GraphQL 은 \`[bot]\` 접미사 없음** — "${ctx.botLogin}[bot]" 비교는 전부 미스): ` +
		"gh api graphql -f query='mutation{ resolveReviewThread(input:{threadId:\"<ID>\"}){ thread{ id } } }'\n" +
		`3) 끝나면 '${ctx.botDisplayName} 리뷰 스레드 정리 완료' 코멘트 한 개(이건 ${ctx.postCmd}). ` +
		`뮤테이션은 **반드시 일반 gh**(사용자 토큰) — App 토큰은 FORBIDDEN. ${ignoreClause(ctx)}`
	);
}

/** Inline diff-thread reply (pull_request_review_comment mentioning the bot). */
export function reviewThreadReplyInstr(
	ctx: InstructionContext,
	repo: string,
	num: number,
	comment: { id: number; login: string; path?: string; line?: number | null; diffHunk?: string; body: string },
): string {
	return (
		`GitHub ${repo} PR #${num} 의 diff 라인 인라인 코멘트에서 ${comment.login} 가 ${ctx.botDisplayName}(너)를 불렀다.\n` +
		`파일 ${comment.path} 라인 ${comment.line} 근처:\n` +
		`diff hunk:\n${comment.diffHunk}\n` +
		`코멘트:\n---\n${comment.body}\n---\n\n` +
		"이 줄에 대한 질문에 한국어 반말로 정확히 답한다. 코드 판단이 필요하면 " +
		"질문에 답하는 데 필요한 **최소 범위**(해당 파일+직접 의존 1~3개)만 gh 로 확인, 전체 PR 재검증 금지.\n" +
		"답은 반드시 같은 스레드에, App 명의로 단다:\n" +
		`  ${ctx.postCmd} api --method POST repos/${repo}/pulls/${num}/comments/${comment.id}/replies -f body='<답>'\n` +
		ignoreClause(ctx)
	);
}

/** PR conversation chat (issue_comment mentioning the bot, no command). */
export function chatInstr(
	ctx: InstructionContext,
	repo: string,
	num: number,
	title: string,
	login: string,
	body: string,
): string {
	return (
		`GitHub ${repo} PR #${num} "${title}" 코멘트에서 ${login} 가 ${ctx.botDisplayName}(너)를 불렀다:\n` +
		`---\n${body}\n---\n\n` +
		"한국어 반말로 답한다. 코드/저장소 작업이 필요하면 직접 수행" +
		"(조회는 gh, 리포 clone·로컬 수정 금지)하고 결과를 요약, 단순 질문·대화면 바로 답. 핵심만.\n" +
		"답은 이 PR에 App 명의로 코멘트한다:\n" +
		`  ${ctx.postCmd} pr comment ${num} --repo ${repo} --body '<답>'\n` +
		ignoreClause(ctx)
	);
}
