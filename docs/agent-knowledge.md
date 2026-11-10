# agent-knowledge 근거 검색 연결

agent-knowledge 색인의 문서 항목을 계획 입력에 선택적으로 더하는 연결 계약의 정본이다. 기본값은 꺼짐(off)이며, 끄거나 생산자가 없으면 기존 [근거 수집·AI 계획](ai-planning.md)·[오케스트레이션](orchestration.md)·[관리 실행](code-agent-control.md)과 동일하게 동작한다. 색인·재색인은 agent-knowledge가 소유하며 master-agent는 검색 결과를 검증해 쓰기만 한다.

검색 결과는 문서 발췌이며 지시 권한이 없다. 현재 코드 관찰(`sources`)이나 준비 점검을 대체하지 않고 테스트 통과·승인·완료 증거로 쓰지 않는다.

## 모드와 연결 설정

연결은 두 단계다. master-agent를 시작하는 환경 변수로 생산자 CLI를 지정하고, 프로젝트마다 모드를 지정한다. 환경 변수가 없거나 모든 프로젝트가 off면 생산자를 호출하지 않는다.

| 모드 | 동작 |
| --- | --- |
| `off` (기본) | 생산자·연결 설정을 보지 않는다. 계획 입력·프롬프트·스키마·기록 형식이 연결 이전과 같다. 이미 승인된 계획이 지식 참조를 쓰면 그 무결성·원본 확인은 로컬로 계속한다 |
| `shadow` | 기존 context로 분석을 끝낸 뒤 같은 질의로 검색해 비교 기록만 남긴다. 계획 입력·contextHash·프로젝트 revision·상태 전이에 섞지 않는다 |
| `enabled` | AI 호출 전에 검색하고, 검증을 통과한 항목을 `context.knowledge`에 더한다. 작업이 인용한 항목은 배정 때 다시 확인한다 |

| 환경 변수 | 용도 | 미지정 시 |
| --- | --- | --- |
| `MASTER_AGENT_KNOWLEDGE_CLI` | agent-knowledge CLI의 JS 진입점(`dist/src/cli/main.js`) 또는 실행 파일 절대 경로 | 연결하지 않는다. enabled·shadow 프로젝트도 `knowledge-not-configured` 진단만 남기고 기존 경로로 계획한다 |
| `MASTER_AGENT_KNOWLEDGE_CONFIG` | 생산자 `--config` 파일 절대 경로 | `MASTER_AGENT_KNOWLEDGE_DB`가 있으면 생략 가능 |
| `MASTER_AGENT_KNOWLEDGE_DB` | 생산자 `--db` 절대 경로 | `MASTER_AGENT_KNOWLEDGE_CONFIG`가 있으면 생략 가능 |
| `MASTER_AGENT_KNOWLEDGE_RETRIEVAL_CONFIG` | 생산자 검색 설정(`retrieval.yaml`) 절대 경로. 내용 해시가 설정 해시에 들어간다 | CLI 위치 기준 `../../../config/retrieval.yaml` |
| `MASTER_AGENT_KNOWLEDGE_TIMEOUT_MS` | 호출 하나의 제한 시간(1000~120000) | 20000 |

생산자는 셸 없이 인자 배열로 실행하며 `AGENT_KNOWLEDGE_*` 환경 변수는 비운다. 요청은 master-agent 임시 폴더의 파일로 전달하고 호출 뒤 삭제한다. 대상 저장소에는 아무것도 쓰지 않는다.

```powershell
master-agent project knowledge <프로젝트ID>
master-agent project knowledge-mode <프로젝트ID> shadow --knowledge-project order-service
master-agent project knowledge-mode <프로젝트ID> enabled --revision 1 --allow-link payment-api:contract,api-catalog
master-agent project knowledge-mode <프로젝트ID> off --revision 2
```

- `project knowledge`는 저장된 모드와 환경 변수 해석 결과를 보여 준다. 생산자를 호출하지 않는다.
- 연결 설정은 별도 `agent-knowledge-binding` 기록이며 프로젝트 revision·카탈로그·수집 목록을 바꾸지 않는다. 처음 만들 때는 `--revision`을 주지 않고, 이후 변경은 현재 설정 버전이 필요하다.
- shadow·enabled에는 agent-knowledge 프로젝트 ID(`^[a-z0-9][a-z0-9._-]{0,63}$`)가 필요하다. 한 agent-knowledge 프로젝트를 두 master 프로젝트에 연결할 수 없다(`knowledge-project-conflict`).
- `--allow-link <프로젝트>:<종류,…>`는 이 프로젝트 검색에서 함께 볼 외부 계약이다. 최대 8개, 종류는 `contract`·`dependency`·`api-catalog`만 허용하며 자기 자신·중복은 거부한다. 옵션을 생략하면 기존 허용 목록을 유지하고, `--allow-link none` 하나만 주면 모두 철회한다. 다른 agent-knowledge 프로젝트로 다시 연결하면 허용 목록을 물려받지 않으므로 필요하면 다시 지정한다.
- `off`는 연결 정보·허용 목록·기존 묶음·비교 기록을 지우지 않는다. 다시 켜면 같은 설정으로 돌아간다.

전체 사용자 프로젝트의 자동 활성화, 전역 설정 교체, 임베딩·벡터 DB 운영은 이 연결의 범위가 아니다.

## 검색 범위와 질의

검색 대상은 목표 범위(`scope.projectIds`)에서 해당 모드인 프로젝트뿐이다. 각 호출의 범위는 그 프로젝트의 agent-knowledge 프로젝트 하나와 명시적 허용 연결이며, master라는 이유로 다른 저장소를 더하지 않는다.

질의는 `master-knowledge-query-1` 규칙으로 목표 원문의 첫 조각, 완료 조건 설명, 나머지 목표 조각 순서로 만든다. 문장 단위로 512자 이하로 나누고 중복을 제거해 최대 8개를 쓰며, 넘는 수는 `queriesOmitted`로 남긴다. 질문 응답과 이전 계획은 질의에 쓰지 않는다.

```json
{ "profile": "master", "query": "주문 취소 정책", "limit": 10,
  "scope": { "projects": ["order-service"], "allowedLinks": [{ "project": "payment-api", "kinds": ["contract"] }] },
  "version": { "generation": 7 } }
```

호출은 프로젝트·질의 순서로 순차 실행한다. 전체 기한은 60초이며 각 호출의 제한 시간은 설정값과 남은 시간 중 작은 값이다. 남은 시간이 1초보다 적으면 호출하지 않고 `knowledge-deadline`으로 기록한다. 첫 성공 응답의 색인 세대·발행 시각을 고정하고 이후 요청에 `version.generation`을 보낸다. 세대가 바뀌면 그 응답을 쓰지 않는다. master-agent는 검색마다 수집(collect)이나 재색인을 실행하지 않는다.

## 응답 검증

| 검사 | 실패 시 |
| --- | --- |
| `schema: agent-knowledge.search`, `schemaVersion: 1`, 종료 코드와 status 일치(ok=0, no-results=3) | `knowledge-unsupported-version` · `knowledge-invalid-output` |
| `appliedScope.projects`가 요청 프로젝트 하나, `allowedLinks`가 요청 범위 이내 | `knowledge-scope-mismatch` |
| `publishedAt`이 64자 이하 ISO-8601 시각, `index.generation`·`publishedAt`이 고정값과 같음, 출처 프로젝트가 범위 안, 커밋이 40·64자리 16진수 | `knowledge-invalid-output` · `knowledge-generation-mismatch` · `knowledge-scope-mismatch` |

항목 단위 검사에 실패한 항목은 버리고 코드별 개수만 남긴다. 나머지 항목은 계속 쓴다.

| 코드 | 조건 |
| --- | --- |
| `knowledge-item-invalid` | 필수 필드·형식 위반, 8192자를 넘는 ID·제목, 4096자를 넘거나 안전하지 않은 경로(`\`·`:`·제어 문자·절대 경로·`.`/`..`) |
| `knowledge-item-out-of-scope` | 허용 연결 항목의 종류가 허용 종류 밖 |
| `knowledge-source-unknown` | 응답 `index.sources`에 없는 출처 |
| `knowledge-item-deprecated` | `deprecated` 상태 |
| `knowledge-commit-mismatch` · `knowledge-generation-mismatch` | 항목의 커밋·세대가 출처·고정 세대와 다름 |
| `knowledge-item-hash-mismatch` | 잘리지 않은 발췌의 sha256이 `itemSha256`과 다름. 잘린 발췌는 줄 범위가 항목 범위 안이어야 한다 |

호출 결과는 `hit`(질의 적중 항목 있음), `linked-hit`(허용 연결 항목만 적중), `rejected`(질의 적중 항목이 검증에서 모두 버려졌거나 쓸 항목이 없음), `mandatory-only`(필수·의존 자료만 반환), `no-results`, `error`로 구분한다. 버린 항목의 코드별 개수는 분석 요약의 `rejectedItems`에 남는다. 필수·의존 자료는 그 프로젝트에 질의 적중이 있을 때만 후보가 된다. 따라서 무관한 필수 항목만 돌아온 검색은 적중으로 세지 않는다.

## 계획 입력과 참조

선택은 `master-knowledge-select-2` 규칙이다. 프로젝트별 후보는 질의 적중 항목(질의 순서·생산자 순위)을 먼저 두고 필수·의존 자료를 그 뒤에 둔다. 생산자는 필수·의존 자료를 먼저 돌려주므로 응답 순서를 그대로 쓰지 않는다. 같은 항목은 처음 나온 발췌로 고정한 뒤 프로젝트를 돌아가며 하나씩 넣는다. 프로젝트당 16개, 전체 40개, `min(192KiB, 1MiB − 기존 context − 64KiB)` 이내다. 남은 예산이 4KiB보다 작으면 지식을 넣지 않고 `knowledge-context-budget`을 기록한다. 기존 파일 근거를 줄여 자리를 만들지 않는다.

```json
{
  "notice": "agent-knowledge 색인에서 검색한 문서 발췌다 …",
  "retrieval": { "contract": "agent-knowledge.search@1", "queryVersion": "master-knowledge-query-1", "selectionVersion": "master-knowledge-select-2",
    "settingsHash": "…", "generation": 7, "publishedAt": "…", "indexVersions": {}, "queries": [], "queriesOmitted": 0,
    "projects": [{ "projectId": "order", "knowledgeProject": "order-service", "head": "…",
      "sources": [{ "sourceId": "order-service", "commit": "…", "relation": "same-as-head" }], "outcomes": [], "rejected": {}, "selected": 3, "dropped": 0 }] },
  "items": [{ "ref": "kitem:order:0123456789abcdef", "forProject": "order", "scopeRole": "project", "itemId": "…", "status": "confirmed_policy",
    "confirmed": true, "path": "docs/rules.md", "startLine": 10, "endLine": 18, "commit": "…", "blobSha": "…",
    "documentSha256": "…", "itemSha256": "…", "excerptTruncated": false, "excerpt": "…", "sourceState": "unchanged" }]
}
```

- 참조 ID는 `kitem:<master 프로젝트>:<sha256(itemId + "\n" + itemSha256) 앞 16자>`이며 근거 `source:` 네임스페이스와 섞지 않는다. 같은 경로·제목의 항목도 생산자 항목 ID와 내용 해시가 다르면 다른 ID다.
- 파일 근거의 `source.digest`와 생산자의 `documentSha256`·`itemSha256`은 계산 대상이 달라 서로 비교·치환하지 않는다.
- 출처 `relation`은 색인 커밋과 현재 HEAD의 관계다(`same-as-head`·`ancestor-of-head`·`not-ancestor`·`unknown`). 공통 기준과 작업 브랜치의 차이를 계획 AI가 판단하도록 실제 커밋 SHA를 그대로 남긴다.
- 항목 `sourceState`는 분석 시점에 프로젝트 저장소에서 확인한 원본 상태다(`unchanged`·`unchanged-lines`·`changed`·`missing`·`unverifiable`, [원본 확인](#원본-확인)). 허용 연결 항목은 목표 범위 밖 저장소이므로 읽지 않고 `unverifiable`이다. 확정 항목이 `changed`·`missing`이면 요약 진단에 `knowledge-index-stale`과 개수를 남긴다. 재색인이 필요하다는 신호다.

`context.knowledge`가 있을 때만 프롬프트 판이 `master-planner-v6+knowledge-2`가 되고 지식 사용 규칙이 붙는다. 출력 스키마의 `decisions`·`issues`·`plan.tasks[]`에 `knowledgeRefs`가 필수로 더해지며 값은 이번 항목의 ref 열거형이다. 지식이 없으면 프롬프트·스키마가 기존과 같고, 기존 저장 계획은 `knowledgeRefs`가 없어도 그대로 통과한다.

| 검증 코드 | 조건 |
| --- | --- |
| `unknown-knowledge-reference` | 이번 묶음에 없는 ref, 묶음 없는 계획의 ref |
| `knowledge-reference-scope` | 작업의 ref가 다른 프로젝트(`forProject ≠ projectId`) 항목 |
| `unconfirmed-knowledge-basis` | ready 결과의 판단 근거에 미확정(`confirmed: false`)·`conflicted` 항목 |
| `knowledge-source-stale` | 작업 ref나 ready 판단 근거에 `sourceState`가 `changed`·`missing`인 확정 항목. 같은 색인으로 재분석해도 배정에서 다시 막히지 않게 계획 단계에서 거부한다 |

미확정 항목은 탐색·질문·불확실성 기록에만 쓰며 확정 판단 근거가 되지 않는다. 작업 ref에 들어가도 배정에서 확정 근거로 세지 않는다(`dependsOnConfirmed`, 원본 변경은 기록만). 작업의 `references`에는 계속 수집한 `source:` ID만 쓰며 작업마다 해당 프로젝트의 실제 파일 근거가 필요하다.

contextHash는 지식 블록을 포함한 실제 입력 전체의 해시다. 설정 해시는 `retrieval.yaml` 내용 해시·질의/선택 규칙 판·profile·한도·필수 자료 정책으로 만든다. 시각·호출 순서·소요 시간은 넣지 않으므로 같은 색인·설정·목표는 같은 입력이 되고, 설정이 바뀌면 다른 입력이 된다.

## 봉인 묶음과 보존

enabled 분석이 지식을 쓰면 분석 시작 트랜잭션에서 `agent-knowledge-bundle`(`kb:<분석ID>`)에 블록 전체와 봉인 해시를 저장한다. 분석 기록에는 `bundleId`·`bundleHash`와 검색 요약만, 활성 계획에는 작업이 인용한 ref의 식별·상태·해시만 남긴다. 본문은 묶음 하나(192KiB 이하)에만 있다.

| 상황 | 처리 |
| --- | --- |
| 새 분석 시작 | 현재 분석·활성 계획이 쓰지 않는 이전 묶음 본문을 해제한다(`analysis-superseded`) |
| 계획 활성화 | 봉인 해시를 대조한 뒤 묶음 항목으로 작업 ref를 검증한다. 다른 계획의 묶음은 해제한다(`plan-replaced`) |
| 분류 정정 | 봉인 묶음으로 같은 입력을 다시 만든다. 묶음이 없거나 해시가 다르면 정정하지 않고 새 분석을 요구한다 |
| 일시 정지·프로세스 중단·재개 | 묶음을 유지한다. 재개 시 생산자를 다시 호출하지 않는다 |
| 재계획 | 재분석이 새 검색·새 묶음을 만든다. 이전 작업의 `knowledgeRefs`는 새 분석 입력에서 뺀다 |
| 완료·취소(`succeeded`·`cancelled`·`simulation-complete`) | 본문을 해제하고 봉인 해시·요약은 남긴다(`mission-finished`) |

해제는 본문만 비우고 기록·해시·사유·시각은 보존한다. 잃은 세대를 최신 세대로 자동 교체하지 않는다. 생산자가 오래된 세대를 정리해도 로컬 봉인 묶음으로 같은 계획을 검증한다.

## 배정과 code-agent 인계

지식 참조가 없는 작업은 기존 배정과 같다. 참조가 있는 작업은 프로젝트 모드와 무관하게 배정 전에 다음을 확인한다. 모두 로컬 검사이며 생산자를 호출하지 않는다. 연결을 꺼도 이미 승인된 계획이 기대는 근거의 오류를 무시하고 실행하지 않는다.

1. 활성 계획의 묶음이 보존·봉인 해시 일치 상태이고 모든 ref가 그 묶음의 같은 프로젝트 항목이어야 한다. 아니면 `knowledge-integrity` 또는 `knowledge-bundle-released`로 그 작업만 막는다.
2. 항목이 지금도 그 프로젝트의 연결 범위(자기 agent-knowledge 프로젝트, 허용 연결과 종류) 안이어야 한다. 계획 뒤 다른 프로젝트로 다시 연결했거나 허용 연결을 철회했으면 `knowledge-scope-changed`로 그 작업만 막는다.
3. 확정 항목의 원본을 [원본 확인](#원본-확인)으로 대조한다. `changed`·`missing`이면 `knowledge-source-changed`로 그 작업만 막는다. 미확정 항목의 변경과 `unverifiable`은 기록만 한다.

막힌 작업은 배정 기록을 만들지 않고 workflow 관찰에 코드를 남긴다. 다른 작업은 계속 진행한다. 해결은 `mission analyze`로 새 검색·새 계획을 만드는 것이며, 새 분석은 원본이 바뀐 확정 항목을 작업 근거로 받지 않는다. 색인을 갱신하려면 agent-knowledge에서 재색인한다. 배정 트랜잭션 안에서 묶음·연결 범위를 다시 확인한다. 이어 실행(`continue`)도 모드와 무관하게 묶음·연결 범위를 다시 확인한다. 작업 자신의 변경이 원본을 바꿀 수 있으므로 원본 대조는 하지 않으며, 수집한 정책 문서의 변경은 기존 근거 최신성 검사가 막는다.

### 원본 확인

작업 프로젝트 저장소에 항목의 색인 커밋과 같은 blob이 있어야 같은 원본으로 본다. 없으면 `unverifiable`이다. 그다음 HEAD 커밋의 파일과 작업 트리의 파일을 각각 대조하고 더 나쁜 상태를 쓴다. 작업 트리를 함께 보는 것은 커밋하지 않은 변경(선행 작업의 `local-files` 인계 등)도 실제 작업이 보는 원본이기 때문이다.

| 상태 | 조건 |
| --- | --- |
| `unchanged` | blob(작업 트리는 문서 sha256)이 색인과 같다 |
| `unchanged-lines` | 문서는 바뀌었지만 항목 줄 범위의 해시가 `itemSha256`과 같다 |
| `changed` | 줄 범위 해시가 다르거나, 색인과 다른 내용을 읽거나 UTF-8로 디코드할 수 없다(폴더로 바뀜·16MiB 초과 포함) |
| `missing` | 파일이 없다 |
| `unverifiable` | 저장소·색인 커밋·HEAD를 확인할 수 없다 |

줄 범위 해시는 생산자와 같은 규칙(UTF-8 엄격 디코드·BOM 제거·CRLF/CR/LF 분할·`\n` 결합)으로 계산한다. Git 호출은 읽기 전용(`GIT_OPTIONAL_LOCKS=0`)이다.

code-agent와 합의한 수신 계약이 없으므로 인계 블록(`master-agent.knowledge-handoff` v1: 묶음 ID·해시·세대, 항목 식별·경로·줄·커밋·blob·해시, 본문 없음, 40개·32KiB 이하)은 계산만 하고 보내지 않는다. 시도에는 `knowledgeHandoff: { status: 'not-sent', reason: 'no-agreed-contract', hash, count, dependsOnConfirmed, sourceCheck }`를 남긴다. 프로젝트 모드가 enabled가 아니면 reason은 `knowledge-disabled`다. 관리 실행 프롬프트에서는 `knowledgeRefs`를 빼며 `submit` 필드·승인·권한 프로토콜과 도구 권한은 바꾸지 않는다. 지식 참조는 배정 판단의 evidence나 검증 통과 근거가 아니다.

## shadow 비교 기록

shadow 프로젝트가 있는 분석은 결과를 저장한 뒤 `agent-knowledge-shadow`(`ks:<분석ID>`)를 한 번 남긴다. 분석 상태·contextHash·소요 시간, 검색 요약·진단, 선택 항목의 식별 정보(발췌 본문 없음, 40개 이하)와 프로젝트별 경로 비교(`contextPaths`·`ragPaths`·`overlap`·`ragOnly`·`contextOnly`·`citedPaths`·`citedOverlap`)를 담는다. 비교 키는 (프로젝트, 상대 경로)다. 검색 실패도 기록만 하며 분석 결과·상태·이벤트는 off와 같다.

## 실패 처리

| 상황 | 진단 코드 | 처리 |
| --- | --- | --- |
| 환경 변수 없음·형식 오류 | `knowledge-not-configured` | 기존 context로 계획 |
| CLI 파일 없음·실행 실패 | `knowledge-unavailable` | 기존 context로 계획 |
| 제한 시간·출력 2MiB 초과·전체 기한 | `knowledge-timeout` · `knowledge-output-limit` · `knowledge-deadline` | 해당 호출 제외 |
| 생산자 오류(색인 없음·저장소·설정·범위) | `knowledge-producer-error` + 생산자 코드·사유 | 해당 호출 제외. 생산자 메시지 원문은 저장하지 않는다 |
| 지원하지 않는 판·형식 오류 | `knowledge-unsupported-version` · `knowledge-invalid-output` | 해당 호출 제외 |
| 빈 결과·필수 자료만·항목 폐기·예산 부족 | 분석 요약의 `outcome: empty`·`mandatory-only`·`rejected`·`omitted` | 지식 없이 기존 입력으로 계획 |
| 색인 뒤 원본이 바뀐 확정 항목 | `knowledge-index-stale`(개수) | 항목은 `sourceState`와 함께 넣되 작업·확정 판단 근거로 받지 않는다 |

분석 요약(`outcome`: `used`·`unavailable`·`failed`·`omitted`·`rejected`·`mandatory-only`·`empty`)은 분석 기록과 `analyze-requirements` 판단에 남는다. 검색 실패는 계획 성공이 아니며, 계획 성공 여부는 기존 검증으로만 정한다. 무결성·범위·세대 문제는 해당 작업 배정만 막는다.

## 다른 저장소에 필요한 변경

현재 연결은 agent-knowledge `search` v1의 구현된 필드만 사용한다. 아래 항목은 계약이 준비되기 전까지 master-agent가 독자 필드로 연동 완료를 선언하지 않는 부분이다. 생산자가 기능 조회와 새 응답 판을 공통 계약 문서에 확정하면 기능 조회로 협상한 뒤 전환한다. 그 전에는 기본 응답 판만 요청하고, 다른 판의 응답은 `knowledge-unsupported-version`으로 처리해 기존 경로를 쓴다.

agent-knowledge(생산자):

- 색인 DB 식별자와 세대 고정. DB를 다시 만들면 세대 번호가 다시 시작되므로 지금은 `publishedAt`까지 대조한다. 안정적인 index ID나 세대 lease·pin이 필요하다.
- 검색 설정·순위 판의 응답 표기. 지금은 master가 `retrieval.yaml` 내용 해시로 대신한다.
- 원본 항목 ID와 분할 항목 ID의 구분, 응답 크기 예산 요청 필드, 필수 자료 포함 여부의 요청 옵션.

code-agent(소비자):

- `hello`의 지식 인계 기능 공지와 `submit`의 인계 블록 필드. 공지가 없는 빌드에는 보내지 않는다.
- 수신 측의 Git 대조(커밋·blob·줄 해시)와 원본 변경·세대 만료 시 처리, 수신 확인(ack).

## 열린 결정

- 필수 자료를 질의 적중이 있는 프로젝트에만 넣는 현재 정책의 유지 여부
- 질문 응답을 질의에 포함할지 여부
- 같은 목표의 선행 작업이 바꾼 문서로 인한 `knowledge-source-changed` 차단을 허용할지 여부
- 원본이 바뀐 확정 항목을 계획 입력에서 아예 뺄지, 재색인을 요청할지(지금은 표시하고 근거로만 받지 않는다)
- 해제된 묶음 기록과 shadow 비교 기록의 보존 기간
- 허용 연결을 프로젝트 설정이 아닌 목표 단위로 줄 필요가 있는지 여부
