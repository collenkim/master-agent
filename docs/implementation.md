# 구현 현황과 다음 작업

기준일: 2026-10-16. 실행 흐름은 [README](../README.md), 실제 결과는 [검증 기록](verification.md), 제품 목표는 [요구사항](requirements.md)을 따른다.

## 현재 제공 범위

| 영역 | 현재 상태 |
| --- | --- |
| 실행 기반 | Node.js 24 ESM, SQLite, LangGraph JS 노드·체크포인트·실행 소유권 |
| 목표와 계획 | 프로젝트·그룹·근거 수집, Codex·Claude CLI 분석 어댑터, 계획 검증·재검토·질문 응답 |
| 실제 개발 | Claude 개발 호스트, code-agent 접수·결과 조회 분리, 독립 프로젝트 병렬 실행, 위임 판단·같은 세션 계속 실행 |
| 인계·관측 | 검증 계약의 exports → 파일·검사에 결합된 inputContracts 인계, mission progress의 작업별 대기 원인 |
| 완료 판정 | 정확한 변경 범위·독립 검사·산출물·반영 커밋·동의 영수증·통합 작업 대조 |
| 복구·제어 | 범위 내 수정·재검증·재계획, 분석 취소·관측 복구, 정지·취소·재부착·제어권 인계 |
| 검증 | 자동 회귀 163개, 앞선 답 실제 판단 5건, 보완 전 두 프로젝트·세 작업 실제 전체 완료 |

`drive --control`은 독립 프로젝트를 먼저 접수해 외부 실행을 겹치고, DB 변경·판단·검사는 순차 처리한다. 직접 Claude 실행은 기존 방식으로 종료를 기다린다. UI·HTTP 서버·원격 러너·운영 예산·Codex 개발 호스트는 미구현이다. 추가 파일의 자율 탐색과 카탈로그 자동 갱신도 별도 범위다. 복구 제어의 자동 시험과 실제 모델 정상 흐름의 확인 범위를 구분한다.

CLI는 `apps/cli`, 도메인·저장·카탈로그·근거·판단·오케스트레이션·러너·code-agent 어댑터·검증 모듈은 `packages/`에 있다. 세부 실행 계약은 [LangGraph](langgraph.md)와 [code-agent 통신](code-agent-control.md)을 따른다.

## 다음 보완 작업

실제 실행에서 발견한 master 보완 세 항목을 구현했다. code-agent 내부 담당 입력과 답 출처 보완은 별도 작업이다. 샘플의 명세·검사 불일치는 [검증 기록](verification.md)에 시험 하네스 문제로 구분했다.

**master-agent**

| 상태 | 보완 항목 | 구현 및 확인 범위 |
| --- | --- | --- |
| 완료 | 선행 작업의 계약을 구조화해 인계 | [검증 계약](live-verification.md)의 exports에 함수·입력 범위·반환·오류·검사 ID를 등록한다. 실제 파일 해시·통과한 검사·증거·커밋에 결합해 간접 의존 작업까지 inputContracts로 전달한다. 후속 접수·계속 실행·승인·질문 판단에 포함하고 세부 담당 전달을 지시한다. code-agent 내부 입력 해시 연결은 아래 별도 범위다. |
| 완료 | 독립 프로젝트의 실행 대기 분리 | 접수 직후 실행 ID를 저장하고 결과를 한 번씩 조회한다. 서로 다른 프로젝트의 실행 겹침, 잠금·의존성, pause, DB 재연결, 관측 시간 초과 후 중복 접수 금지를 회귀로 확인했다. 이전 실제 모델 75분 실행은 순차 실행 결과이며 신규 병렬 경로의 실제 모델 재검증은 남아 있다. |
| 완료 | 진행 상태와 대기 원인 표시 | 원래 state는 보존한다. mission progress와 show.progress에서 실행·위임 대기·위임 처리·사람 답·장애·검증·인계를 구분하고 phase·runId·마지막 진척 시각을 제공한다. 별도 CLI 프로세스에서 판단 중 상태를 읽는 회귀를 추가했다. |

**code-agent**

| 우선순위 | 보완 항목 | 관찰 및 완료 기준 |
| --- | --- | --- |
| 1 | 기존 계약 재인용과 사람 답의 출처 구분 | checkout Q1은 개발 호스트가 배정 지시문의 criteria[discount]를 인용해 답했으며 새 사용자 답은 없었다. questions.md에는 `[Source]: 대화`로 저장됐고 `src/agent/answers.ts`는 이를 conversation(대화 직접 입력·관찰 안 됨)으로 표시한다. 실제 사람 답으로 인증한 것은 아니지만, 기존 계약에서 도출한 답과 미관찰 대화 답을 구분할 필요가 있다. 근거 경로·커밋·내용 해시가 있는 출처를 추가하고 master의 위임·사람 전달 출처와 섞이지 않는지 검증한다. |
| 1 | 세부 담당의 외부 의존 계약 입력 보완 | checkout의 explore·design 담당은 discount.js가 배정 inputs 밖이라고 기록했고, design이 needs-input을 반환했다. `src/agent/planning.ts`·`planningState.ts`에서 선행 결과의 확인된 계약 또는 명시적으로 허용한 의존 소스를 담당 입력과 입력 해시에 포함한다. 전 저장소 읽기 허용으로 우회하지 않으며 근거가 없으면 질문하는 동작은 유지한다. |
| 2 | 결과 응답의 불필요한 재생성 줄이기 | design 담당이 result.json을 쓴 뒤 `결과: <경로>`와 설명을 함께 반환했다. `src/agent/planningState.ts`의 RESULT_POINTER는 한 줄 전체 일치만 허용해 `planningHook.ts`에서 JSON 파싱 오류와 보정 재배정이 발생했다. 통합 리뷰에서도 `- 없음` 뒤에 검토 근거를 붙여 형식 오류로 두 번째 리뷰어 호출이 필요했다. 구조화된 반환을 우선하고, 부연이 붙은 응답을 수용할 경우에도 현재 배정의 정확한 resultFile·소유권·스키마·입력 해시 및 리뷰 지적 유무 검증을 유지한다. |
| 2 | 실행 가능한 테스트 계획을 처음부터 생성 | 합계 계획에서 '전체 테스트 통과'를 독립 TC로 둔 자기참조 항목이 critic에 차단돼 수정됐다. 통합 계획에서도 `[PLN-SEQ] T2: 담당 요구의 완료 기준이 없습니다`로 첫 결과가 거부돼 재작성했다. 기능 assertion과 전체 실행·기존 파일 보존 같은 절차를 분리하고, 작업별 AC 연결을 생성 시 점검해 보정 비용을 줄인다. 기존 검사가 잘못된 계획을 차단한 것은 정상 동작이다. |

다음 단계는 code-agent의 담당 입력·답 출처에 master의 inputContracts 형식을 연결하고, 갱신된 실제 모델 하네스로 계약 전달과 병렬 흐름을 함께 재검증하는 것이다.


## 후속 검증의 완료 기준

1. 계약 인계·답 출처 보완 후 동일한 두 프로젝트 통합에서 이미 알려진 계약을 다시 묻지 않는지, 근거가 없는 답은 여전히 보류되는지 확인한다.
2. 병렬 스케줄링의 자동 회귀는 추가했다. 실제 모델에서도 서로 다른 프로젝트의 실행 시간 겹침, 같은 프로젝트 잠금, 후행 작업 대기, 중복 접수·중단 복구를 확인한다.
3. 실제 모델의 실패 수정·재계획·master 재시작과 재부착을 격리 저장소에서 실행한다. 정상 흐름 성공으로 대체하지 않는다.
4. 최초 AI 계획 생성부터 검증 계약 연결·전체 완료까지 연속 실행하고, 이후 Codex 및 더 큰 업무 사례로 확장한다.

## code-agent 담당 Codex에 전달할 작업 지시

아래 블록을 `C:/IdeaProjects/code-agent`를 연 Codex 대화에 복사해 실행한다.

```text
C:/IdeaProjects/code-agent에서 다음 보완 작업을 진행해줘.

먼저 AGENTS.md와 현재 소스·미커밋 변경을 확인하고 기존 사용자 작업을 보존해줘.
근거 문서:
- C:/IdeaProjects/master-agent/docs/implementation.md
- C:/IdeaProjects/master-agent/docs/evidence/2026-10-16-full-flow.json
- C:/IdeaProjects/master-agent/docs/evidence/2026-10-16-answer-context.json

2026-10-16 실제 Claude 시험은 두 프로젝트·세 작업이 모두 성공했다.
아래는 그 과정에서 발견한 입력 전달·출처·재호출 비용의 보완이다.
증거 JSON과 기존 실행 기록은 수정하지 말고, 새 검증은 격리 저장소에서 해줘.

1. 세부 담당에게 외부 의존 계약 전달
   - checkout의 explore/design은 discount.js가 inputs 밖이라 조건을 읽지 못했다.
     전체 배정의 criteria[discount]에는 이미 입력 범위·오류 계약이 있었다.
   - planning.ts·planningState.ts와 배정 입력 생성 경로를 확인해,
     확인된 선행 계약 또는 명시적으로 허용한 의존 소스를 담당 입력에 포함해줘.
   - 근거 경로·커밋·내용 해시를 유지하고 입력 해시/변경 감지에 반영해줘.
     전체 저장소 읽기 허용으로 우회하지 말고 자료가 없거나 모순되면 질문해야 해.
   - master는 이제 inputContracts 배열을 접수·계속 실행 프롬프트에 보낸다.
     각 항목은 taskId/projectId/evidenceId/verificationRunId/treeDigest/commit/contracts이며,
     contracts에는 id/path/symbol/inputs[{name,type,range}]/returns{type,description}/
     errors[{type,when}]/checkIds/sourceDigest/contractHash가 있다.
     스키마와 예시는 master-agent/docs/live-verification.md를 참조해줘.
     프롬프트 문자열만으로 출처를 인증하지 말고 기존 입력·신뢰 경계를 유지해줘.
   - master 쪽 형식 변경이 필요하면 필요한 계약을 명시해줘.
     master-agent 저장소는 이 작업에서 수정하지 마.

2. 기존 계약 재인용과 사람 답의 출처 분리
   - checkout Q1은 호스트가 기존 criteria를 인용한 답인데 [Source]: 대화로 기록됐다.
     실제 사용자 답은 없었고 기존 표시는 conversation(관찰 안 됨)이었다.
   - answers.ts·questions.ts·답 기록 명령·표시·템플릿을 확인하고,
     근거 있는 기존 계약 재사용을 conversation/observed/delegated/relayed와 구분해줘.
   - 단순 Source 문자열만으로 검증된 출처를 만들지 않도록 하고,
     답·근거 변조나 상충 시 인증된 답으로 인정하지 않는 회귀를 추가해줘.
   - 기존 출처의 호환성과 실제 사람 승인·master 위임 권한 검사는 유지해줘.

3. 설계·리뷰 결과 응답의 형식 안정화
   - design이 resultFile 포인터 뒤에 설명을 붙여 JSON 파싱 오류로 재배정됐다.
     리뷰도 '- 없음' 뒤에 근거 설명을 붙여 두 번째 호출이 필요했다.
   - planningHook.ts·RESULT_POINTER·리뷰 파서·호스트 지침을 대조하고,
     구조화된 결과와 설명을 분리해 같은 내용을 재생성하는 호출을 줄여줘.
   - 포인터를 처리한다면 현재 배정의 정확한 resultFile, 소유권, 스키마,
     입력 해시·크기 제한을 유지해줘. 잘못된 경로·복수 포인터·손상된 JSON과
     '없음'에 상충하는 실제 지적을 포함한 응답은 정상 성공으로 처리하지 마.

4. 계획·테스트 케이스 생성 품질
   - 합계에서 '전체 테스트 통과' 자체를 TC로 만들어 critic이 차단했다.
     checkout 계획은 T2의 완료 기준 연결 누락으로 PLN-SEQ 검사에 실패했다.
   - 계획 템플릿·지침·사전 검증에서 기능 assertion과 전체 실행/파일 보존 절차를
     구분하고, 각 작업의 요구·AC·TC 연결을 빠짐없이 만들도록 보완해줘.
   - 기존 게이트를 약화하거나 테스트를 삭제해 통과시키지 말아줘.

각 항목의 유효한 처리와 거부해야 할 반례를 테스트하고,
저장소가 요구하는 빌드·테스트·문서 동기화를 수행해줘.
검증한 내용과 미검증 범위, master-agent에서 필요한 후속 변경을 구분해 정리하고,
code-agent의 관련 변경만 커밋해줘. 원격 push는 하지 마.
```
