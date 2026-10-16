# 프로젝트 근거 수집과 AI 계획 생성

master-agent는 등록된 프로젝트의 지정 문서·코드를 읽어 근거 스냅샷을 만들고, 이를 Codex 또는 Claude CLI에 전달해 요구사항 분석과 프로젝트별 계획을 생성한다. AI 응답은 독립적인 검증기를 통과한 뒤 판단 기록과 함께 활성화한다. 이 단계는 계획 생성이며 실제 코드 변경·테스트 실행은 하지 않는다.

## 근거 수집

프로젝트별 수집 목록에는 상대 경로와 종류를 지정한다. policy, contract, code, plan, experience, overview를 구분한다. 경로를 모델이 임의로 확장하게 하지 않는다.

```json
{
  "schemaVersion": 1,
  "sources": [
    { "path": "docs/POLICY.md", "kind": "policy" },
    { "path": "src/order.mjs", "kind": "code" }
  ]
}
```

```powershell
node apps/cli/main.mjs project list
node apps/cli/main.mjs project collect <프로젝트ID> <목록JSON> --revision <프로젝트버전>
node apps/cli/main.mjs project sources <프로젝트ID>
node apps/cli/main.mjs project search <프로젝트ID> "주문 취소"
```

수집은 프로젝트 파일을 수정하지 않는다. DB에 UTF-8 본문, 상대 경로, 근거 종류, 줄 수와 바이트 해시를 보존한다. 같은 내용·종류의 재수집은 프로젝트 버전을 늘리지 않는다. 변경된 스냅샷은 새 참조를 만들고 이전 참조와 기록은 보존한다. 검색은 선택한 프로젝트의 최신 스냅샷에서 수행하며 줄 번호와 근거 종류를 반환한다.

상위 경로, 절대 경로, 심볼릭 링크·junction, 자격 증명 관련 경로, 바이너리는 수집을 거부한다. 수집 목록은 전달할 문서의 명시적인 선택이며 비밀 정보 전체를 자동 판별하는 기능은 아니다. 모델에는 선택한 본문과 프로젝트 메타데이터가 전달된다.

현재 전송 크기 보호값은 파일당 64KiB, 프로젝트당 최대 32개·256KiB, 분석 context 전체 1MiB다. 큰 자료는 적절히 나눈 문서로 지정해야 하며 본문을 조용히 잘라 전달하지 않는다. 이는 구현의 입력 크기 제한이며 운영 예산이나 서비스 정책의 확정값은 아니다.

## AI로 계획 만들기

먼저 모든 대상 프로젝트의 근거를 수집하고 목표를 접수한다. 모델은 현재 등록된 도메인·기능·제약·계획을 실제 근거와 함께 평가하며 프로젝트 카탈로그의 도메인 정의를 임의 변경하지 않는다.

```powershell
node apps/cli/main.mjs mission analyze <목표ID> --revision <목표버전> --provider codex
node apps/cli/main.mjs mission analyze <목표ID> --revision <목표버전> --provider claude
```

CLI 경로를 자동 발견하지 못하면 `--ai-cli <절대경로>`로 `.exe` 또는 JS 진입점을 지정한다. 셸 래퍼 `.cmd`, `.bat`, `.ps1`은 받지 않는다. `--model <모델명>`을 생략하면 해당 CLI의 기본 모델을 사용하며 기록에는 cli-default로 표시한다. API 키와 인증 파일을 master DB에 복제하지 않고 기존 CLI 인증을 이용한다.

프롬프트는 stdin으로 전달한다. 대상 프로젝트를 AI CLI의 작업 디렉터리로 열지 않고 별도 임시 폴더에서 수집한 context만 전달한다. Codex는 read-only·ephemeral·사용자 설정 미로딩·셸 도구 및 웹 검색 비활성화로 호출한다. Claude는 도구·스킬·사용자 설정·MCP 연결을 제외하고 세션 저장 없이 구조화 출력을 요청한다. 관리자가 적용한 CLI 정책과 인증 조건은 그대로 적용된다. 이 옵션 조합은 지원되는 CLI 버전이 필요하며 권한 우회 옵션은 사용하지 않는다.

구조화 출력 연결은 공식 [Codex 비대화형 실행](https://learn.chatgpt.com/docs/non-interactive-mode)과 [Claude 프로그램 방식 실행](https://code.claude.com/docs/en/headless)에 기반한다. 설치 버전은 `--help`로 지원 옵션을 확인한다.

## 분석 결과와 자동 재검토

분석은 요청 원문에 연결된 세부 요구, 모든 대상 프로젝트의 평가와 참여·제외 이유, 선택 대안과 근거, 미해결 항목, 실행 계획을 반환한다. 실제 수집한 근거만 참조할 수 있고 작업별로 해당 프로젝트의 근거가 필요하다.

검증기는 구조, 근거 ID, 원문 인용, 완료 조건 누락, 도메인·실행 기능, 평가와 배정 일치, 기존 계획 참조, 의존 관계, 후행 검증을 검사한다. 이는 내용의 업무적 정확성을 완전히 보증하지 않는다. 출처와 선택 이유를 추적할 수 있는 구조로 제공한다.

| 결과 | 처리 |
| --- | --- |
| ready | 현재 목표·프로젝트·관측·파일 버전을 다시 대조한 뒤 자동 계획 활성화 |
| needs-context | 근거와 대안을 재검토한 뒤 여전히 부족하면 blocked로 기록 |
| needs-human | 재검토 후에도 중대한 사람 판단이 필요하면 waiting-decision으로 기록 |
| 형식·참조·계획 오류 | 검증 오류를 AI에 전달해 수정 요청; 유효한 계획 없으면 blocked |
| 인증·연결·시간 초과 | 오류 기록, 고정 예제나 가짜 계획으로 대체하지 않음 |

현재 한 번의 analyze 요청은 최초 생성과 한 번의 재검토를 수행한다. 추가 파일의 자율 탐색은 아직 없으며, 새 근거가 필요하면 수집 목록을 보완하고 다시 분석한다. 미해결 사항을 남긴 ready 결과는 거부한다. 일반 정보 부족과 중대한 사람 판단을 분리하지만 그 의미 분류는 모델의 판단이므로 실제 업무 사례 평가가 더 필요하다.

AI 호출 전에 판단과 분석 시작 상태를 저장한다. 결과의 모든 검토 회차, context 해시, 프롬프트 버전, provider와 요청 모델, 선택 내용은 analysis-run에 보존한다. `mission show`의 analyses와 decisions에서 확인할 수 있다. CLI 원시 로그는 기록에 복사하지 않는다.

분석 중 목표 상태·관측값·프로젝트 정보·파일이 바뀌면 결과를 적용하지 않는다. 계획 활성화 후에도 배정과 완료 검사에서 근거 파일의 변경을 확인한다. 실패한 재분석 이후에는 이전 계획으로 실행을 계속하지 않는다.

## 질문 응답과 재분석

```json
{
  "analysisId": "현재 분석 ID",
  "answers": [{ "issueId": "질문 ID", "answer": "환불 확정 이벤트를 기준으로 처리한다." }]
}
```

```powershell
node apps/cli/main.mjs mission clarify <목표ID> <응답JSON> --revision <목표버전> --provider claude
```

현재 질문의 ID와 상태 버전을 대조한 뒤 사람 판단을 기록한다. provider를 지정하면 답변을 포함해 즉시 재분석한다. 생략하면 답변만 기록하고 analyze를 별도로 호출한다. 답변은 허용 프로젝트나 완료 조건을 자동 변경하지 않고 재분석의 근거로 사용한다. 오래된 질문과 중복 답변은 거부한다.

분석 프로세스가 중단돼 analyzing 상태가 남은 경우 pause 후 resume으로 기존 분석을 무효화하고 다시 analyze할 수 있다. 그 사이 도착한 이전 응답은 상태 버전 대조로 버린다. 이 동작이 이전 AI 프로세스의 종료를 보장하지는 않는다.

## 예제와 검증

```powershell
node apps/cli/main.mjs project add examples/project.json
node apps/cli/main.mjs project collect example-project examples/sources.json --revision 1
node apps/cli/main.mjs mission create examples/mission.json
node apps/cli/main.mjs mission analyze <반환된목표ID> --revision 1 --provider claude
node apps/cli/main.mjs mission run <목표ID> --simulate
```

이미 등록된 예제는 project list로 현재 버전을 확인한다. 예제 목표 접수 키는 같은 내용이면 기존 목표를 반환하므로 재분석에는 mission show의 최신 revision을 사용한다.

`node scripts/smoke-planner.mjs --provider claude` 또는 `--provider codex`는 합성 정책·코드로 실제 CLI 계획 생성을 확인한다. 실제 모델 사용량이 발생하며 테스트 저장소와 계획·보고서는 `.master-agent/ai-smoke-*/`에 남는다. 일반 `npm test`는 모델을 호출하지 않는다.

실제 Claude 호스트 배정과 관측은 [개발 호스트 연결](live-execution.md), 실제 테스트 검증·자동 후행 배정은 [실제 검증과 자동 진행](live-verification.md), 실패 분석·수정은 [자동 복구](recovery.md)를 따른다. [재계획 인계](replanning.md)는 종료된 실패 작업을 최신 근거의 새 계획에 연결한다. grant 범위의 위임 판단은 [code-agent 통신 계약](code-agent-control.md)에서 지원하며 UI는 후속 범위다.
