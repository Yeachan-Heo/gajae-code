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
  <a href="https://discord.gg/8vPXmxSt9"><img alt="Discord" src="https://img.shields.io/badge/Discord-join-5865F2?style=flat-square&logo=discord&logoColor=white"></a>
</p>

<p align="center">
  <a href="#빠른-시작">빠른 시작</a> ·
  <a href="#왜-gajae-code인가">왜</a> ·
  <a href="#쓰던-코딩-플랜-그대로">코딩 플랜</a> ·
  <a href="#휴대폰으로-답하기">휴대폰</a> ·
  <a href="#변경-전에-계획">워크플로</a> ·
  <a href="#토큰을-덜-쓰기">토큰 다이어트</a> ·
  <a href="#openclaw--hermes가-gjc를-부리게-하기">컨트롤러</a> ·
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

**설치** — Linux(x64/arm64), macOS(arm64/x64), Windows(x64) 프리빌드 바이너리 제공. npm/Bun 경로는 어디서나 동작:

```sh
bun install -g gajae-code
gjc
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

나이틀리 채널: `bun install -g gajae-code@nightly`. 전체 설치 매트릭스, Windows 설정, 업데이트 채널, 셸 자동완성: [docs/install.md](docs/install.md).

**한국어 실행 명령어** — `가재씨`를 `gjc` 대신 사용할 수 있습니다:

```sh
가재씨 --version
```

`가재씨`는 설치 시 패키지 bin 항목으로 함께 생성되며, `gjc`와 완전히 동일하게 동작합니다. Linux·macOS(UTF-8 로케일)에서 지원됩니다.

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
                         └─ 병렬 tmux 워커가 도움이 될 때만 선택적 team 실행
```

| 표면 | 역할 |
| :--- | :--- |
| `deep-interview` | 모호한 요청을 구체적인 요구사항으로 바꿉니다. |
| `ralplan` | 코드 변경 전에 구현 계획을 세우고 비평합니다. |
| `ultragoal` | 실행·수정·검증·증거까지 목표를 추적합니다. |
| `team` | 병렬화가 가치 있을 때 tmux 기반 워커를 조율합니다. |
| `executor` / `architect` / `planner` / `critic` | 구현 및 읽기 전용 리뷰 레인을 위한 번들 역할 에이전트. |

옵트인 기능: **`gjc rlm`** (노트북과 리포트를 합성하는 Jupyter 스타일 리서치/REPL 모드), **`computer-use`** (실험적 데스크톱 제어). [Python REPL](docs/python-repl.md), [docs/tools/computer.md](docs/tools/computer.md) 참고.

---

## 토큰을 덜 쓰기

GJC는 토큰 비용의 양쪽을 모두 최적화합니다:

- **캐시 히트** — 프로바이더별 `cacheRetention` 제어. Anthropic은 짧은 캐시가 긴 에이전트 실행에 취약하므로 기본이 장기(1시간) 캐시 유지입니다. 프로바이더 랭킹은 저렴한 `cacheRead` 경로를 우선하고, 옵트인 session-affinity 헤더로 OpenAI 호환 릴레이가 서버측 프롬프트 캐시를 재사용할 수 있습니다.
- **컨텍스트 절약** — 파일 읽기는 전체 파일 대신 구조 요약을 반환하고, 과대한 셸 출력은 컨텍스트를 채우는 대신 최소화되어 회수 가능한 `artifact://` 참조로 넘어갑니다. 컴팩션과 브랜치 요약이 긴 세션을 윈도 안에 유지하면서 이전 작업 맥락을 잃지 않게 합니다.

[캐시 유지 & 프로바이더 호환](docs/models.md) · [컴팩션 & 브랜치 요약](docs/compaction.md)

---

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
(`sdk.promptDeadlineMs`, 기본 30분)이며 `sdk.promptMaxRuntimeMs`(기본 6시간)로 상한이 잡힌다. 갱신은 해당 턴에
귀속되는 툴 실행만으로 이루어지고, 하트비트나 스트리밍 텍스트로는 갱신되지 않는다.

세션 하나가 아니라 여러 워크트리에 이벤트 기반으로 펼쳐야 한다면, 네이티브
[Coordinator MCP 브리지](docs/hermes-mcp-bridge.md)(`gjc mcp-serve coordinator`, `gjc setup hermes`로 설치)가
그 형태의 위임 도구를 제공한다.

- [외부 컨트롤러 / 봇 통합 가이드](docs/bot-integration.md) — 프로바이더 독립 스모크; [`docs/aside-integration.md`](docs/aside-integration.md)는 옵트인 검색/컨텍스트 사이드카를 다룬다
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
<td>T3 Code는 아직 Codex·Claude·Cursor·Grok·OpenCode 하네스만 제공하고 GJC 하네스가 업스트림에 없다. 지금은 나란히 띄워 쓰고, 네이티브 프로바이더는 작업 중이다.</td>
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

Orca는 필드 하나다: GJC를 설치(`bun install -g @gajae-code/coding-agent`)하고 커맨드 `gjc`에 인자 없이 커스텀
에이전트를 추가한다. Orca는 권한 우회 플래그가 있는 에이전트에 그 플래그를 미리 넣어 주는데, GJC는 설계상 그런
플래그가 없다 — 인자는 비워 두고 GJC 자체 승인 게이트를 그대로 살려 둔다.

**[전체 통합 가이드 → docs/terminal-app-integrations.md](docs/terminal-app-integrations.md)** — 호스트별 설정,
검증, 취소 의미, 트러블슈팅 표, 그리고 각 호스트가 아직 닿지 못하는 영역까지.

---

## 문서

**[gajae-code.com](https://gajae-code.com)** 또는 `docs/`에서 시작하세요:

- [설치 & 업데이트](docs/install.md) · [환경 변수](docs/environment-variables.md) · [키바인딩](docs/keybindings.md) · [테마](docs/theme.md)
- [모델 & 프로바이더](docs/models.md) · [커스텀 프로바이더 & 멀티 계정 라우팅](docs/custom-providers-and-multi-account.md) · [멀티 벤더 프로필](docs/multi-vendor-profiles.md) · [Auth 브로커](docs/auth-broker-gateway.md)
- [텔레그램](docs/telegram-onboarding.md) · [봇 통합](docs/bot-integration.md) · [SDK](docs/sdk.md) · [SDK 세션 CLI](docs/sdk-session-cli.md)
- [세션](docs/session.md) · [컴팩션](docs/compaction.md) · [메모리](docs/memory.md) · [시크릿](docs/secrets.md)
- [코드베이스 개요](docs/codebase-overview.md) · [기여 / 개발 환경](CONTRIBUTING.md)
- [macOS Option/Alt 키 설정 (iTerm2)](docs/macos-option-key.md) · [GEO 가시성 벤치마크](docs/geobench.md)

기본 다크 TUI 아이덴티티는 GJC red-claw 테마이며, 라이트 계열 터미널은 번들된 blue-crab 테마가 기본입니다. 교체나 커스텀은 [테마](docs/theme.md)를 참고하세요.

## SDK 확장

- [gjc-remote](https://github.com/kogangdon/gjc-remote) — Discord에서 원격 호스트의 allowlist된 GJC 세션 제어.
- [oh-my-gajae-code](https://github.com/devswha/oh-my-gajae-code) — 추가 스킬과 슬래시 커맨드를 위한 커뮤니티 플러그인 마켓플레이스.
- [GJC 멀티벤더 설정 가이드](https://github.com/project820/gjc-multivendor-setup-guide) — 멀티벤더 설정을 위한 역할 기반 프로바이더 프로필.

## 개발

```sh
bun install
bun run build:native
bun run dev:link       # 전역 `gjc`가 이 체크아웃의 소스를 실행
bun run dev:doctor     # 링크 검증
```

패키지 맵과 게이트는 [CONTRIBUTING.md](CONTRIBUTING.md)와 [docs/codebase-overview.md](docs/codebase-overview.md)를 참고하세요.

## 기여자 & 계보

[Yeachan-Heo](https://github.com/Yeachan-Heo), [IYENTeam](https://github.com/IYENTeam), [HaD0Yun](https://github.com/HaD0Yun), [probepark](https://github.com/probepark)에게 감사드립니다. GJC는 여러 에이전트 하네스에서 얻은 교훈 위에 세워졌으며, 역사적 어트리뷰션은 [NOTICE.md](NOTICE.md)에 있습니다.

## 라이선스

MIT. [LICENSE](LICENSE) 참고.

---

<p align="center">
  <em>"Encode intention. Decode software."</em>
  <br/><br/>
  <strong>계획이 먼저다. 변경은 자격을 증명해야 한다.</strong>
</p>
