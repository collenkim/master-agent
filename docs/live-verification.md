# 실제 검증과 자동 진행

live 작업의 완료는 모델 요약이 아니라 파일 변경 범위, 실제 검증 명령, code-agent 승인·검증 상태, 외부 작업 종료 관측으로 판단한다. `drive`는 현재 계획에서 가능한 배정·검증·인계·후행 작업을 이어가며, 사람 승인과 실패를 기다리는 지점에서 멈춘다. UI 없이 이 실행 계약을 먼저 사용한다.

## 배정 전 검증 계약

계획 작업마다 정확한 변경 파일, 완료 조건을 검사할 명령, 실제 산출물 연결을 등록한다. 계획 생성 AI가 임의의 테스트 명령을 실행하도록 허용하지 않는다. 검증 계약은 운영자가 CLI로 등록하는 실행 입력이며, 프로젝트 정책과 계획 범위에 맞는지 확인해야 한다.

```json
{
  "schemaVersion": 1,
  "taskId": "implement-invoice",
  "allowedPaths": ["src/subtotal.mjs", "test/subtotal.test.mjs"],
  "checks": [{
    "id": "subtotal-test",
    "executable": "C:/Program Files/nodejs/node.exe",
    "args": ["--test", "test/subtotal.test.mjs"],
    "criterionIds": ["negative-input"],
    "timeoutMs": 60000
  }],
  "artifacts": [{ "name": "test-report", "checkId": "subtotal-test" }]
}
```

`taskId`, `criterionIds`, 산출물 name은 활성 계획과 일치해야 한다. 모든 작업 조건과 산출물에 연결이 있어야 한다. 산출물은 검증 명령의 실제 stdout에 `checkId`로 연결하거나, Git에서 확인되는 실제 파일에 `path`로 연결한다. 체크 명령의 종료 코드 0과 파일 해시가 증거가 되며, 선언한 테스트가 업무 조건을 제대로 검사하는지는 계약 작성·리뷰의 책임이다.

`allowedPaths`는 디렉터리나 와일드카드가 아닌 정확한 상대 파일 경로다. code-agent가 생성하는 작업 문서도 변경한다면 그 경로를 포함해야 한다. 자동 발급 ID를 아직 모를 때는 새 작업의 `--work <지정ID>`로 ID를 정해 두고 문서 경로를 등록할 수 있다. 기존 정책·계약 근거 파일 변경은 검증 계약에 들어 있어도 재검토가 필요하다.

명령은 프로젝트 경로에서 셸 없이 실행한다. executable은 절대 실행 파일 경로이며 `.cmd`·`.bat`·`.ps1`·`.sh` 래퍼는 받지 않는다. npm 테스트는 Node 실행 파일과 npm CLI JS 진입점을 args에 지정할 수 있다. 이 기능은 명령 실행 권한을 제한하는 샌드박스가 아니므로 등록한 명령의 동작을 신뢰할 수 있어야 한다.

```powershell
node apps/cli/main.mjs mission verification <목표ID> <계약JSON> --revision <목표버전>
node apps/cli/main.mjs mission drive <목표ID> --cli C:/IdeaProjects/code-agent/dist/agent/cli.js
```

`advance`는 한 단계만 수행하고 `drive`는 가능한 전이를 반복한다. 작업 선택은 고정 계획의 의존 관계와 현재 상태에 따른다. AI 분석·재계획은 기존 analyze 경로가 담당한다. 막혔을 때 `blockers`와 `mission show`의 시도·판단·검증 기록을 확인한다. 자동으로 기존 외부 작업을 가져오거나 실패한 호스트를 반복 실행하지 않는다.

## 검증과 인계

배정 시 Git 루트·HEAD와 추적 파일 및 무시되지 않은 미추적 파일의 내용 해시를 저장한다. 기존 작업 트리 변경은 배정 기준의 일부로 보존하며 이후 변경만 비교한다. 삭제·추가·이름 변경도 경로 차이에 포함된다. 하위 저장소 경로, 링크·junction·submodule, 과도한 파일 개수·크기는 거부한다. 현재 한계는 파일 2만 개, 파일당 32MiB, 총 256MiB이며 운영 정책값이 아니다. Git이 무시하는 빌드 산출물·파일 전체를 검사하는 기능은 아니다.

`verify`는 다음을 확인한다.

1. 현재 계획·시도·프로젝트 잠금과 등록된 검증 계약이 일치한다.
2. code-agent의 같은 작업에서 요구 확정·계획 승인이 유효하고, 현재 트리와 결합된 check·test 성공 기록이 있다. 열린 질문·동의·차단 발견이 없어야 한다. 최종 반영 동의를 기다리는 상태에서도 로컬 검증은 가능하다.
3. HEAD가 배정 기준과 같고, 변경 파일이 정확한 허용 경로 안에 있다. 정책·계약 근거와 다른 프로젝트의 인계된 파일도 대조한다.
4. 판단과 verification-run 시작 기록을 먼저 저장하고 실제 검증 명령을 순서대로 실행한다.
5. 모든 명령이 성공하고, 전후 파일·HEAD·원격 상태가 같아야 verified가 된다. stdout 일부와 전체 해시, 조건 연결, 실제 산출물 해시를 보존한다.

verified는 잠금 해제가 아니다. 기존 code-agent에서 작업을 마치고 임대를 해제한 뒤 `handoff`를 수행한다. 현재 관측이 no-work이고 활성 작업·접수·동의·임대가 없으며 검증 후 파일 내용이 같을 때만 작업을 succeeded로 바꾸고 잠금을 해제한다. 이후 현재 파일을 후행 작업의 기준으로 삼는다.

no-work만으로 커밋·반영 승인을 증명할 수는 없다. 여기서 succeeded는 등록된 로컬 완료 조건과 검증된 산출물의 인계를 뜻하며, 커밋·push·배포 완료를 보증하지 않는다. 배정 전 delivery 계약을 등록하면 지정한 기록 파일의 변경, 커밋 내 영수증과 반영 후 독립 테스트를 대조한다. [반영 기록·관측 복구](delivery-reconciliation.md)의 계약을 따르며, 등록되지 않은 변경은 여전히 차단한다.

```powershell
node apps/cli/main.mjs mission verify <목표ID> <시도ID> --revision <목표버전> --expect-state <원격버전> --cli <code-agent경로>
node apps/cli/main.mjs mission handoff <목표ID> <시도ID> --revision <목표버전> --expect-state <원격버전> --cli <code-agent경로>
node apps/cli/main.mjs mission complete <목표ID> --revision <목표버전>
```

모든 계획 작업의 인계와 조건별 실제 증거, 최종 파일 내용을 확인하면 목표가 succeeded가 된다. 다중 프로젝트 계획에는 모든 선행 작업을 묶는 통합 검증이 필요하다. 검증·인계 후 파일 변경이나 증거 훼손이 발견되면 후행 배정과 목표 완료를 거부한다. 내용 해시는 변경 탐지용이며 DB 자체에 대한 서명·권한 격리 수단은 아니다.

## 실패와 재개

- 명령 실패: verification-failed로 남기고 잠금을 유지한다. 기존 호스트를 명시적으로 continue해 수정하거나 같은 시도를 재검증한다. drive는 실패를 무한 재시도하지 않는다.
- 시간 초과·실행 중 변경·관측 불가: unknown으로 격리한다. 자동 재실행·잠금 해제는 하지 않는다.
- 검증 중 pause: 실행 중인 명령을 강제 취소하지 않으며 다음 명령의 시작을 막는다. 돌아온 결과로 일시 정지를 해제하지 않는다.
- 프로세스 중단으로 verifying이 남음: mission unknown으로 미확인을 기록할 수 있다.
- 과거 배정에 검증 계약·기준 스냅샷이 없음: 검증을 소급 승인하지 않는다. 기존 호스트 기록의 점검·복구가 필요하다.

`drive/advance`에 `--provider codex|claude`를 지정하면 실패 근거를 분석하고 기존 범위에서 수정·재검증한다. 개별 명령과 한도·보류 규칙은 [자동 복구](recovery.md)에 정리했다. 호스트 반환 후 관측 실패의 제한된 복구와 반영 영수증 대조를 지원한다. 실제 code-agent의 사람 승인 위임·원자적 작업 예약·실행 중 취소·일반 unknown 복구와 관제 UI는 후속 범위다. 운영 조건은 아직 확정하지 않는다.
