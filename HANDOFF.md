# t_f611090c — doctor restart lease expiry 진단 인계

## 판정 / STOP

Historical 최초 `session.list` 거절의 code/message는 원문에 없으며, 이번 실제 FS/native 실행에서는 재현되지 않았다. 제품 결함 / fixture 동기화 결함 / CI 환경 영향 중 하나로 확정할 증거가 부족하다. 수리 완료 또는 flake로 판정하지 않는다. STOP 사유는 최초 응답 및 native 완료와 reservation 해제의 실제 시간 순서가 historical 로그에 없는 구체적 관측 한계다.

`intent === null`은 cancellation 완료의 증명이 아니다. 아래 실제 코드 순서상 native unlink와 JS reservation 해제 사이에 관측 창이 존재한다. 이 창이 historical 거절을 발생시켰다는 것은 아직 가설이다. SDK enrollment와 공통 원인을 주장하지 않으며 #6699/#6915 lock, #6904 reload, #6907 C52를 수정하지 않았다.

## 실행 기준

- branch: doctor-lease-t_f611090c
- 실행 전 HEAD / origin/dev: 90621699835a312c2fb4b5c738a90240ae1c2229
- historical: f5ae6dc8dc00b5d5f6730a6d471112f2efd56d6e (run 39199582022, job 117896924170, attempt 1)
- Bun: 1.4.0 (34cbb9a40), Linux x64. mac 실행으로 간주하지 않았다.
- historical과 SHA는 다르다. test/doctor-broker-restart.test.ts, src/sdk/broker/broker.ts, src/sdk/broker/discovery.ts는 두 SHA 간 동일하다. crates/pi-natives/src/path_identity.rs에는 별도 exact-unlink/Windows error 관련 변경이 있다. 해당 전체 diff를 증거 폴더에 보존했다. native cancel 구간 자체는 이 diff에 없다. 전체 환경 동등성은 주장하지 않는다.
- 모든 shell 명령에 PORT_BASE=45080, COMPOSE_PROJECT_NAME=doctor-lease-t_f611090c를 export했다.

## 실행 결과 / AC1

명령: `bun test packages/coding-agent/test/doctor-broker-restart.test.ts`

1. 초기 호출: exit 1, 575ms. native addon 부재로 import 중단, 0 pass / 1 fail / 1 error. 실제 23개 case는 실행되지 않았다. lease failure의 재현으로 계산하지 않는다.
2. worktree-local `bun run build:native`: exit 0. 기존 workspace dependency가 있어 install/global link는 실행하지 않았다. 빌드가 만든 index.d.ts 공백 1줄 차이는 원상복구했다.
3. 준비 완료 후 전체 파일 유효 실행 1회: exit 0, 35.17s, 23 pass / 0 fail / 99 expect. 대상 expiry case 224.13ms; 명시적 lease cancellation case 49.41ms. 반복 재현 시도 없음.
4. `bunx --no-install biome lint packages/coding-agent/test/doctor-broker-restart.test.ts packages/coding-agent/src/sdk/broker/broker.ts packages/coding-agent/src/sdk/broker/discovery.ts`: exit 0, 3 files, no fixes.

23개 전수표는 증거 폴더의 cases.csv 및 cases.txt에 있다. source에서 임의 추정하지 않고 local 결과와 historical 해당 파일 구간을 파싱해 각각 23개 및 이름 일치를 검증했다. historical은 22 pass / 1 fail / 98 expect / 36.78s / file exit 1이다.

## 원문 타임라인 / AC2·AC3

historical-job.log의 원문 행 번호:

- 4431: 2026-10-19T05:01:31.3766338Z 전체 파일 START.
- 4439: 05:01:33.1493561Z 명시적 cancellation case pass (253.52ms).
- 4440–4458: 05:01:33.4492496Z 이후 expiry case assertion 출력. :193 intent-null 검사를 통과한 다음 :194 session.list의 `.ok`가 false였다. :194는 response를 저장/출력하지 않아 code/message는 알 수 없다. 실패 case 300.04ms.
- 4482–4486: 05:02:08.1619405Z 이후 22 pass / 1 fail, 23 tests, 36.78s.
- 9287–9290: shard에서 이 파일 exit=1, job exit=1.

실제 구현에서 보존해야 할 순서 (현재 dev 파일:줄, TS 3개 파일은 historical과 동일):

1. broker.ts:4402–4407 admission close, expiry timer 설정, in-memory #restart 저장. :4406 timer는 `void cancelRestart(...)`로 cancellation 완료를 기다리지 않는다.
2. broker.ts:4470–4479 current reservation을 유지한 채 retained publication.cancelRestartIntent()를 await한다.
3. discovery.ts:315–317은 native cancelRestartIntentAsync() 완료를 기다린다. crates/pi-natives/src/path_identity.rs:310–314는 blocking task를 사용하고 :394–398에서 serialized publication write를 실행한다.
4. 같은 Rust 파일 :2610–2622에서 identity-bound unlink (:2618, 실제 unlinkat :2655) → root.sync_all (:2621) → cancelled 반환 순서다. FS 이름이 사라진 뒤에도 native 작업/Promise 전달이 아직 끝나지 않았을 수 있다.
5. broker.ts:4480–4482는 위 await가 끝난 후 timer clear → #restart undefined → admission reopen을 한다. 따라서 :193 FS null은 :4481이 수행됐다는 barrier가 아니다.
6. broker.ts:5193–5199는 canonical ownership 검사, :5214–5215는 stopping/publication health 검사, :5216은 #restart 검사 순서다. reservation을 보기 전에 ownership 검사 자체도 await한다. 이 await 동안 cancellation이 끝나면 성공할 수 있으므로 위 창만으로 실패를 단정할 수 없다.
7. test:151–178 명시적 cancellation case는 :161에서 cancelRestart 완료를 await한 후 :164에서 session.list를 호출한다. expiry case :192–194는 sleep 150ms 및 FS null만 확인하고 cancellation 완료는 await하지 않는다. fixture의 관측 barrier 후보 차이이며 수정 제안의 확정 근거는 아니다.

최초 응답 후보 (소스상 가능한 거절 분기이며 관측된 응답으로 오인하면 안 됨):

- broker.ts:5199: unavailable / broker lock ownership is not held
- broker.ts:5215: unavailable / broker publication is unavailable
- broker.ts:5216: broker_restarting / broker restart is prepared

historical code/message: UNKNOWN (원문은 `.ok=false`만 기록).
local 대상 code/message: 해당 없음 (pass; response payload를 추가 계측하지 않음).
intent-null, publication health, reservation 해제의 historical 실제 상호 순서는 UNKNOWN이다. 상기 순서는 코드의 happens-before 제약이지 측정 타임라인이 아니다.

## 산출물

증거 디렉터리 (gitignored; 원문은 수정하지 않음):
`/home/probe/.hermes-wtpool/Yeachan-Heo_gajae-code/p4/artifacts/doctor-lease-t_f611090c/`

- historical-job.log: GitHub job 전체 원문 9307행. gh api --allow-escape-sequences로 확보. 이 옵션은 원문의 ANSI 보존용이며 테스트 변경이 아니다.
- historical-doctor-file.log: 해당 전체 파일 실행 구간 원문 추출.
- historical-excerpt.log: 원문 행 번호를 붙인 관련 발췌.
- historical-source.diff: historical → 현재 dev의 지정 코드 차이.
- full-file.log / full-file.exit: 초기 native import 오류.
- native-build.log: 실제 native 빌드 출력.
- full-file-native.log / full-file-native.exit: 준비 후 전체 파일 유효 실행.
- lint.log: targeted lint 원문.
- cases.csv / cases.txt: 23개 전수 비교표.
- environment.json / cleanup.json: 실행 기준 및 프로세스 정리 확인.

PM 경로 `/opt/data/kanban/boards/gajae-pr/workspaces/t_69994218/doctor-shard.log`는 이 host에 없었다. 대신 지정 GitHub job 원문을 직접 확보했다. 원문 로그는 위 gitignored 경로에 있으므로 runner는 worktree 정리 전에 함께 수거해야 한다.

## Assumptions

- isolation의 port 0 허용 조항을 적용했다. 원본 BrokerTransport는 transport.ts:72 기본값 0, :85–89 loopback ephemeral bind를 사용한다. 고정/default 프로젝트 포트를 사용하지 않았다. 45080..45099에 강제 고정하면 원본 fixture/자식 broker 설정을 바꿔야 하므로 하지 않았다.
- 초기 import 실패는 재현 retry가 아닌 실행 준비 문제로 분리한다. native 준비 후 전체 파일은 한 번만 유효 실행했다.
- 진단 전용 원문/문서 산출물만 인계하며 production/test 영구변경, PR, timeout/sleep/assert 변경은 금지로 해석했다.

## 우회

- AC1의 문자 그대로 총 1회 호출은 충족하지 못했다. 첫 호출이 native 부재로 collection 이전 중단되어 빌드 후 한 번 유효 실행했다. 두 로그 모두 보존했다.
- PM 로컬 근거 파일 부재는 지정 GitHub 원문 직접 확보로 대체했다.
- 최소 관측 instrumentation도 적용하지 않았다. 무계측 유효 실행에서 미재현이므로 반복/강제 지연으로 다른 실패를 만드는 대신 원래 응답 관측 한계를 STOP으로 채택했다.

## 정리 / 후속 판단

이 세션에서 시작한 외부 서버/컨테이너/워처는 없다. 테스트가 시작한 successor/fixture child는 테스트 정리 경로를 거쳤으며 완료 후 worktree cwd의 live Bun 프로세스는 0이다. 다른 실행의 broker/port/fixture를 조작하거나 kill하지 않았다. 빌드 addon은 이 worktree에만 남겼다. 임시 계측 diff는 없음; production/test 최종 diff는 없음.

PM 후속: 최초 거절 branch를 확정하려면 원실패 당시 response code/message 및 native cancel 완료 전후와 publication/reservation 상태의 같은 실행 내 관측이 필요하다. 현 증거만으로 product fix, fixture fix, 환경 탓 중 하나를 승인하지 않는다. SDK enrollment 관련 연계나 flake acknowledgment도 하지 않는다.
