# 공통 질문·선택·승인 요청함

기준일: 2026-10-23. 실제 연결 계약과 지원 범위를 정리한다. 조작은 [공통 요청함 화면](ui.md#공통-요청함), 시험 결과는 [검증 기록](verification.md)을 따른다. code-agent 정본은 설치된 소스의 `doc/dashboard-interactions.md`다.

## 선행 API 확인

연결 진입점은 설치 탐색으로 찾은 code-agent CLI다. 지원 여부는 프로젝트에 적용된 런타임의 공개 기능 조회로 판정한다. 패키지 버전이 같아도 프로젝트별 적용 릴리스와 지원 기능은 다를 수 있다.

`hello.result.codeAgent.stateSchema >= 7`, `hello.result.interactions.schemaVersion === 1`, `humanChannel: dashboard-human`, `signature: Ed25519`, 아래 명령을 함께 확인한다. 프로젝트 식별자는 `hello.result.project.projectId`다.

| code-agent 명령 | master 연결 |
| --- | --- |
| `hello` | 공개 기능 조회. 미지원이면 기존 질문/동의 관측만 제공 |
| `interactions` | 변경 피드·커서·sourceInstanceId 저장. 페이지당 200건, 한 관측에서 최대 5페이지 후 다음 관측에서 계속 |
| `interaction` | 제출 직전 원본 요청·권한·문맥 재확인 |
| `interaction.respond` | 명시적 화면 제출을 서명하고 전송함 저장 후 전송 |
| `interaction.result` | 대기·응답 수신·소비·적용·재개 상태 대조 |

어댑터는 `packages/code-agent-adapter/interactions.mjs`, 저장·정규화·응답 서비스는 `packages/dashboard/interactions.mjs`다. 질문 원장·동의 파일을 master가 직접 수정하지 않는다. 메모리에만 있는 질문이나 준비 세션이 없는 요청은 복원하지 않으므로 원래 채널에서 처리하거나 원래 세션에서 재발행한다.

## 사람 채널

사람 채널의 최초 등록·갱신과 기존 터미널 연결은 [제어 연결(페어링)](code-agent-control.md#제어-연결페어링)을 따른다.

준비 점검이 `제어 연결 가능`을 찾으면 준비 요청 항목에 `제어 연결 후 기존 요청 이어 실행`을 추가한다. 이 항목은 추천·기본 선택이 없다. 화면은 제출 전에 프로젝트별 연결 확인 화면을 띄우고, 서버는 대상 프로젝트의 연결이 모두 등록됐을 때만 재점검·재개를 접수한다. 연결이 없으면 `stale-question`으로 거부하고 접수 기록을 남기지 않는다.

서버는 같은 OS 계정의 code-agent 키 저장소(`CODE_AGENT_HOME` 또는 `~/.code-agent`)의 `dashboard-channels`에서 해당 channelId의 키 파일 하나를 찾는다. 개인 키·토큰 값은 DB·브라우저·로그·모델 프롬프트에 저장하지 않는다. 키 경로는 브라우저 입력으로 받지 않는다. 사람 채널 만료·회수·소유권 세대 변경은 code-agent의 기존 검사를 따른다. 재연결 없이 AI grant로 대신 승인하지 않는다.

화면은 loopback 서버의 정확한 Host/Origin·CSRF 토큰·JSON 요청 경계를 사용한다. 일반 모델 실행 경로에는 서명 함수를 연결하지 않는다. 서버와 같은 OS 계정을 침해한 프로세스까지 격리하는 인증 체계는 아니다.

## 요청과 전송의 보존

목록은 읽기 전용 `GET /api/interactions`로 상자·필터·페이지를 조회한다. 한 페이지는 기본 25건, 최대 100건이며 `total`·`page`로 이전·다음 이동을 계산한다. master 요청 동기화는 서버 시작·관측 변경·응답 제출 뒤에 수행하고 GET에서는 쓰기 트랜잭션을 열지 않는다. 전체 요청함을 overview에 포함하지 않는다. 열어 둔 항목과 다음 분석 질문은 별도 필드로 함께 조회해 페이지 변경 뒤에도 입력 초안·응답 결과를 유지한다. HTTP 인자와 응답은 [로컬 HTTP 계약](ui.md#로컬-http-계약)을 따른다.

브라우저에는 질문·선택 조건·응답 이력 등 화면이 쓰는 필드만 투영한다. 원격 `challenge`·`humanChannel`·서명 envelope와 알 수 없는 확장 필드는 전송하지 않는다.

원격 질문의 입력 길이는 0~8000(최대 길이는 1 이상), 선택 개수는 0~16의 정수이며 최소값이 최대값을 넘을 수 없다. 승인 선택 번호는 0~10000 정수로 제한한다. 위반 레코드는 `invalid-remote-question`으로 거부하고, 화면의 숫자 속성과 문구도 이스케이프한다.

- code-agent 요청 키는 프로젝트 ID·sourceInstanceId·requestId다. 복사된 원장이나 동일 TASK 번호를 다른 프로젝트와 합치지 않는다. master 요청은 목표·분석/복구 실행·질문 ID로 식별한다.
- 원본 질문·추천·근거·선택 조건·프로젝트/그룹 범위·작업/시도/세션·브랜치·HEAD·버전·해시를 보존한다. 작업 ID 없는 독립 설정·운영 질문도 수집한다.
- 작업 생성 전 준비 승인은 기록된 실행 ID·프로젝트·시도·세션이 일치할 때 기존 목표·TASK에 연결한다. 빈 작업 ID끼리 연결하지 않는다. 연결된 차단 안내는 원본 요청으로 이동하며 전체 요청함에서 중복 표시하지 않는다.
- 제출 직전 표시 버전·내용 해시·문맥과 원본 상태를 대조한다. master 요청은 목표뿐 아니라 질문을 만든 분석·복구·요청 레코드의 버전도 대조한다. 수정 중 질문이 바뀌면 기존 입력을 유지하되 제출을 막고 다시 확인하게 한다.
- commandId·입력 해시·정확한 서명 envelope를 전송 전에 SQLite에 저장한다. 같은 명령의 다른 답은 거부하고, 두 탭의 중복 제출을 막는다. 전송 실패는 자동 성공 처리하지 않는다.
- 서버 기동 시 전송 중(`sending`)이던 응답은 `unknown`으로 전환하고 저장된 envelope·commandId로 결과를 한 번 자동 확인한다. code-agent가 같은 명령의 영수증을 반환하므로 새 답변이나 서명을 만들지 않는다. 확인에 실패하면 미확인 상태와 수동 결과 확인·재시도 경로를 유지하며 다음 기동에서 자동 반복하지 않는다. 수신과 적용·재개는 별도 상태로 대조한다.
- `control-busy`처럼 명시적으로 거절된 응답은 오류 코드와 원문 사유를 보존한다. 접수되지 않은 답의 원본 `pending`은 응답 대기이며, 승인 적용이나 재개 성공을 의미하지 않는다.
- 전송·수신 후 적용이 미확인인 프로젝트의 삭제·업데이트를 막고, 업데이트 중에는 답변을 새로 전송하지 않는다. 그룹 편집은 이미 접수한 목표 범위를 변경하지 않는다.

원격 답변의 `optionInputs`는 객체이며 각 값은 8,000자 이하의 문자열이어야 한다. 다른 타입은 서명과 전송 기록 생성 전에 거부한다.

## 화면과 원래 처리기

| 요청 | 화면과 적용 |
| --- | --- |
| code-agent 일반 질문 | 10개 단계 공통 수집. single/multiple/text, 추천 ID·이유·근거·결과, 옵션별 입력·직접 입력·명시적 제출 |
| code-agent 보류 | 원래 요청에 defer 전송. 최신 버전으로 reopen 후 다시 응답 |
| code-agent 동의 | 별도 전문 화면. 확인 체크·승인/수정 요청·모든 변경 후보의 적용/유지를 명시적으로 선택. 기본 승인 없음 |
| master 분석/재분석 질문 | 추천 문구와 선택지가 정확히 일치할 때만 기본 선택. 기존 Planner.clarify로 저장. 모든 답이 모이면 같은 목표·TASK의 실행기를 재개 |
| master 분석 오류 | 오류 코드·사유와 분석 복구·재시도 표시. 분류만 잘못된 기존 결과는 최신 근거와 전체 검증을 통과할 때 새 분석 기록으로 복구하며 이전 기록 보존 |
| master 검증 계약 누락 | 대기 작업별 변경 파일·검사 명령·완료 조건·산출물 입력. 명시적 확인 후 모든 계약을 원자적으로 등록하고 같은 요청 재개 |
| 연결 없는 code-agent 요청 | 공개 상태의 interaction ID도 연결 안내로 표시. 질문 전문·선택지를 추측하지 않으며 연결 후 인증된 원본으로 교체 |
| master 검증 실패의 정보/사람 질문 | 같은 시도·검증 실행에 답을 결속. 기존 Recovery가 파일·외부 상태·근거·범위·승인을 재검사한 뒤 복구 판단 |
| master 사람 이관 | 요청·판단 이유·근거 표시. code-agent 질문/동의의 원래 항목에서 처리하며 사람 이관 기록 자체를 승인으로 사용하지 않음 |

필터·추천·선택·초안·응답 이력 조작은 [공통 요청함 화면](ui.md#공통-요청함)을 따른다. master 및 구형 관측의 보류는 master 목록에만 저장한다.

정보 질문과 중대한 판단 질문이 섞인 `needs-context` 결과는 질문·대안을 보존한 채 `needs-human`으로 분류하고 전체 분석 검증을 다시 적용한다. 미응답 질문이 남은 요청의 단순 이어 실행은 질문을 새로 생성하지 않는다. 모든 답변이 모이면 이전 답변 이력도 현재 요청의 완료·추가 조치 상태를 표시한다.

검증 계약 화면은 Gradle 빌드·설정 파일 또는 실행 스크립트를 감지하면 작업별로 `Gradle test`와 추천 근거를 표시하고 첫 검증 명령에 미리 채운다. 프로젝트의 `scripts/gradle.ps1`(Windows)·`scripts/gradle.sh`를 우선하고, 없으면 [Gradle Wrapper](https://docs.gradle.org/current/userguide/gradle_wrapper.html)의 `gradlew.bat`·`gradlew`를 사용한다. 빌드 파일만 있고 실행 경로가 없으면 추천과 수동 지정 안내를 표시한다. `spotbugsMain`·`compileJava`는 계획의 검증 설명에 명시된 경우 추가 후보로 제공한다.

계획의 파일 패턴은 제한된 탐색으로 기존 파일과 계획에 명시된 새 산출물 경로로 구체화하고, 실제 검증 계약에는 정확한 파일 목록을 등록한다. code-agent 문서·승인 기록 변경 허용과 계약 등록·재개는 명시적으로 확인한다. 일반 분석 답변은 계약 등록을 대신하지 않는다.

연결 안내는 적용 버전의 페어링 미지원과 아직 등록하지 않은 제어 연결을 구분한다. 구버전의 대기 질문과 업데이트 확인 절차는 [대시보드 연결 문제](ui.md#실행과-연결)를 따른다.

code-agent 답은 원래 producer가 소비한다. 살아 있는 세션의 consume/complete와 저장된 관리 실행의 같은 세션 재개는 code-agent가 담당한다. 재개 가능 여부는 요청별 continuation 계약으로 확인한다. master는 새 개발 작업을 만들어 답을 복사하지 않는다. master 재개가 서버 종료로 미확인이면 기존 queued 실행만 대조·시작하며 이미 실행 중인 작업을 queued로 초기화하지 않는다. Codex 관리 실행은 확정된 thread ID로 같은 세션을 재개하며 독립 세션은 지원 범위·복구 조건을 확인한다. 열린 Claude 선택창을 외부에서 닫지 않으며 원래 호스트 확인이 시작된 동의는 그 채널에서 마친다. CLI로 만든 master 목표는 답을 저장한 뒤 기존 분석·복구 CLI로 이어간다. 재계획 채택은 질문 답변으로 실행하지 않는다.

## 확인한 범위

두 격리 프로젝트에서 실제 CLI·서명·단계별 질문의 수신/소비/적용, 다중 입력·보류/재열기·브랜치 불일치·키 부재·문서 동의 적용을 확인했다. 실제 브라우저의 다중 질문과 승인 제출도 같은 API를 통과했다. 발행자와 최초 인증 정보는 합성 시험 fixture이며, 사용자 실제 TTY 등록이나 실제 모델의 전체 업무 완주를 검증했다고 보지 않는다.

후속 시험과 운영 검증은 [남은 작업](implementation.md#남은-작업)을 따른다.

## 재현

```powershell
npm.cmd test
npm.cmd run check
node scripts/check-interaction-support.mjs C:/IdeaProjects/code-agent/dist/agent/cli.js
node scripts/smoke-dashboard-interactions.mjs
node scripts/smoke-dashboard-verification.mjs
node scripts/smoke-interactions-live.mjs C:/IdeaProjects/code-agent/dist/agent/cli.js
node scripts/smoke-interactions-live.mjs C:/IdeaProjects/code-agent/dist/agent/cli.js --browser --browser-only
```

실제 API 시험은 code-agent의 빌드된 시험 fixture를 사용하며 테스트 키·토큰을 저장소 밖 임시 디렉터리에 둔다. 브라우저 시험은 Windows Chrome을 사용하고 `CHROME_PATH`로 진입점을 바꿀 수 있다. 관리 프로젝트·code-agent 소스는 수정하지 않는다. 결과 JSON·화면은 `.master-agent`의 무시된 로컬 증거이며, 필요한 최신 결과만 [검증 기록](verification.md)에 요약한다.
