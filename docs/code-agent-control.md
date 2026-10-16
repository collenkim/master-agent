# code-agent 통신 계약 연동

code-agent가 제공하는 master 통신 계약(`code-agent.master` v1, code-agent 저장소 `doc/master-control.md`)으로 실행을 접수·관찰·정지·재개·인계하고, 사람이 code-agent에서 준 권한 범위의 일상 판단을 위임 판단으로 보낸다. 기존 직접 실행 호스트(`ClaudeHost`)와 기존 명령의 동작은 그대로이며, `--control`을 붙인 명령과 이 문서의 명령만 이 경로를 쓴다.

## 역할과 적용 조건

| 주체 | 하는 일 |
| --- | --- |
| master-agent | 목표 분석·작업 배분·의존성·진행·재계획·독립 검증·전체 완료 판정, 위임 판단의 분류·이유·근거 기록 |
| code-agent | 프로젝트 안의 접수·계획·구현·검증·반영 절차와 승인 조건, 원자적 접수, 위임 판단의 범위 검증과 적용, 사람 응답과의 구분 기록 |
| code-agent 감독 프로세스 | 실행 세션(Claude) 시작·생존 확인·협력 정지·강제 종료·종료 기록 |
| 사람 | 연동 켜기·제어자 등록, 위임 권한(grant) 부여·회수, 중대한 판단, 강제 인계 |

1. 사람이 대상 프로젝트의 TTY에서 `code-agent master enable --controller <ID> --token-out <저장소 밖 파일>`로 연동을 켠다. 켜지 않은 프로젝트는 연결되지 않고(`control-not-enabled`) 기존 직접 실행 경로만 쓴다.
2. master는 `project control`로 제어자로 연결한다. 연결 기록에는 토큰 파일 경로만 남기고 토큰 값은 저장하지 않는다. **연결은 승인 권한이 아니다** — 위임 판단은 사람이 `code-agent master grant <권한.json>`으로 준 범위(동작·임무 또는 작업·경로·만료·사용 횟수)에서만 code-agent가 받는다.
3. 사람만 하는 동작(setup·docs·baseline·model·plugin·update·abort 등)과 master 실행이 준비하지 않은 확인 요청은 위임 대상이 아니다.

## 명령

```powershell
node apps/cli/main.mjs project control <프로젝트ID> --cli <code-agent cli.js> --controller <제어자ID> --token-file <절대경로>
node apps/cli/main.mjs project snapshot <프로젝트ID> --cli <경로>
node apps/cli/main.mjs mission drive <목표ID> --cli <경로> --control --provider claude [--poll-ms 2000] [--follow-timeout-ms 14400000]
node apps/cli/main.mjs mission dispatch <목표ID> <작업ID> --revision <N> --expect-state <버전> --cli <경로> --control
node apps/cli/main.mjs mission reattach <목표ID> <시도ID> --cli <경로>
node apps/cli/main.mjs mission stop <목표ID> <시도ID> --cli <경로> --mode pause|cancel [--force] [--wait-ms <N>]
node apps/cli/main.mjs mission delegate <목표ID> <시도ID> --cli <경로> --provider claude
node apps/cli/main.mjs mission escalations <목표ID>
node apps/cli/main.mjs mission relay <목표ID> <시도ID> <답JSON> --cli <경로>
node apps/cli/main.mjs project handover <프로젝트ID> --cli <경로> --to <새 제어자> [--wait-ms <N>]
node apps/cli/main.mjs project accept <프로젝트ID> --cli <경로> --controller <새 제어자> --token-file <절대경로>
```

`--control`은 dispatch·continue·verify·handoff·reconcile·replan·recover·advance·drive에 붙인다. reattach·stop·delegate·relay는 항상 이 경로다. `--poll-ms`(결과·이벤트 조회 주기)와 `--follow-timeout-ms`(한 실행을 기다리는 상한 — 넘으면 기다림만 멈추고 실행은 code-agent에서 계속된다)는 master 쪽 설정이다. heartbeat·연결 끊김 판단·정지 유예·실행 시간 상한 등은 code-agent 정책(`code-agent master enable --policy`, 통신 `policy`)이 정한다.

## 실행 — 원자적 접수와 관찰

1. 배정·계속 실행은 기존과 같이 판단·시도·잠금을 한 트랜잭션으로 저장한 뒤 시작한다.
2. 시작은 `submit` 한 번이다. commandId는 `inv-<invocationId>`이고 기대 상태 버전(`expect.stateVersion`)과 master 식별자(`links`: 임무·작업·시도·계획 버전·호출)를 함께 보낸다. code-agent가 상태·소유·임대·작업 연결을 한 잠금 안에서 확인하고 받는다. 응답을 잃어 같은 commandId로 다시 보내면 기록된 응답이 돌아오고 실행은 하나다. 같은 commandId에 다른 내용은 `control-conflict`로 거부된다. code-agent가 이어 실행 접수를 응답으로 거부하면(`ok: false` — 재개 판정·임대·소유 등) 실행을 만들지 않았다는 확인이므로 같은 세션의 막힘(`blocked`, 결과의 `control.state: rejected`)으로 남기고 `control-submit-rejected`를 기록한다. 자동으로 다시 보내지 않는다. 통신 실패나 세션이 없는 첫 실행의 거부는 시도를 unknown으로 남긴다. 실행이 시작되면 세션 임대·hook 기록으로 상태 버전이 바뀌므로, 실행 프롬프트는 세션에 기대 상태를 다시 대조시키지 않고 지정된 작업인지만 확인하게 한다. 실행 세션 안의 `code-agent status --json`은 그 실행의 세션으로 임대를 본다. 프롬프트는 검증 계약의 독립 검사와 변경 범위 제약을 code-agent의 수락 기준·테스트 케이스로 옮기지 말라고 알린다 — 그것은 master가 반영 뒤 확인한다. 같은 프로젝트의 선행 작업이 반영한 커밋이 있으면 `codeAgentBase`로 넣어 새 작업을 그 위에서 시작하게 한다(code-agent 접수의 `--base`). 기본 기준 브랜치에서 시작하면 선행 산출물이 빠지기 때문이다. 선행 작업 증거는 요약(작업·프로젝트·검사 결과·산출물 해시·반영 커밋)만 싣는다 — 파일 트리 스냅샷·원격 상태·검사 출력은 master 기록에 남고, 통합 작업처럼 선행이 여럿이면 code-agent 접수 한도(프롬프트 20000자)를 넘기 때문이다.
3. 접수된 실행은 `control-run` 기록으로 남기고, 끝 상태가 될 때까지(끝 상태를 본 뒤 한 번 더) 이벤트를 커서(`control-cursor`: 기록 ID·순번)로 받아 진척·질문·동의·검증·실행·연결 이벤트를 `control-event`로 남긴다. 기록 ID가 바뀌거나 구간이 비면(gap) 누락을 추측하지 않고 스냅샷으로 다시 맞춘다(`control-resynced`).
4. 결과는 code-agent의 결과 근거(종료 코드·최종 메시지·권한 거부·실행 전후 상태·변경 파일·커밋·검증 기록)를 호스트 결과로 옮긴다. 모델의 완료 발언은 요약일 뿐이고, 회차의 처분은 기존처럼 실행 뒤 code-agent 상태와 master의 독립 검증으로 정한다. `unknown`·`abandoned` 실행은 결과로 받지 않고 시도를 unknown으로 남긴다(자동 재실행 없음).

연결 상태(통신), 프로세스 생존(감독·호스트 pid와 heartbeat), 업무 진척(단계·재개 판정)은 code-agent가 따로 보고한다. 통신이 끊긴 것만으로 실패·재배정하지 않는다 — 잠금은 시도가 끝날 때까지 유지되고, 실행은 code-agent 정책(`onMasterDisconnect`)에 따라 계속되거나 협력 정지한다.

## 재시작 뒤 재부착

master가 결과를 받기 전에 멈추면 시도가 `running`으로 남는다. `mission drive`(또는 `mission reattach`)는 그 시도의 commandId로 code-agent의 명령 기록을 조회해 같은 실행에 다시 붙고, 커서 다음부터 이벤트를 받아 결과를 기록한다. 실행을 새로 접수하지 않는다. code-agent가 그 호출을 받은 기록이 없으면(`control-not-submitted`) 실행되지 않은 것으로 보고 시도를 unknown으로 남긴다 — 다시 배정하려면 상태를 대조한 뒤 새 호출로 한다.

## 정지·취소

`mission stop`은 그 시도의 지금 호출로 접수된 실행 하나만 대상으로 한다(commandId `stop-<runId>-<mode>`). 응답의 `requested`는 요청 접수, `stopped`는 끝 상태 확인이다. pause는 hook을 통한 협력 정지이고, 유예가 지나거나 `--force`면 code-agent가 확인된 프로세스만 강제 종료한다(결과에 협력·강제가 구분돼 남는다). 취소는 파일·커밋을 되돌리지 않는다. 시도의 상태는 결과를 받는 쪽(진행 중인 drive 또는 reattach)이 실행의 끝 상태로 남긴다. `mission pause`는 기존처럼 새 배정만 멈춘다. drive가 실행을 따라가는 동안 다른 터미널에서 `mission stop`·`mission relay`·`mission escalations`를 부를 수 있다 — 같은 DB의 쓰기는 잠금이 풀릴 때까지 최대 5초 기다린다.

## 위임 판단

drive는 code-agent 통신 계약 호스트에서 판단기(`--provider`)가 있으면, 판단을 기다리는 시도(`waiting-decision`, 반영 동의는 `verified`)의 확인 요청·업무 질문을 먼저 위임 판단으로 처리한다. 업무 질문의 판단 자료에는 그 질문과 배정·목표에 더해 같은 작업에서 이미 답한 질문(답과 출처 — 사람 답인지 위임 판단인지)이 실린다. 뒤 질문은 앞 답을 전제로 묻고(예: 사람 답을 반영하려 앞 단계로 되감을지), 판단기는 사람이 정한 답을 뒤집거나 넓히지 않는다.

| 분류 | 처리 |
| --- | --- |
| routine | 배정된 목표·완료 조건·허용 범위 안에서 근거로 바로 판단할 수 있다 — 승인 또는 답을 보낸다 |
| ambiguous | 근거가 부족하거나 해석이 둘 이상이다 — 수정 요청(재검토)만 보내고, 그 밖은 "추가 정보 필요"로 사람에게 넘긴다 |
| critical | 범위·정책·보안·데이터·외부 영향·되돌리기 어려운 변경·완료 조건 완화 — 보내지 않고 사람에게 넘긴다 |

- 판단(분류·결론·이유·근거·입력 해시·권한 ID)을 master 기록(`decision` actor `ai-delegate`, `delegation` state `recorded`)에 먼저 남긴 뒤 보낸다. 판단 ID가 commandId(`dec-…`·`ans-…`)라 보내기 전후에 끊겨도 한 번만 적용된다.
- 보내지 않고 사람에게 넘기는 경우(`escalation`): 사람만 하는 동작, master 실행이 준비하지 않은 확인 요청, 판단기 없음, 맞는 권한 없음, 판단 실패, critical, 승인을 내린 ambiguous. 사람에게 넘긴 대상은 사람이 닫을 때까지 다시 판단하지 않는다. 사람이 code-agent에서 직접 처리하면 다음 판단 때 관찰로 닫는다.
- 반영(deliver) 확인은 master의 독립 검증(`verified`)이 끝난 시도에서만 판단한다. 반영 확인의 문서 변경 후보(지식 문서 갱신)는 위임 판단이 적용하지 않는다 — 모두 유지로 보내고 판단기에도 그렇게 알린다. 갱신은 사람이 따로 정한다.
- 보낸 판단이 모두 적용·수정 요청·답으로 끝나고 사람에게 넘긴 것이 없으면 그 회차에 한해 같은 세션을 자동으로 이어 간다(`delegatedTurnId`). 수정 요청을 보낸 회차는 code-agent가 다시 받을 확인 요청을 사람 몫(`needs-human`·`reapproval-required`의 요구 확정·계획·반영 확인)으로 보여도 같은 세션이 고쳐 다시 준비한다 — 이어 가는 프롬프트에 수정 지시 전문을 넣고, 다시 준비한 확인 요청은 다시 판단한다. 사람이 직접 응답한 회차는 기존 조건(요구 확정·계획 승인)으로만 자동 계속한다.
- code-agent는 권한 범위·준비 세션·보여 준 내용의 해시·상태 버전·중복 사용·회수를 다시 검사하고, 사람의 응답과 같은 적용 함수로 적용하되 원장·동의·영수증에 `master-delegation`(사람 응답 아님)으로 남긴다.
- `mission escalations`는 사람에게 넘긴 판단과 보낸 위임 판단을 보여 준다. 사람에게 넘긴 업무 질문의 사람 답은 `mission relay`로 전달할 수 있다(code-agent가 '관찰되지 않은 사람 답'으로 구분해 남긴다). 확인 요청(동의)은 사람이 code-agent 세션이나 TTY에서 직접 응답한다.

## 검증·인계에서 달라지는 점

- 검증 계약의 `codeAgentRecords: true`는 그 작업의 code-agent 기록(`doc/work/<작업ID>/`, `.code-agent/work/<작업ID>/`, `.code-agent/approvals/<작업ID>/`)을 변경 범위로 허용한다. 제품 파일·다른 작업의 기록은 여기에 들지 않는다.
- 독립 검증은 code-agent 작업이 반영 단계에 닿은 뒤에만 한다(반영 동의를 아직 준비하지 않았거나, 반영 동의 하나가 응답을 기다리는 자리). code-agent의 check·test가 통과했어도 리뷰·통합 검증이 남아 있으면 같은 세션을 먼저 이어 간다. 반영 동의는 그 검증이 끝난 뒤에만 판단한다.
- 검증 뒤 code-agent 작업이 반영 단계를 떠나거나(되감기) 반영 확인이 위임 수정 요청을 받으면 그 검증으로 인계하지 않는다. 같은 세션을 이어 가고 반영 단계에서 다시 검증한다 — 인계 증거는 다시 한 검증에 결합한다. 이 계속 실행은 통신 계약 호스트에만 있다.
- 반영 영수증은 사람이 고른 응답(observed) 또는 위임 영수증이어야 한다. 위임 영수증은 `master-delegation` 통로이고, 이 시도의 deliver 위임 기록(승인·적용 완료)과 판단 ID·확인 요청 ID·작업 ID가 같아야 하며, 사람 응답이 섞이지 않아야 한다.
- 반영 뒤 남은 지난 작업의 임대(`other-work`)는 인계를 막지 않는다 — code-agent도 다음 진행 명령에서 넘겨받는 기록이다.

## 제어권 인계

`project handover`는 지금 소유자만 보낸다. code-agent가 실행을 협력 정지로 멈추고 끝난 것을 확인한 뒤 세대를 올려 넘기며, 그 세션의 작업 임대를 푼다. heartbeat 만료나 오래된 임대만으로 넘기지 않는다. 넘어가면 이 연결은 소유자가 아니고 이전 세대의 상태 변경 요청은 `control-fenced`로 거부된다. 새 제어자는 `project accept`로 새 세대를 인수한 뒤 연결을 다시 맺는다 — 인수 전에는 새 제어자의 실행·판단도 받지 않는다. 인계 도중 끊기면 code-agent가 기록한 단계부터 이어 간다.

## 시험

- 모의 시험(`tests/control.test.mjs`): code-agent 통신 계약을 흉내 낸 전송과 가짜 판단기로 두 프로젝트의 위임 → 독립 검증 → 위임 반영 → 인계 → 통합 완료, 판단 기록 선행, critical·ambiguous·권한 없음·준비하지 않은 동의의 사람 이관, 검증 전 반영 판단 금지, 위임 영수증 결합, 재부착, commandId 충돌·이벤트 재동기화, 정지 대상 제한, 독립 프로젝트 진행과 의존 작업 대기, 반영 단계에서만 하는 독립 검증과 반영 단계를 떠난 검증된 시도의 계속 실행, 위임 수정 요청 뒤 같은 세션의 재준비, 이어 실행 접수 거부의 막힘 기록, 반영 확인 수정 요청 뒤 재준비와 재검증, 선행 증거 요약 프롬프트, 업무 질문 판단 자료의 앞선 답을 본다.
- 실제 code-agent CLI 연동 시험(`tests/code-agent-control.test.mjs`): 빌드된 code-agent(`CODE_AGENT_DIST` 또는 옆 저장소)와 가짜 호스트로 연결·원자적 접수·중복 거부·이벤트 커서·결과·재부착·정지·제어권 인계와 이전 소유자 거부를 본다. code-agent 빌드가 없으면 건너뛴다.
- 실제 AI 전체 사이클과 앞선 답 판단의 최신 결과·실패 이력·미검증 범위는 [검증 기록](verification.md)을 따른다.
