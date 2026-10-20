# 공통 질문·선택·승인 요청함

기준일: 2026-10-20. 실제 연결 계약과 지원 범위를 정리한다. 조작은 [README](../README.md#공통-질문승인-요청함)와 [대시보드](ui.md#공통-요청함), 시험 결과는 [검증 기록](verification.md)을 따른다. code-agent 정본은 설치된 소스의 `doc/dashboard-interactions.md`다.

## 선행 API 확인

연결 진입점은 설치 탐색으로 찾은 code-agent CLI다. 검증한 로컬 빌드는 1.0.0·stateSchema 7·interaction schema 1이며, 출처는 [검증 기록](verification.md)에 남긴다. 패키지 버전만으로 지원 여부를 판정하지 않는다.

`hello.result.codeAgent.stateSchema >= 7`, `hello.result.interactions.schemaVersion === 1`, `humanChannel: dashboard-human`, `signature: Ed25519`, 아래 명령을 함께 확인한다. 프로젝트 식별자는 `hello.result.project.projectId`다.

| code-agent 명령 | master 연결 |
| --- | --- |
| `hello` | 공개 기능 조회. 미지원이면 기존 질문/동의 관측만 제공 |
| `interactions` | 변경 피드·커서·sourceInstanceId 저장. 페이지당 200건, 한 관측에서 최대 5페이지 후 다음 관측에서 계속 |
| `interaction` | 제출 직전 원본 요청·권한·문맥 재확인 |
| `interaction.respond` | 명시적 화면 제출을 서명하고 전송함 저장 후 전송 |
| `interaction.result` | 대기·응답 수신·소비·적용·재개 상태 대조 |

어댑터는 `packages/code-agent-adapter/interactions.mjs`, 저장·정규화·응답 서비스는 `packages/dashboard/interactions.mjs`다. 질문 원장·동의 파일을 master가 직접 수정하지 않는다.

## 사람 채널

사용자가 프로젝트 폴더에서 `code-agent master enable`과 `code-agent master human enable`을 직접 TTY로 수행한다. 기존 제어자가 있으면 동일 ID로 사람 채널을 추가한다. master의 `project control`에는 기존 제어 토큰 파일을 연결한다. 연결 명령 전체는 [README](../README.md)에 있다.

서버는 같은 OS 계정의 `~/.code-agent/dashboard-channels`에서 해당 channelId의 키 파일 하나를 찾는다. 개인 키·토큰 값은 DB·브라우저·로그·모델 프롬프트에 저장하지 않는다. 키 경로는 브라우저 입력으로 받지 않는다. 사람 채널 만료·회수·소유권 세대 변경은 code-agent의 기존 검사를 따른다. 재연결 없이 AI grant로 대신 승인하지 않는다.

화면은 loopback 서버의 정확한 Host/Origin·CSRF 토큰·JSON 요청 경계를 사용한다. 일반 모델 실행 경로에는 서명 함수를 연결하지 않는다. 서버와 같은 OS 계정을 침해한 프로세스까지 격리하는 인증 체계는 아니다.

## 요청과 전송의 보존

- code-agent 요청 키는 프로젝트 ID·sourceInstanceId·requestId다. 복사된 원장이나 동일 TASK 번호를 다른 프로젝트와 합치지 않는다. master 요청은 목표·분석/복구 실행·질문 ID로 식별한다.
- 원본 질문·추천·근거·선택 조건·프로젝트/그룹 범위·작업/시도/세션·브랜치·HEAD·버전·해시를 보존한다. 작업 ID 없는 독립 설정·운영 질문도 수집한다.
- 제출 직전 표시 버전·내용 해시·문맥과 원본 상태를 대조한다. 수정 중 질문이 바뀌면 기존 입력을 유지하되 제출을 막고 다시 확인하게 한다.
- commandId·입력 해시·정확한 서명 envelope를 전송 전에 SQLite에 저장한다. 같은 명령의 다른 답은 거부하고, 두 탭의 중복 제출을 막는다. 전송 실패는 자동 성공 처리하지 않는다.
- 미확인 전송은 같은 commandId로 명시적으로 재시도한다. 재시작 뒤에도 저장된 envelope를 사용한다. 원래 receipt/application/continuation을 대조하며 수신과 적용·재개를 구분한다.
- 전송·수신 후 적용이 미확인인 프로젝트의 삭제·업데이트를 막고, 업데이트 중에는 답변을 새로 전송하지 않는다. 그룹 편집은 이미 접수한 목표 범위를 변경하지 않는다.

## 화면과 원래 처리기

| 요청 | 화면과 적용 |
| --- | --- |
| code-agent 일반 질문 | 10개 단계 공통 수집. single/multiple/text, 추천 ID·이유·근거·결과, 옵션별 입력·직접 입력·명시적 제출 |
| code-agent 보류 | 원래 요청에 defer 전송. 최신 버전으로 reopen 후 다시 응답 |
| code-agent 동의 | 별도 전문 화면. 확인 체크·승인/수정 요청·모든 변경 후보의 적용/유지를 명시적으로 선택. 기본 승인 없음 |
| master 분석/재분석 질문 | 추천 문구와 선택지가 정확히 일치할 때만 기본 선택. 기존 Planner.clarify로 저장. 모든 답이 모이면 같은 목표·TASK의 실행기를 재개 |
| master 검증 실패의 정보/사람 질문 | 같은 시도·검증 실행에 답을 결속. 기존 Recovery가 파일·외부 상태·근거·범위·승인을 재검사한 뒤 복구 판단 |
| master 사람 이관 | 요청·판단 이유·근거 표시. code-agent 질문/동의의 원래 항목에서 처리하며 사람 이관 기록 자체를 승인으로 사용하지 않음 |

발행 주체·프로젝트·그룹·작업/TASK·단계·상태 필터, 새 요청·대기 시간·차단 대상·응답 이력을 제공한다. 추천 없는 질문을 임의로 추천하지 않는다. 다중 선택의 기본값은 명시된 defaultOptionIds만 사용한다. 열람·시간 경과·창 닫기는 제출이 아니다. master 및 구형 관측의 보류는 master 목록에만 저장한다.

code-agent 답은 원래 producer가 소비한다. 살아 있는 세션의 consume/complete와 저장된 관리 실행의 같은 세션 재개는 code-agent가 담당한다. 재개 가능 여부는 요청별 continuation 계약으로 확인한다. master는 새 개발 작업을 만들어 답을 복사하지 않는다. master 재개가 서버 종료로 미확인이면 기존 queued 실행만 대조·시작하며 이미 실행 중인 작업을 queued로 초기화하지 않는다.

## 확인한 범위와 남은 경계

두 격리 프로젝트에서 실제 CLI·서명·단계별 질문의 수신/소비/적용, 다중 입력·보류/재열기·브랜치 불일치·키 부재·문서 동의 적용을 확인했다. 실제 브라우저의 다중 질문과 승인 제출도 같은 API를 통과했다. 발행자와 최초 인증 정보는 합성 시험 fixture이며, 사용자 실제 TTY 등록이나 실제 모델의 전체 업무 완주를 검증했다고 보지 않는다.

- 세션 재개 가능 여부는 현재 code-agent의 기능 협상·요청별 continuation 계약을 따른다. Codex 관리 실행은 확정된 thread ID로 같은 세션을 재개하며, 독립 세션도 지원 범위와 복구 조건을 확인해야 한다. 열린 Claude 선택창을 외부에서 닫지 않으며, 원래 호스트 확인이 시작된 동의는 그 채널에서 마친다.
- 기존 메모리에만 있는 질문이나 준비 세션이 없는 요청은 복원하지 않는다. 원래 채널에서 처리하거나 원래 세션에서 재발행한다.
- CLI로 만든 master 목표는 답을 저장한 뒤 기존 분석/복구 CLI로 이어간다. 재계획 채택·질문과 무관한 작업 취소를 임의의 선택 답으로 실행하지 않는다.
- 실서비스 반영·운영 업데이트·플러그인 변경 및 두 실제 모델의 초기 설정부터 완료까지 연속 검증은 이번 계약 시험의 범위 밖이다. 기존 실제 모델 전체 흐름 기록과 구분한다.

## 재현

```powershell
npm.cmd test
npm.cmd run check
node scripts/check-interaction-support.mjs C:/IdeaProjects/code-agent/dist/agent/cli.js
node scripts/smoke-dashboard-interactions.mjs
node scripts/smoke-interactions-live.mjs C:/IdeaProjects/code-agent/dist/agent/cli.js
node scripts/smoke-interactions-live.mjs C:/IdeaProjects/code-agent/dist/agent/cli.js --browser --browser-only
```

실제 API 시험은 code-agent의 빌드된 시험 fixture를 사용하며 테스트 키·토큰을 저장소 밖 임시 디렉터리에 둔다. 브라우저 시험은 Windows Chrome을 사용하고 `CHROME_PATH`로 진입점을 바꿀 수 있다. 관리 프로젝트·code-agent 소스는 수정하지 않는다. 결과 JSON·화면은 `.master-agent`의 무시된 로컬 증거이며, 필요한 최신 결과만 [검증 기록](verification.md)에 요약한다.
