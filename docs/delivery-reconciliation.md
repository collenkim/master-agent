# 반영 기록과 중단된 호스트 관측 복구

## 반영 증거의 수준

기존 인계는 `local-files`로 기록한다. 테스트를 통과한 파일과 외부 작업 종료를 확인한 것이며 커밋·push·배포를 증명하지 않는다.

배정 전 검증 계약에 다음 선택 항목을 넣으면 `local-commit-with-consent-record` 수준의 인계를 요구한다.

```json
{
  "delivery": {
    "mode": "code-agent-commit",
    "metadataPaths": ["doc/work/MA-example/07-delivery.md"]
  }
}
```

이는 기존 검증 계약에 추가하는 항목이다. 실제 프로젝트의 정확한 반영 기록 경로를 등록하며 경로 패턴이나 디렉터리 전체 허용은 지원하지 않는다. `metadataPaths`는 md·jsonl 파일만 허용한다. 산출물 파일과 정책 근거의 변경은 이 목록에 넣어도 우회할 수 없다.

`mission handoff`와 drive는 다음 조건을 대조한다.

1. 기존 독립 검증과 같은 작업·시도이고, code-agent의 작업·접수·동의·임대가 종료됐다.
2. 검증 시점 HEAD를 부모로 하는 단일 반영 커밋이며 작업 트리와 인덱스가 깨끗하다. merge 커밋과 중간 커밋이 여러 개인 인계는 현재 지원하지 않는다.
3. 검증 이후 변경은 등록된 기록 파일과 `.code-agent/approvals/<작업ID>/consents.jsonl`(검증 계약의 `codeAgentRecords: true`면 그 작업의 code-agent 기록 폴더까지)에 한정된다. 검증 산출물은 변경할 수 없다.
4. 해당 커밋에서 직접 읽은 영수증에 현재 실행 세션·작업 경로·시도 시작 이후 시각과 결합된 deliver/this-commit 항목이 하나 존재한다. 그 항목은 사람의 선택 기록(observed)을 갖거나, `master-delegation` 통로의 위임 영수증이어야 한다 — 위임 영수증은 이 시도의 deliver 위임 판단(승인·적용 완료)과 판단 ID·확인 요청 ID·작업 ID가 같고 사람 응답이 섞이지 않아야 한다([code-agent 통신 계약 연동](code-agent-control.md#위임-판단)).
5. 반영 검사 판단을 저장한 다음 기존 검증 명령을 모두 다시 실행한다. 전후 파일·HEAD·선행 산출물·원격 종료 상태가 유지돼야 인계한다.

반영 동의 JSONL이 손상됐거나 객체 형식이 아니면 `invalid-delivery-receipt`로 거부하고 증거·잠금을 유지한다.

code-agent의 `consentReceipts.ts`에 정의된 커밋 내 기록 형식을 읽는다. 영수증은 로컬 감사 자료이며 전자 서명이나 독립적인 사용자 신원 인증이 아니다. master가 승인·영수증을 생성하거나 커밋·push·배포하지 않는다. 위임 판단도 code-agent가 권한 범위를 확인하고 같은 반영 절차로 커밋·영수증을 만든다. 실제 기존 승인 절차는 code-agent가 담당한다. TTY 반영 등 해당 형식의 this-commit 영수증이 없는 경로는 이 계약을 통과하지 못한다.

`mission show`의 `deliveries`에는 커밋·부모·영수증 해시·변경 목록·후검증 결과가, `evidence[].delivery`에는 증거 수준이 표시된다. 후검증 성공 기록은 봉인해 인계 저장 실패 후 재사용할 수 있다. 후검증 실행 중 오류·시간 초과·관측 실패는 unknown으로 보존하고 잠금을 해제하지 않는다.

## 호스트 반환 후 관측 중단 복구

호스트 호출마다 `invocationId`를 새로 부여한다. CLI가 정상 결과를 반환하면 원격 상태를 조회하기 전에 `host-return`을 영속 저장한다. 늦게 도착한 이전 호출의 결과는 새 호출에 적용하지 않는다.

```powershell
master-agent mission reconcile <목표ID> <시도ID> --revision <현재버전> --expect-state <상태버전> --control
```

대상은 unknown 상태이고 배정 기준·검증 계약을 가진 시도다. 프로세스 중단으로 running만 남았다면 기존 `mission unknown`으로 먼저 미확인 상태를 기록한다. 이는 프로세스 종료를 증명하지 않는다.

reconcile은 현재 invocation의 봉인된 정상 반환, 동일 code-agent 작업과 세션, 승인·질문·동의 상태, 현재 트리에 결합된 code-agent check/test, 활성 실행 임대 없음, 허용된 파일 변경과 기준 HEAD를 대조한다. 통과하면 잠금을 유지한 채 `awaiting-verification`으로 이동한다. 호스트를 다시 실행하지 않으며 독립 검증이 끝나기 전 `continue`도 금지한다. 이후 `mission verify` 또는 drive로 진행한다.

반환 기록이 없거나 이전 호출의 기록뿐인 경우, 검증·반영 검사 프로세스가 running/unknown으로 남은 경우, 외부 작업이 이미 사라진 경우, 임대 충돌·파일 범위 변경·일시 정지는 복구하지 않는다. 이 경로는 호스트가 반환했지만 관측·저장이 중단된 경우에 한정된다. 읽기 전용 분석 예약과 정상 반환된 검증의 중단 처리는 [분석·검증 중단 처리](interruption.md)로 확장했다. 관리 실행의 정지·취소는 [code-agent 통신 계약 연동](code-agent-control.md#정지취소)을 따른다. 상태 파일을 직접 수정하는 우회 절차도 제공하지 않는다.

## 검증 범위

임시 Git 저장소에서 실제 로컬 커밋·독립 테스트·저장 롤백과 재개를 시험했다. 영수증과 code-agent 상태·개발 호스트는 시험용 응답이며 실제 사람 동의나 모델 전체 사이클을 검증한 것은 아니다.
