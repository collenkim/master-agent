# agent-knowledge 근거 검색 연결

agent-knowledge 색인의 문서 항목을 계획 입력에 선택적으로 더하고, 계획 작업이 인용한 항목의 참조를 code-agent 실행에 인계하는 연결 계약의 정본이다. 기본값은 꺼짐(off)이며, 끄거나 생산자가 없고 지식 참조를 쓴 계획이 없으면 [근거 수집·AI 계획](ai-planning.md)·[오케스트레이션](orchestration.md)·[관리 실행](code-agent-control.md)이 지식 연결 없이 동작할 때와 입력·기록이 같다. 색인·재색인은 agent-knowledge가 소유하며 master-agent는 검색 결과를 검증해 쓰기만 한다.

검색 결과는 문서 발췌이며 지시 권한이 없다. 현재 코드 관찰(`sources`)이나 준비 점검을 대체하지 않고 테스트 통과·승인·완료 증거로 쓰지 않는다. 인계의 접수·저장 일치·code-agent 재확인 통과도 관찰일 뿐이며 진행을 막는 쪽으로만 쓴다.

## 모드와 연결 설정

연결은 두 단계다. master-agent를 시작하는 환경 변수로 생산자 CLI를 지정하고, 프로젝트마다 모드를 지정한다. 환경 변수가 없으면 생산자를 호출하지 않는다. 모든 프로젝트가 off면 검색·임대 획득·연장을 하지 않으며, 이미 잡은 임대를 놓는 호출만 모드와 무관하게 한다([생산자 세대 임대](#생산자-세대-임대)).

| 모드 | 동작 |
| --- | --- |
| `off` (기본) | 생산자·연결 설정을 보지 않는다. 계획 입력·프롬프트·스키마·기록 형식이 지식 연결이 없을 때와 같다. 이미 승인된 계획이 지식 참조를 쓰면 그 무결성·원본 확인은 로컬로 계속하고, 필수 참조는 생산자 호출 없이 계속 인계한다 |
| `shadow` | 기존 context로 분석을 끝낸 뒤 같은 질의로 검색해 비교 기록만 남긴다. 계획 입력·contextHash·프로젝트 revision·상태 전이에 섞지 않고 임대를 잡지 않는다. 인계는 off와 같다 |
| `enabled` | AI 호출 전에 검색하고, 검증을 통과한 항목을 `context.knowledge`에 더한다. 작업이 인용한 항목은 배정 때 다시 확인하고 필수·선택 참조를 code-agent에 인계한다. 형식 2 생산자면 근거 세대 임대를 잡고 배정·이어 실행 때 연장한다 |

| 환경 변수 | 용도 | 미지정 시 |
| --- | --- | --- |
| `MASTER_AGENT_KNOWLEDGE_CLI` | agent-knowledge CLI의 JS 진입점(`dist/src/cli/main.js`) 또는 실행 파일 절대 경로 | 연결하지 않는다. enabled·shadow 프로젝트도 `knowledge-not-configured` 진단만 남기고 기존 경로로 계획한다 |
| `MASTER_AGENT_KNOWLEDGE_CONFIG` | 생산자 `--config` 파일 절대 경로 | `MASTER_AGENT_KNOWLEDGE_DB`가 있으면 생략 가능 |
| `MASTER_AGENT_KNOWLEDGE_DB` | 생산자 `--db` 절대 경로 | `MASTER_AGENT_KNOWLEDGE_CONFIG`가 있으면 생략 가능 |
| `MASTER_AGENT_KNOWLEDGE_RETRIEVAL_CONFIG` | 생산자 검색 설정(`retrieval.yaml`) 절대 경로. 형식 1 생산자에서는 내용 해시가 설정 해시에 들어간다 | CLI 위치 기준 `../../../config/retrieval.yaml` |
| `MASTER_AGENT_KNOWLEDGE_TIMEOUT_MS` | 호출 하나의 제한 시간(1000~120000) | 20000 |

생산자는 셸 없이 인자 배열로 실행하며 `AGENT_KNOWLEDGE_*` 환경 변수는 비운다. 검색·임대 흐름이 쓰는 명령은 `capabilities`, `status --response-version 2`, `search`(형식 1·2), `lease`(acquire·renew·release)다. 호출 경계(`packages/knowledge/agent-knowledge.mjs`)는 `get`·`verify` 응답 형식도 검사하지만 계획·배정 흐름은 이 둘을 부르지 않는다. 요청이 있는 명령은 master-agent 임시 폴더의 파일로 전달하고 호출 뒤 삭제한다. 대상 저장소에는 아무것도 쓰지 않는다.

```powershell
master-agent project knowledge <프로젝트ID>
master-agent project knowledge-mode <프로젝트ID> shadow --knowledge-project order-service
master-agent project knowledge-mode <프로젝트ID> enabled --revision 1 --allow-link payment-api:contract,api-catalog
master-agent project knowledge-mode <프로젝트ID> enabled --revision 2 --ranker bm25 --segments on
master-agent project knowledge-mode <프로젝트ID> off --revision 3
```

- `project knowledge`는 저장된 모드와 환경 변수 해석 결과를 보여 준다. 생산자를 호출하지 않는다.
- 연결 설정은 별도 `agent-knowledge-binding` 기록이며 프로젝트 revision·카탈로그·수집 목록을 바꾸지 않는다. 처음 만들 때는 `--revision`을 주지 않고, 이후 변경은 현재 설정 버전이 필요하다.
- shadow·enabled에는 agent-knowledge 프로젝트 ID(`^[a-z0-9][a-z0-9._-]{0,63}$`)가 필요하다. 한 agent-knowledge 프로젝트를 두 master 프로젝트에 연결할 수 없다(`knowledge-project-conflict`).
- `--allow-link <프로젝트>:<종류,…>`는 이 프로젝트 검색에서 함께 볼 외부 계약이다. 최대 8개, 종류는 `contract`·`dependency`·`api-catalog`만 허용하며 자기 자신·중복은 거부한다. 옵션을 생략하면 기존 허용 목록을 유지하고, `--allow-link none` 하나만 주면 모두 철회한다. 다른 agent-knowledge 프로젝트로 다시 연결하면 허용 목록을 물려받지 않으므로 필요하면 다시 지정한다.
- `--ranker legacy|bm25|default`·`--segments on|off|default`는 형식 2 생산자에서만 쓰는 이 프로젝트만의 검색 방식 선택이다. 생략하면 기존 값을 유지하고 `default`는 생산자 기본값으로 되돌린다. 전역 기본값과 다른 프로젝트는 바꾸지 않는다. 생산자가 형식 1이거나 고른 순위 방식·분할을 공지하지 않으면 그 프로젝트 검색은 `knowledge-feature-unavailable` 오류이며 다른 방식으로 대신 검색하지 않는다.
- `off`는 연결 정보·허용 목록·검색 방식 선택·기존 묶음·비교 기록을 지우지 않는다. 다시 켜면 같은 설정으로 돌아간다.

전체 사용자 프로젝트의 자동 활성화, 전역 설정 교체, 임베딩·벡터 DB 운영은 이 연결의 범위가 아니다.

## 검색 범위와 질의

검색 대상은 목표 범위(`scope.projectIds`)에서 해당 모드인 프로젝트뿐이다. 각 호출의 범위는 그 프로젝트의 agent-knowledge 프로젝트 하나와 명시적 허용 연결이며, master라는 이유로 다른 저장소를 더하지 않는다.

질의는 `master-knowledge-query-1` 규칙으로 목표 원문의 첫 조각, 완료 조건 설명, 나머지 목표 조각 순서로 만든다. 문장 단위로 512자 이하로 나누고 중복을 제거해 최대 8개를 쓰며, 넘는 수는 `queriesOmitted`로 남긴다. 질문 응답과 이전 계획은 질의에 쓰지 않는다.

```json
{ "profile": "master", "query": "주문 취소 정책", "limit": 10,
  "scope": { "projects": ["order-service"], "allowedLinks": [{ "project": "payment-api", "kinds": ["contract"] }] },
  "version": { "generation": 7 } }
```

위는 형식 1 요청이다. 형식 1은 프로젝트·질의 순서로 순차 호출하고, 형식 2는 프로젝트마다 질의 전체를 한 요청으로 보낸다([생산자 형식 협의](#생산자-형식-협의)). 전체 기한은 60초이며 각 호출의 제한 시간은 설정값과 남은 시간 중 작은 값이다. 남은 시간이 1초보다 적으면 호출하지 않고 `knowledge-deadline`으로 기록한다. 형식 1은 첫 성공 응답의 색인 세대·발행 시각을 고정하고 이후 요청에 `version.generation`을 보낸다. 세대가 바뀌면 그 응답을 쓰지 않는다. master-agent는 검색마다 수집(collect)이나 재색인을 실행하지 않는다.

## 생산자 형식 협의

검색 한 번(enabled 분석 또는 shadow 비교)마다 먼저 생산자 응답 형식(`responseVersion`)을 한 번 협의한다. 이 번호는 [code-agent 인계 형식](#인계-계약)과 별개다.

1. `capabilities`(응답 형식 1): `commands.search.responseVersions`에 2가 있고, `profiles.master.configHash`가 64자리 16진수이며, `index.v2RequiresSchemaVersion`이 정수여야 한다.
2. `status --response-version 2`: `databaseSchemaVersion`이 1의 `v2RequiresSchemaVersion` 이상, `activeGeneration`이 1 이상, `indexId`가 `null` 또는 32자리 16진수여야 한다.

하나라도 확인하지 못하면 형식 1로 검색하고 분석 요약 `negotiation.reason`에 사유를 남긴다.

| 사유 | 조건 |
| --- | --- |
| `capabilities-missing` | 생산자가 `capabilities` 명령을 모른다(사용법 오류) |
| `capabilities-unavailable` | `capabilities` 호출 실패 |
| `search-v2-unsupported` | 검색 형식 2·master 설정 해시·스키마 요구 판 공지가 없다 |
| `status-unavailable` · `schema-upgrade-required` | `status` 호출 실패, 생산자 DB 스키마 갱신 필요 |
| `status-v2-invalid` | 스키마 판 부족·활성 세대 없음·색인 ID 형식 오류 |
| `deadline` | 협의할 남은 시간이 1초보다 적다 |

협의는 검색 전에 한 번만 한다. 형식 2 검색 오류(범위·해시·세대·색인 불일치 포함)는 그 프로젝트 호출의 오류로 남기며 형식 1로 다시 묻지 않는다.

```json
{ "responseVersion": 2, "profile": "master", "queries": [{ "key": "q1", "text": "주문 취소 정책" }],
  "scope": { "projects": ["order-service"], "allowedLinks": [] },
  "version": { "generation": 7, "indexId": "<32자리 16진수>", "exact": true }, "limit": 10,
  "budget": { "maxItems": 16, "maxExcerptChars": "…", "maxResponseBytes": 2031616, "priority": ["direct", "linked", "mandatory", "dependencies"] },
  "ranker": "bm25", "segments": true }
```

- 질의는 생산자가 공지한 질의 수·길이 한도 안에서 보낸다. `limit`은 `min(50, 10 × 질의 수)`다.
- 세대는 `status`의 활성 세대와 색인 ID로 정확히 고정한다(`exact: true`, 색인 ID가 `null`이면 세대만). 첫 성공 응답의 발행 시각을 이후 응답과 대조한다.
- `budget`은 계획 입력 예산을 생산자 예산으로 넘긴 값이다(프로젝트 한도 16개·프로젝트별 발췌 몫·호출 출력 상한). 최종 선택은 master가 다시 바이트로 자른다.
- `ranker`·`segments`는 프로젝트가 선택했을 때만 보낸다.

## 응답 검증

| 검사 | 실패 시 |
| --- | --- |
| `schema: agent-knowledge.search`, `schemaVersion`이 요청한 응답 형식(1·2)과 같음, 종료 코드와 status 일치(ok=0, no-results=3) | `knowledge-unsupported-version` · `knowledge-invalid-output` |
| `appliedScope.projects`가 요청 프로젝트 하나, `allowedLinks`가 요청 범위 이내 | `knowledge-scope-mismatch` |
| `publishedAt`이 64자 이하 ISO-8601 시각, `index.generation`·`publishedAt`이 고정값과 같음, 출처 프로젝트가 범위 안, 커밋이 40·64자리 16진수 | `knowledge-invalid-output` · `knowledge-generation-mismatch` · `knowledge-scope-mismatch` |
| 형식 2: `index.indexId`가 `status`의 색인 ID와 같음 | `knowledge-index-mismatch` |
| 형식 2: `retrieval.configHash`가 `capabilities`의 master 설정 해시와 같음 | `knowledge-config-mismatch` |
| 형식 2: 프로젝트가 고른 순위 방식·분할 요청이 응답 `retrieval`에 반영됨 | `knowledge-feature-mismatch` |
| 형식 2: `scopeFingerprint`·`retrieval.ranker`(이름·판)·`queryVersion`·`digests`(request·items·result) 형식 | `knowledge-invalid-output` |

항목 단위 검사에 실패한 항목은 버리고 코드별 개수만 남긴다. 나머지 항목은 계속 쓴다.

| 코드 | 조건 |
| --- | --- |
| `knowledge-item-invalid` | 필수 필드·형식 위반, 8192자를 넘는 ID·제목, 4096자를 넘거나 안전하지 않은 경로(`\`·`:`·제어 문자·절대 경로·`.`/`..`). 형식 2의 `ref`(핸들 `ak-<20자리 16진수>`, 항목·출처·provenance 필드)나 조각(segment, 항목 줄 범위 안·ref의 조각 필드와 일치)이 응답과 맞지 않음 |
| `knowledge-item-out-of-scope` | 허용 연결 항목의 종류가 허용 종류 밖 |
| `knowledge-source-unknown` | 응답 `index.sources`에 없는 출처 |
| `knowledge-item-deprecated` | `deprecated` 상태 |
| `knowledge-commit-mismatch` · `knowledge-generation-mismatch` | 항목의 커밋·세대가 출처·고정 세대와 다름. 형식 2의 `ref.indexId`·`indexGeneration`이 응답 색인과 다름 |
| `knowledge-item-hash-mismatch` | 잘리지 않은 발췌의 sha256이 `itemSha256`(형식 2 조각 결과면 `segment.sha256`)과 다름. 잘린 발췌는 줄 범위가 항목(조각) 범위 안이어야 한다 |

호출 결과는 `hit`(질의 적중 항목 있음), `linked-hit`(허용 연결 항목만 적중), `rejected`(질의 적중 항목이 검증에서 모두 버려졌거나 쓸 항목이 없음), `mandatory-only`(필수·의존 자료만 반환), `no-results`, `error`로 구분한다. 버린 항목의 코드별 개수는 분석 요약의 `rejectedItems`에 남는다. 필수·의존 자료는 그 프로젝트에 질의 적중이 있을 때만 후보가 된다. 따라서 무관한 필수 항목만 돌아온 검색은 적중으로 세지 않는다.

## 계획 입력과 참조

선택은 형식 1에서 `master-knowledge-select-2`, 형식 2에서 `master-knowledge-select-3` 규칙이다. 프로젝트별 후보는 질의 적중 항목을 먼저 두고 필수·의존 자료를 그 뒤에 둔다. 적중 항목의 순서는 형식 1이 질의 순서·생산자 순위, 형식 2가 생산자의 직접 적중 순위(`directRank`)다. 생산자는 필수·의존 자료를 먼저 돌려주므로 응답 순서를 그대로 쓰지 않는다. 같은 항목(형식 2는 같은 조각)은 처음 나온 발췌로 고정한 뒤 프로젝트를 돌아가며 하나씩 넣는다. 프로젝트당 16개, 전체 40개, `min(192KiB, 1MiB − 기존 context − 64KiB)` 이내다. 남은 예산이 4KiB보다 작으면 지식을 넣지 않고 `knowledge-context-budget`을 기록한다. 기존 파일 근거를 줄여 자리를 만들지 않는다.

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

형식 2 묶음은 `retrieval`에 `contract: agent-knowledge.search@2`·`selectionVersion: master-knowledge-select-3`과 `indexId`·`configHash`·`producerQueryVersion`을 더한다. `projects[].producer`에는 `indexId`·`scopeFingerprint`·`configHash`·`ranker{name, version}`·`queryVersion`·`segments{requested, effective}`·`producerOutcome`·`budget{truncated, omittedCount}`·`digests{request, items, result}`를 남긴다. 항목에는 `indexId`·`indexGeneration`·`handle`과, 조각 결과면 `segmentId`·`segmentSha256`·`segmentStartLine`·`segmentEndLine`이 붙는다.

- 참조 ID는 `kitem:<master 프로젝트>:<sha256(itemId + "\n" + itemSha256) 앞 16자>`이며 근거 `source:` 네임스페이스와 섞지 않는다. 조각 결과는 해시 입력에 `"\n" + 조각 ID`를 더해 부모 항목·다른 조각과 구별한다. 같은 경로·제목의 항목도 생산자 항목 ID와 내용 해시가 다르면 다른 ID다.
- 파일 근거의 `source.digest`와 생산자의 `documentSha256`·`itemSha256`은 계산 대상이 달라 서로 비교·치환하지 않는다.
- 출처 `relation`은 색인 커밋과 현재 HEAD의 관계다(`same-as-head`·`ancestor-of-head`·`not-ancestor`·`unknown`). 공통 기준과 작업 브랜치의 차이를 계획 AI가 판단하도록 실제 커밋 SHA를 그대로 남긴다.
- 항목 `sourceState`는 분석 시점에 프로젝트 저장소에서 확인한 원본 상태다(`unchanged`·`unchanged-lines`·`changed`·`missing`·`unverifiable`, [원본 확인](#원본-확인)). 허용 연결 항목은 목표 범위 밖 저장소이므로 읽지 않고 `unverifiable`이다. 확정 항목이 `changed`·`missing`이면 요약 진단에 `knowledge-index-stale`과 개수를 남긴다. 재색인이 필요하다는 신호다.

`context.knowledge`가 있을 때만 프롬프트 판이 `master-planner-v6+knowledge-3`이 되고 지식 사용 규칙이 붙는다. 출력 스키마의 `decisions`·`issues`·`plan.tasks[]`에 `knowledgeRefs`가, `plan.tasks[]`에 `knowledgeRequired`가 필수로 더해지며 값은 이번 항목의 ref 열거형이다. 지식이 없으면 프롬프트 판(`master-planner-v6`)·문구·스키마가 지식 연결이 없을 때와 같고, 두 키가 없는 저장 계획도 그대로 통과한다.

| 검증 코드 | 조건 |
| --- | --- |
| `unknown-knowledge-reference` | 이번 묶음에 없는 ref, 묶음 없는 계획의 ref |
| `knowledge-reference-scope` | 작업의 ref가 다른 프로젝트(`forProject ≠ projectId`) 항목 |
| `knowledge-required-unreferenced` | `knowledgeRequired`에 그 작업의 `knowledgeRefs` 밖 ref가 있음 |
| `unconfirmed-knowledge-basis` | ready 결과의 판단 근거에 미확정(`confirmed: false`)·`conflicted` 항목 |
| `knowledge-source-stale` | 작업 ref나 ready 판단 근거에 `sourceState`가 `changed`·`missing`인 확정 항목, 또는 그런 항목을 확정 여부와 무관하게 `knowledgeRequired`에 씀. 같은 색인으로 재분석해도 배정에서 다시 막히지 않게 계획 단계에서 거부한다 |

미확정 항목은 탐색·질문·불확실성 기록에만 쓰며 확정 판단 근거가 되지 않는다. 작업 ref에 들어가도 배정에서 확정 근거로 세지 않는다(`dependsOnConfirmed`). 작업의 `references`에는 계속 수집한 `source:` ID만 쓰며 작업마다 해당 프로젝트의 실제 파일 근거가 필요하다.

contextHash는 지식 블록을 포함한 실제 입력 전체의 해시다. 설정 해시는 형식 1에서 `retrieval.yaml` 내용 해시·질의/선택 규칙 판·profile·한도·필수 자료 정책으로 만든다. 형식 2에서는 파일 바이트 대신 생산자가 의미 단위로 낸 `configHash`·생산자 질의 판·master 질의/선택 규칙 판·한도·필수 자료 정책과 프로젝트별 순위 방식·분할 선택(순위 방식 판 포함)으로 만든다. 시각·호출 순서·소요 시간·임대 ID·만료 시각은 넣지 않으므로 같은 색인·설정·목표는 같은 입력이 되고, 설정이 바뀌면 다른 입력이 된다.

### 필수 의존

작업이 인용한 항목(`knowledgeRefs`) 중 내용이 계획 때와 같아야 작업을 진행할 수 있는 항목이 필수 의존(`knowledgeRequired`)이다. 나머지는 선택 참조다.

- 지식을 실은 AI 분석은 모든 작업에 `knowledgeRequired`를 낸다(없으면 `[]`). 사람이 쓴 계획은 키를 생략할 수 있고, 있으면 같은 검사를 한다.
- 필수 여부는 `confirmed`로 정하지 않는다. 확정 여부는 판단 근거 자격이고, 필수 여부는 작업 진행에 그 내용의 검증이 필요한지다.
- 키가 있으면 의존이 선언된 것(`dependency: declared`)이다. 키가 없는 계획은 의존을 모르는 것(`unknown`)으로 보고 인용한 항목을 모두 필수로 다룬다. 선택으로 조용히 낮추지 않는다.
- 배정에서 원본이 바뀐 필수 항목은 확정 여부와 무관하게 `knowledge-source-changed`로 막는다.
- 활성 계획의 지식 요약(`plan.knowledge`)은 ref마다 `required`와 그 ref를 필수로 쓰는 작업 목록(`requiredBy`)을 남기고, 형식 2면 `indexId`·`configHash`도 남긴다.
- 관리 실행 프롬프트에는 `knowledgeRefs`·`knowledgeRequired`·발췌를 싣지 않는다. 참조는 [인계 계약](#인계-계약)의 구조화 필드로만 보낸다.

## 봉인 묶음과 보존

enabled 분석이 지식을 쓰면 분석 시작 트랜잭션에서 `agent-knowledge-bundle`(`kb:<분석ID>`)에 블록 전체와 봉인 해시를 저장한다. 분석 기록에는 `bundleId`·`bundleHash`와 검색 요약만, 활성 계획에는 작업이 인용한 ref의 식별·상태·해시·필수 여부만 남긴다. 본문은 묶음 하나(192KiB 이하)에만 있다. 형식 2 생산자에서 얻은 묶음은 근거 세대 임대(`lease`)를 함께 기록하며, 임대는 봉인 해시·contextHash 밖이다.

| 상황 | 처리 |
| --- | --- |
| 새 분석 시작 | 현재 분석·활성 계획이 쓰지 않는 이전 묶음 본문을 해제한다(`analysis-superseded`) |
| 계획 활성화 | 봉인 해시를 대조한 뒤 묶음 항목으로 작업 ref를 검증한다. 다른 계획의 묶음은 해제한다(`plan-replaced`) |
| 분류 정정 | 봉인 묶음으로 같은 입력을 다시 만든다. 묶음이 없거나 해시가 다르면 정정하지 않고 새 분석을 요구한다 |
| 일시 정지·프로세스 중단·재개 | 묶음을 유지한다. 재개 시 새 검색을 하지 않고 원래 묶음으로 배정한다 |
| 재계획 | 재분석이 새 검색·새 묶음·새 임대를 만든다. 이전 작업의 `knowledgeRefs`·`knowledgeRequired`는 새 분석 입력에서 뺀다 |
| 완료·취소(`succeeded`·`cancelled`·`simulation-complete`) | 본문을 해제하고 봉인 해시·요약은 남긴다(`mission-finished`) |

해제는 본문만 비우고 기록·해시·사유·시각은 보존한다. 잡고 있던 임대는 `release-pending`이 된다([생산자 세대 임대](#생산자-세대-임대)). 잃은 세대를 최신 세대로 자동 교체하지 않는다. 생산자가 오래된 세대를 정리해도 로컬 봉인 묶음으로 같은 계획을 검증한다.

## 생산자 세대 임대

형식 2 생산자는 보존 기간이 지난 세대를 정리한다. code-agent가 같은 근거를 다시 조회할 수 있도록 master는 계획 근거 세대를 목표 단위 보유자(`master-agent:<목표ID>`)의 생산자 임대로 붙잡는다. 새 보관 체계는 만들지 않고 생산자 `lease` 명령만 쓴다. 임대 기간은 3일(`--ttl 259200`)이다.

| 시점 | 임대 처리 |
| --- | --- |
| 분석(enabled·형식 2·지식 사용) | `lease acquire --holder master-agent:<목표ID> --generation <세대> --ttl 259200 [--index-id <색인ID>]`로 잡아 묶음 `lease`에 둔다(`held`). 실패는 분석 요약의 `lease` 상태와 진단 `knowledge-lease-failed`만 남기고 계획은 계속한다 |
| 계획 승인·활성화 | 유지한다. 생산자를 부르지 않는다 |
| 배정·이어 실행(enabled) | 임대 ID로 연장한다(`lease renew`). 만료·없음(`lease-expired`·`lease-not-found`)이면 같은 세대·색인 ID로 다시 잡고 `knowledge-lease-reacquired`를 남긴다. 분석 때 잡지 못한 임대도 이때 잡는다. 세대·색인이 사라졌으면(`generation-not-found`·`no-generation`·`index-id-mismatch`) `lost`로 고정해 다시 묻지 않는다. 그 밖의 실패는 `unavailable`이다. 연결 설정이 없거나 잘못됐으면 생산자를 부르지 않고 `unavailable`(진단 `knowledge-not-configured` 등)로 기록한다. 결과가 `held`가 아니면 `knowledge-lease-failed` 이벤트를 남긴다. 결과는 [보류 코드](#보류-코드)를 따른다 |
| 재부착(enabled) | 최선 노력으로 연장한다. 실패해도 재부착을 막지 않는다 |
| off·shadow 프로젝트 | 생산자를 부르지 않는다. 마지막 기록을 그대로 쓰며, 기록이 `lost`면 필수 참조 배정을 막는다 |
| 일시 정지·프로세스 중단 | 유지한다. 생산자를 부르지 않는다. 다음 배정·이어 실행이 연장하고, 그사이 기간이 지났으면 세대가 남아 있을 때 다시 잡는다 |
| 재개 | 원래 묶음·임대로 진행한다. 새 검색을 하지 않는다 |
| 재분석·재계획 | 새 분석이 새 묶음·새 임대를 만든다. 이전 묶음이 대체(`analysis-superseded`)·계획 교체(`plan-replaced`)로 해제되면 그 임대는 `release-pending`이 된다 |
| 완료·취소 | 묶음 해제(`mission-finished`)와 함께 `release-pending`이 된다 |

`release-pending` 임대는 `lease release --lease-id`로 놓고 `released`와 `knowledge-lease-released` 이벤트를 남긴다. 분석 종료, `mission drive`·`advance` 종료, CLI의 `mission …` 명령 뒤에 그 목표 것을 한 번에 최대 16개씩 최선 노력으로 처리한다. 실패하면 시도 횟수와 진단 코드만 남기고 다음 기회에 다시 하며, 끝내 놓지 못한 임대는 기간이 지나면 생산자가 정리한다. 놓기는 master가 잡은 자원의 정리이므로 모드와 무관하다.

형식 1 생산자에는 임대가 없다. 생산자 보존 기간 밖의 세대는 code-agent 재확인에서 실패할 수 있고 master는 배정 전에 이를 알 수 없다.

## 배정과 code-agent 인계

지식 참조가 없는 작업은 기존 배정과 같으며 `hello` 공지·생산자를 부르지 않는다. 참조가 있는 작업은 프로젝트 모드와 무관하게 배정 전에 다음을 로컬로 확인한다. 연결을 꺼도 이미 승인된 계획이 기대는 근거의 오류를 무시하고 실행하지 않는다.

1. 활성 계획의 묶음이 보존·봉인 해시 일치 상태이고 모든 ref가 그 묶음의 같은 프로젝트 항목이어야 한다. 아니면 `knowledge-integrity` 또는 `knowledge-bundle-released`로 그 작업만 막는다.
2. 항목이 지금도 그 프로젝트의 연결 범위(자기 agent-knowledge 프로젝트, 허용 연결과 종류) 안이어야 한다. 계획 뒤 다른 프로젝트로 다시 연결했거나 허용 연결을 철회했으면 `knowledge-scope-changed`로 그 작업만 막는다.
3. 확정 항목과 필수 항목의 원본을 [원본 확인](#원본-확인)으로 대조한다. `changed`·`missing`이면 `knowledge-source-changed`로 그 작업만 막는다. 그 밖 항목의 변경과 `unverifiable`은 기록만 한다.

이 확인과 함께 시도를 만들기 전(트랜잭션 밖)에 code-agent `hello`의 지식 인계 공지를 읽고 enabled면 [임대](#생산자-세대-임대)를 연장하며, 위 확인을 통과한 작업의 [인계](#인계-계약)를 정한다. 필수 참조를 보낼 수 없으면 [보류 코드](#보류-코드)로 그 작업만 막는다. 배정 트랜잭션 안에서 묶음·연결 범위를 다시 확인한다.

막힌 작업은 배정 기록을 만들지 않고 workflow 관찰에 코드를 남긴다. 다른 작업은 계속 진행한다. 근거 문제의 해결은 `mission analyze`로 새 검색·새 계획을 만드는 것이며, 새 분석은 원본이 바뀐 확정 항목을 작업 근거로 받지 않는다. 색인을 갱신하려면 agent-knowledge에서 재색인한다. 이어 실행(`continue`)도 모드와 무관하게 묶음·연결 범위를 다시 확인한다. 작업 자신의 변경이 원본을 바꿀 수 있으므로 원본 대조는 하지 않으며, 수집한 정책 문서의 변경은 기존 근거 최신성 검사가 막는다.

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

### 인계 계약

번호가 두 가지다. 생산자 응답 형식(`responseVersion` 1·2)은 master와 agent-knowledge 사이의 검색 응답 형식이고, 인계 형식(`version` 1·2)은 master가 code-agent `submit`의 `payload.knowledge`로 보내는 형식이다. 인계 형식·hello 공지·송신 결정의 정본은 공통 계약 agent-knowledge `docs/integration.md`(「인계 형식」·「송신 결정」)와 정본 사례 `docs/contract/handoff-cases.json`이다. 시험은 agent-knowledge `1d1fdba`의 정본 사례를 그대로 복사한 `tests/fixtures/agent-knowledge-handoff-cases.json`으로 송신 결정 19건과 수신 33건을 대조한다. 수신 구현은 code-agent `src/agent/master/protocol.ts`의 `knowledgeHandoffOf`·`knowledgeDigest`, `control.ts`의 `hello.knowledge` 공지, `src/agent/knowledgeGate.ts`의 진행 게이트다.

```json
"knowledge": { "schemaVersion": 1, "mode": "enabled",
  "refs": { "supported": true, "accepted": true, "max": 20, "versions": [1, 2], "supportedVersions": [1, 2], "maxBytes": 32768, "requiredGate": true, "requiredDefault": true, "scope": "registered-docs" },
  "gate": { "resume": "knowledge-blocked", "actions": ["knowledge-reverify", "knowledge-replan"], "causes": […], "ttlSeconds": 86400, "command": { "type": "knowledge", "actions": ["verify", "replace"] } } }
```

- `hello`에 공지가 없으면 지식 인계를 지원하지 않는 빌드로 본다. `schemaVersion`이 1이 아니거나 `refs`가 없는 공지는 모르는 공지로 보고 추측해 싣지 않는다. 통신 실패(`control-unavailable`)는 미지원과 구별한다.
- `versions`는 지금 받는 형식이다(형식 2는 code-agent 어댑터가 색인 식별을 대조하는 등록일 때만 들어간다). 없으면 형식 1만 받는 것으로 본다. `supportedVersions`는 그 빌드가 읽을 줄 아는 형식일 뿐 보낼 형식이 아니다. 지금 받는 형식이 비면 미수락이다.
- `requiredGate`가 `true`인 수신자만 필수 참조가 확인되기 전·실패하면 그 작업의 진행을 막고 상태로 알린다. 없으면(3c5bbac) `false`다.
- `max`는 참조 수 상한, `maxBytes`는 정본 JSON(키 정렬) 바이트 상한이다. `maxBytes`가 없으면 master가 32KiB를 지킨다. code-agent `3c5bbac`는 `max: 20`만 공지한다.
- `gate`가 있으면 수신자가 필수 근거 검증 결과를 상태 조회(`state.knowledge`)와 재개 코드 `knowledge-blocked`로 내고, `gate.command`가 있으면 `knowledge` 명령(verify)을 받는다. 없으면(3c5bbac) 그 결과를 통신 계약으로 받을 수 없다.

송신 결정(공통 계약 「송신 결정」, 작업 하나마다):

1. 참조가 없으면 `knowledge` 없이 보낸다.
2. `hello` 통신 실패는 `knowledge-receiver-unreachable`, 공지가 없거나 `refs.supported`가 `true`가 아니면 `knowledge-handoff-unsupported`다.
3. `refs.accepted`가 `false`(또는 지금 받는 형식이 없음)면 `knowledge-handoff-not-accepted`다. 형식보다 먼저 본다.
4. 필수 참조가 있으면 `requiredGate`가 `true`가 아닐 때 `knowledge-handoff-ungated`, 두 쪽이 형식 2를 함께 쓸 수 없을 때(수신자 `versions`에 2가 없거나 계획 묶음이 형식 2 생산자 결과가 아님) `knowledge-handoff-version`, 필수 참조가 `max`·`maxBytes`를 넘을 때 `knowledge-handoff-limit`으로 그 작업을 보류한다. 그 밖에는 형식 2로 보낸다. 형식 1로 내려 보내지 않는다(형식 1에는 색인 ID가 없어 다른 DB의 같은 세대 번호를 가를 수 없다).
5. 선택 참조만 있으면 함께 쓰는 가장 높은 형식으로 보낸다(형식 1은 40자리 `commit` 참조만). 상한을 넘으면 선택 참조를 뒤에서부터 빼고 뺀 목록을 남긴다.
6. 2·3·형식 불일치일 때 필수 참조가 있으면 그 작업만 보류하고, 선택 참조만 있으면 빼고 기존 경로로 진행한다(enabled 프로젝트면 `not-sent`의 `reason`이 같은 코드, 그 밖은 `knowledge-disabled`).
7. 허용 연결(외부 계약) 항목은 수신자가 자기 범위로 확인할 수 없으므로 필수면 보류(`knowledge-handoff-scope`), 선택이면 뺀다.
- `accepted`는 그 프로젝트가 지금 참조를 받는지(code-agent 쪽 agent-knowledge 연결)다. `mode`는 기록만 한다.

```json
{ "version": 1, "refs": [
  { "itemId": "order-service:docs/rules.md#…", "generation": 7, "commit": "<40자리 16진수>", "itemSha256": "<64자리 16진수>", "required": true } ] }
```

- 항목 ID는 512자 이하·제어 문자 없음·`:`와 `#` 포함, 커밋은 40자리 소문자 16진수, 해시는 64자리 소문자 16진수다. 세대는 항목의 색인 세대(형식 2면 `indexGeneration`)다.
- 형식 1에는 색인 ID·조각 식별이 없다. 같은 항목의 조각 참조는 부모 항목 참조 하나로 합치고(하나라도 필수면 필수, 시도 기록의 `refs[].merged`) 부모 항목 전체 해시로 대조한다. 같은 항목 ID에 커밋·해시·세대가 다른 참조는 표현할 수 없다.
- 형식 2는 생산자 형식 2 `items[].ref`의 필드 이름 그대로에 `required`를 더한다: `indexId`·`indexGeneration`·`itemId`·`itemSha256`·`commit`·`sourceId`·`path`·`startLine`·`endLine`(필수), 조각이면 `segmentId`·`segmentSha256`·`segmentStartLine`·`segmentEndLine`, 있으면 `handle`·`projectId`·`documentSha256`·`blobSha`. 값이 없는 선택 필드는 보내지 않는다(null 금지). 참조 열쇠는 (항목 ID, 조각 ID)라 조각은 따로 보낸다.

```json
{ "version": 2, "refs": [
  { "indexId": "<32자리 16진수>", "indexGeneration": 7, "itemId": "kb:docs/rules.md#br-001", "itemSha256": "<64자리>", "commit": "<40자리>", "sourceId": "kb",
    "path": "docs/rules.md", "startLine": 3, "endLine": 9, "projectId": "orders", "required": true } ] }
```

- 보내기 전에 수신 파서와 같은 규칙(키·형식·중복·수·바이트 상한)으로 다시 검사한다. 시도 기록에는 code-agent `knowledgeDigest`와 같은 정본 해시(`digest`: 형식과, 열쇠 순으로 정렬한 참조의 키 정렬 JSON의 SHA-256)를 남긴다.
- 발췌·제목·경로 같은 본문 정보, 묶음과 검색 요약, 허용 연결(외부 계약) 항목은 보내지 않는다. 허용 연결 항목은 수신자가 자기 저장소에서 대조할 수 없으므로 범위를 넓히지 않는다. 프롬프트 문자열에도 참조를 싣지 않는다.
- 필수 참조는 모드와 무관하게 보낸다(off·shadow는 생산자 호출 없이). 선택 참조는 enabled 프로젝트에서만 보내며, 보낼 수 없으면 사유와 함께 시도 기록 `omitted`로 뺀다(`knowledge-disabled`·`receiver-scope`·`receiver-limit`·형식 문제·`generation-expired`). 상한을 넘으면 선택 참조를 뒤에서부터 빼고 필수 참조는 자르지 않는다.
- 새 실행 접수(`submit mode:start`)에만 싣는다. 값은 배정 때 시도에 고정한 그대로라 같은 commandId 재전송은 같은 내용이다. 이어 실행(`continue`)에는 보내지 않는다. code-agent가 처음 실행의 인계를 작업에 고정해 쓰며, 같은 작업 ID로 다른 참조를 보내면 `conflict`로 거부한다. 따라서 재계획 뒤 새 시도는 새 code-agent 작업 ID로 배정한다.

### 인계 상태

| 단계 | 기록 | 의미 |
| --- | --- | --- |
| 준비(`prepared`) | 시도 `knowledgeHandoff`(기록 형식 `master-agent.knowledge-handoff` 판 2: payload·해시·바이트·`sent`·`sentRequired`·`refs`·`omitted`·`dependency`·`receiver`·`sourceCheck`·`lease`), `dispatch-live` 판단의 `knowledge` 요약 | 보낼 payload를 정해 시도에 고정했다 |
| 보내지 않음(`not-sent`) | 시도 `knowledgeHandoff.reason` | 보낼 참조가 없다(선택 참조만 있고 수신 불가·모드 off·shadow 등). 기존 배정과 같다. reason은 enabled면 공통 계약 코드(`knowledge-receiver-unreachable`·`knowledge-handoff-unsupported`·`knowledge-handoff-not-accepted`·`knowledge-handoff-version`) 또는 `no-sendable-refs`, 그 밖은 `knowledge-disabled` |
| 보류 | 시도 없음, workflow 관찰 | 필수 참조를 보낼 수 없다([보류 코드](#보류-코드)) |
| 전송 시도 | `knowledge-handoff-sent` 이벤트(submit 직전) | 보냈다는 기록일 뿐 수신 확인이 아니다 |
| 접수 | `control-run.knowledge.state`, `knowledge-handoff-accepted` 이벤트 | 접수 응답의 `knowledge.refs` 수, 그리고 돌려준 경우 형식(`version`)과 정본 해시(`digest`)가 보낸 인계와 모두 같으면 `accepted`, 하나라도 다르거나 없으면 `receipt-mismatch`. 수신자의 `receipt: stored`·`verification`은 말 그대로 남긴다(접수 ≠ 검증). 3c5bbac는 수만 돌려준다 |
| 거부 | `knowledge-handoff-rejected` 이벤트, 시도 결과 `rejected` | code-agent가 지식 인계 때문에 접수를 거부했다(`detail.reason`이 `knowledge-`로 시작: `knowledge-refs-not-accepted`·`knowledge-version-not-accepted`·`knowledge-scope`·`knowledge-format` 등, 작업 고정 `conflict`). 실행은 만들어지지 않았다 |
| 저장 확인 | `control-run.knowledge.stored`, `knowledge-handoff-checked` 이벤트 | 실행이 끝난 뒤 snapshot에서 이 실행의 작업을 찾아 고정된 참조와 대조한다: `matched`·`mismatch`·`missing`(작업에 참조 없음)·`unbound`(작업을 열지 않은 실행)·`unchecked`(snapshot 실패). 저장 확인이지 내용 검증이 아니다 |
| 검증 관찰(게이트) | `control-run.knowledge.verification`(`source: code-agent-gate`), 회차마다 시도 `delivery.verification` | 게이트를 공지한 수신자: 상태 조회의 `knowledge`(이 작업·같은 정본 해시일 때만)를 옮긴다. `verified` → `passed`(검증 시각·만료·검증 주체), `blocked`+`knowledge-replan` → `failed`(참조가 지금 근거와 맞지 않음: 해시·세대·커밋·원본 변경·범위), `blocked`+`knowledge-reverify` → `unverified`(검증 전·만료·어댑터 장애), `pending` → `pending`. 다른 작업·다른 인계의 판정은 쓰지 않는다. 검증 관찰은 이 상태 조회(`state.knowledge`)에서만 얻는다 |
| 검증 관찰(게이트 없음) | `control-run.knowledge.verification`(`state: not-reported`, `reason: receiver-without-gate`) | 게이트가 없는 수신자(3c5bbac)에게는 선택 참조만 보낸다. 그 확인 결과는 통신 계약에 없으므로 보고 없음으로 남긴다 |
| 시도 결과 | 시도 `knowledgeHandoff.delivery`, `knowledge-handoff-recorded` 이벤트 | 첫 회차 결과 기록 때 `state`(`accepted`·`receipt-mismatch`·`rejected`·`unconfirmed`·`unreported`)·`runId`·`acceptedRefs`·`stored`·`verification`을 남긴다. 첫 회차가 접수 뒤 응답을 잃어 미확인이면 재부착 결과의 접수 기록으로 고친다 |
| 재검증 | 시도 `knowledgeHandoff.reverify`, `knowledge-reverified` 이벤트 | 게이트가 재검증 판정이면 code-agent `knowledge` verify(같은 참조, 새 검색 없음)를 시도마다 한 번만 보낸다(commandId `kv-<시도ID>`) |

필수 참조를 보낸 시도(`sentRequired > 0`)는 다음이면 회차 처분을 `blocked`로 둔다(동의·질문 대기여도 막는다 — 위임 판단이 그 근거 위의 동의를 처리하지 않게. 결과 미확인 `unknown`은 그대로). 같은 코드로 이어 실행(`continue`)·독립 검증(`verify`)·인계(`handoff`)를 거부한다. 이어 실행 전에는 지금 상태 조회의 게이트 판정으로 다시 판단한다(사람이 code-agent에서 다시 검증했을 수 있다).

- 검증 `failed`(재계획 판정) → `knowledge-verification-failed`
- 검증 `unverified`(재검증 판정) → `knowledge-verification-pending`
- 시도 결과가 `rejected` → `knowledge-handoff-rejected`
- 시도 결과가 `accepted`가 아니거나 저장 확인이 `mismatch` → `knowledge-handoff-unconfirmed`

회복은 code-agent 진행 게이트의 판정을 따른다. 재검증 판정(`knowledge-reverify`)이면 `mission drive`가 같은 참조의 재검증을 시도마다 한 번 요청하고, 풀리면 이어 간다. 재계획 판정(`knowledge-replan`)이나 재검증 뒤에도 막히면 그 작업만 `knowledge-blocked`로 관찰에 남기고 사람·재계획을 기다린다. required를 낮추거나 최신 항목으로 갈음하거나 범위를 넓혀 다시 찾지 않는다. 다른 작업은 계속한다.

`missing`·`unbound`·`unchecked`·`not-reported`는 기록만 한다. 선택 참조만 보낸 시도는 막지 않는다. 접수 거부는 첫 실행의 접수 실패이므로 시도는 기존 경로대로 `unknown`(회차 오류 코드 `knowledge-handoff-rejected`)이 되고 자동으로 이어 가지 않는다. 같은 commandId는 같은 거부를 돌려주므로 다시 보내지 않으며, 원인을 고친 뒤 새 호출로 배정한다. 필수 참조를 보낸 시도의 이어 실행은 enabled면 임대를 연장하고, 세대 소실(모드 무관)·임대 실패(enabled)를 보류 코드로 거부한다.

`mission progress`의 작업 항목은 `knowledge`(`status`·`reason`·`version`·`required`·`sent`·`delivery`·`stored`·`verification`·`action`·`reverify`, 본문·payload 없음)를 보이고(대시보드 작업 표에도 같은 요약과 안내가 나온다), 이유가 지식 코드면 아래 안내 문구를 `guidance`로 함께 보인다. 인계 결과로 `blocked`가 된 작업의 이유는 그 코드다.

### 보류 코드

배정 시점 코드는 필수 참조가 있을 때만 막는다. 필수 참조가 없으면 선택 참조를 사유와 함께 빼고 기존 경로로 배정한다(세대 소실이면 선택 참조도 `generation-expired`로 뺀다).

| 코드 | 시점 | 조건 | 안내 |
| --- | --- | --- | --- |
| `knowledge-receiver-unreachable` | 배정 | `hello` 통신 실패 | 연결을 확인한 뒤 다시 배정한다 |
| `knowledge-handoff-unsupported` | 배정 | `hello`에 지식 인계 공지가 없거나, 모르는 공지이거나, 공지가 지원하지 않음(`refs.supported` false·상한 무효) | code-agent를 지식 인계 지원 판으로 올리거나 근거 없이 진행할지 다시 계획한다 |
| `knowledge-handoff-not-accepted` | 배정 | `refs.accepted`가 false이거나 지금 받는 형식이 없음 | code-agent 쪽 agent-knowledge 연결(enabled·`context.docs.refs` 등록)을 확인하거나 다시 계획한다 |
| `knowledge-handoff-ungated` | 배정 | 필수 참조가 있는데 수신자가 `requiredGate`를 공지하지 않음(3c5bbac) | 보내지 않는다. code-agent를 진행 게이트 지원 판으로 올리거나 근거 없이 진행할지 다시 계획한다 |
| `knowledge-handoff-version` | 배정 | 필수 참조가 있는데 두 쪽이 형식 2를 함께 쓸 수 없음(수신자 `versions`에 2 없음 — 색인 대조 등록 필요, 또는 계획 묶음이 형식 1 생산자 결과). 선택 참조만이면 함께 쓰는 형식이 없음 | 형식 1로 내려 보내지 않는다. 두 쪽을 맞춘 뒤 다시 분석·배정한다 |
| `knowledge-handoff-scope` | 배정 | 필수 참조가 허용 연결 항목 | 범위를 넓히지 않는다. 작업 프로젝트 근거로 다시 계획한다 |
| `knowledge-handoff-unrepresentable` | 배정 | 필수 참조를 고른 형식으로 표현할 수 없음(형식 1: 항목 ID·40자리 커밋·해시, 형식 2: 색인 ID·경로·줄 범위·조각) 또는 같은 열쇠가 충돌 | 다시 계획한다 |
| `knowledge-handoff-limit` | 배정 | 필수 참조 수가 `max`를 넘거나 필수 참조만으로 바이트 상한을 넘음 | 잘라 보내지 않는다. 작업을 나눠 다시 계획한다 |
| `knowledge-generation-expired` | 배정·이어 실행 | 임대 `lost`(`generation-not-found`·`no-generation`) | `mission analyze`로 다시 계획한다 |
| `knowledge-index-mismatch` | 배정·이어 실행 | 임대 `lost`(`index-id-mismatch`), 생산자 DB가 계획 때와 다름 | 같은 DB로 연결하거나 다시 계획한다 |
| `knowledge-lease-failed` | 배정·이어 실행(enabled만) | 임대 연장·재획득 실패(`unavailable`) | agent-knowledge 연결을 확인한 뒤 다시 실행한다 |
| `knowledge-handoff-rejected` | 접수 | code-agent가 지식 인계로 접수를 거부 | 기록된 사유를 확인하고 설정을 맞추거나 다시 계획한다 |
| `knowledge-handoff-unconfirmed` | 결과 기록 | 접수 영수증 불일치·미확인, 저장 `mismatch` | 실행 결과를 검토한다 |
| `knowledge-verification-failed` | 결과 기록 | code-agent 게이트가 재계획 판정 | required를 낮추지 않는다. 원본·색인을 확인하고 다시 계획한다 |
| `knowledge-verification-pending` | 결과 기록·재검증 | 게이트가 재검증 판정이고 한 번의 재검증으로 풀리지 않음 | 지식 검색 연결을 확인한 뒤 code-agent `knowledge verify`로 다시 검증한다 |
| `knowledge-blocked` | 상태 관찰 | code-agent 재개 코드 `knowledge-blocked`(진행 게이트가 멈춤) | code-agent status의 다음 동작(재검증·재계획)을 따른다 |

배정 시점 코드는 시도·판단·프로젝트 잠금을 만들지 않고 그 작업만 막는다. 배정 때 인계 결정·임대 상태에서 나온 보류(`knowledge-receiver-unreachable`, 배정 시점 `knowledge-handoff-*`, `knowledge-generation-expired`·`knowledge-index-mismatch`·`knowledge-lease-failed`)는 `knowledge-handoff-held` 이벤트(작업·프로젝트·코드·필수/선택 수·수신 공지, 임대 보류면 수신 공지 없음)를 남긴다. `mission drive`는 모든 지식 코드를 예상된 막힘으로 받아 workflow 관찰에 남기고 다른 작업을 계속한다. 이어 실행·검증·인계에서 나온 코드도 같은 방식으로 관찰에 남는다.

## shadow 비교 기록

shadow 프로젝트가 있는 분석은 결과를 저장한 뒤 `agent-knowledge-shadow`(`ks:<분석ID>`)를 한 번 남긴다. 분석 상태·contextHash·소요 시간, 검색 요약·진단, 선택 항목의 식별 정보(발췌 본문 없음, 40개 이하)와 프로젝트별 경로 비교(`contextPaths`·`ragPaths`·`overlap`·`ragOnly`·`contextOnly`·`citedPaths`·`citedOverlap`)를 담는다. 형식 협의 결과(`contract`·`negotiation`)와, 형식 2면 색인 ID·프로젝트별 생산자 기록(`producers`)·항목의 핸들과 조각 식별도 남긴다. 비교 키는 (프로젝트, 상대 경로)다. 검색 실패도 기록만 하며 분석 결과·상태·이벤트는 off와 같다. shadow는 임대를 잡지 않는다.

## 실패 처리

| 상황 | 진단 코드 | 처리 |
| --- | --- | --- |
| 환경 변수 없음·형식 오류 | `knowledge-not-configured` | 기존 context로 계획 |
| CLI 파일 없음·실행 실패 | `knowledge-unavailable` | 기존 context로 계획 |
| 형식 2 협의 실패 | 분석 요약 `negotiation.reason` | 형식 1로 검색 |
| 제한 시간·출력 2MiB 초과·전체 기한 | `knowledge-timeout` · `knowledge-output-limit` · `knowledge-deadline` | 해당 호출 제외 |
| 생산자 오류(색인 없음·저장소·설정·범위) | `knowledge-producer-error` + 생산자 코드·사유 | 해당 호출 제외. 생산자 메시지 원문은 저장하지 않는다 |
| 지원하지 않는 판·형식 오류 | `knowledge-unsupported-version` · `knowledge-invalid-output` | 해당 호출 제외 |
| 형식 2 색인·설정·검색 방식 불일치 | `knowledge-index-mismatch` · `knowledge-config-mismatch` · `knowledge-feature-mismatch` | 해당 호출 제외. 형식 1로 다시 묻지 않는다 |
| 프로젝트가 고른 순위 방식·분할을 생산자가 지원하지 않음 | `knowledge-feature-unavailable` | 그 프로젝트 검색 제외. 다른 방식으로 대신 검색하지 않는다 |
| 빈 결과·필수 자료만·항목 폐기·예산 부족 | 분석 요약의 `outcome: empty`·`mandatory-only`·`rejected`·`omitted` | 지식 없이 기존 입력으로 계획 |
| 색인 뒤 원본이 바뀐 확정 항목 | `knowledge-index-stale`(개수) | 항목은 `sourceState`와 함께 넣되 작업·확정 판단 근거와 필수 의존으로 받지 않는다 |
| 근거 세대 임대 실패 | `knowledge-lease-failed`, 분석 요약 `lease` | 계획은 계속한다. 배정 때 다시 잡는다 |

분석 요약(`outcome`: `used`·`unavailable`·`failed`·`omitted`·`rejected`·`mandatory-only`·`empty`, 형식 협의 `contract`·`negotiation`, 임대 `lease`)은 분석 기록과 `analyze-requirements` 판단에 남는다. 검색 실패는 계획 성공이 아니며, 계획 성공 여부는 기존 검증으로만 정한다. 무결성·범위·세대 문제와 인계 보류·접수 미확인·재확인 실패는 해당 작업만 막는다.

## 다른 저장소에 필요한 변경

master는 두 code-agent 수신 빌드와 함께 동작한다. `3c5bbac`(인계 형식 1, 공지 `max`만, 게이트 없음)에는 선택 참조만 보내고, 필수 근거 진행 게이트가 있는 `7ef02d0`(`versions`·`supportedVersions`·`maxBytes`·`requiredGate`·`gate`·정본 해시 영수증·상태 조회 `knowledge`·`knowledge` 명령·형식 2)에는 필수 참조도 보낸다. agent-knowledge에서는 `capabilities`·`status`·`search`(형식 1·2)·`lease`를 쓴다.

code-agent(소비자):

- `requiredGate`를 공지하지 않는 수신자(`3c5bbac`)는 필수 참조의 확인 실패에서 진행을 멈추지 않으므로, master는 필수 참조를 보내지 않고 그 작업을 `knowledge-handoff-ungated`로 보류한다. 필수 근거 인계에는 `7ef02d0` 이상이 필요하다.
- 게이트 빌드는 플러그인이 색인 식별 대조(`context.docs.refs.indexed`)를 받는 등록에서만 `versions: [1, 2]`를, 아니면 `[1]`을 공지한다. `[1]`이면 필수 참조는 `knowledge-handoff-version`으로 보류된다.
- 인계 교체(`knowledge replace`)는 master가 아직 보내지 않는다. 재계획은 새 묶음·새 code-agent 작업 ID로 배정하므로, 막힌 이전 작업은 사람이 code-agent에서 닫거나 교체해야 재계획 조건(모든 프로젝트 `no-work`)을 만족한다.

agent-knowledge(공통 계약):

- 공통 계약(`docs/integration.md`)의 인계 형식 2·hello 공지·송신 결정은 두 소비자의 커밋과 확인 전까지 `제안` 단계다. 확정되거나 바뀌면 이 문서와 `packages/knowledge/handoff.mjs`, 정본 사례 복사본(`tests/fixtures/agent-knowledge-handoff-cases.json`)을 함께 맞춘다.
- 형식 1 생산자의 세대 보존 한계는 [생산자 세대 임대](#생산자-세대-임대)를 따른다.

## 열린 결정

- 운영 환경에서 enabled를 켜는 시점과 대상 프로젝트, 전역 BM25 기본값 전환, 실제 정답(ground truth) 검토
- 막힌 code-agent 작업의 인계 교체(`knowledge replace`)를 master 재계획에서 보낼지 여부
- 필수 자료를 질의 적중이 있는 프로젝트에만 넣는 현재 정책의 유지 여부
- 질문 응답을 질의에 포함할지 여부
- 같은 목표의 선행 작업이 바꾼 문서로 인한 `knowledge-source-changed` 차단을 허용할지 여부
- 원본이 바뀐 확정 항목을 계획 입력에서 아예 뺄지, 재색인을 요청할지(지금은 표시하고 근거로만 받지 않는다)
- 해제된 묶음 기록과 shadow 비교 기록의 보존 기간
- 허용 연결을 프로젝트 설정이 아닌 목표 단위로 줄 필요가 있는지 여부
- 근거 세대 임대 기간(지금 3일, 운영 확정 수치가 아님)
- code-agent 게이트 빌드가 형식 2를 받는 등록(색인 식별 대조)을 기본으로 할 시점
