# 독립 작업 진행·승인 후 재개·검증 계약 재사용

## 작업별 보류

일반 정보 부족, 외부 동의 대기, 범위 내 복구 한도는 해당 프로젝트와 의존 작업을 보류한다. 다른 프로젝트의 코드·정책 근거를 명시적으로 참조하는 작업도 영향 범위로 본다. 독립 프로젝트는 배정·검증·인계를 계속할 수 있다. 변경 중인 다른 독립 프로젝트의 코드 때문에 입력 전체가 오래됐다고 판단하지 않는다. 정책 근거, 카탈로그 버전, 선행 완료 증거의 대조는 유지한다.

중대한 판단과 전체 재계획은 범위가 확정되지 않았으므로 목표 전체를 보류한다. `mission show.recoveryHolds`와 `taskDetails[].waitingFor`에서 보류 이유를 조회한다. 한 프로젝트의 보류를 해소해도 다른 프로젝트의 보류가 해제되지 않는다.

## 승인 후 자동 계속 실행

drive는 기존 작업의 요구 확정·계획 승인이 유효하고 질문·동의·임대·차단 문제가 없으며 resume이 ready이면 같은 세션을 계속 실행한다. code-agent check/test 증거가 준비됐다면 독립 검증을 우선한다. 권한 거부가 남은 호스트와 재검증을 요구하는 복구 시도는 자동으로 이어가지 않는다.

실행 전에 기존 판단·상태 대조와 별도로 자동 계속 실행임을 기록한다. 같은 원격 상태 버전은 반복 제출하지 않고 한 시도에서 최대 8회로 제한한다. 이는 무한 반복 방지 장치이며 운영 정책의 확정 수치가 아니다. code-agent 동의를 자동 생성하지 않는다.

## 재사용 검증 템플릿

작업마다 등록하는 기존 verification 명령 외에 목표 단위로 재사용을 명시한 계약을 등록할 수 있다.

```powershell
node apps/cli/main.mjs mission verification-template <목표ID> template.json --revision <버전>
```

```json
{
  "id": "invoice-negative-input",
  "projectId": "invoice",
  "domain": "invoice",
  "kinds": ["implementation", "verification"],
  "criteria": ["negative"],
  "outputs": ["test-result"],
  "recipe": {
    "schemaVersion": 1,
    "allowedPaths": ["subtotal.mjs"],
    "checks": [{
      "id": "negative-input",
      "executable": "C:/Program Files/nodejs/node.exe",
      "args": ["test-negative.mjs"],
      "criterionIds": ["negative"],
      "timeoutMs": 10000
    }],
    "artifacts": [{"name": "test-result", "checkId": "negative-input"}]
  }
}
```

실제 Node 경로와 프로젝트에 존재하는 테스트를 사용한다. 템플릿 등록은 해당 목표에서 프로젝트·도메인·작업 종류·완료 조건·변경 파일·산출물 범위 안의 반복 검증을 허용하는 설정이다. 명령의 의미와 완료 조건 연결은 최초 등록에서 확인해야 한다.

AI 계획 입력에도 템플릿을 전달한다. drive는 현재 작업에 맞는 템플릿이 정확히 하나일 때 판단 기록을 남기고 검증 계약을 자동 연결한다. 파일 허용 범위는 현재 작업이 요구한 정확한 경로로 좁힌다. 조건의 ID 또는 의미, 프로젝트 경로, 도메인, 작업 종류, 산출물·수정 범위가 맞지 않거나 여러 템플릿이 겹치면 자동 선택하지 않는다. 모델이 임의의 실행 명령을 생성하는 방식은 지원하지 않는다.

재계획 시 템플릿은 유지하지만 이미 실행한 검증 계약·성공 증거는 재사용하지 않는다. 새 작업마다 템플릿 적합성을 다시 검사한다. 템플릿을 등록하지 않은 목표는 기존처럼 작업별 계약 등록이 필요하다.

## 실제 연동 시험과 남은 경계

직접 실행 호스트는 질문 도구가 없는 print 세션에서 code-agent 동의를 받을 수 없다. 격리 프로젝트의 실측(`.master-agent/live-smoke-ce0603e1-2a69-41e6-a971-f97ae81205d3/report.json`)에서 상태 조회와 접수 시작까지 진행했고, 질문 도구·쓰기·명령 권한에서 구현 전에 차단됐다. 이 호스트에서 요구 확정·계획 승인·반영 동의는 사람이 대화형 호스트나 TTY에서 응답한다.

사람이 code-agent에서 연동을 켜고 위임 권한을 준 프로젝트는 [code-agent 통신 계약 연동](code-agent-control.md) 경로(`--control`)를 쓴다.

- code-agent 감독이 실행 세션의 질문 도구를 막고 동의는 준비까지만 하게 한다. 업무 질문은 작업 폴더의 questions.md에 남는다.
- master 판단기는 사람이 준 권한(동작·작업 또는 임무·경로·만료·사용 횟수) 안의 routine 판단만 보낸다. ambiguous는 수정 요청이나 추가 정보 요청으로, critical과 사람만 하는 동작은 사람에게 넘긴다.
- code-agent가 권한·준비 세션·보여 준 내용의 해시·상태 버전·중복·회수를 다시 검사하고, 사람 응답과 같은 적용 함수로 적용하며 `master-delegation`(사람 응답 아님)으로 남긴다. master는 승인 파일을 만들거나 사람 응답을 대신 기록하지 않는다.
- 위임 판단이 처리한 회차는 같은 세션을 자동으로 이어 간다. 그 밖의 자동 계속 조건(요구 확정·계획 승인)은 위 절과 같다.

위임 계약의 범위·기록·거부 조건의 정본은 code-agent 저장소의 `doc/master-control.md` 8절이다. 실제 AI 다중 프로젝트 전체 완료 결과는 [검증 기록](verification.md), 후속 보완 항목은 [구현 현황](implementation.md)에 있다.
