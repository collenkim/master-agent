# 실행 기반 사용법

프로젝트·그룹·목표 관리, 근거 수집·AI 계획, Claude 개발 호스트, code-agent 통신 계약의 위임 판단·정지·재부착, 독립 검증·반영 대조·통합 완료와 범위 내 복구를 제공한다. 전체 순서는 [README](../README.md), AI 연결은 [AI 계획 생성](ai-planning.md), 실제 접수·위임은 [code-agent 통신 계약](code-agent-control.md)을 따른다. 모의 실행은 실제 결과와 구분한다.

## 준비와 빠른 실행

Node.js 24.19 이상인 24.x와 Git이 필요하다. LangGraph 의존성을 잠금 파일 기준으로 설치한다.

```powershell
cd C:\IdeaProjects\master-agent
npm.cmd ci --ignore-scripts
npm.cmd test
npm.cmd run check
npm.cmd run demo
```

데모는 `.master-agent/master.db`에 프로젝트 세 개와 고정 계획을 등록하고 구현 모의 작업 세 개 뒤 통합 모의 작업을 수행한다. 프로젝트 디렉터리는 `.master-agent/demo-projects` 아래에 생성한다. 재실행할 때는 별도의 예제 목표를 만든다. 상태 `simulation-complete`는 오케스트레이션 모의 실행 완료이며 실제 주문·환불 기능 구현 완료가 아니다.

```powershell
node apps/cli/main.mjs mission list
node apps/cli/main.mjs mission show <목표ID>
node apps/cli/main.mjs project list
node apps/cli/main.mjs group list
```

모든 명령은 `--db <경로>`로 저장소를 바꿀 수 있다. 출력은 JSON이며 오류는 표준 오류에 코드와 메시지로 출력한다. `help`는 데이터베이스를 만들지 않는다.

## 직접 목표와 계획 입력

예제 경로는 현재 작업 디렉터리를 기준으로 해석하므로 저장소 루트에서 실행한다.

```powershell
node apps/cli/main.mjs project add examples/project.json
node apps/cli/main.mjs mission create examples/mission.json
node apps/cli/main.mjs mission plan <목표ID> examples/plan.json --revision 1
node apps/cli/main.mjs mission step <목표ID> --simulate
node apps/cli/main.mjs mission show <목표ID>
node apps/cli/main.mjs mission run <목표ID> --simulate
```

프로젝트 등록은 중복 경로를 거부한다. 같은 requestKey와 내용의 목표 접수는 기존 목표를 반환하며, 같은 키의 다른 내용은 오류다. 그룹 JSON은 `id`, `name`, `projectIds`로 구성해 `group save <JSON>`으로 저장한다. 그룹 수정에는 마지막 revision을 전달한다. 목표 접수 때 고정한 대상 목록은 이후 그룹 변경으로 바뀌지 않는다.

계획에는 모든 작업의 프로젝트·도메인·배정 이유·근거·선행 작업·완료 조건·허용 범위·산출물·검증 방법이 필요하다. 등록된 근거 ID에 없는 참조, 도메인 불일치, 미지원 기능, 순환 의존, 후행 검증 누락을 거부한다. 여러 프로젝트 계획에는 전체 작업과 완료 조건을 연결하는 통합 검증 작업이 필요하다.

프로젝트에 currentPlans가 있으면 관련 작업에 `planAcknowledgements`로 기존 계획 참조를 넣고 `coordination`으로 조정 내용을 설명한다. 규칙 검사는 참조와 설명의 존재를 확인한다. AI 분석은 수집된 근거로 조정 내용을 판단하며, 실제 프로젝트 작업과의 호환성 검증은 개발 실행 연결 단계에서 보완해야 한다.

모호함을 나타내는 unresolved가 비어 있지 않으면 계획 활성화를 거부한다. 직접 입력한 계획은 보완하고, AI 분석에서는 검증 오류와 미해결 사항을 모델에 전달해 재검토한다. 일반 정보 부족과 중대한 사람 판단을 구분하며 모든 계획에 사람 승인을 요구하지 않는다.

## 일시 정지와 재개

```powershell
node apps/cli/main.mjs mission show <목표ID>
node apps/cli/main.mjs mission pause <목표ID> --revision <조회한버전>
node apps/cli/main.mjs mission resume <목표ID> --revision <새버전>
node apps/cli/main.mjs mission run <목표ID> --simulate
```

revision은 오래된 조작을 거부하는 상태 버전이며 승인 값이 아니다. 일시 정지는 새 배정을 막고 이미 실행 중인 작업의 결과는 기록한다. resume은 배정 가능 상태로 바꾸며 모의 실행을 이어가려면 run을 호출한다.

실패가 확인된 모의 작업은 `mission retry <목표ID> <작업ID> --revision <버전>`으로 다시 대기 상태에 넣을 수 있다. 성공한 다른 작업은 반복하지 않는다. 새 계획은 `mission plan`으로 적용하며 이전 계획·시도·증거를 보존하되 모든 작업을 새로 검증한다. 영향받지 않은 증거를 골라 재사용하는 최적화는 아직 없다.

프로젝트 지식은 `project update <프로젝트ID> <JSON> --revision <버전>`으로 변경한다. 갱신 가능한 항목은 domains, capabilities, constraints, currentPlans, references다. 이 정보가 계획 이후 바뀌면 실행 전 재계획을 요구한다. 현재는 보수적으로 대상 스냅샷 안의 프로젝트 버전을 모두 비교한다.

프로세스 중단 후 남은 running 상태는 자동 재실행하지 않는다. `mission unknown <목표ID> <시도ID> --revision <버전>`으로 미확인을 기록할 수 있다. 호스트 반환 기록이 있는 일부 unknown 작업은 mission reconcile로 검증 단계에 복구한다. 반환 기록 없는 실행·검증 프로세스의 잠금 해제는 제공하지 않는다. 상태 파일을 직접 바꾸는 복구 방식은 제공하지 않는다.

## code-agent 상태 조회

실제 프로젝트의 절대 경로와 도메인 정보를 JSON으로 작성해 등록한 뒤 실행한다.

```powershell
node apps/cli/main.mjs project observe <프로젝트ID> --cli C:/IdeaProjects/code-agent/dist/agent/cli.js
```

설치 마커 `.code-agent/version`이 있어야 하며 지원하는 실행 진입점은 절대 경로의 `.js`, `.cjs`, `.mjs`, `.exe`다. `.cmd`·`.bat`는 실행하지 않는다. 마커는 조회 전 검사이며 전체 설치 무결성을 보장하지 않는다.

어댑터는 등록 경로를 cwd로 사용해 `status --json`만 실행한다. code-agent.state 버전 1, 반환된 저장소 경로와 핵심 필드를 검사한다. 설치 없음, JSON 오류, 버전 불일치, 시간 초과, 관측 불가를 구별한다. 마지막 관측은 그대로 보존하되 최신 조회 실패를 정상으로 표시하지 않는다. OS 프로세스 생존은 이 조회로 확인할 수 없다.

실제 CLI와의 읽기 계약 시험은 임시 Git 저장소에서 실행할 수 있다.

```powershell
node scripts/smoke-code-agent.mjs C:/IdeaProjects/code-agent/dist/agent/cli.js
```

이 시험은 상태 조회 전후 파일이 바뀌지 않는지 확인한다. 실제 호스트 설치·개발·승인 전달 시험은 아니다.

## code-agent 통신 계약

사람이 대상 프로젝트에서 `code-agent master enable`로 연동을 켜고 위임 권한(`code-agent master grant`)을 준 경우에만 쓴다. 연결은 승인 권한이 아니다.

```powershell
node apps/cli/main.mjs project control <프로젝트ID> --cli C:/IdeaProjects/code-agent/dist/agent/cli.js --controller <제어자ID> --token-file <절대경로>
node apps/cli/main.mjs mission drive <목표ID> --cli C:/IdeaProjects/code-agent/dist/agent/cli.js --control --provider claude
node apps/cli/main.mjs mission escalations <목표ID>
node apps/cli/main.mjs mission stop <목표ID> <시도ID> --cli C:/IdeaProjects/code-agent/dist/agent/cli.js --mode pause
```

원자적 접수·이벤트 재동기화·재부착·정지·위임 판단·제어권 인계의 조건은 [code-agent 통신 계약 연동](code-agent-control.md)을 따른다.

## 구현 경계

`mission verification-template`으로 재사용 범위를 등록하면 drive가 새 계획의 일치하는 작업에 검증 계약을 자동 연결한다. 일반 복구 보류는 프로젝트·의존 작업으로 제한하고 기존 승인 후 ready 상태를 같은 세션에서 자동 재개한다. [자동 진행 보완](autonomous-progress.md)에 계약과 실제 호스트 시험 결과를 정리했다.

읽기 전용 분석은 `mission stop-analysis <목표ID> <분석ID> --revision <버전>`으로 결과 적용을 취소한다. 검증 명령이 모두 반환했지만 관측·저장이 중단된 unknown 시도는 `mission reconcile-verification`으로 새 검증에 연결한다. [분석·검증 중단 처리](interruption.md)의 조건을 따른다. 두 명령은 개발 프로세스의 강제 종료를 수행하지 않는다.

배정 전 `delivery` 검증 계약을 등록하면 handoff에서 code-agent 커밋의 동의 기록과 반영 후 테스트를 대조한다. 호스트 반환 뒤 관측이 끊긴 unknown 시도는 `mission reconcile`로 실행 없이 검증 단계에 복구할 수 있다. 적용 조건과 증거 수준은 [반영 기록·관측 복구](delivery-reconciliation.md)를 따른다.

재계획으로 보류된 실패 시도는 `mission replan <목표ID> <시도ID> --revision <버전> --expect-state <상태버전> --cli <경로> [--provider claude|codex]`로 인계한다. provider가 있는 drive도 외부 종료 확인 후 같은 흐름을 사용한다. [재계획 인계](replanning.md)의 보존·재수집·재분석 계약을 따른다.

규칙 판단은 Decision.actor=rule-engine, 검증된 AI 계획 활성화는 ai+validator, 사용자 질문 응답은 human, 검증 계약 등록은 operator로 기록한다. 카탈로그의 도메인·기능·수집 경로는 직접 지정하며 AI가 수집된 코드·문서를 근거로 프로젝트 역할과 계획을 생성한다. 실제 검증은 파일 스냅샷과 독립 명령의 조건별 결과·산출물 해시를 보존한다. 사용법은 [실제 검증과 자동 진행](live-verification.md)을 따른다.

mode=live 목표는 등록·AI 분석·계획 검증과 Claude 호스트 배정·관측·계속 실행, 검증 계약 등록·독립 테스트·로컬 인계·완료 판정을 지원한다. `mission drive`는 가능한 배정·검증·인계·후행 작업을 자동 진행하며 `--provider` 지정 시 [검증 실패 복구](recovery.md)를 수행한다. 개별 복구는 `mission recover`로 실행한다. code-agent 통신 계약 경로(`--control`)는 사람이 준 권한 범위의 위임 판단, 실행 정지·취소, 재시작 뒤 재부착, 제어권 인계를 지원한다. UI·HTTP 서버, API 기반 모델 연결, 원격 러너·운영 예산은 구현하지 않았다.
