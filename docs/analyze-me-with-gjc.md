# Analyze Me with GJC

Use this prompt for meetup icebreakers where each participant asks GJC to introduce them from their own local GJC usage history.

The prompt is designed to be repeatable: it tells GJC what local artifacts to inspect, what patterns to extract, how to avoid leaking secrets, and how to turn the analysis into a short spoken self-introduction.

## Full prompt

```text
~/.gjc 에 있는 내 가재코드 사용내역을 바탕으로, 가재코드 밋업 아이스브레이킹용 “가재코드가 보는 나” 자기소개 글을 작성해줘.

목표:
- 내 실제 가재코드 사용패턴을 분석해서, 내가 어떤 개발자/빌더/운영자인지 소개하는 글을 써줘.
- 단순 통계 나열이 아니라, 사용 습관과 관심사에서 드러나는 성향을 해석해줘.
- 밋업에서 2~4분 정도 읽을 수 있는 분량으로 작성해줘.
- 너무 딱딱한 리포트 말고, 사람 소개글처럼 재미있고 선명하게 써줘.
- 과장하거나 없는 사실을 만들지 말고, 실제 ~/.gjc 기록에서 관찰된 패턴만 근거로 삼아줘.

분석 지시:
1. ~/.gjc 디렉터리 구조를 먼저 확인해줘.
2. 가능한 경우 아래의 안전한 메타데이터 중심 자료만 분석해줘:
   - ~/.gjc/agent/history.db 의 집계값
   - ~/.gjc/agent/sessions/**/*.jsonl 의 세션 메타데이터(세션 제목, timestamp, cwd, 메시지 수, tool-call 수, 파일 크기, subagent/task 이름)
   - ~/.gjc 내부의 추가 파일은 사용패턴 집계에 꼭 필요하고 민감정보가 없다고 판단되는 경우에만 읽어줘.
   - 기본적으로 ~/.gjc/logs/*, auth/config/credential 파일, env dump, raw tool-result body, raw prompt body, secret-like 값은 읽지 마.
3. history.db에서는 최소한 다음을 봐줘:
   - 전체 프롬프트 수
   - 기간 범위
   - 작업 디렉터리 / 레포지토리 분포
   - 자주 등장하는 주제어
   - 짧은 명령과 긴 프롬프트의 비율
   - /skill:ultragoal, /skill:ralplan, /skill:deep-interview, /skill:autoresearch 사용 빈도
   - continue, fix, review, merge, PR, CI, test, verify, implement, delegate 같은 실행/검증 관련 단어 빈도
4. sessions jsonl에서는 가능하면 다음을 봐줘:
   - 메인 세션 수
   - 서브에이전트 / task 세션 수
   - 짧은 세션과 긴 세션의 분포
   - 세션 title 또는 worktree 이름에서 보이는 관심사
   - 장기 실행, 병렬 위임, 검증, 리뷰, 릴리스 운영 흔적
5. 레포지토리와 주제 다양성을 꼭 반영해줘:
   - 어떤 레포지토리/워크트리에서 많이 일했는지
   - GJC core, 개인 프로젝트, 연구/quant, infra, UI, automation, image/media 등 주제 범위가 보이면 묶어서 설명해줘.
6. 민감정보는 절대 노출하지 마:
   - API key, 토큰, credential, 개인 연락처, 로컬 secret, private URL, 인증정보는 출력하지 마.
   - 프롬프트 예시는 필요할 때만 짧게 paraphrase해서 써줘.
   - 파일 경로나 레포 이름은 자기소개에 필요한 수준으로만 언급해줘.
   - 분석 중에도 민감정보를 모델 컨텍스트에 올리지 않도록 metadata-first / aggregate-only 방식으로 처리해줘.

출력 형식:

먼저 아주 짧게 “분석한 근거”를 3~6개 bullet로 요약해줘.
예:
- 분석 기간:
- 프롬프트 수:
- 주요 작업 공간:
- 세션 패턴:
- 자주 보인 workflow/skill:
- 주요 관심사:

그 다음 아래 제목으로 자기소개 글을 써줘:

# 가재코드가 보는 나

글 스타일:
- 한국어로 작성.
- 살짝 위트 있게.
- “당신은 …” 또는 “나는 …” 중 더 자연스러운 쪽을 선택해도 됨.
- 밋업에서 읽기 좋게 문단을 나눠줘.
- 너무 아부하지 말고, 사용패턴에서 드러나는 장점과 특이한 습관을 솔직하게 말해줘.
- 마지막에는 한 문장으로 요약해줘:
  “한 문장으로 말하면, 나는 ___ 하는 사람이다.”

추가로 마지막에 선택사항으로 아래 3개를 붙여줘:

## 10초 버전
한두 문장짜리 초단기 자기소개.

## 한 줄 별명
사용패턴 기반 별명 3개.

## 밋업용 오프닝 멘트
처음 인사할 때 바로 읽을 수 있는 20~30초짜리 멘트.

주의:
- 분석 없이 일반론으로 쓰지 마.
- 실제 ~/.gjc 기록을 읽고 나서 작성해.
- 숫자를 말할 때는 실제로 확인한 숫자만 써.
- 확인하지 못한 항목은 “확인 불가”라고 하지 말고, 그 항목을 빼고 자연스럽게 작성해.
```

## Short meetup prompt

Use this when participants need a shorter copy/paste prompt.

```text
~/.gjc 사용내역을 분석해서 밋업 아이스브레이킹용 “가재코드가 보는 나” 자기소개 글을 써줘.

반드시 실제 ~/.gjc 기록을 읽되, 안전한 메타데이터와 집계값 중심으로 근거 기반 작성해:
- history.db의 프롬프트 수, 기간, cwd/레포 분포, 자주 쓰는 단어, skill 사용량
- sessions jsonl의 세션 수, 세션 길이 다양성, subagent/task 사용 흔적
- 레포지토리/주제 다양성
- 짧은 명령 vs 긴 지시문 패턴
- 실행/검증/리뷰/PR/CI/릴리스/위임 습관

민감정보는 읽지도 출력하지도 마. API key, 토큰, private credential, 개인 secret, 긴 원문 프롬프트, raw tool-result body, ~/.gjc/logs/*, auth/config/env dump는 기본적으로 건너뛰고, 필요한 경우에도 안전한 집계값과 짧은 paraphrase만 써.

출력:
1. 분석 근거 bullet 3~6개
2. 제목: “가재코드가 보는 나”
3. 밋업에서 2~4분 읽을 수 있는 한국어 자기소개 글
4. 마지막에:
   - 10초 버전
   - 사용패턴 기반 별명 3개
   - 20~30초 오프닝 멘트

스타일:
- 재미있고 선명하게
- 과장 없이
- 통계 나열보다 “이 사람이 어떤 식으로 일하는 사람인지” 해석 중심
- 마지막 문장은 “한 문장으로 말하면, 나는 ___ 하는 사람이다.”
```

## Optional: GajaeTI prompt

A meetup host can also turn the same analysis into a playful, MBTI-like “GajaeTI” result. This is only an icebreaker taxonomy, not a psychological assessment.

```text
~/.gjc 사용내역을 안전한 메타데이터와 집계값 중심으로 분석해서, 밋업 아이스브레이킹용 “가재TI”를 만들어줘.

목표:
- MBTI처럼 4글자 코드와 타입명을 만들되, 실제 성격검사가 아니라 가재코드 사용패턴 기반의 재미있는 작업 스타일 분류로 작성해.
- 실제 ~/.gjc 기록에서 확인한 사용패턴만 근거로 삼아줘.
- 민감정보는 읽지도 출력하지도 마. API key, 토큰, private credential, 개인 secret, 긴 원문 프롬프트, raw tool-result body, ~/.gjc/logs/*, auth/config/env dump는 기본적으로 건너뛰고, 안전한 집계값과 짧은 paraphrase만 써.

먼저 아래 4개 축을 기준으로 타입을 판정해줘. 각 축은 한쪽을 고르되, 애매하면 근거와 함께 중간 성향이라고 설명해.

1. E / P — Execute vs Plan
   - E: fix, implement, merge, ship, PR, CI, release처럼 실행/운영 명령이 강함.
   - P: deep-interview, ralplan, spec, architecture, review처럼 계획/정의/합의 흐름이 강함.

2. S / M — Sprint vs Marathon
   - S: 짧은 명령, 빠른 follow-up, `continue`, 작은 세션이 많음.
   - M: 장기 세션, durable goal, 긴 프롬프트, 며칠짜리 작업 흐름이 많음.

3. C / D — Craft vs Delegate
   - C: 직접 구현/수정/탐색 중심.
   - D: subagent, executor, architect, critic, autoresearch, parallel delegation 사용이 강함.

4. X / O — Explore vs Operate
   - X: 새로운 모델/provider/tool/research/실험 주제가 많음.
   - O: PR, CI, release, changelog, version, production 운영/마감 흐름이 많음.

분석할 최소 근거:
- history.db의 프롬프트 수, 기간, cwd/레포 분포, 자주 쓰는 단어, skill 사용량
- sessions jsonl의 세션 수, 세션 길이 다양성, subagent/task 흔적
- 레포지토리/주제 다양성
- 짧은 명령 vs 긴 지시문 패턴
- 실행/검증/리뷰/PR/CI/릴리스/위임 습관

출력 형식:

# 나의 가재TI: <4글자 코드> — <타입명>

## 판정 근거
- E/P: <선택> — <실제 집계 또는 관찰 근거>
- S/M: <선택> — <실제 집계 또는 관찰 근거>
- C/D: <선택> — <실제 집계 또는 관찰 근거>
- X/O: <선택> — <실제 집계 또는 관찰 근거>

## 타입 설명
밋업에서 1분 정도 읽을 수 있게, 이 사람이 가재코드를 어떻게 쓰는 사람인지 재미있게 설명해줘.

## 강점
3개 bullet.

## 주의할 점
놀리는 느낌은 살짝 있어도 되지만, 비하하지 말고 작업 습관상 조심할 점 2~3개.

## 어울리는 밋업 별명
3개.

주의:
- 이건 성격검사가 아니라 사용패턴 기반 밋업 놀이야.
- 숫자는 실제로 확인한 값만 써.
- 확인하지 못한 축은 억지로 단정하지 말고 “근거 부족” 또는 “혼합형”이라고 써.
```
