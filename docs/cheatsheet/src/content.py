"""치트시트 본문 — 1:3 세로형, 주제별 그룹. 한글판/영문판 공용."""
import sheet as S
from sheet import (Page, Group, Section, code, line, desc, kv, gap, rule, img,
                   ORANGE, AMBER, CORAL, INK, GREY, MAROON,
                   FONT_MONO, FONT_SANS, FONT_SANS_EN, S_CODE, S_DESC)

# 한글 설명문 중 가장 긴 줄이 들어가는 폭. 넓힐수록 글자가 상대적으로 작아진다.
PAGE_W = 9.60

# 워크플로 다이어그램 최대 높이(절대 인치). A4 판에선 줄인다.
DIAGRAM_MAX = 8.4

# src/ 와 assets/ 가 형제 디렉토리라는 전제. 어디서 돌려도 안정적이다.
from pathlib import Path as _Path

_HERE = _Path(__file__).resolve().parent
ASSETS = str(_HERE.parent / "assets")

def _asset(name):
    """에셋 경로를 푼다.

    1) 이 폴더의 assets/ — 로컬 작업본
    2) 저장소 루트의 assets/ — docs/cheatsheet 로 배포됐을 때.
       character.png·logo-vertical.png 는 루트에 이미 있으므로
       중복 사본을 두지 않는다.
    """
    for base in (_HERE.parent / "assets", _HERE.parents[2] / "assets"):
        p = base / name
        if p.exists():
            return str(p)
    raise FileNotFoundError(f"에셋을 찾을 수 없다: {name}")

REPO = "github.com/Yeachan-Heo/gajae-code"

LANG = "ko"


def t(ko, en):
    return ko if LANG == "ko" else en


# ── 머리말 ──────────────────────────────────────────────────────────────
def header_h():
    return 1.30 * S.SCALE


def header(page, y=None, measure=False):
    if measure:
        return header_h()
    k = S.SCALE
    x = S.MARGIN
    top = y

    # 캐릭터 (좌측)
    im = S.mpimg.imread(_asset("character.png"))
    ih, iw = im.shape[0], im.shape[1]
    h = 1.02 * k
    w = h * iw / ih
    page.ax.imshow(im, extent=(x, x + w, top - h, top), zorder=3,
                   interpolation="lanczos", aspect="auto")

    tx = x + w + 0.18 * k
    page.ax.text(tx, top - 0.04 * k, "gajae-code", fontsize=26 * k, color=ORANGE,
                 fontfamily=page.sans, fontweight="bold", ha="left", va="top")
    page.ax.text(tx, top - 0.46 * k, t("치트시트", "Cheat sheet"), fontsize=11.5 * k,
                 color=INK, fontfamily=page.sans, fontweight="bold",
                 ha="left", va="top")
    page.ax.plot([tx, tx + 1.55 * k], [top - 0.66 * k] * 2, color=CORAL,
                 linewidth=2.4 * k, solid_capstyle="round")
    page.ax.text(tx, top - 0.74 * k, REPO, fontsize=9.2 * k, color=ORANGE,
                 fontfamily=FONT_MONO, fontweight="bold", ha="left", va="top")
    page.ax.text(tx, top - 0.96 * k, "shape  ·  act  ·  prove", fontsize=7.4 * k,
                 color=GREY, fontfamily=page.sans, fontweight="bold",
                 ha="left", va="top")
    return top - header_h()


# ── 그룹 1 · 시작하기 ───────────────────────────────────────────────────
def g_start():
    why = Section(t("왜 가재코드인가", "Why gajae-code"), [
        desc(t("구독과 API 이중 과금", "Double billing"), INK),
        desc(t("    -> 쓰던 플랜으로 로그인", "    -> log in with your plan"), ORANGE),
        desc(t("이해 전에 고치는 에이전트", "Edits before understanding"), INK),
        desc(t("    -> 승인 게이트", "    -> approval gate"), ORANGE),
        desc(t("자리 비우면 멈추는 세션", "Stalls when you step away"), INK),
        desc(t("    -> 폰으로 응답", "    -> answer by phone"), ORANGE),
        desc(t("컨텍스트 폭발", "Context bloat"), INK),
        desc(t("    -> 구조 요약·아티팩트", "    -> summaries, artifacts"), ORANGE),
    ])
    install = Section(t("설치 & 첫 실행", "Install & first run"), [
        line("curl -fsSL <repo>/scripts/\\"),
        line("  install.sh -o gjc-install.sh"),
        line("sh gjc-install.sh"),
        line("gjc", ORANGE),
        gap(0.05),
        desc(t("태그 버전 설치가 기본. main 파이프는 가변",
               "Prefer the tagged installer; piping main")),
        desc(t("콘텐츠라 의도할 때만 쓴다. Bun 불필요.",
               "runs mutable content. Bun not required.")),
        rule(),
        code("/login", t("플랜 선택", "pick a plan")),
        code("/skill:deep-interview", t("요구 정리", "requirements")),
        code("/skill:ralplan", t("계획+비판", "plan + critique")),
        code("gjc ultragoal create-goals", ""),
    ])
    run = Section(t("실행 모드", "Run modes"), [
        code("gjc", t("현재 체크아웃", "current checkout")),
        code("gjc --tmux", t("tmux 리더 세션", "tmux leader")),
        code("gjc --tmux --worktree X", t("격리 워크트리", "isolated tree")),
        code("gjc -p \"...\"", t("비대화·1회성", "headless, once")),
        code("gjc @shot.png \"...\"", t("이미지 입력", "image input")),
        code("gjc --master --scope repo", t("마스터 세션", "master session")),
        code("gjc --no-tools", t("툴 전부 끄기", "disable tools")),
        code("gjc --no-lsp / --no-pty", ""),
        gap(0.05),
        desc(t("위험한 작업은 --worktree 로 격리한다.",
               "Isolate risky work with --worktree.")),
        desc(t("부모 체크아웃을 건드리지 않는다.",
               "The parent checkout stays untouched.")),
    ])
    rules = Section(t("열 가지 원칙", "Ten simple rules"), [
        desc(f"{i}. {x}", INK) for i, x in enumerate([
            t("승인 전에는 아무것도 변경하지 않는다",
              "Never mutate before the approval gate"),
            t("구독으로 로그인해 이중 과금을 피한다",
              "Log in with the plan you already pay for"),
            t("모호하면 deep-interview 부터 간다",
              "Vague request? Start with deep-interview"),
            t("위험한 작업은 워크트리로 격리한다",
              "Isolate risky work in a worktree"),
            t("전체 파일 대신 구조 요약을 읽는다",
              "Read structural summaries, not whole files"),
            t("긴 출력은 artifact:// 로 흘려보낸다",
              "Spill long output to artifact://"),
            t("planner 와 critic 은 벤더를 가른다",
              "Split planner and critic across vendors"),
            t("스킬은 .gjc 정식 위치에만 둔다",
              "Keep skills in canonical .gjc locations"),
            t("안 보이면 customize doctor 부터 본다",
              "Missing something? customize doctor first"),
            t("자리를 비워도 폰으로 답한다",
              "Step away — answer from your phone"),
        ], 1)
    ], badge="READ")
    return Group(t("1 · 시작하기", "1 · Getting started"),
                 [why, install, run, rules])


# ── 그룹 2 · 계획 먼저 ──────────────────────────────────────────────────
def g_plan():
    diagram = Section(t("승인 게이트를 통과해야 변경된다",
                        "Nothing mutates before the gate"), [
        # img() 가 SCALE 을 곱하므로 절대 인치로 주려면 미리 나눈다.
        img(f"{ASSETS}/pb_workflow_{LANG}_crop.png", DIAGRAM_MAX / S.SCALE),
    ])
    skills = Section(t("워크플로 스킬", "Workflow skills"), [
        kv(t("요구를 구체화", "Clarify requirements"), "deep-interview", 0.44),
        kv(t("계획 수립·비판", "Plan and critique"), "ralplan", 0.44),
        kv(t("실행·검증·증거", "Execute and verify"), "ultragoal", 0.44),
        kv(t("근거 리서치", "Research missions"), "autoresearch", 0.44),
        gap(0.04),
        desc(t("네 개뿐이다. 디스크 스킬로 대체 불가.",
               "Exactly four. Disk skills cannot replace them.")),
        gap(0.05),
        desc(t("승인 전에는 제품 소스·커밋·PR 금지.",
               "No source edits, commits or PRs before approval."), MAROON),
    ])
    agents = Section(t("역할 에이전트", "Role agents"), [
        kv(t("구현 (쓰기 가능)", "Implementation (writes)"), "executor", 0.54),
        kv(t("아키텍처 리뷰", "Architecture review"), "architect", 0.54),
        kv(t("순서·수용기준", "Sequencing"), "planner", 0.54),
        kv(t("계획 비판", "Plan critique"), "critic", 0.54),
        gap(0.04),
        desc(t("executor 만 변경한다. 나머지 셋은 읽기 전용.",
               "Only executor mutates; the rest are read-only.")),
    ])
    lane = Section(t("작업 분류", "Task routing"), [
        line("gjc quick-lane classify \\", INK),
        line("  \"add validation to parser\"", ORANGE),
        gap(0.04),
        desc(t("바로 실행할 일인지, 계획·인터뷰가 필요한",
               "Decides whether a task goes the bounded")),
        desc(t("깊은 경로인지 판정한다. --json 지원.",
               "quick lane or the deep planning path.")),
    ])
    sess = Section(t("세션", "Sessions"), [
        code("gjc -c", t("이전 세션 계속", "continue")),
        code("gjc -r [id|path]", t("재개·피커", "resume / picker")),
        code("gjc --fork <id>", t("분기", "fork")),
        code("gjc --no-session", t("저장 안 함", "ephemeral")),
        code("gjc --session-dir=<d>", t("저장 위치", "storage dir")),
        code("gjc --export=<f>", t("HTML 내보내기", "export HTML")),
    ])
    return Group(t("2 · 계획 먼저, 변경은 그다음", "2 · Plan before mutation"),
                 [diagram, skills, agents, lane, sess], full_width_first=True)


# ── 그룹 3 · 모델과 비용 ────────────────────────────────────────────────
def g_models():
    plans = Section(t("구독 플랜으로 로그인", "Bring your coding plan"), [
        kv(k, v, 0.46) for k, v in [
            ("Claude Pro / Max", "anthropic"),
            ("ChatGPT Plus / Pro", "openai-codex"),
            ("Cursor", "cursor"),
            ("GitHub Copilot", "github-copilot"),
            ("OpenCode Zen / Go", "opencode-zen"),
            ("Kimi / Moonshot", "kimi-code"),
            ("Z.AI GLM", "zai"),
            ("MiniMax", "minimax-code"),
            ("xAI Grok", "xai"),
            ("Qwen Portal", "qwen-portal"),
        ]] + [
        gap(0.04),
        desc(t("이미 내는 구독 위에서 돈다.",
               "Runs on the subscription you already pay for.")),
        desc(t("API 종량제와 이중 과금하지 않는다.",
               "No second per-token API bill.")),
    ])
    presets = Section(t("provider 프리셋", "Provider presets"), [
        line("gjc setup provider --preset \\"),
        line("     commandcode-goat", ORANGE),
        line("     cline-pass", ORANGE),
        line("     minimax | glm", ORANGE),
        line("     alibaba-token-plan", ORANGE),
        gap(0.04),
        desc(t("API 타입·baseUrl·환경변수·라이브 카탈로그를",
               "Writes API type, base URL, env var and a live")),
        desc(t("한 번에 기록한다. GJC 업데이트 없이도 신규",
               "model catalog together, so new models appear")),
        desc(t("모델이 들어온다.", "without a GJC update.")),
        gap(0.04),
        desc(t("로컬 런타임(Ollama·LM Studio·vLLM)·게이트웨이·",
               "Local runtimes (Ollama, LM Studio, vLLM),")),
        desc(t("API 키 provider 50종 이상을 같이 쓴다.",
               "gateways and 50+ API-key providers also work.")),
    ])
    accounts = Section(t("계정 & 인증", "Accounts & auth"), [
        code("gjc accounts list", t("보관 계정", "stored")),
        code("gjc accounts check <p>", t("상태 점검", "health")),
        code("gjc accounts pin <p> id:N", t("고정", "pin")),
        code("gjc accounts logout <p>", t("제거", "remove")),
        code("gjc auth-broker login <p>", t("재로그인", "re-login")),
        code("gjc auth-gateway", t("팀 공유", "team gateway")),
        gap(0.05),
        desc(t("자격증명이 죽으면 그 provider 가 경고 없이",
               "A dead credential drops the whole provider"), MAROON),
        desc(t("통째로 사라진다. 모델이 안 보이면 여기부터.",
               "silently. Missing models? Start here."), MAROON),
        gap(0.03),
        desc(t("API 키 환경변수가 OAuth 보다 우선한다.",
               "An API-key env var overrides stored OAuth.")),
        desc(t("구독으로 쓰려면 키를 벗기고 실행할 것.",
               "Strip the key to stay on the subscription.")),
    ])
    models = Section(t("모델 지정", "Model selection"), [
        line("provider/model:effort", ORANGE),
        gap(0.03),
        code("--model anthropic/claude-opus-5", ""),
        code("--thinking high", t("사고 수준", "effort")),
        code("--models a,b,c", t("Alt+N 순환", "Alt+N cycle")),
        code("gjc --list-models", t("전체 목록", "list all")),
        gap(0.04),
        desc("effort: off · minimal · low · medium · high"),
        desc(t("        · xhigh · max — 모델마다 다르다.",
               "        · xhigh · max — varies per model.")),
    ])
    profiles = Section(t("역할별 모델 / 프로필", "Per-role models / profiles"), [
        line("task:", INK),
        line("  agentModelOverrides:", INK),
        line("    executor:  p/m:low", ORANGE),
        line("    architect: p/m:high", ORANGE),
        line("    planner:   p/m", ORANGE),
        line("    critic:    p/m:xhigh", ORANGE),
        gap(0.04),
        desc(t("profiles: 로 묶으면 /model 첫 화면(프리셋)에",
               "A profile shows up on the first /model")),
        desc(t("바로 뜬다. 없으면 검색해야 나온다.",
               "screen; otherwise you must search for it.")),
        gap(0.03),
        desc(t("planner 와 critic 을 다른 벤더로 갈라야",
               "Split planner and critic across vendors —")),
        desc(t("자기추인이 아니라 반론이 나온다.",
               "same model self-approves instead of objecting.")),
    ])
    tokens = Section(t("토큰 아끼기", "Spend fewer tokens"), [
        desc(t("구조 요약 — 파일 전체 대신 시그니처만",
               "Structural summaries, not whole files"), INK),
        desc(t("artifact:// — 긴 출력은 보관 후 참조",
               "artifact:// — long output is stored, not dumped"), INK),
        desc(t("compaction — 긴 세션을 창 안에 유지",
               "compaction — long sessions stay in window"), INK),
        desc(t("cacheRetention — 캐시 히트 우선 라우팅",
               "cacheRetention — prefers cheap cache reads"), INK),
        gap(0.04),
        code("read artifact://<id>", t("잘린 출력 복구", "recover")),
    ])
    stats = Section(t("사용량 통계", "Usage statistics"), [
        code("gjc stats", t("대시보드 :3847", "dashboard :3847")),
        code("gjc stats --summary", t("콘솔 요약", "console summary")),
        code("gjc stats --json", ""),
        code("gjc stats -p <port>", t("포트 지정", "set port")),
        gap(0.04),
        desc(t("요청수·토큰·캐시율·비용·TTFT·토큰/초를",
               "Requests, tokens, cache rate, cost, TTFT and")),
        desc(t("모델별로 집계한다. 캐시율이 낮으면 프롬프트",
               "tokens/s per model. A low cache rate means")),
        desc(t("앞부분이 계속 바뀌고 있다는 뜻이다.",
               "your prompt prefix keeps changing.")),
    ])
    return Group(t("3 · 모델과 비용", "3 · Models & cost"),
                 [plans, presets, accounts, models, profiles, tokens, stats])


# ── 그룹 4 · 도구와 확장 ────────────────────────────────────────────────
def g_tools():
    tools = Section(t("내장 툴", "Built-in tools"), [
        kv(k, v, 0.62) for k, v in [
            (t("파일·URL·아카이브·DB", "files, URLs, archives, DB"), "read"),
            (t("정규식 검색", "regex search"), "search"),
            (t("글롭 탐색", "glob lookup"), "find"),
            (t("부분 치환", "surgical replace"), "edit"),
            (t("생성·덮어쓰기", "create / overwrite"), "write"),
            (t("터미널", "terminal"), "bash"),
            (t("서브에이전트 병렬", "parallel subagents"), "task"),
        ]] + [
        gap(0.04),
        desc(t("cat·grep·ls 대신 전용 툴을 쓴다.",
               "Use these instead of cat/grep/ls.")),
        desc(t("출력이 잘리지 않고 컨텍스트를 아낀다.",
               "Output is not truncated and costs less context.")),
    ])
    sel = Section(t("read 셀렉터", "read selectors"), [
        code(k, v) for k, v in [
            ("file.ts", t("구조 요약", "structure")),
            ("file.ts:50-200", t("행 범위", "line range")),
            ("file.ts:50+150", t("시작+개수", "start+count")),
            ("file.ts:5-16,60-73", t("다중 범위", "multi range")),
            ("file.ts:raw", t("원문 그대로", "verbatim")),
            ("file.ts:conflicts", t("머지 충돌", "conflicts")),
            ("a.zip:in/f.ts:1-20", t("아카이브 내부", "in archive")),
            ("db.sqlite", t("테이블 목록", "tables")),
            ("db.sqlite:users:42", t("단일 행", "one row")),
            ("db.sqlite?q=SELECT..", t("조회", "query")),
            ("https://...", t("리더 모드", "reader mode")),
        ]] + [
        gap(0.04),
        desc(t("요약 하단 푸터가 알려준 셀렉터를 그대로",
               "Re-issue the exact selector the summary")),
        desc(t("다시 부른다. '..' 안을 추측하지 않는다.",
               "footer names. Never guess inside '..'.")),
    ])
    keys = Section(t("키보드 단축키", "Keyboard shortcuts"), [
        code(k, v) for k, v in [
            ("ctrl+p", t("명령 팔레트", "command palette")),
            ("ctrl+l", t("모델 선택", "select model")),
            ("alt+n / alt+shift+n", t("모델 순환", "cycle model")),
            ("alt+p", t("임시 모델", "temp model")),
            ("shift+tab", t("사고 수준 순환", "cycle effort")),
            ("ctrl+t", t("사고 토글", "toggle thinking")),
            ("alt+shift+p", t("플랜 토글", "toggle plan")),
            ("ctrl+r", t("히스토리 검색", "history search")),
            ("ctrl+o", t("툴 출력 펼치기", "expand tools")),
            ("ctrl+g", t("외부 에디터", "external editor")),
            ("alt+q / alt+enter", t("메시지 큐", "queue message")),
            ("alt+shift+c", t("프롬프트 복사", "copy prompt")),
            ("alt+shift+b", t("백그라운드 접기", "background fold")),
            ("alt+h", t("음성 입력", "speech input")),
            ("escape", t("중단", "interrupt")),
            ("ctrl+c / ctrl+d", t("지우기 / 종료", "clear / exit")),
        ]])
    skills = Section(t("커스텀 스킬", "Custom skills"), [
        line("mkdir -p .gjc/skills", INK),
        desc(t("프로젝트 로컬 — 저장소마다", "Project-local, per repository")),
        line("mkdir -p ~/.gjc/agent/skills", INK),
        desc(t("사용자 전역 — 모든 프로젝트", "User-wide, every project")),
        gap(0.04),
        code("gjc skills list", t("번들 스킬", "bundled")),
        code("gjc skills read <name>", t("본문 보기", "read one")),
        code("gjc skills discover", t("탐지·진단", "discover")),
        gap(0.04),
        desc(t(".claude/skills · .codex/skills 는 가져오기",
               ".claude/skills and .codex/skills are import")),
        desc(t("출처일 뿐, 복사해야 쓸 수 있다.",
               "sources only — copy before invoking.")),
    ])
    plug = Section(t("MCP · 플러그인", "MCP & plugins"), [
        code("gjc mcp list", t("등록 서버", "servers")),
        code("gjc plugin install|list", ""),
        code("gjc plugin marketplace", t("마켓", "marketplace")),
        code("gjc plugin doctor --fix", t("진단·복구", "diagnose")),
        line("~/.gjc/agent/mcp.json", ORANGE),
    ])
    slash = Section(t("슬래시 명령", "Slash commands"), [
        code("/login", t("플랜 로그인", "plan login")),
        code("/login <p> --manual", t("코드 페어링", "pair by code")),
        code("/model", t("모델 전환", "switch model")),
        code("/theme", t("테마", "theme")),
        code("/settings", t("알림·외형", "notify / look")),
        code("/provider add --preset", ""),
        code("/extensions", t("로컬 확장", "local ext")),
    ])
    optin = Section(t("선택 기능", "Opt-in surfaces"), [
        kv(t("데스크톱 제어 (실험적)", "desktop control (experimental)"),
           "computer-use", 0.58),
        kv(t("파이썬 실행", "python execution"), "python-repl", 0.58),
        kv(t("음성 입력", "speech to text"), "stt", 0.58),
        gap(0.04),
        code("gjc setup <component>", ""),
        desc(t("claude · codex · credentials · defaults · hermes",
               "claude · codex · credentials · defaults · hermes")),
        desc(t("hooks · paseo · provider · python · stt",
               "hooks · paseo · provider · python · stt")),
    ])
    return Group(t("4 · 도구와 확장", "4 · Tools & extensions"),
                 [tools, sel, keys, skills, plug, slash, optin])


# ── 그룹 5 · 운영 ───────────────────────────────────────────────────────
def g_ops():
    conf = Section(t("설정 파일", "Config files"), [
        line("~/.gjc/agent/config.yml", ORANGE),
        desc("modelRoles · agentModelOverrides · ui"),
        line("~/.gjc/agent/models.yml", ORANGE),
        desc(t("providers · profiles — 직접 등록",
               "providers · profiles — your own")),
        line("~/.gjc/config.yml", ORANGE),
        desc(t("retry 예산 (request / stream)",
               "retry budgets (request / stream)")),
        gap(0.04),
        code("gjc config list", t("키 목록", "keys")),
        code("gjc config get <k>", t("조회", "get")),
        code("gjc config set <k> <v>", t("변경", "set")),
        gap(0.04),
        desc(t("models.yml 은 한 군데만 틀려도 파일 전체가",
               "One bad entry invalidates the whole"), MAROON),
        desc(t("무효화된다. 고친 뒤 --list-models 로 확인.",
               "models.yml. Verify with --list-models."), MAROON),
    ])
    retry = Section(t("재시도 예산", "Retry budgets"), [
        line("retry:", INK),
        line("  requestMaxRetries: 4", ORANGE),
        line("  streamMaxRetries:  100", ORANGE),
        line("  maxRetries:        3", ORANGE),
        line("  maxDelayMs:        300000", ORANGE),
        gap(0.04),
        desc(t("request 는 스트림 수립 전, stream 은 재생 안전한",
               "request applies before a stream is established;")),
        desc(t("일시 실패에만 적용된다.",
               "stream only to replay-safe transient failures.")),
        gap(0.03),
        desc(t("인증 오류·미지원 모델·잘못된 요청·컨텍스트",
               "Invalid auth, unsupported models, malformed"), MAROON),
        desc(t("초과·사용자 중단·영구 쿼타는 즉시 실패한다.",
               "requests, overflow and quota fail fast."), MAROON),
    ])
    upd = Section(t("업데이트 · 정리", "Updating & cleanup"), [
        code("gjc update", t("바이너리 교체", "replace binary")),
        line("gjc config set \\", INK),
        line("  startup.checkUpdate false", ORANGE),
        gap(0.04),
        code("gjc gc", t("기본은 보고만", "dry-run report")),
        code("gjc gc --prune", t("실제 정리", "actually prune")),
        code("gjc gc --disk", t("디스크 보존량", "disk retention")),
        gap(0.04),
        desc(t("세션·PID 기록, blob·아티팩트·백업을 회수한다.",
               "Reclaims stale session/PID records, blobs,")),
        desc(t("시작 시 검사는 알림일 뿐 자가 교체하지 않는다.",
               "artifacts and backups. Launch check only notifies.")),
    ])
    notify = Section(t("자리를 비울 때", "Answer from anywhere"), [
        code("gjc notify setup", t("최초 설정", "first setup")),
        code("gjc notify status|health", ""),
        code("gjc notify test", t("발송 확인", "send test")),
        code("gjc daemon status", t("데몬 확인", "daemon status")),
        code("gjc daemon restart", t("재기동", "restart")),
        gap(0.04),
        desc(t("결정이 필요하면 Telegram·Discord·Slack 으로",
               "The agent asks on Telegram, Discord or Slack")),
        desc(t("묻고, 어디서든 답하면 세션이 이어진다.",
               "and your reply resumes the session.")),
    ])
    themes = Section(t("테마", "Themes"), [
        kv(k, v, 0.46) for k, v in [
            (t("다크 기본", "dark default"), "red-claw"),
            (t("라이트 기본", "light default"), "blue-crab"),
            (t("Claude Code 풍", "Claude Code feel"), "claude-code"),
            (t("Codex 풍", "Codex feel"), "codex"),
            (t("OpenCode 풍", "OpenCode feel"), "opencode"),
        ]])
    doctor = Section(t("안 보일 때", "When something is missing"), [
        code("gjc customize doctor", t("출처·우선순위", "provenance")),
        code("gjc customize doctor --json", ""),
        gap(0.04),
        desc(t("툴·스킬·훅·확장·슬래시·MCP·플러그인이",
               "One read-only surface explains why a tool,")),
        desc(t("안 뜨는 이유를 한 곳에서 알려준다.",
               "skill, hook, slash, MCP or plugin is absent.")),
        desc(t("자격증명은 절대 출력하지 않는다.",
               "Credentials are never printed.")),
    ])
    sub = Section(t("서브커맨드", "Subcommands"), [
        line("accounts  auth-broker", ORANGE),
        line("auth-gateway  config  skills", ORANGE),
        line("mcp  mcp-serve  plugin", ORANGE),
        line("daemon  notify  stats  gc", ORANGE),
        line("update  setup  customize", ORANGE),
        line("migrate  web-search(q)", ORANGE),
        line("quick-lane  interview", ORANGE),
        line("ultragoal  contribute-pr", ORANGE),
    ])
    sdk = Section(t("외부 컨트롤러", "External controllers"), [
        line("gjc-sdk-discover", ORANGE),
        line("gjc-sdk-operate", ORANGE),
        line("gjc-sdk-author", ORANGE),
        gap(0.04),
        desc(t("봇·cron 이 브로커 결합 SDK 세션 CLI 로 진짜",
               "Bots and cron drive real sessions through the")),
        desc(t("세션을 몰고, 터미널 긁어모으기는 안 한다.",
               "broker-bound SDK CLI — never terminal scraping.")),
    ])
    comm = Section(t("커뮤니티 확장", "Community extensions"), [
        code(k, v) for k, v in [
            ("gjc-remote", t("Discord 원격 제어", "remote via Discord")),
            ("oh-my-gajae-code", t("플러그인 마켓", "plugin marketplace")),
            ("gjc-agy-skill", t("비전·OCR·이미지", "vision / OCR / image")),
            ("multivendor-setup", t("역할별 프로필", "role profiles")),
        ]] + [
        gap(0.05),
        rule(),
        desc(REPO, ORANGE, S.S_CODE),
        desc("docs/models.md · docs/skills.md"),
        desc("docs/keybindings.md · docs/install.md"),
        desc("docs/compaction.md · docs/hooks.md"),
    ])
    return Group(t("5 · 운영과 문제해결", "5 · Operations & troubleshooting"),
                 [conf, retry, upd, notify, themes, doctor, sub, sdk, comm])


def groups():
    return [g_start(), g_plan(), g_models(), g_tools(), g_ops()]


FOOTER = ("제작: 이제현  |  jehyun.lee@gmail.com  |  "
          "https://jehyunlee.github.io  |  KIST AIX전략실")

# A4 가로 (인치)
A4_W, A4_H = 11.69, 8.27
MAX_A4_PAGES = 4


def _paginate(gs):
    """그룹을 A4 한 장씩에 담는다. 그룹은 쪼개지 않는다 —
    주제 묶음이 페이지 경계로 끊기면 묶은 의미가 없다.
    한 그룹이라도 한 장을 넘으면 None."""
    avail = A4_H - 2 * S.MARGIN
    pages, cur, used = [], [], header_h()
    for g in gs:
        h = g.height()
        if h > avail:
            return None
        need = h + (S.GGAP if cur else 0)
        if used + need > avail and cur:
            pages.append(cur)
            cur, used = [g], h
        else:
            cur.append(g)
            used += need
    if cur:
        pages.append(cur)
    return pages


def _page(lang):
    p = Page(sans=FONT_SANS if lang == "ko" else FONT_SANS_EN)
    for g in groups():
        p.add(g)
    return p


def build(out, lang="ko"):
    """세로 스크롤판. 비율을 고정하면 글자를 키워도 지면이 같이 커져
    상대 크기가 그대로다. 그래서 폭을 고정하고 높이는 내용이 정한다."""
    global LANG
    LANG = lang
    S.set_scale(2.0, cols=2)
    S.set_width(PAGE_W)
    _page(lang).render(out, header_fn=header, footer=FOOTER)


def build_a4(out, lang="ko"):
    """A4 가로 1장판. 지면이 고정이므로 내용을 줄이는 대신
    배율·단수를 풀어 맞춘다. 들어가는 조합을 직접 탐색한다."""
    global LANG, DIAGRAM_MAX
    LANG = lang

    keep = DIAGRAM_MAX
    DIAGRAM_MAX = 2.15         # A4 한 장을 다이어그램이 잡아먹지 않게
    try:
        # 단을 5단 이상으로 늘리면 한글 설명문이 단 폭을 넘어간다.
        # 페이지 수를 먼저 줄이고, 같으면 글자가 큰 쪽을 고른다.
        # 단을 늘리면 한글 설명문이 단 폭을 넘어간다. 추정하지 말고
        # 실제 글자 폭을 재서 넘치는 조합을 탈락시킨다.
        sans = FONT_SANS if lang == "ko" else FONT_SANS_EN
        best = None
        for cols in (3, 4, 5):
            for k100 in range(100, 59, -1):
                k = k100 / 100.0
                S.set_scale(k, cols=cols)
                S.set_width(A4_W)
                gs = groups()
                if S.overflow_rows(gs, sans):
                    continue
                pages = _paginate(gs)
                if pages is None:
                    continue
                if len(pages) > MAX_A4_PAGES:
                    continue
                # 인쇄물이니 가독성 우선: 장수 상한 안에서 글자가 가장 큰 조합.
                cand = (-k, len(pages))
                if best is None or cand < best[0]:
                    best = (cand, k, cols, len(pages))
        if best is None:
            raise SystemExit("A4 에 맞는 조합을 못 찾았다")

        _, k, cols, npages = best
        print(f"  A4: 배율 {k:.2f}  {cols}단  {npages}장  "
              f"(코드 {6.3 * k:.1f}pt)")
        S.set_scale(k, cols=cols)
        S.set_width(A4_W)
        p = _page(lang)
        pages = _paginate(p.groups)
        p.render_pages(pages, out, A4_H, header_fn=header, footer=FOOTER)
    finally:
        DIAGRAM_MAX = keep


if __name__ == "__main__":
    import sys
    outdir = sys.argv[1] if len(sys.argv) > 1 else str(_HERE.parent)
    for lang in ("ko", "en"):
        for ext in ("png", "pdf"):
            build(f"{outdir}/gajae-code-cheatsheet-{lang}.{ext}", lang)
            build_a4(f"{outdir}/gajae-code-cheatsheet-{lang}_A4.{ext}", lang)
