<p align="right">
  <a href="README.md">English</a> | <strong>한국어</strong> | <a href="README.zh-CN.md">中文</a> | <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <img src="assets/hero.png" alt="Gajae-Code 자율 코딩 에이전트 히어로 일러스트" width="100%" />
</p>

<h1 align="center">G A J A E - C O D E</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong>
  <br/>
  <sub><strong>이미 결제 중인 플랜</strong>으로 돌아가고, 휴대폰으로 답하는 코딩 에이전트.</sub>
</p>

<p align="center">
  <a href="https://gajae-code.com"><img alt="Website" src="https://img.shields.io/badge/website-gajae--code.com-ff4d4f?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/gajae-code"><img alt="npm package" src="https://img.shields.io/npm/v/gajae-code?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <a href="https://discord.gg/wSyUQYfhAw"><img alt="Discord" src="https://img.shields.io/badge/Discord-join-5865F2?style=flat-square&logo=discord&logoColor=white"></a>
</p>

<p align="center">
  <a href="https://github.com/devswha/gajae-code-app"><kbd><strong>🖥️ Gajae-Code App 살펴보기 → 데스크톱·셀프 호스팅 웹 GUI</strong></kbd></a>
  <br/>
  <sub>커뮤니티가 만드는 실험적 서드파티 프로젝트이며, Gajae-Code의 공식 퍼스트파티 앱이 아닙니다.</sub>
</p>

<p align="center">
  <a href="#빠른-시작">빠른 시작</a> ·
  <a href="#왜-gajae-code인가">왜</a> ·
  <a href="#쓰던-코딩-플랜-그대로">코딩 플랜</a> ·
  <a href="#휴대폰으로-답하기">휴대폰</a> ·
  <a href="#변경-전에-계획">워크플로</a> ·
  <a href="#토큰을-덜-쓰기">토큰 다이어트</a> ·
  <a href="#openclaw--hermes--grokbot--내가-만든-봇이-gjc를-부리게-하기">컨트롤러</a> ·
  <a href="#paseo--orca--t3-code-안에서-gjc-돌리기">에이전트 셸</a> ·
  <a href="#문서">문서</a>
</p>

**이미 구독 중인 플랜으로 로그인하고, 파일 하나 바뀌기 전에 계획하고, 증거와 함께 실행하고 — 에이전트의 질문에는 터미널·휴대폰·자체 봇 어디서든 답하세요.**

Gajae-Code(`gjc`)는 외부 코딩 에이전트 하네스입니다. 아무 저장소나 워크트리에 넣고 돌리세요. 별도 API 과금 없음. 토큰 단가 불안 없음. 터미널 앞 대기 없음.

> Gajae-Code는 실험적인 베타 단계 프로젝트입니다. 거친 부분이 있을 수 있으니 중요한 작업에는 출력을 검증한 뒤 사용하세요.
>
> 이 문서는 영어 [README.md](README.md)의 번역본입니다. 내용이 다르면 영어 버전이 기준(SSOT)입니다.

---

## 왜 Gajae-Code인가?

대부분의 코딩 에이전트는 세 군데서 무너집니다: 요금을 두 번 물리고, 이해하기 전에 코드를 고치고, 키보드에서 벗어나는 순간 침묵합니다.

| 문제 | 어떻게 되나 | Gajae-Code의 해법 |
| :--- | :--- | :--- |
| 별도 API 과금 | 플랜 요금 *플러스* 토큰당 API 비용 | 이미 결제 중인 코딩 플랜으로 `/login` — Claude, Codex, Cursor, Copilot, OpenCode Go, GOAT, ClinePass 등 |
| 코드부터 고치는 에이전트 | 이해 전에 수정 → 재작업 | 계획 게이트 워크플로: 인터뷰 → 계획 → 비평 → *그 다음에* 변경, 승인 게이트 포함 |
| 터미널 종속 세션 | 새벽 2시에 질문이 오면 아침까지 정지 | 질문이 텔레그램/Discord/Slack으로 라우팅 — 어디서든 답변 |
| 컨텍스트 폭발 | 전체 파일 읽기와 로그 홍수가 윈도를 태움 | 구조 요약, artifact 스필, 캐시 인지 라우팅, 컴팩션 |

---

## 빠른 시작

**설치** — Linux(x64/arm64), macOS(arm64/x64), Windows(x64) 프리빌드 바이너리. Bun은 필요 없습니다:

```sh
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/v0.15.3/scripts/install.sh -o gjc-install.sh
sh gjc-install.sh
gjc
```

`main`을 파이프하면 변경 가능한 설치 스크립트가 실행됩니다. 최신 설치기가 필요할 때만 사용하세요:

```sh
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh
```

Windows (PowerShell, 태그 고정):

```powershell
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/v0.15.3/scripts/install.ps1 -OutFile gjc-install.ps1
powershell -File gjc-install.ps1
```

**첫 실행** — 플랜 고르고 바로 시작:

```text
/login                       프로바이더 / 코딩 플랜 선택
/skill:deep-interview        모호한 요구사항 명확화
/skill:ralplan               계획 수립 및 비평
gjc ultragoal create-goals --brief-file <승인된-계획>
```

**실행 모드:**

```sh
gjc                                # 현재 체크아웃에서 실행
gjc --tmux                         # tmux 기반 리더 세션
gjc --tmux --worktree my-task      # 위험한 작업을 위한 격리 워크트리
gjc @screenshot.png "뭘 바꿔야 할까?"   # 이미지 입력
```

나이틀리 채널: `sh gjc-install.sh --channel nightly` (위에서 받은 태그 설치기). 전체 설치 매트릭스, Windows 설정, 업데이트 채널, 셸 자동완성: [docs/install.md](docs/install.md). Bun은 소스 빌드에만 필요합니다.

**한국어 실행 명령어** — `가재씨`는 패키지 매니저 설치에서 `gjc`와 함께 제공되는 별칭입니다. 독립 바이너리 설치는 `gjc`만 제공합니다:

```sh
가재씨 --version
```

---

## 쓰던 코딩 플랜 그대로

<p align="center">
  <img src="assets/coding-plans-banner.png" alt="GJC가 지원하는 코딩 플랜과 프로바이더: Claude, ChatGPT/Codex, Cursor, GitHub Copilot, OpenCode Go, Kimi, GLM/Z.AI, MiniMax, Grok, Qwen, Command Code GOAT, ClinePass" width="100%" />
</p>

한 번 로그인하면 이미 결제 중인 구독으로 GJC가 돌아갑니다. 세션 안에서 `/login`을 실행하고 플랜을 고르세요:

| 플랜 / 구독 | OAuth 로그인 |
| :--- | :--- |
| Claude Pro / Max | `anthropic` |
| ChatGPT Plus / Pro (Codex) | `openai-codex` (브라우저) · `openai-codex-device` (헤드리스) |
| Cursor | `cursor` |
| GitHub Copilot | `github-copilot` |
| OpenCode Zen / OpenCode Go | `opencode-zen` · `opencode-go` |
| Kimi Code / Coding Plan / Moonshot | `kimi-code` · `moonshot` |
| Z.AI GLM Coding Plan | `zai` |
| MiniMax Coding Plan (해외 / 중국) | `minimax-code` · `minimax-code-cn` |
| xAI (Grok) | `xai` |
| Alibaba Token Plan / Qwen Portal | `alibaba-token-plan` · `qwen-portal` |

그 외 OAuth 플랜 — Google Gemini CLI, GitLab Duo, Perplexity Pro/Max, Fire Pass, Xiaomi Token Plan — 은 [docs/models.md](docs/models.md)에서 다룹니다.

### 신규: 코딩 플랜 프리셋

키 기반 코딩 플랜은 명령 하나로 온보딩됩니다 — 프리셋이 API 타입, base URL, 환경 변수, 호환 플래그, **라이브 모델 카탈로그**를 한 번에 기록하므로 새 모델이 GJC 업데이트 없이 바로 나타납니다:

```sh
gjc setup provider --preset commandcode-goat   # Command Code GOAT 플랜 (CMD_API_KEY)
gjc setup provider --preset cline-pass         # ClinePass (CLINE_API_KEY)
```

- **Command Code GOAT** — 프로바이더의 라이브 `/models` 카탈로그를 가져오고, `claude-*` 모델은 네이티브 Anthropic Messages로, 나머지는 Chat Completions로 라우팅합니다. 별칭: `commandcode`, `goat`.
- **ClinePass** — 하드코딩된 모델이 없습니다. GJC가 Cline이 자체 카탈로그를 생성하는 방식 그대로 라이브 카탈로그를 가져옵니다. 별칭: `clinepass`, `cline`.
- 그 외 프리셋: `minimax`, `minimax-cn`, `glm`, `alibaba-token-plan` — TUI 안에서는 `/provider add --preset <name>`.

<details>
<summary><strong>코딩 플랜 너머: 50+ 프로바이더, 게이트웨이, 로컬 런타임</strong></summary>

API 키 프로바이더, 로컬 런타임(Ollama, LM Studio, vLLM), 게이트웨이(Cloudflare AI Gateway, Vercel AI Gateway, LiteLLM 등)를 모두 지원합니다. `models.yml`에 자체 엔드포인트를 등록하고, 프로바이더당 여러 계정을 사용량 기반으로 라우팅하고, 모델 프리셋/프로필로 역할별 벤더를 섞거나, auth 브로커/게이트웨이로 팀 자격증명을 중앙화하세요.

- [모델·프로바이더·인증 해석 순서](docs/models.md)
- [커스텀 프로바이더 & 멀티 계정 라우팅](docs/custom-providers-and-multi-account.md)
- [멀티 벤더 역할 프로필](docs/multi-vendor-profiles.md)
- [Auth 브로커 & 게이트웨이 (팀 공용 자격증명)](docs/auth-broker-gateway.md)

</details>

---

## 휴대폰으로 답하기

<p align="center">
  <img src="assets/telegram-mobile-hero.png" alt="Gajae Code 모바일 응답 히어로 일러스트" width="100%" />
</p>

에이전트가 결정을 요청하면 텔레그램으로 알림이 오고, 어디서든 답할 수 있습니다:

- **Coordinator/lifecycle 세션용 포럼 토픽** — 실시간/최종 출력, 컨텍스트 업데이트, 이미지 첨부, 인라인 버튼, 자유 텍스트 답장, 타이핑 표시.
- **한 번만 설정** — 실행 중인 세션의 `/settings` → Notifications에서, 또는 헤드리스로 `gjc notify setup|status|health|test|recovery`. 토큰은 입력 시 마스킹되고 이후 절대 표시되지 않습니다.
- **`gjc daemon`** — 봇 토큰당 하나의 안전한 long-poll 소유자를 유지해 새 세션이 텔레그램 409 충돌 없이 깔끔하게 붙습니다.
- Discord와 Slack 전달도 함께 제공됩니다. 범용 `action_needed`/`reply` 프로토콜로 어떤 봇/모바일 앱이든 터미널 스크래핑 없이 답을 되돌릴 수 있습니다.

[텔레그램 온보딩](docs/telegram-onboarding.md) · [Discord](docs/discord-onboarding.md) · [Slack](docs/slack-onboarding.md)

---

## 변경 전에 계획

의도적으로 작은 워크플로 표면 — 스킬 4개, 역할 에이전트 4개, 그 이상은 없습니다:

```text
deep-interview -> ralplan -> ultragoal
               └─ 리서치가 계획을 뒷받침해야 할 때 선택적 autoresearch 미션
```

| 표면 | 역할 |
| :--- | :--- |
| `deep-interview` | 모호한 요청을 구체적인 요구사항으로 바꿉니다. |
| `ralplan` | 코드 변경 전에 구현 계획을 세우고 비평합니다. |
| `ultragoal` | 실행·수정·검증·증거까지 목표를 추적합니다. |
| `autoresearch` | 목표 지향 리서치 미션을 수행하고 구조화된 판정으로 마무리합니다. |
| `executor` / `architect` / `planner` / `critic` | 구현 및 읽기 전용 리뷰 레인을 위한 번들 역할 에이전트. |

옵트인 기능: **`computer-use`** (실험적 데스크톱 제어). [Python REPL](docs/python-repl.md), [docs/tools/computer.md](docs/tools/computer.md) 참고.

## 사용자 스킬

GJC는 Claude Code / Codex의 `SKILL.md` 파일 규약을 사용하지만, 런타임 스킬은 정식 GJC 경로에서만 직접 로드합니다. 별도 설정은 필요 없습니다:

```sh
# 프로젝트 로컬, 저장소별:
mkdir -p .gjc/skills && cp -r my-skill .gjc/skills/

# 모든 프로젝트에서 쓸 사용자 전역 경로:
mkdir -p ~/.gjc/agent/skills && cp -r my-skill ~/.gjc/agent/skills/
```

Claude Code와 Codex 스킬 디렉터리는 가져오기 소스일 뿐입니다. `gjc skills discover`가 정확한 복사 명령과 함께 이를 알려 주므로, 스킬을 정식 `.gjc` 경로로 복사한 뒤 세션에서 `/skill:my-skill`로 실행하세요. 범위 신뢰는 `skills.trustProjectSkills` / `skills.trustUserSkills`로 명시하며(둘 다 기본 활성화), `skills.enabled`가 전체 스위치입니다. 위의 번들 워크플로 스킬 4개는 디스크 스킬로 교체할 수 없습니다. 위치, 우선순위, 진단은 [docs/skills.md](docs/skills.md)를 참고하세요.

## 기본 테마

기본 다크 TUI 아이덴티티는 GJC red-claw 테마이며, 라이트 외관 터미널은 번들된 blue-crab 테마가 기본입니다. 명시적으로 설정한 테마가 항상 우선합니다.

---

## 토큰을 덜 쓰기

GJC는 토큰 비용의 양쪽을 모두 최적화합니다:

- **캐시 히트** — 프로바이더별 `cacheRetention` 제어. Anthropic은 짧은 캐시가 긴 에이전트 실행에 취약하므로 기본이 장기(1시간) 캐시 유지입니다. 프로바이더 랭킹은 저렴한 `cacheRead` 경로를 우선하고, 옵트인 session-affinity 헤더로 OpenAI 호환 릴레이가 서버측 프롬프트 캐시를 재사용할 수 있습니다.
- **컨텍스트 절약** — 파일 읽기는 전체 파일 대신 구조 요약을 반환하고, 과대한 셸 출력은 컨텍스트를 채우는 대신 최소화되어 회수 가능한 `artifact://` 참조로 넘어갑니다. 컴팩션과 브랜치 요약이 긴 세션을 윈도 안에 유지하면서 이전 작업 맥락을 잃지 않게 합니다.

[캐시 유지 & 프로바이더 호환](docs/models.md) · [컴팩션 & 브랜치 요약](docs/compaction.md)

---

기본 다크 TUI 아이덴티티는 GJC red-claw 테마이며, 라이트 외관 터미널은 번들된 blue-crab 테마가 기본입니다. 전체 카탈로그와 `theme.dark` / `theme.light` 설정은 [docs/theme.md](docs/theme.md)를 참고하세요.

## OpenClaw / Hermes / Grokbot / 내가 만든 봇이 GJC를 부리게 하기

외부 컨트롤러는 무엇이든 된다 — OpenClaw, Hermes, Grokbot, 디스코드 봇, 크론 스크립트. 브로커에 바인딩된
**SDK 세션 CLI**와 번들 [`sdk-skills/`](https://github.com/Yeachan-Heo/gajae-code/tree/main/sdk-skills)
절차(`gjc-sdk-discover` · `gjc-sdk-operate` · `gjc-sdk-author`)로 실제 GJC 세션을 움직인다. durable turn과
크리덴셜 없는 JSON만 오간다 — 터미널 스크래핑은 없다.

가이드를 읽을 필요 없이, 아래 프롬프트를 컨트롤러에 붙여넣으면 스스로 연결을 구성한다:

<details>
<summary><strong>복붙용 컨트롤러 설정 프롬프트</strong></summary>

```text
Use Gajae-Code (gjc) as your coding-agent backend on this machine. gjc is already installed.
Your interface is the broker-bound SDK session CLI. Never scrape terminal output, never read
endpoint records or credentials under .gjc/state/sdk, never open a raw session WebSocket.

1. Load the shipped procedures before acting. Read these skill files from the gjc checkout or
   from https://github.com/Yeachan-Heo/gajae-code/tree/main/sdk-skills (bundle root
   `sdk-skills/`, manifest.json formatVersion 1 — if it is missing, malformed, or a different
   version, stop and report instead of guessing):
     sdk-skills/gjc-sdk-discover/SKILL.md   -- find and inspect sessions
     sdk-skills/gjc-sdk-operate/SKILL.md    -- the allowlisted control/lifecycle operations
     sdk-skills/gjc-sdk-author/SKILL.md     -- TypeScript/Python templates for scripted flows
   Follow their allowlists exactly. Pass every value as an argv item, never as a shell string.

2. Prove the surface works (read-only). Run from inside the target repository:
     gjc --version
     gjc sdk session list
   `list` returns a credential-free JSON DTO of indexed sessions. Fail closed on missing,
   unavailable, stale, dead, unknown, or ambiguous rows. Exit 2 = usage error, exit 1 =
   operational failure (broker unavailable, session unavailable, retention gap, wait timeout).

3. Understand a session before touching it:
     gjc sdk session inspect <sessionId>
     gjc sdk session raw query <sessionId> --query session.metadata
     ... then context.get, goal.list, todo.list, workflow.gates.list, session.stats
   These reads are not an atomic snapshot: label every reported field confirmed / inferred /
   stale / unavailable / unknown. Never invent a missing value.

4. Start work in an isolated session:
     gjc sdk session raw global --op session.create \
       --idempotency-key <fresh-uuid> --json-input '{"cwd":"/abs/path/to/repo"}'
   Lifecycle ops allowed: session.create, session.fork, session.resume, session.close.
   session.delete is NOT allowed. session.get_endpoint is refused unconditionally.

5. Drive a turn and reconcile it:
     gjc sdk session send <sessionId> --text "<task>" --op-ref <fresh-ulid>
     gjc sdk session status <sessionId> <opRef>        # lossless turn.result lookup
     gjc sdk session tail <sessionId> --until-idle     # replay + live follow
   Use `send --wait --timeout-ms <ms>` for a bounded wait; a wait window that elapses reports
   wait_timeout and never cancels the running turn. One fresh op-ref per logical prompt --
   `unknown` means uncertainty, never proof of non-execution, so reconcile with `status`
   instead of replaying a prompt.

6. Answer what the agent asks you:
     gjc sdk session raw control <sessionId> --op ask.answer --json-input '{...}'
     gjc sdk session raw control <sessionId> --op workflow.gate_answer --json-input '{...}'
   For gate answers use the durable workflow gate ID plus expectedSessionId; a transient
   action_needed.id is never durable authority. Other allowed per-session controls:
   turn.prompt, turn.steer, turn.follow_up, todo.replace, session.switch, session.rename.

7. Show the human the exact operation and target before any mutating call, and treat the
   approval as single-use: if the operation, input, or target changes, ask again.
```

</details>

긴 프롬프트를 걸어 두고 나가도 된다: SDK 프롬프트 데드라인은 진행 상황을 반영하는 유휴 리스
(`sdk.promptDeadlineMs`, 기본 60분)이며 `sdk.promptMaxRuntimeMs`(기본 6시간)로 상한이 잡힌다. 갱신은 해당 턴에
귀속되는 툴 실행만으로 이루어지고, 하트비트나 스트리밍 텍스트로는 갱신되지 않는다.

세션 하나가 아니라 여러 워크트리에 이벤트 기반으로 펼쳐야 한다면, 네이티브
[Coordinator MCP 브리지](docs/hermes-mcp-bridge.md)(`gjc mcp-serve coordinator`, `gjc setup hermes`로 설치)가
그 형태의 위임 도구를 제공한다.

- [외부 컨트롤러 / 봇 통합 가이드](docs/bot-integration.md) — 프로바이더 독립 스모크; [`docs/aside-integration.md`](docs/aside-integration.md)는 옵트인 검색/컨텍스트 사이드카와 `/aside` 컴포저 명령을 다룬다
- [SDK 세션 CLI](docs/sdk-session-cli.md) · [SDK & 와이어 프로토콜](docs/sdk.md) · [SDK 앱 가이드](docs/sdk-app-guide.md) · [외부 제어 준비도](docs/external-control-readiness.md)

---

## Paseo · Orca · T3 Code 안에서 GJC 돌리기

터미널 대신 데스크톱/모바일 에이전트 셸을 쓰고 있다면, GJC는 대표적인 세 곳에 붙는다 — 지원 수준은 솔직하게 서로 다르다.

<table>
<tr>
<th width="120">호스트</th><th width="110">지원 수준</th><th>얻는 것</th><th>설정</th>
</tr>
<tr>
<td align="center">
  <a href="https://paseo.sh"><img src="https://www.google.com/s2/favicons?domain=paseo.sh&sz=64" width="28" alt="Paseo 로고" /><br/><strong>Paseo</strong></a><br/>
  <sub><a href="https://github.com/getpaseo/paseo">저장소</a></sub>
</td>
<td align="center">★★★★★<br/><sub>1급 지원</sub></td>
<td>GJC가 스스로 설치하는 네이티브 ACP 프로바이더. 모델 카탈로그, Default/Plan 모드, thinking 레벨, 실제 권한 승인 프롬프트, 소유 서브에이전트까지 끊는 취소, 모바일 제어.</td>
<td><code>gjc setup paseo</code><br/><sub>이후 <code>paseo daemon restart</code></sub></td>
</tr>
<tr>
<td align="center">
  <a href="https://onorca.dev"><img src="https://www.google.com/s2/favicons?domain=onorca.dev&sz=64" width="28" alt="Orca 로고" /><br/><strong>Orca</strong></a><br/>
  <sub><a href="https://github.com/stablyai/orca">저장소</a></sub>
</td>
<td align="center">★★★★☆<br/><sub>필드 하나로 동작</sub></td>
<td>GJC가 커스텀 CLI 에이전트로 실행되며 세션마다 워크트리가 분리된다. Orca의 diff 리뷰, 터미널 분할, SSH 워크트리, 모바일 컴패니언을 그대로 쓴다. 사용량 추적·계정 핫스왑은 아직 없다.</td>
<td><strong>Settings → Agents</strong><br/>커맨드에 <code>gjc</code> 추가</td>
</tr>
<tr>
<td align="center">
  <a href="https://t3.codes"><img src="https://www.google.com/s2/favicons?domain=t3.codes&sz=64" width="28" alt="T3 Code 로고" /><br/><strong>T3 Code</strong></a><br/>
  <sub><a href="https://github.com/pingdotgg/t3code">저장소</a></sub>
</td>
<td align="center">★★★☆☆<br/><sub>실험적</sub></td>
<td>T3 Code는 아직 Codex·Claude·Cursor·Grok·OpenCode 하네스만 제공하고 GJC 하네스가 업스트림에 없다. 지금은 나란히 띄워 쓰고, 네이티브 프로바이더는 <a href="https://github.com/pingdotgg/t3code/discussions/7290">업스트림에 제안</a>해 둔 상태다.</td>
<td><sub>아직 한 줄 설치는 없음 — 가이드 참고</sub></td>
</tr>
</table>

Paseo는 이 블록 하나로 끝난다:

```sh
gjc setup paseo            # ACP 프로바이더 엔트리 작성 + 백업, 데몬은 절대 대신 재시작하지 않음
paseo daemon restart
paseo provider ls          # gjc가 `available`로 보여야 한다
paseo run --provider gjc --cwd /path/to/repo "프롬프트"

gjc setup paseo --check    # pass / stale / drift 진단, --json으로 기계 판독
gjc setup paseo --remove   # GJC가 직접 만든 키만 롤백
```

Orca는 필드 하나다: GJC를 설치([docs/install.md](docs/install.md))하고 커맨드 `gjc`에 인자 없이 커스텀
에이전트를 추가한다. Orca는 권한 우회 플래그가 있는 에이전트에 그 플래그를 미리 넣어 주는데, GJC는 설계상 그런
플래그가 없다 — 인자는 비워 두고 GJC 자체 승인 게이트를 그대로 살려 둔다.

**[전체 통합 가이드 → docs/terminal-app-integrations.md](docs/terminal-app-integrations.md)** — 호스트별 설정,
검증, 취소 의미, 트러블슈팅 표, 그리고 각 호스트가 아직 닿지 못하는 영역까지.

---

## 문서

**[gajae-code.com](https://gajae-code.com)** 또는 `docs/`에서 시작하세요:

- [설치 & 업데이트](docs/install.md) · [환경 변수](docs/environment-variables.md) · [키바인딩](docs/keybindings.md) · [테마](docs/theme.md) · [UI 언어](docs/ui-language.md)
- [모델 & 프로바이더](docs/models.md) · [커스텀 프로바이더 & 멀티 계정 라우팅](docs/custom-providers-and-multi-account.md) · [멀티 벤더 프로필](docs/multi-vendor-profiles.md) · [Auth 브로커](docs/auth-broker-gateway.md)
- [커스터마이징 권한·가져오기·신뢰](docs/customization.md) · [스킬](docs/skills.md) · [훅](docs/hooks.md) · [독립 MCP](docs/standalone-mcp.md) · [플러그인 번들](docs/gjc-plugins.md)
- [터미널 앱 통합: Paseo · Orca · T3 Code](docs/terminal-app-integrations.md)
- [텔레그램](docs/telegram-onboarding.md) · [봇 통합](docs/bot-integration.md) · [SDK](docs/sdk.md) · [SDK 세션 CLI](docs/sdk-session-cli.md)
- [세션](docs/session.md) · [컴팩션](docs/compaction.md) · [메모리](docs/memory.md) · [시크릿](docs/secrets.md)
- [코드베이스 개요](docs/codebase-overview.md) · [기여 / 개발 환경](CONTRIBUTING.md)
- [macOS Option/Alt 키 설정 (iTerm2)](docs/macos-option-key.md) · [GEO 가시성 벤치마크](docs/geobench.md)

기본 다크 TUI 아이덴티티는 GJC red-claw 테마이며, 라이트 계열 터미널은 번들된 blue-crab 테마가 기본입니다. 교체나 커스텀은 [테마](docs/theme.md)를 참고하세요.

## SDK 확장

### 로컬 커스터마이징: `/extensions`

대화형 세션에서 `/extensions`는 기본 커스터마이징 설정 화면입니다. 프로젝트(`<project>/.gjc/`)와 사용자 전역(`~/.gjc/agent/`) 범위의 스킬·훅·MCP를 구성하고, 상태·출처 진단, 활성화·비활성화·제거, Claude Code/Codex에서 가져오는 안내형 흐름(정규화된 미리보기, 명시적 확인, 충돌 시 건너뛰기·이름 변경·덮어쓰기 정책, 롤백 가능한 원자적 쓰기)을 제공합니다. 비대화형 설정에서는 MCP 서버에 `gjc mcp`, Claude Code/Codex 가져오기에 `gjc migrate`를 사용하세요.

### 스킬 마이그레이션 및 번들 스킬 검사

워크플로를 GJC로 옮길 때는 설치하거나 덮어쓰기 전에 번들 기본값을 먼저 검사하세요:

```sh
gjc skills list
gjc skills read ralplan
gjc setup defaults --check
```

`gjc setup defaults`는 번들된 GJC 워크플로 스킬 4개를 사용자 `.gjc` 디렉터리에 설치하며, 기본적으로 기존 로컬 파일을 보존합니다. `--check`가 누락되었거나 다른 파일을 보고하면 먼저 `gjc skills read <name>`으로 내장 사본과 비교하세요. 로컬 기본 워크플로 스킬 파일을 의도적으로 교체할 때만 `gjc setup defaults --force`를 사용하세요.

## 기존 에이전트·봇과 함께 쓰기

| 도구 또는 봇 | 권장 GJC 명령 | 경계 |
| --- | --- | --- |
| Codex CLI | `gjc --tmux --worktree <name>` 또는 `gjc` | `--worktree`는 GJC가 관리하는 인접 워크트리에 이름을 붙입니다. 기존 경로에서는 먼저 그곳으로 `cd`하세요. |
| Claude Code | `gjc --tmux` 또는 `gjc --tmux --worktree <name>` | GJC는 Claude Code 확장이 되지 않습니다. |
| OpenCode | `gjc` 또는 `gjc --tmux` | 현재는 외부 러너 워크플로만 지원합니다. |
| Claw Code | `gjc --tmux --worktree <name>` | GJC는 Claw Code에 설치되거나 이를 대체하지 않습니다. |
| [Paseo](https://paseo.sh) | `gjc setup paseo` | GJC가 ACP 프로바이더로 자신을 등록하고 `--remove`로 되돌립니다. Paseo 자체 설정 파일은 Paseo가 소유합니다. |
| [Orca](https://onorca.dev) | 커스텀 에이전트 명령으로 `gjc` | Orca가 자체 워크트리 터미널에서 GJC를 실행하고, GJC는 자체 승인 게이트를 유지합니다. |
| [T3 Code](https://t3.codes) | 아직 없음 — 실험적 | 업스트림에 GJC 하네스가 없습니다([제안](https://github.com/pingdotgg/t3code/discussions/7290)). 드라이버가 나올 때까지 GJC를 나란히 실행하세요. |
| 외부 컨트롤러 / 봇 | Coordinator MCP, `gjc sdk session`, 또는 구성된 관리형 어댑터 | 외부 컨트롤러는 스크롤백이나 직접 엔드포인트 전송 대신 브로커 바인딩·크리덴셜 없는 표면을 사용합니다. 호스트 중립적인 `gjc-sdk-*` 스킬은 `gjc sdk session`을 조합하며 Coordinator 통합을 설치하지 않습니다. |

옵트인 검색/컨텍스트 검색 사이드카로 Aside를 평가하려면 [`docs/aside-integration.md`](docs/aside-integration.md)를 참고하세요. 일반적인 서드파티 봇 설정과 프로바이더 독립 스모크는 [`docs/bot-integration.md`](docs/bot-integration.md), 외부 제어 준비도는 [`docs/external-control-readiness.md`](docs/external-control-readiness.md), 와이어 프로토콜 및 머신 인터페이스는 [`docs/sdk.md`](docs/sdk.md)를 참고하세요.

## SDK 확장 프로그램

- [gjc-remote](https://github.com/kogangdon/gjc-remote) — Discord에서 원격 호스트의 허용 목록 GJC 세션을 제어하는 실사용 SDK 확장입니다.
- [oh-my-gajae-code](https://github.com/devswha/oh-my-gajae-code) — 추가 워크플로 스킬과 슬래시 명령을 설치하는 커뮤니티 플러그인 마켓플레이스입니다.
- [gjc-agy-skill](https://github.com/jkf87/gjc-agy-skill) — Antigravity CLI를 통한 비전/OCR, 이미지 생성, Gemini print-mode 원샷 워크플로를 통합하는 서드파티 커뮤니티 GJC 스킬입니다.
- [GJC 멀티벤더 설정 가이드](https://github.com/project820/gjc-multivendor-setup-guide) — 멀티벤더 GJC 환경을 위한 역할 기반 프로바이더 프로필과 설치 가능한 모델 번들입니다.

## 설정

프로바이더 재시도 예산은 `~/.gjc/config.yml`에 있습니다:

```yaml
retry:
  requestMaxRetries: 4
  streamMaxRetries: 100
  maxRetries: 3
  maxDelayMs: 300000
```

`requestMaxRetries`는 스트림이 수립되기 전에 적용됩니다. `streamMaxRetries`는 재생 안전한 일시적 스트림 실패에만 적용됩니다. 잘못된 인증, 지원하지 않는 모델/프로바이더, 잘못된 요청, 컨텍스트 초과, 사용자 중단, 영구적인 할당량 실패는 계속 즉시 실패합니다.

### 시작 시 업데이트

대화형 시작은 기본적으로 백그라운드에서 더 새 GJC 버전이 있는지 GitHub 릴리스를 확인합니다. 이 검사는 알림 전용이며 변경하지 않습니다. GJC는 시작 중 스스로를 설치하거나 교체하지 않습니다. 지원 플랫폼에서는 `gjc update`가 일치하는 GitHub 릴리스 바이너리를 내려받아 원자적으로 교체합니다(패키지 매니저 shim은 덮어쓰지 않습니다). 소스 체크아웃과 `dev:link` 실행 파일은 해당 체크아웃을 통해 업데이트해야 하며, `gjc update`는 이를 스스로 덮어쓰지 않습니다. 지원하지 않는 플랫폼에서는 문서화된 설치기를 다시 실행하세요.

시작 시 확인을 끄려면 `gjc config set startup.checkUpdate false`를 실행하세요. 네트워크 실패는 시작을 막지 않도록 무시됩니다.

### 함께 읽으면 좋은 자료

- [GJC 멀티벤더 설정 가이드](https://github.com/project820/gjc-multivendor-setup-guide) — Anthropic, OpenAI/Codex, Google/Gemini, xAI/Grok, opencode-go 전반에서 역할별 프로바이더/프로필을 선택하는 커뮤니티 가이드입니다. 프리셋은 번들 기본값이 아니라 사용자 수준 설정 지침으로 취급하고, 도입 전에는 환경에서 모델 가용성과 프로바이더 인증을 확인하세요.

## TUI 아이덴티티

기본 다크 TUI 아이덴티티는 GJC red-claw 테마이고, 라이트 외관 터미널은 번들된 blue-crab 테마가 기본입니다. 추가 번들 마이그레이션 테마 `claude-code`, `codex`, `opencode`는 해당 도구의 외관을 따라가 눈에 익은 환경으로 쉽게 옮길 수 있으며 Settings 또는 `/theme`에서 선택합니다. 명시적인 사용자 테마 설정이 항상 우선합니다.

### 번들 테마 표

Settings(`Appearance -> Dark theme` / `Light theme`) 또는 `/theme`에서 고르세요.

| 테마 | 시각적 인상 | 적합한 경우 |
| --- | --- | --- |
| `red-claw` | 따뜻한 red-claw 포인트와 강한 상태 대비를 갖춘 다크 GJC 기본 테마. | 다크 터미널의 GJC 고유 아이덴티티. |
| `blue-crab` | 밝은 슬롯에서 읽기 좋도록 조정한 밝은 터미널용 블루 팔레트. | 라이트 터미널 또는 OS 외관. |
| `claude-code` | 테라코타·핑크 하이라이트를 갖춘 Claude Code 풍 다크 팔레트. | GJC 안에서 유지하는 Claude Code의 익숙함. |
| `codex` | 코딩 세션 대비를 또렷하게 한 선명한 다크 블루그레이 팔레트. | Codex 같은 다크 작업 공간. |
| `opencode` | 더 강한 터미널 포인트를 갖춘 OpenCode 풍 다크 팔레트. | 번들 피커에서 쓰는 OpenCode의 익숙함. |

## 문제 해결

도구, 스킬, 훅, 확장, 슬래시 명령, MCP 서버, 플러그인 번들이 예상대로 보이지 않으면 여기서 시작하세요:

```sh
gjc customize doctor         # 사람이 읽는 출처와 해결책
gjc customize doctor --json # CI/설정 도구용 안정적인 JSON
```

`gjc customize doctor`는 유일한 읽기 전용 문제 해결 표면입니다. 발견한 모든 커스터마이징, 출처 규약과 범위(`gjc`, Claude 프로젝트, Codex 프로젝트, 플러그인, 명시적 설정), 실제 우선순위 및 섀도잉, loaded/enabled/disabled/quarantined/rejected/stored-only 상태, 제한된 이유 코드, 해결 명령, 신뢰 요구사항, 재시작/새 세션 필요 여부를 보고합니다. 크리덴셜, 엔드포인트 토큰, 인증 헤더, 안전하지 않은 원시 설정 덤프는 절대 출력하지 않습니다.

## 개발

```sh
bun install
bun run build:native
bun run dev:link       # 전역 `gjc`가 이 체크아웃의 소스를 실행
bun run dev:doctor     # 링크 검증
```

패키지 맵과 게이트는 [CONTRIBUTING.md](CONTRIBUTING.md)와 [docs/codebase-overview.md](docs/codebase-overview.md)를 참고하세요.

## 기여자 & 계보

[Yeachan-Heo](https://github.com/Yeachan-Heo), [IYENTeam](https://github.com/IYENTeam), [HaD0Yun](https://github.com/HaD0Yun), [probepark](https://github.com/probepark), [snowykr](https://github.com/snowykr)에게 감사드립니다. 저장소 유지관리자와 GitHub 접근 권한은 [MAINTAINERS.md](MAINTAINERS.md)에 정리되어 있습니다. GJC는 작은 에이전트 하네스 계보에서 얻은 교훈 위에 세워졌으며, 역사적 어트리뷰션은 [NOTICE.md](NOTICE.md)에 있습니다.

## 라이선스

MIT. [LICENSE](LICENSE) 참고.

---

<p align="center">
  <em>"Encode intention. Decode software."</em>
  <br/><br/>
  <strong>계획이 먼저다. 변경은 자격을 증명해야 한다.</strong>
</p>
