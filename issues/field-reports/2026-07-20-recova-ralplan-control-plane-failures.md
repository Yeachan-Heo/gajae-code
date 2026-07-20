# RECOVA Ralplan 실사용 중 발견된 GJC 제어면 결함

## 문서 정보

- 발견일: 2026-07-20
- 발견 환경: `/Users/slit/dev/Recova_source`
- GJC 소스 저장소: `/Users/slit/dev/gajae-code`
- 성격: 실제 장시간 Ralplan dogfood 중 발견한 도구 스키마·CLI wrapper·workflow persistence 결함 묶음
- 영향받은 작업: RECOVA Agent/Brain/source-native Action 통합 계획
- 제품 코드 영향: 없음. RECOVA 제품 소스 구현이나 실행 승인은 시작되지 않았다.

## 요약

RECOVA에서 고위험 통합 작업을 `/skill:ralplan --deliberate`로 계획하던 중 다음 세 문제가 연쇄적으로 발생했다.

1. **현재 Agent에게 노출된 `ask` 도구 입력 스키마와 GJC의 실제 `ask.ts` Zod 계약이 다르다.**
   - 소스에서는 `deepInterview`, `intent_contract`, `intent_review`가 모두 optional이다.
   - 현재 세션에 노출된 API 도구 스키마에서는 이 필드들이 required처럼 나타났다.
   - required 스키마를 만족하려고 `intent_contract`와 `intent_review`를 같이 보내면 런타임은 둘이 mutually exclusive라며 거부한다.
   - 그 결과 일반 Ralplan 질문·승인 gate를 `ask`로 제출할 수 없었다.

2. **RECOVA 로컬 `gjc` wrapper가 `ralplan`과 `state` 관리 명령 앞에 `--mcp-config`를 잘못 삽입한다.**
   - 정상 명령 `gjc ralplan --write ...`가 실제로는 `REAL_GJC --mcp-config <path> ralplan --write ...` 형태가 된다.
   - CLI가 기대하는 subcommand 위치가 깨져 writer와 state 명령이 장시간 멈췄다.
   - 여러 Planner/Architect가 300초, 600초, 900초 timeout을 겪었다.

3. **Ralplan role-agent persistence 실패가 workflow 차원에서 빠르게 진단되거나 복구되지 않는다.**
   - 계획 내용 작성은 끝났지만 sanctioned writer가 timeout되면서 receipt가 남지 않았다.
   - 동일 연구를 수행한 fallback Planner가 반복 생성됐다.
   - 일부 Architect는 review artifact 내용을 완성했으나 persistence 실패 때문에 join gate에서 사용할 정식 receipt가 생기지 않았다.

첫 번째 문제는 GJC core의 **도구 스키마 직렬화·노출 경로** 문제로 보인다. 두 번째 문제는 RECOVA 프로젝트 wrapper 템플릿 결함이지만, GJC가 관리 명령 앞 global option 삽입에 취약하고 wrapper smoke가 이를 잡지 못했다는 점에서 GJC 통합 계약도 함께 점검해야 한다. 세 번째 문제는 Ralplan의 persistence failure UX와 복구 계약 문제다.

---

## 1. `ask` 노출 스키마와 실제 Zod 계약 불일치

### 기대 동작

일반 Ralplan 범위 질문은 Deep Interview 메타데이터 없이 다음처럼 호출할 수 있어야 한다.

```json
{
  "questions": [
    {
      "id": "ralplan_ceiling",
      "question": "실행 범위를 어떻게 확정할까요?",
      "options": [
        { "label": "G0+E0/E1만 먼저 구현" },
        { "label": "전체 범위를 더 정밀하게 계획" },
        { "label": "현재 계획을 보존하고 중단" }
      ],
      "multi": false,
      "recommended": 0,
      "workflowGate": {
        "stage": "ralplan",
        "kind": "question"
      }
    }
  ]
}
```

`deepInterview`는 Deep Interview round를 기록해야 할 때만 존재해야 한다.

### 실제 GJC 소스 계약

`packages/coding-agent/src/tools/ask.ts`의 현재 소스는 올바르게 optional로 선언돼 있다.

```ts
const DeepInterviewMeta = z
  .object({
    round_id: z.string().max(128).optional(),
    round: z.number().int().nonnegative(),
    component: z.string().min(1).max(128),
    dimension: z.string().min(1).max(128),
    ambiguity: z.number().min(0).max(1),
    intent_contract: DeepInterviewIntentContract.optional(),
    intent_review: DeepInterviewIntentReview.optional(),
  })
```

질문 객체에서도 다음과 같이 optional이다.

```ts
const QuestionItem = z.object({
  // ...
  deepInterview: DeepInterviewMeta.optional(),
  workflowGate: WorkflowGateMeta.optional(),
})
```

그리고 런타임 검증기는 의도적으로 다음을 강제한다.

```ts
if (value.intent_contract && value.intent_review) {
  context.addIssue({
    code: "custom",
    message: "intent_contract and intent_review are mutually exclusive",
  });
}
```

이 계약 자체는 타당하다.

### 실제 Agent에게 노출된 도구 스키마

문제가 발생한 세션에서 Agent가 받은 `ask` 도구 선언은 다음 구조였다.

- `questions[].multi` required
- `questions[].recommended` required
- `questions[].deepInterview` required
- `questions[].workflowGate` required
- `deepInterview.intent_contract` required
- `deepInterview.intent_review` required

즉 소스의 optional 정보가 도구 선언으로 변환되는 과정에서 소실됐다.

### 재현 결과

`intent_contract`와 `intent_review`를 둘 다 넣으면:

```text
Validation failed for tool "ask":
- questions/0/deepInterview/intent_contract: intent_contract requires Round 0 review-topology metadata
- questions/0/deepInterview: intent_contract and intent_review are mutually exclusive
```

Round 0용 placeholder를 넣어도:

```text
- intent_review requires a post-Round-0 answer
- intent_contract and intent_review are mutually exclusive
```

Round 1 이상으로 바꾸면:

```text
- intent_contract requires Round 0 review-topology metadata
- intent_contract and intent_review are mutually exclusive
```

따라서 노출된 required 스키마를 만족하면서 실제 런타임 검증도 통과하는 값이 존재하지 않는다.

### 영향

- 일반 Ralplan question gate를 열 수 없다.
- 최종 approval gate도 같은 `ask` 도구를 사용하므로 workflow 종료가 막힐 수 있다.
- Agent가 validation error를 보고 불필요한 Deep Interview metadata를 조작하게 유도한다.
- headless/RPC 클라이언트가 구조화된 workflow gate를 받지 못하고 plaintext 질문으로 퇴행할 수 있다.
- Ralplan은 “항상 `ask`로 최종 선택을 제시한다”는 자체 계약을 이행할 수 없다.

### 유력한 원인

`ask.ts`의 Zod 계약 자체가 아니라, Zod schema를 플랫폼/API tool schema로 직렬화하거나 도구 메타데이터로 전달하는 경로가 optional 속성을 required로 바꾸는 것으로 보인다.

확인할 후보:

- `AgentTool.parameters`에서 provider/tool declaration으로 변환하는 경로
- Zod 4 JSON Schema 변환기 설정
- strict tool schema 정규화 단계
- API 런타임이 optionalProperties를 required properties로 변환하는 adapter
- discoverable tool activation 시 원본 schema 대신 별도 generated schema를 사용하는 경로
- system/developer tool inventory 생성기

### 제안 수정

1. `askSchema`의 JSON Schema snapshot을 직접 생성해 optional/required 목록을 검증한다.
2. 실제 provider에 전달되는 최종 tool declaration을 fixture로 캡처한다.
3. 다음 필드가 `required`에 들어가지 않는지 단언한다.
   - `multi`
   - `recommended`
   - `deepInterview`
   - `workflowGate`
   - `round_id`
   - `intent_contract`
   - `intent_review`
4. `intent_contract`와 `intent_review`가 상호배타적인 현재 런타임 계약은 유지한다.
5. 일반 Ralplan 질문 fixture가 `deepInterview` 없이 통과하는 end-to-end test를 추가한다.

### 필요한 회귀 테스트

```text
ask schema export:
- plain question without deepInterview passes
- workflowGate-only Ralplan question passes
- deepInterview metadata without intent gate passes
- Round 0 intent_contract alone passes
- post-Round-0 intent_review alone passes
- contract + review together fails
- exported JSON Schema required[] matches Zod optionality
- provider-visible schema and local askSchema agree
```

관련 파일 후보:

- `packages/coding-agent/src/tools/ask.ts`
- `packages/coding-agent/test/tools/ask.test.ts`
- `packages/coding-agent/test/tools/provider-schema-compatibility.test.ts`
- `packages/coding-agent/test/workflow-gate-schema.test.ts`
- Agent tool schema를 provider declaration으로 변환하는 실제 소유 모듈

---

## 2. 프로젝트 GJC wrapper가 관리 subcommand 위치를 깨뜨림

### 배경

RECOVA는 저장소 안에서 GJC를 실행할 때 `.mcp.json`을 자동 로드하기 위해 `/Users/slit/.local/bin/gjc` wrapper를 설치한다.

템플릿:

```text
/Users/slit/dev/Recova_source/deploy/cbm-gjc-wrapper.sh
```

설치 결과:

```text
/Users/slit/.local/bin/gjc
```

### 현재 wrapper 동작

wrapper는 일부 GJC 자체 관리 명령만 MCP 주입에서 제외한다.

```bash
case "${1:-}" in
  mcp|config|setup|update|migrate|gc|--help|-h|--version|-v)
    run_gjc "$REAL_GJC" "$@"
    ;;
esac
```

그 외에는 Recova worktree에서 다음처럼 실행한다.

```bash
run_gjc "$REAL_GJC" --mcp-config "$MCP_CONFIG" "$@"
```

따라서:

```bash
gjc ralplan --write ...
```

는 다음으로 변환된다.

```bash
/Users/slit/.bun/bin/gjc \
  --mcp-config /Users/slit/dev/Recova_source/.mcp.json \
  ralplan --write ...
```

`gjc state ...`도 같은 방식으로 변형된다.

### 관찰된 증상

- `gjc ralplan --write ...`: 300초, 600초, 900초 timeout
- `gjc state ralplan get --json`: 30초 timeout
- role agent는 artifact를 완성했지만 receipt를 받지 못함
- wrapper를 우회하거나 명령 뒤에 명시적인 `--mcp-config`를 넣었을 때 일부 writer는 즉시 성공함
- `gjc ralplan --help --mcp-config <path>`는 정상적으로 help를 출력함

### 직접 원인

현재 CLI는 global option을 subcommand 앞에 삽입하는 형태를 해당 관리 명령 경로에서 안전하게 처리하지 못한다. wrapper는 이를 고려하지 않고 모든 일반 명령 앞에 `--mcp-config`를 삽입한다.

### 책임 경계

이 결함의 직접 소유자는 RECOVA의 wrapper 템플릿이다. 다만 GJC 측에서도 다음이 부족하다.

- global option 위치에 대한 명확한 CLI 계약
- wrapper/integration 작성자를 위한 안전한 invocation API
- `ralplan`, `state`, workflow writer 명령을 포함한 wrapper compatibility test
- 잘못된 option 위치에서 즉시 usage error를 내지 않고 장시간 대기하는 fail-slow 동작

### 제안 수정 — RECOVA wrapper

최소 수정:

```bash
case "${1:-}" in
  mcp|config|setup|update|migrate|gc|state|ralplan|deep-interview|ultragoal|team|--help|-h|--version|-v)
    run_gjc "$REAL_GJC" "$@"
    ;;
esac
```

더 안전한 방향은 subcommand별 예외 목록을 계속 늘리는 것이 아니라, MCP config를 지원하는 실행 명령만 allowlist하는 것이다. 실제 GJC 명령 구조에 맞춰 allowlist를 소스에서 확정해야 한다.

### 제안 수정 — GJC core

1. `--mcp-config`가 subcommand 앞·뒤 어디에 와도 동일하게 처리되도록 parser 계약을 명확히 하거나,
2. 지원하지 않는 위치라면 즉시 non-zero usage error를 반환한다.
3. workflow writer는 MCP startup을 전혀 필요로 하지 않는 관리 경로로 유지한다.
4. wrapper authors를 위한 문서 또는 `GJC_MCP_CONFIG` 환경변수처럼 위치 독립적인 공식 입력을 제공한다.

### 필요한 회귀 테스트

```text
wrapper smoke:
- gjc ralplan --help exits promptly
- gjc ralplan --write ... exits promptly and writes one receipt
- gjc state ralplan get --json exits promptly
- gjc --version exits promptly
- ordinary Recova agent invocation still receives the configured MCP file
- explicit --mcp-config is not duplicated
- invalid option placement fails fast instead of hanging
```

RECOVA 쪽 관련 파일:

- `/Users/slit/dev/Recova_source/deploy/cbm-gjc-wrapper.sh`
- `/Users/slit/dev/Recova_source/deploy/cbm-gjc-install.sh`
- `/Users/slit/dev/Recova_source/deploy/cbm-gjc-smoke.sh`

---

## 3. Ralplan persistence timeout과 fallback 폭증

### 기대 동작

Planner가 계획을 작성한 뒤 writer persistence가 실패하면 workflow는 다음 중 하나를 해야 한다.

1. 빠르게 명확한 persistence error를 반환한다.
2. 동일 Planner context를 유지한 채 bounded retry한다.
3. 상태와 artifact가 실제로 기록됐는지 확인한다.
4. 원인이 CLI invocation/wrapper인지 state lock인지 구분한다.
5. 불필요한 연구 재수행과 새 Planner 생성을 막는다.

### 실제 동작

이번 세션에서는 다음과 같은 fallback 계보가 생겼다.

```text
3-RecovaAgentIntegrationPlan
→ writer timeout
→ resume 실패

4-RecovaAgentPlanFallback
→ writer timeout
→ resume 실패

5-RecovaAgentPlanRealCli
→ restricted bash와 wrapper 우회 충돌
→ 여러 resume 실패

6-RecovaRalplanPlanner
→ 명시적 --mcp-config workaround로 최초 persistence 성공
```

이후에도 일부 Architect writer가 300초·600초·900초 timeout을 겪었다. review 본문은 완성됐으나 정식 receipt가 없어 join gate에서 직접 사용할 수 없는 경우가 있었다.

### 영향

- 수십 분의 불필요한 대기
- 동일 저장소 조사 반복
- role-agent 비용 증가
- Planner identity와 resumability 감사 정보가 복잡해짐
- 합의 loop가 실제 계획 품질보다 writer 신뢰성에 지배됨
- max iteration ceiling을 persistence 장애가 소모할 위험
- review artifact는 존재하지만 receipt schema 반환 실패로 task가 failed 처리되는 불일치

### 문제를 더 악화시킨 요소

- role agent restricted bash는 승인된 `gjc ralplan --write` prefix만 허용한다.
- 실제 바이너리 절대경로를 직접 호출하거나 `GJC_SESSION_ID`를 명령에서 설정하는 것은 차단된다.
- 프로젝트 wrapper가 고장 난 상황에서 role agent가 공식적으로 wrapper를 우회할 통로가 없다.
- tool response schema에 없는 `findings`를 반환한 Architect는 artifact persistence에 성공하고도 task 결과가 schema violation으로 failed 처리됐다.
- parent는 artifact 경로를 직접 읽어 결과를 복구할 수 있었지만, workflow join은 receipt-first 계약 때문에 취약해졌다.

### 제안 수정

#### A. Writer preflight

Ralplan role task 시작 시 다음을 5초 이내로 검사한다.

```text
- resolved gjc executable path
- wrapper 여부
- `gjc ralplan --help` 성공
- current session routing
- writer lock 상태
- sanctioned command prefix 호환성
```

실패하면 계획 연구 전에 즉시 멈추고 하나의 구조화된 blocker receipt를 반환한다.

#### B. Persistence timeout 상한

- 첫 writer timeout: 30초
- lock owner/progress가 확인되는 경우에만 제한적으로 연장
- 300/600/900초 blind retry 금지
- 같은 artifact digest를 가진 retry는 연구를 다시 수행하지 않음

#### C. Receipt recovery

writer 응답이 유실됐지만 artifact와 `index.jsonl`이 존재하면:

1. artifact digest 검증
2. index entry 확인
3. canonical receipt 재구성
4. `recovered_receipt: true` 표시

으로 task를 성공 복구할 수 있어야 한다.

#### D. Review task output 분리

role agent의 durable artifact에는 상세 findings를 자유롭게 넣되, task 반환 envelope는 receipt와 verdict만 projection해야 한다. 추가 필드 때문에 task 전체가 failed 처리되지 않도록 writer receipt projection을 런타임이 소유해야 한다.

#### E. Wrapper-independent management channel

restricted role agent는 관리 writer에 대해 PATH wrapper를 거치지 않는 canonical GJC management launcher를 사용해야 한다.

가능한 방향:

- GJC 런타임 내부 API로 writer 호출
- resolved real binary path를 runtime이 주입
- wrapper-safe management socket
- `gjc management ralplan-write` 같은 고정 내부 경로

role prompt가 절대경로나 env 우회법을 추측하게 만들면 안 된다.

### 필요한 회귀 테스트

```text
- broken PATH wrapper is detected before role research
- writer timeout produces bounded structured failure
- same digest retry resumes without re-research
- persisted artifact + lost stdout reconstructs receipt
- Architect artifact with rich findings returns receipt-only task envelope
- persistence failure does not consume a consensus review iteration
- fallback Planner is spawned only after verified context_unavailable/resume_failed
- role agent can persist even when user PATH contains a project wrapper
```

관련 파일 후보:

- `packages/coding-agent/src/gjc-runtime/ralplan-runtime.ts`
- role-agent restricted bash policy 소유 모듈
- task receipt/output projection 모듈
- Ralplan skill prompt
- Ralplan writer/index receipt parser
- workflow join gate 구현

---

## 4. 실제 사건 타임라인

### 초기 상태

- RECOVA `main@0977a77`
- 사용자가 Agent/Brain/Action 통합에 대해 deliberate Ralplan 시작 요청
- 제품 코드 mutation은 Ralplan 정책으로 차단

### Planner persistence 장애

1. 첫 Planner가 연구와 계획 작성을 완료했다.
2. `gjc ralplan --write`가 300초, 600초, 300초 timeout됐다.
3. state와 audit에는 hook activation만 있고 plan receipt가 없었다.
4. resume와 fallback을 반복했다.
5. wrapper가 `ralplan` 앞에 `--mcp-config`를 삽입한다는 사실을 발견했다.
6. explicit `--mcp-config`를 명령 뒤에 제공해 wrapper의 자동 삽입을 막은 새 Planner에서 persistence가 성공했다.

### Consensus loop

- Planner stage 1 작성
- Architect BLOCK, Critic ITERATE
- revision 2 작성
- Architect BLOCK, Critic ITERATE
- revision 3 작성
- Architect BLOCK, Critic ITERATE
- revision 4 작성
- Architect persistence timeout, Critic ITERATE
- revision 5 작성
- Architect persistence timeout, Critic ITERATE
- 5회 상한 도달

### `ask` 장애

Ralplan ceiling에서 사용자에게 범위 선택을 요청해야 했다. 일반 Ralplan `workflowGate` 질문을 보내려 했으나 현재 도구 선언이 `deepInterview`와 두 intent 객체를 required로 노출했다.

- 둘 다 포함: mutually exclusive
- Round 0: review 불가
- Round 1+: contract 불가
- placeholder: option/display 또는 recorder 조건 불일치

결국 구조화된 `ask` gate를 열지 못했다.

---

## 5. 우선순위 제안

### P0 — `ask` provider-visible schema 정합성

일반 Ralplan 질문과 approval gate가 막힌다. workflow 종료와 execution approval이 불가능해지는 핵심 제어면 결함이다.

### P0 — management command wrapper fail-fast/compatibility

workflow artifact persistence가 수십 분씩 멈춘다. 적어도 잘못된 option 위치는 즉시 실패해야 한다.

### P1 — Ralplan receipt recovery와 bounded writer retry

외부 wrapper나 stdout 문제 하나가 전체 consensus 비용을 폭증시키지 않도록 해야 한다.

### P1 — role-agent 반환 projection 강제

artifact 본문과 receipt envelope를 분리해 schema violation 때문에 완료된 review가 failed 처리되지 않게 해야 한다.

---

## 6. 완료 조건

이 이슈 묶음은 다음이 모두 충족돼야 해결된 것으로 본다.

1. 실제 Agent에게 노출된 `ask` schema에서 optional 필드가 required로 변하지 않는다.
2. `deepInterview` 없는 Ralplan question/approval gate가 실제 세션에서 성공한다.
3. Round 0 contract와 post-Round-0 review가 각각 단독으로 성공한다.
4. project PATH wrapper가 있어도 `gjc ralplan --write`와 `gjc state`가 5초 내 정상 응답하거나 명확히 fail-fast한다.
5. writer stdout 유실 또는 timeout 후 persisted receipt를 복구할 수 있다.
6. 동일 계획 연구를 fallback Planner가 반복하지 않는다.
7. detailed Architect/Critic artifact와 receipt-only task envelope가 함께 정상 처리된다.
8. real-binary dogfood test가 위 세 경로를 한 번에 검증한다.

---

## 7. 비목표

- RECOVA의 Agent/Brain 아키텍처 자체를 이 문서에서 수정하지 않는다.
- Ralplan 리뷰어가 제기한 RECOVA 구현계획의 기술적 쟁점을 GJC 결함으로 취급하지 않는다.
- Deep Interview intent locking 규칙을 완화하지 않는다.
- `intent_contract`와 `intent_review`의 상호배타성을 제거하지 않는다.
- role-agent restricted bash를 일반 shell 권한으로 완화하지 않는다.
- 프로젝트 MCP 자동 로딩 기능 자체를 제거하지 않는다.

핵심은 기존 안전 규칙을 약화하는 것이 아니라, **소스 계약·provider-visible schema·CLI wrapper·workflow persistence가 동일한 계약을 따르게 만드는 것**이다.
