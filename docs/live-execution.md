# 실제 개발 호스트 연결

master-agent는 live 목표의 준비된 작업을 code-agent 관리 실행으로 배정하고 실행 회차와 상태를 저장한다. CLI의 배정·계속 실행·검증·인계·복구·재계획·자동 진행에는 `--control`이 필요하다. 대시보드와 요청 실행기는 같은 관리 실행 계약을 사용한다. 연결과 host 선택은 [code-agent 통신 계약 연동](code-agent-control.md)을 따른다.

## 실행 계약

1. 프로젝트와 작업에 `code-agent:managed`, `code-agent:claude`, `code-agent:codex` 중 일치하는 실행 기능을 등록한다. 목표의 mode는 live여야 한다.
2. 대상 프로젝트를 code-agent에 제어 연결하고 지원되는 개발 호스트를 설치한다. master-agent가 실제 프로젝트의 호스트 설정을 자동으로 바꾸지 않는다.
3. code-agent 상태의 stateVersion과 master 목표 revision을 전달한다. master는 계획 근거·선행 작업·프로젝트 잠금을 검사하고 판단·입력 해시·실행 시도·대상 작업 ID를 트랜잭션으로 저장한다.
4. code-agent가 상태·작업·임대를 한 잠금 안에서 대조해 실행을 접수한다. 프롬프트는 주입된 호스트 지침과 `code-agent flow advance --json`의 절차를 따른다.
5. 실행 ID·세션·결과 요약·출력 해시와 실행 후 상태의 투영을 저장한다. 호출·관측 오류 원문은 DB와 모델 프롬프트에 넣지 않는다. 오류 코드와 스택 첫 줄은 요청 로그와 서버 진단 채널에만 남긴다.

## 배정과 계속 실행

```powershell
master-agent project observe <프로젝트ID>
master-agent mission show <목표ID>
master-agent mission dispatch <목표ID> <계획작업ID> --revision <목표버전> --expect-state <code-agent상태버전> --control
master-agent mission continue <목표ID> <시도ID> --revision <목표버전> --expect-state <현재code-agent상태버전> --control
master-agent mission drive <목표ID> --control --provider claude
```

code-agent CLI는 자동 탐색한다. 별도 설치는 `--cli <code-agent CLI 경로>`를 지정한다. 개발 호스트 실행 파일과 세션 관리는 code-agent가 담당한다. master-agent의 Claude 직접 실행 경로와 `--host-cli` 옵션은 제공하지 않는다.

빈 프로젝트에는 `MA-<UUID>` 작업 ID를 발급한다. 기존 작업을 연결할 때는 `--work <code-agent작업ID>`를 지정하고 작업 내용과 계획의 일치를 확인한다. 다른 작업·미완료 접수·열린 동의나 질문·다른 세션 임대가 있으면 새 배정을 거부한다.

계속 실행은 같은 작업과 기록된 세션을 사용한다. 질문·승인은 [공통 요청함](dashboard-interactions.md) 또는 기존 code-agent 호스트에서 처리한다. `mission clarify`는 계획 분석 질문용이다. 실제 작업이 시작된 뒤 새 계획으로 실행 시도를 덮을 수 없다.

## 상태와 잠금

| 작업 상태 | 의미 | 후속 동작 |
| --- | --- | --- |
| running | 관리 실행을 접수했거나 관측 중 | 응답 대기 또는 reattach |
| waiting-decision | 열린 동의·확인할 질문 존재 | 응답 뒤 현재 상태로 continue |
| blocked | 실행·재승인·재계획 조건 미충족 | 저장한 회차의 상태와 이유 확인 |
| awaiting-verification | 실행이 반환되고 해당 작업이 ready | 독립 검증 또는 같은 작업 계속 |
| verifying | 독립 검증 명령 실행 중 | 결과 대기 |
| verification-failed | 검증 실패 확인 | 명시적 수정·재검증 또는 근거 기반 복구 |
| verified | 파일 범위·테스트·승인 대조 통과 | 외부 작업 종료 후 handoff |
| succeeded | 검증된 로컬 산출물 인계 완료 | 잠금 해제·후행 작업 진행 |
| unknown | 실행 여부나 소유권 불명 | 부작용 확인; 자동 재실행 금지 |

검증과 인계가 끝날 때까지 프로젝트 잠금을 유지한다. 호스트 문장이나 종료 코드만으로 작업을 succeeded로 바꾸지 않는다. `pause`는 새 배정과 다음 검증 명령의 시작을 멈춘다. 실제 실행 정지는 `mission stop`을 사용한다. master 재시작 뒤에는 `mission reattach`로 저장한 실행에 다시 붙는다. 실행을 확인할 수 없으면 `mission unknown`으로 미확인을 기록하며 잠금은 유지한다. 목표 취소 조건과 잠금 해제는 [오케스트레이션](orchestration.md)을 따른다.

호스트의 정상 코드 변경은 초기 근거와 달라질 수 있다. 계속 실행은 동일 계획·카탈로그·작업·세션을 대조한다. 정책·계약 등 다른 근거 변경은 계속 실행을 막는다. 검증·인계는 [실제 검증과 자동 진행](live-verification.md), 실패 후 조치는 [복구](recovery.md)와 [재계획](replanning.md)을 따른다.
