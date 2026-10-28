# master-agent 시스템 구조

현재 코드의 책임과 저장·실행 경계를 정리한다. 제품 목표는 [요구사항](requirements.md), 제공 기능과 후속 범위는 [구현 현황](implementation.md)을 따른다.

## 구성과 책임

```text
CLI / 로컬 대시보드
  → 프로젝트·그룹 요청 → 목표와 고정 범위
  → 근거 수집 → AI 계획 → 계획 검증·활성화
  → LangGraph 실행 조정 → code-agent 관리 실행
  → 독립 검증·반영 대조 → 계약 인계·후속 작업 → 완료 조건 판정
```

| 코드 위치 | 책임 |
| --- | --- |
| apps/cli | 명령 입력·검증과 엔진 호출 |
| apps/dashboard, packages/dashboard | 화면, 로컬 HTTP, 관측·요청함·타임라인·설치 업데이트 |
| packages/catalog, packages/knowledge | 프로젝트·그룹·경로 등록, 정책·코드·문서 근거 수집 |
| packages/reasoning | CLI 모델 호출, 계획·재검토·질문 응답과 근거 검증 |
| packages/orchestrator | 목표·계획·시도·결정, 요청 실행기, 그래프·잠금·복구·재계획 |
| packages/code-agent-adapter | 설치 탐색, 상태 관측, 페어링·관리 통신·사람 응답 계약 |
| packages/runner | 관리 호스트, 프로세스 실행·종료, 환경 정리·진단 |
| packages/verification | 변경 트리·검사 명령·산출물·반영·동의 영수증 대조 |
| packages/storage | node:sqlite 도메인 저장과 체크포인터 어댑터 |
| packages/simulation | demo와 모의 실행 그래프·러너·결과 처리 |

AI는 계획과 판단을 제안한다. 도메인 코드가 스키마·근거·권한·버전·실행 조건을 검증한 뒤 상태를 변경한다. 개발 절차와 프로젝트 내부 상태는 code-agent가 관리하며 master는 이를 직접 고쳐 단계를 넘기지 않는다.

## 실행 단위와 범위

주 실행 단위는 목표, 계획 버전, 작업, 시도다. 단일 프로젝트·그룹 요청은 목표와 같은 ID의 `target-request`를 만들고 별도 실행기로 진행한다. 접수 키로 중복을 방지하며 그룹 구성은 접수 당시의 범위로 고정한다.

프로젝트는 실제 경로를 정규화해 중복 등록을 막는다. 카탈로그는 도메인·기능·제약·현재 계획·근거를 보존한다. 한 프로젝트는 여러 그룹에 속할 수 있다. 등록 해제는 사용자 저장소를 삭제하지 않는다. 상세 조건은 [프로젝트와 그룹 삭제](ui.md#프로젝트와-그룹-삭제)를 따른다.

계획은 작업 간 의존 관계와 완료 조건을 연결한다. 준비된 독립 프로젝트의 작업은 병렬 진행하고, 같은 프로젝트의 쓰기 배정은 잠금으로 제한한다. 선행 작업의 성공 수만으로 전체 목표 완료를 판정하지 않는다. [오케스트레이션](orchestration.md)과 [검증 계약](live-verification.md)을 따른다.

## 저장과 재시작

SQLite의 `records`는 종류·ID·revision·JSON 본문을 저장한다. `events`, `locks`, `requests`, `paths`는 이벤트·프로젝트 잠금·접수 중복·경로 등록을 관리한다. `graph_leases`·`graph_runs`와 체크포인터는 그래프 실행 소유권과 재개 지점을 관리한다.

스키마는 `user_version`에 따라 순차 마이그레이션하며 현재 버전은 2다. 목표별 레코드와 이벤트에 인덱스를 사용한다. DB 트랜잭션에는 동기 저장 작업만 넣고 모델·프로세스 호출은 커밋 이후에 수행한다.

도메인 저장과 LangGraph 체크포인트는 하나의 분산 트랜잭션이 아니다. 외부 호출 전에 시도와 결정·실행 의도를 저장하고, code-agent의 원자적 접수·같은 실행 ID 재부착으로 중복 실행을 방지한다. 미확인 실행을 새 작업으로 자동 접수하지 않는다. 임대·체크포인트 수명은 [LangGraph](langgraph.md), 운영자 복구는 [복구](recovery.md)를 따른다.

## 외부 연결과 HTTP

관측은 code-agent의 구조화한 상태 조회, 개발 실행은 관리 통신 계약을 사용한다. 지원 기능·준비 상태·소유권을 확인한 뒤 접수하고, 결과·질문·동의는 각각의 공개 계약으로 대조한다. 상세 내용은 [code-agent 통신 계약](code-agent-control.md)을 따른다.

대시보드는 loopback에 바인딩하고 Host·Origin·요청 토큰·JSON 입력을 검사한다. 경로와 응답은 [로컬 HTTP 계약](ui.md#로컬-http-계약)을 정본으로 한다. `POST /api/project-candidates`는 알려진 작업 위치를 탐색하며 요청 본문으로 탐색 경로를 받지 않는다.

자식 프로세스는 실행 파일과 인자 배열, `shell: false`, `windowsHide`를 사용한다. 셸 래퍼를 직접 실행하지 않으며 호스트 표지를 제거한 환경을 전달한다. 토큰·개인 키·호스트 오류 원문은 DB·화면·모델 프롬프트에 넣지 않는다.

## code-agent 계약 소스

- 상태 조회: code-agent 저장소의 `src/agent/stateView.ts`
- CLI 연결: `src/agent/cliMain.ts`
- 호스트 정보: `src/agent/hosts.ts`
- 관리 통신: `doc/master-control.md`
- 공통 요청함: `doc/dashboard-interactions.md`
