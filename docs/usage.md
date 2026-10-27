# 실행 기반 사용법

프로젝트·그룹·목표 관리, 근거 수집·AI 계획, code-agent의 Claude·Codex 관리 실행, 위임 판단·정지·재부착, 독립 검증·반영 대조·통합 완료와 범위 내 복구를 제공한다. 전체 순서는 [README](../README.md), AI 연결은 [AI 계획 생성](ai-planning.md), 호스트 설정 주입·실제 접수·위임은 [code-agent 통신 계약](code-agent-control.md)을 따른다. 모의 실행은 실제 결과와 구분한다.

## 준비와 빠른 실행

Node.js 24.19 이상인 24.x와 Git이 필요하다. LangGraph 의존성을 잠금 파일 기준으로 설치하고 CLI를 등록한다.

```powershell
cd C:\IdeaProjects\master-agent
npm.cmd ci --ignore-scripts
npm.cmd install -g --ignore-scripts "C:\IdeaProjects\master-agent"
npm.cmd test
npm.cmd run check
npm.cmd run demo
```

데모는 `.master-agent/master.db`에 프로젝트 세 개와 고정 계획을 등록하고 구현 모의 작업 세 개 뒤 통합 모의 작업을 수행한다. 프로젝트 디렉터리는 `.master-agent/demo-projects` 아래에 생성한다. 재실행할 때는 별도의 예제 목표를 만든다. 상태 `simulation-complete`는 오케스트레이션 모의 실행 완료이며 실제 주문·환불 기능 구현 완료가 아니다.

```powershell
master-agent mission list
master-agent mission show <목표ID>
master-agent project list
master-agent group list
```

모든 명령은 `--db <경로>`로 저장소를 바꿀 수 있다. 기본 DB는 현재 작업 디렉터리의 `.master-agent/master.db`이므로 같은 작업을 조회할 때 동일한 절대 경로를 권장한다. 출력은 JSON이며 오류는 표준 오류에 코드와 메시지로 출력한다. `help`는 데이터베이스를 만들지 않는다. Windows 실행 정책이 막으면 `master-agent.cmd`를 사용한다.

`master-agent mission events prune <목표ID> --revision <버전>`은 종료 후 30일이 지난 목표의 오래된 이벤트를 정리한다. 종료 체크포인트 삭제와 근거·회차 저장 범위는 [기록 보존과 정리](langgraph.md#기록-보존과-정리)를 따른다.

`master-agent dashboard --db <DB 경로>`로 전체 등록 프로젝트의 로컬 웹 관제를 연다. 설치된 code-agent를 자동 탐색한다. 출력된 URL에 접속하며 Ctrl+C로 대시보드만 종료한다. 저장된 관측만 볼 때는 `--saved`를 쓴다. 모든 code-agent 연동 명령의 `--cli`는 별도 빌드 지정용 선택 옵션이며 환경 변수 `CODE_AGENT_CLI`보다 우선한다. 자세한 범위는 [대시보드](ui.md)를 따른다.

같은 `--db`를 지정해 `dashboard status`로 서버 상태를 확인하고 `dashboard restart`로 기존 설정을 유지해 재시작한다. `dashboard stop`은 대시보드만 종료한다. 시작·재시작 명령은 해당 터미널을 유지해야 한다. 등록 창의 설치 후보는 실행 중에도 자동 갱신되므로 새 프로젝트에 code-agent를 설치한 뒤 서버를 재시작할 필요가 없다.

## 서비스 그룹과 단일 프로젝트 요청

요청 실행기는 프로세스를 시작하기 전에 DB에서 실행 시작을 원자적으로 예약한다. 동시에 같은 요청을 시작해도 하나만 진행하며, 운영자가 초기화한 예약의 이전 실행기가 늦게 도착하면 실행하지 않는다.

웹의 프로젝트 등록·그룹 생성 및 편집은 [대시보드](ui.md#프로젝트와-서비스-그룹)를 따른다. 아래는 같은 카탈로그를 사용하는 CLI와 실제 실행 준비 절차다.

그룹은 서비스 유지보수 범위다. `group create <ID> <이름> --description <범위>`로 만들고 `group add/remove <그룹ID> <프로젝트ID> --revision <그룹버전>`으로 소속을 바꾼다. `group show <ID>`에서 최신 버전을 확인한다. 기존 `group save <JSON> --revision <N>`도 지원하며 JSON은 id, name, description, projectIds다. 빈 그룹 저장은 가능하지만 실행 요청은 거부한다.

```powershell
master-agent group request commerce "주문 취소 오류 수정" --task-number UZRF-392 --criterion "취소 회귀 통과" --host both --main claude --request-key cancel-fix-001
master-agent project request order-api "조회 오류 수정" --task-number UZRF-393 --criterion "조회 회귀 통과" --input request-options.json
master-agent request show <요청ID>
master-agent mission progress <요청ID>
master-agent request continue <요청ID> --revision <요청버전>
```

`--criterion`은 여러 번 지정할 수 있으며 criterion-1부터 ID를 부여한다. 생략하면 요청 원문을 request 완료 조건으로 보존한다. `--host claude|codex|both`로 이번 요청의 개발 host와 계획·판단 AI를 함께 정한다. `both`는 `--main claude|codex`가 필요하다. 단독 host는 교차 검증 없이 그 host가 모두 맡고, both는 주 host가 개발·계획·판단을 맡고 다른 host가 교차 검증한다. 그룹 요청은 모든 프로젝트에 같은 선택을 쓴다. 선택은 이 요청의 새 code-agent 실행에만 적용하고 프로젝트의 execution 설정은 바꾸지 않는다. 같은 code-agent 작업을 이어 가는 실행은 그 작업을 시작할 때의 선택을 유지한다. `--host`를 생략하면 개발 host는 프로젝트 execution 설정을, 계획·판단은 `--provider`(기본 claude)를 따른다. `--host`와 `--provider`는 함께 쓸 수 없다. 요청 ID는 목표 ID다. 그룹 구성은 접수 때 고정하며 같은 request-key와 같은 입력은 같은 요청을 반환한다. 동일 키의 다른 내용은 거부한다. `--revision`을 그룹 요청에 주면 접수 전 그룹 버전을 대조한다.

`--input`은 선택 설정 JSON이다. 예를 들어 `{ "taskNumber": "UZRF-392", "criteria": [{ "id": "cancel", "description": "취소 회귀 통과" }], "templates": [] }` 형태이며 검증 템플릿 배열은 [검증 계약 재사용](autonomous-progress.md)을 따른다. JSON에 `"host": { "mode": "both", "main": "codex" }`를 넣을 수도 있다. CLI의 --task-number, --criterion, --host, --main, --provider, --model, --request-key, --revision을 함께 주면 해당 옵션이 우선한다. both에서 `--model`은 주 host에만 적용하고 검토 host는 CLI 기본 모델을 쓴다. 요청 대상과 원문은 명령의 위치 인자를 사용한다. 대시보드에서도 같은 검증 설정을 전달할 수 있다.

선택 TASK 번호는 요청·목표 기록과 AI 계획·프로젝트별 개발 지시에 전달하고 이어 실행에서도 유지한다. 그룹의 하위 작업은 같은 번호를 참조하며 내부 작업·실행 ID를 대체하지 않는다. 형식은 영문·숫자로 시작하는 64자 이하의 영문·숫자·점·밑줄·하이픈이다. 같은 프로젝트의 TASK 번호는 대소문자를 구분하지 않고 고유하다. 다른 프로젝트에서는 같은 번호를 사용할 수 있다. 새 request-key로 같은 프로젝트·번호를 접수하거나 기존 그룹 요청의 일부 프로젝트에 같은 번호를 다시 접수하면 기존 목표 ID를 안내하고 거부한다. 완료한 목표의 번호는 재사용하지 않으며, 취소한 목표의 번호는 새 요청에서 재사용할 수 있다. 같은 request-key와 내용의 재전송은 기존 목표를 반환하고, 같은 키의 번호·내용 변경은 충돌로 거부한다. 후속 보완은 기존 목표의 질문·재계획·이어 실행 절차로 처리한다.

실행 전 준비는 다음과 같다.

1. 각 code-agent 프로젝트를 대시보드의 수동 등록 또는 `project add`로 등록한다. 요청 실행기는 최초 계획 전 표준 문서·빌드 설정을 수집하고, 해당 파일이 없으면 실제 최상위 폴더 목록을 관측한다. 상세 정책·코드는 `project collect`로 별도 지정할 수 있다. 수집 범위와 제한은 [AI 계획](ai-planning.md)을 따른다.
2. 프로젝트를 code-agent에 제어 연결한다. 페어링을 지원하면 PC당 한 번 프로젝트 카드의 PC 신뢰(확인 단어 `trust`) 또는 터미널의 `code-agent master trust --controller dashboard`로 신뢰한 뒤 프로젝트 카드의 제어 연결(또는 `project pair`)로 연결한다. 지원하지 않으면 사용자가 master 연동을 켜고 `project control`로 연결한다. 위임 grant는 따로 설정한다. 자동 탐색은 설치 경로만 찾으며 제어 권한을 대신 부여하지 않는다.
3. 요청의 완료 조건·작업 범위·검사 명령에 맞는 templates를 전달하거나 계획 후 `mission verification` / `mission verification-template`으로 보완한다.
4. 그룹·단일 요청을 보내면 별도 실행기가 근거·설치·제어 연결을 점검하고 AI 계획·검증 계약 연결·개발·검증·인계를 진행한다. 준비가 부족하면 `waiting`과 `실행 준비 필요`로 표시하며 공통 요청함에서 대상별 조치·보류·재점검을 제공한다. 초기 준비 오류로 실패했던 요청도 같은 요청함에 연결한다. 보완 후 요청함의 재점검 또는 `request continue`로 동일 목표를 이어간다. 업무 분석 질문은 공통 요청함 또는 `mission clarify`, code-agent 질문은 공통 요청함 또는 기존 relay로 답한다.

대시보드 종료는 접수한 작업을 중지하지 않는다. 실행 중인 작업의 중지는 기존 `mission stop`·`mission pause`를 사용한다. 실행기 로그는 DB 디렉터리의 request-logs에 저장한다. 프로세스가 사라진 요청은 interrupted로 표시하며 자동 재접수하지 않는다. 이어 실행도 기존 그래프 소유권과 프로젝트 잠금을 검사한다.

## 직접 목표와 계획 입력

예제 경로는 현재 작업 디렉터리를 기준으로 해석하므로 저장소 루트에서 실행한다.

```powershell
master-agent project add examples/project.json
master-agent mission create examples/mission.json
master-agent mission plan <목표ID> examples/plan.json --revision 1
master-agent mission step <목표ID> --simulate
master-agent mission show <목표ID>
master-agent mission run <목표ID> --simulate
```

프로젝트 등록은 중복 경로를 거부한다. 직접 목표를 접수할 때도 같은 requestKey와 내용은 기존 목표를 반환하며, 같은 키의 다른 내용은 오류다. 그룹 형식·버전과 접수 대상 고정 규칙은 위의 서비스 그룹 절차와 같다.

계획에는 모든 작업의 프로젝트·도메인·배정 이유·근거·선행 작업·완료 조건·허용 범위·산출물·검증 방법이 필요하다. 등록된 근거 ID에 없는 참조, 도메인 불일치, 미지원 기능, 순환 의존, 후행 검증 누락을 거부한다. 여러 프로젝트 계획에는 전체 작업과 완료 조건을 연결하는 통합 검증 작업이 필요하다.

프로젝트에 currentPlans가 있으면 관련 작업에 `planAcknowledgements`로 기존 계획 참조를 넣고 `coordination`으로 조정 내용을 설명한다. 규칙 검사는 참조와 설명의 존재를 확인한다. AI 분석은 수집된 근거로 조정 내용을 판단하며, 실제 프로젝트 작업과의 호환성 검증은 개발 실행 연결 단계에서 보완해야 한다.

모호함을 나타내는 unresolved가 비어 있지 않으면 계획 활성화를 거부한다. 직접 입력한 계획은 보완하고, AI 분석에서는 검증 오류와 미해결 사항을 모델에 전달해 재검토한다. 일반 정보 부족과 중대한 사람 판단을 구분하며 모든 계획에 사람 승인을 요구하지 않는다.

## 일시 정지와 재개

```powershell
master-agent mission show <목표ID>
master-agent mission pause <목표ID> --revision <조회한버전>
master-agent mission resume <목표ID> --revision <새버전>
master-agent mission cancel <목표ID> --revision <새버전> --reason "잘못 접수한 목표"
master-agent mission run <목표ID> --simulate
```

revision은 오래된 조작을 거부하는 상태 버전이며 승인 값이 아니다. 일시 정지는 새 배정을 막고 이미 실행 중인 작업의 결과는 기록한다. resume은 배정 가능 상태로 바꾸며 모의 실행을 이어가려면 run을 호출한다.

`mission cancel`은 종료 전 목표를 `cancelled`로 마감한다. 실행 중 시도는 먼저 `mission stop`으로 종료를 확인하거나 `mission unknown`으로 미확인을 기록한다. 취소는 해당 목표의 잠금을 모두 해제하고 진행 중 분석·복구 기록과 보류를 정리하며 결정과 사유를 보존한다. `--reason`을 생략하면 기본 취소 사유를 기록한다. 이미 종료한 목표의 취소는 거부한다. 취소한 목표의 TASK 번호는 새 요청에서 재사용할 수 있고 프로젝트 등록 해제를 막지 않는다.

실패가 확인된 모의 작업은 `mission retry <목표ID> <작업ID> --revision <버전>`으로 다시 대기 상태에 넣을 수 있다. 성공한 다른 작업은 반복하지 않는다. 새 계획은 `mission plan`으로 적용하며 이전 계획·시도·증거를 보존하되 모든 작업을 새로 검증한다. 영향받지 않은 증거를 골라 재사용하는 최적화는 아직 없다.

프로젝트 지식은 `project update <프로젝트ID> <JSON> --revision <버전>`으로 변경한다. 갱신 가능한 항목은 domains, capabilities, constraints, currentPlans, references다. 이 정보가 계획 이후 바뀌면 실행 전 재계획을 요구한다. 현재는 보수적으로 대상 스냅샷 안의 프로젝트 버전을 모두 비교한다.

프로세스 중단 후 남은 running 상태는 자동 재실행하지 않는다. `mission unknown <목표ID> <시도ID> --revision <버전>`으로 미확인을 기록할 수 있다. 호스트 반환 기록이 있는 일부 unknown 작업은 mission reconcile로 검증 단계에 복구한다. 목표를 폐기할 때는 `mission cancel`로 잠금을 해제한다. 상태 파일을 직접 바꾸는 복구 방식은 제공하지 않는다.

## code-agent 상태 조회

대시보드 또는 `project add`로 등록한 프로젝트를 조회한다. 설치된 code-agent는 자동 탐색한다.

```powershell
master-agent project observe <프로젝트ID>
```

설치 마커 `.code-agent/version`이 있어야 하며 지원하는 실행 진입점은 절대 경로의 `.js`, `.cjs`, `.mjs`, `.exe`다. `.cmd`·`.bat`는 실행하지 않는다. 마커는 조회 전 검사이며 전체 설치 무결성을 보장하지 않는다.

어댑터는 등록 경로를 cwd로 사용해 `status --json`만 실행한다. code-agent.state 버전 1, 반환된 저장소 경로와 핵심 필드를 검사한다. 설치 없음, JSON 오류, 버전 불일치, 시간 초과, 관측 불가를 구별한다. 마지막 관측은 그대로 보존하되 최신 조회 실패를 정상으로 표시하지 않는다. OS 프로세스 생존은 이 조회로 확인할 수 없다.

실제 CLI와의 읽기 계약 시험은 임시 Git 저장소에서 실행할 수 있다.

```powershell
node scripts/smoke-code-agent.mjs C:/IdeaProjects/code-agent/dist/agent/cli.js
```

이 시험은 상태 조회 전후 파일이 바뀌지 않는지 확인한다. 실제 호스트 설치·개발·승인 전달 시험은 아니다.

## code-agent 통신 계약

사람이 연동을 켜고(터미널 `code-agent master enable` 또는 확인한 페어링) 위임 권한(`code-agent master grant`)을 준 경우에만 쓴다. 연결은 승인 권한이 아니다. `project pair`는 TTY에서 확인 내용을 보여 주고 확인 단어 `pair`를 받은 뒤에만 연결한다.

```powershell
master-agent project pair <프로젝트ID> --db <현재 대시보드 DB>
master-agent project control <프로젝트ID> --controller <제어자ID> --token-file <절대경로>
master-agent mission drive <목표ID> --control --provider claude
master-agent mission escalations <목표ID>
master-agent mission stop <목표ID> <시도ID> --mode pause
```

원자적 접수·이벤트 재동기화·재부착·정지·위임 판단·제어권 인계의 조건은 [code-agent 통신 계약 연동](code-agent-control.md)을 따른다.

## 구현 경계

`mission verification-template`으로 재사용 범위를 등록하면 drive가 새 계획의 일치하는 작업에 검증 계약을 자동 연결한다. 일반 복구 보류는 프로젝트·의존 작업으로 제한하고 기존 승인 후 ready 상태를 같은 세션에서 자동 재개한다. [자동 진행 보완](autonomous-progress.md)에 계약과 실제 호스트 시험 결과를 정리했다.

읽기 전용 분석은 `mission stop-analysis <목표ID> <분석ID> --revision <버전>`으로 결과 적용을 취소한다. 검증 명령이 모두 반환했지만 관측·저장이 중단된 unknown 시도는 `mission reconcile-verification`으로 새 검증에 연결한다. [분석·검증 중단 처리](interruption.md)의 조건을 따른다. 두 명령은 개발 프로세스의 강제 종료를 수행하지 않는다.

배정 전 `delivery` 검증 계약을 등록하면 handoff에서 code-agent 커밋의 동의 기록과 반영 후 테스트를 대조한다. 호스트 반환 뒤 관측이 끊긴 unknown 시도는 `mission reconcile`로 실행 없이 검증 단계에 복구할 수 있다. 적용 조건과 증거 수준은 [반영 기록·관측 복구](delivery-reconciliation.md)를 따른다.

재계획으로 보류된 실패 시도는 `mission replan <목표ID> <시도ID> --revision <버전> --expect-state <상태버전> [--provider claude|codex]`로 인계한다. provider가 있는 drive도 외부 종료 확인 후 같은 흐름을 사용한다. [재계획 인계](replanning.md)의 보존·재수집·재분석 계약을 따른다.

규칙 판단은 Decision.actor=rule-engine, 검증된 AI 계획 활성화는 ai+validator, 사용자 질문 응답은 human, 검증 계약 등록은 operator로 기록한다. 카탈로그의 도메인·기능·수집 경로는 직접 지정하며 AI가 수집된 코드·문서를 근거로 프로젝트 역할과 계획을 생성한다. 실제 검증은 파일 스냅샷과 독립 명령의 조건별 결과·산출물 해시를 보존한다. 사용법은 [실제 검증과 자동 진행](live-verification.md)을 따른다.

`mission drive`는 가능한 배정·검증·인계·후행 작업을 진행하고 `--provider` 지정 시 [검증 실패 복구](recovery.md)를 수행한다. 개별 복구는 `mission recover`로 실행한다. 제공 기능과 남은 작업은 [구현 현황](implementation.md), 화면 조작 범위는 [대시보드](ui.md)를 기준으로 한다.
