# 실제 개발 호스트 연결

master-agent는 live 목표의 준비된 작업을 프로젝트에 설치된 Claude Code·code-agent로 배정하고, 실행 회차와 상태를 저장한다. 호스트 시작, 작업 ID 연결, 승인 대기 관측과 같은 세션의 계속 실행을 지원한다. 사람이 code-agent 연동을 켠 프로젝트는 `--control`로 code-agent 통신 계약(원자적 접수·이벤트·정지·재부착·위임 판단·제어권 인계)을 쓴다 — [code-agent 통신 계약 연동](code-agent-control.md). 이 문서의 나머지는 직접 실행 호스트의 계약이다. 등록한 검증 계약에 따른 실제 테스트·산출물 검증과 후행 작업 자동 진행은 [실제 검증과 자동 진행](live-verification.md)을 따른다.

## 실행 계약

1. 프로젝트와 작업에 `code-agent:claude` 실행 기능을 등록한다. 목표의 mode는 live여야 한다. simulation 기능을 요구하는 작업은 배정하지 않는다.
2. 대상에는 Claude용 code-agent의 지침·skills·hook 설치가 필요하다. master-agent가 실제 프로젝트에 자동 설치하거나 설정을 바꾸지 않는다.
3. code-agent 상태를 조회하고 그 stateVersion과 master 목표 revision을 배정 요청에 전달한다. 시작 전 두 버전을 대조한다.
4. 계획 근거·선행 작업·프로젝트 잠금을 검사하고 판단·입력 해시·실행 시도·대상 작업 ID·초기 관측을 하나의 트랜잭션으로 저장한다.
5. 대상 경로에서 Claude를 실행한다. 프롬프트는 stdin으로 전달하고, 프로젝트 지침·skills·hook을 유지한다. 초기 분석용 도구 비활성화 provider와는 별도 러너다.
6. 호스트 세션 ID·요약·권한 거부 도구·출력 해시와 code-agent의 실행 후 상태를 같은 시도의 회차에 저장한다. 실행 실패는 원시 로그 대신 오류 종류를 남긴다.

Claude CLI는 `--print --output-format json --permission-mode manual`로 실행한다. 이 조합은 설치된 CLI의 `--help`에서 확인했다. 지원되지 않는 CLI 버전은 오류로 기록한다. 권한 우회·hook 비활성화·일괄 도구 허용 인자는 추가하지 않는다. 허용되지 않은 도구나 대화형 승인이 필요하면 기존 호스트에서 처리해야 한다. 비대화형 세션의 출력·세션 ID·재개 방식은 [Claude 공식 실행 문서](https://code.claude.com/docs/en/headless)를 참고한다.

## 배정과 계속 실행

```powershell
node apps/cli/main.mjs project observe <프로젝트ID> --cli C:/IdeaProjects/code-agent/dist/agent/cli.js
node apps/cli/main.mjs mission show <목표ID>
node apps/cli/main.mjs mission dispatch <목표ID> <계획작업ID> --revision <목표버전> --expect-state <code-agent상태버전> --cli C:/IdeaProjects/code-agent/dist/agent/cli.js
```

Claude를 자동 발견하지 못하면 `--host-cli <Claude exe 또는 JS 절대경로>`를 추가한다. `--model`을 생략하면 cli-default로 기록한다. 지정된 경로는 셸 래퍼가 아닌 실행 진입점이어야 한다.

빈 프로젝트에는 `MA-<UUID>` 작업 ID를 발급해 요구 접수를 지시한다. 이미 작업 중인 프로젝트를 명시적으로 연결할 때는 `--work <code-agent작업ID>`가 필요하다. 작업 내용과 배정 계획이 일치하는지 먼저 확인한다. 다른 작업, 미완료 접수, 열린 동의·질문, 다른 세션의 임대가 있으면 새 배정을 거부한다.

```powershell
node apps/cli/main.mjs mission continue <목표ID> <시도ID> --revision <목표버전> --expect-state <현재code-agent상태버전> --cli C:/IdeaProjects/code-agent/dist/agent/cli.js
```

계속 실행은 같은 code-agent 작업 ID와 기록된 Claude 세션 ID를 사용한다. `--resume`에 해당 세션을 전달하고, 임대 소유권도 그 세션과 대조한다. 질문·승인은 프로젝트 경로의 기존 Claude 세션에서 처리한 뒤 상태를 다시 조회한다. master의 `mission clarify`는 계획 분석 질문용이며 code-agent 동의 응답을 대신하지 않는다. 이미 시작된 실제 작업이 있으면 새 계획·재분석으로 시도를 덮을 수 없다.

## 상태와 잠금

| 작업 상태 | 의미 | 후속 동작 |
| --- | --- | --- |
| running | 판단 저장 후 호스트를 호출 중 | 응답·관측 대기 |
| waiting-decision | code-agent에 열린 동의·확인할 질문 존재 | 기존 호스트에서 처리 후 현재 상태로 continue |
| blocked | 호스트 권한 거부·미도입·재승인·재계획 등의 진행 조건 미충족 | 저장한 회차의 상태와 이유 확인 |
| awaiting-verification | 호스트가 돌아왔고 해당 작업이 ready | 후속 검증 필요; 필요하면 같은 작업 계속 |
| verifying | 독립 검증 명령 실행 중 | 결과 대기 |
| verification-failed | 명령 실패 확인 | 명시적 수정·재검증 또는 provider를 지정한 근거 기반 복구 |
| verified | 파일 범위·실제 테스트·승인 대조 통과 | 외부 작업 종료 후 handoff |
| succeeded | 검증된 로컬 산출물 인계 완료 | 잠금 해제·후행 작업 진행 |
| unknown | 호출·관측 실패, 다른 작업·세션 관측 등 실행 여부 불명 | 소유권·부작용 확인; 자동 재실행 금지 |

live 회차는 검증과 인계가 끝날 때까지 프로젝트 잠금을 유지한다. 호스트 문장이나 종료 코드만으로 작업을 succeeded로 바꾸지 않는다. `pause`는 새 배정과 다음 검증 명령의 시작을 멈추며 실행 중 프로세스를 취소하지 않는다. 프로세스가 중단된 뒤 running 또는 verifying이 남으면 `mission unknown`으로 미확인을 기록할 수 있지만 잠금은 풀리지 않는다.

## 남은 계약

- 직접 실행 호스트에서는 code-agent의 상태 조회와 호스트 시작 사이에 원자적 예약이 없다(통신 계약 경로는 code-agent가 한 잠금 안에서 접수한다). master DB 잠금은 같은 DB를 사용하는 master끼리 적용되며 독립적으로 열린 외부 호스트까지 잠그지는 못한다. 시작 직전 재조회와 기존 code-agent hook·임대를 함께 사용한다.
- 직접 실행 호스트에서는 요구 확정과 계획 승인 등에 실제 사람 응답이 필요하다. 위임 판단은 통신 계약 경로에서 사람이 code-agent에서 준 권한(행위·범위·만료·사용 횟수·회수) 안의 routine 판단에만 쓰며, master 판단 기록만으로 승인을 대체하지 않는다.
- 호스트의 정상 코드 변경은 초기 근거와 달라질 수 있다. 계속 실행은 동일 계획·카탈로그·작업·세션을 대조하고, 해당 프로젝트의 code 종류 근거와 이미 검증·인계한 프로젝트의 기준을 사용한다. 정책·계약 등 다른 근거 변경은 계속 실행을 막는다. 검증 계층은 파일 범위·테스트·현재 트리를 대조한다. 실패 후에는 [복구](recovery.md)와 종료 확인·변경 보존을 거치는 [재계획](replanning.md)을 사용한다.
- 직접 실행 호스트에서는 세션 종료 관측과 자식 프로세스 전체 종료 확인이 다르다. 통신 계약 경로에서는 code-agent 감독 프로세스가 생존 확인·협력 정지·확인된 프로세스의 강제 종료를 맡는다. 반환 기록 없는 unknown 해제, code-agent 동의의 UI 중계, Codex 개발 호스트 연결은 후속 범위다.

통신 계약 경로에서 실제 Claude 개발·위임 승인·독립 검증·로컬 반영·통합 완료를 확인했다. 직접 실행 호스트의 한계와 실제 모델 시험 범위는 [검증 기록](verification.md)을 따른다. 운영 조건과 수치는 확정하지 않는다.
