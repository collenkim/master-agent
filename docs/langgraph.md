# LangGraph 실행 구조

master-agent의 자동 진행, AI 계획 검토, 실패 복구, 재계획, 모의 실행과 Mission 변경 CLI는 LangGraph JS로 실행합니다. 프로젝트 카탈로그·권한 검사·code-agent 통신·파일 검증은 그래프가 호출하는 도메인 서비스입니다.

## 설치와 실행

Node.js 24.19 이상 24.x에서 잠금 파일 기준으로 설치합니다.

```powershell
npm.cmd ci --ignore-scripts
npm.cmd test
npm.cmd run check
npm.cmd start -- mission graph <MISSION_ID>
```

공식 SqliteSaver에는 Node 내장 SQLite 어댑터를 전달합니다. better-sqlite3의 네이티브 바이너리를 사용하지 않으므로 설치 스크립트 실행은 필요하지 않습니다.

기존 `mission analyze`, `advance`, `drive`, `dispatch`, `continue`, `recover`, `replan` 명령과 결과 형식은 유지됩니다. `drive --provider codex|claude`는 근거 수집을 마친 received 상태에서 계획 생성도 시작합니다. 계획의 미해결 질문이나 부족한 검증 계약을 자동 승인하지 않습니다.

## 그래프와 책임

| 그래프 | 주요 노드 |
| --- | --- |
| Mission | refresh → select → analyze / delegate / ready / observe / dispatch / continue / reattach / poll-wait / verify / handoff / recover / replan / complete |
| 분석 | prepare → generate → validate → record-review → next-pass 또는 finish |
| 복구 | inspect-failure → reserve-review → review → authorize → held 또는 reserve-execution → repair / reverify → finish |
| 재계획 | inspect-settlement → preserve-and-refresh → analyze |
| 모의 실행 | select → prepare → execute → accept → after → select, 또는 complete |
| 개별 Mission 명령 | 명령별 이름을 가진 노드에서 동일 도메인 서비스 또는 위 그래프 호출 |

자동 진행의 분기와 반복은 LangGraph가 담당합니다. `drive --control`은 배정 가능한 대기 작업부터 접수합니다. dispatch·continue는 code-agent의 접수와 실행 ID 저장 후 반환하고, reattach는 같은 invocationId의 결과를 한 번 조회합니다. 아직 실행 중이면 다른 작업을 선택하고, 처리할 일이 없고 실행만 남았으면 poll-wait에서 잠시 기다린 뒤 다시 조회합니다. 독립 프로젝트의 외부 실행은 겹치지만 DB 변경·위임 판단·독립 검사는 순차 처리합니다. 같은 프로젝트의 잠금과 의존성 검사는 계속 적용합니다.

## 상태 저장

SQLite 저장소는 migrations 배열을 버전 순서대로 적용하며 현재 user_version은 2다. v1의 records·events·locks와 기존 graph_runs·graph_leases를 보존하고 임대 시각 열을 추가한다. 그래프 테이블 생성도 버전 마이그레이션에서 처리한다. 알 수 없는 상위 버전은 거부한다. checkpoints·writes는 최초 체크포인터 사용 때 생성한다. v2에는 목표별 레코드·이벤트 조회용 생성 열과 인덱스도 포함한다.

- 그래프 체크포인트: 실행 경로, 다음 단계에 필요한 값, 대기 정보.
- 도메인 저장소: Mission·Attempt·계획·증거·권한·프로젝트 잠금의 기준 상태.
- graph_runs: 그래프 호출의 시작·대기·완료·오류 기록.
- graph_leases: 같은 실행 스레드를 동시에 진행하지 못하게 하는 프로세스 소유권.

현재 상태는 도메인 저장소에서 읽습니다. 그래프에 저장된 오래된 사본으로 권한·계획 버전·외부 상태를 덮어쓰지 않습니다. 체크포인트에서 모델·호스트 객체나 인증 토큰을 재구성하지 않으며 재개 명령이 해당 어댑터를 다시 제공합니다.

## 대기와 재시작

그래프 임대는 started_at·heartbeat_at을 저장하며 노드 완료와 30초 주기로 heartbeat를 갱신한다. 같은 호스트에서 pid가 살아 있으면 계속 유효하다. 그 밖에는 마지막 heartbeat의 기본 TTL 10분이 지나야 자동 회수한다. 회수한 graph_runs는 `interrupted`로 마감하고 이벤트를 남긴다. 프로세스가 죽어도 최근 heartbeat가 남아 있으면 TTL 동안 중복 실행을 차단한다.

`master-agent mission unlock <목표ID> --revision <버전> --confirm`으로 TTL 전에 목표 그래프 임대를 회수할 수 있다. 같은 호스트의 살아 있는 pid는 거부하며 결정과 이벤트를 기록한다. 프로젝트 실행 잠금과 미확인 시도의 상태는 유지한다. 임대 해제가 개발 작업의 종료나 재실행 승인은 아니다.

진행할 수 없는 Mission은 wait 노드의 interrupt로 중단합니다. 다시 advance/drive를 실행하면 Command.resume으로 wait를 깨운 뒤 최신 도메인·외부 상태를 재검사합니다. 이 신호 자체는 질문 답변이나 승인이 아닙니다. 실제 답변·동의·grant는 기존 검증 경로를 거쳐야 합니다. 한 프로젝트의 판단 대기가 독립 프로젝트의 진행을 즉시 차단하지 않도록 선택 가능한 작업을 먼저 확인합니다.

`advance --control`은 접수 또는 완료 관측 같은 한 단계의 진행 뒤 반환할 수 있습니다. 접수 직후 `running`은 정상입니다. 모든 실행이 아직 진행 중이면 interrupt로 반환하고 다음 advance/drive에서 다시 관측합니다. `drive`는 실행이 남아 있는 동안 관측을 반복합니다. pause는 새 접수를 막고 기존 실행·잠금은 보존합니다. 관측 시간 초과나 불확실한 결과는 unknown으로 남기며 재접수하지 않습니다.

정상적인 wait 이외의 프로세스 중단에서는 미완료 노드에 null을 전달해 재실행하지 않습니다. START에서 기존 시도·잠금을 다시 확인합니다. code-agent 통신 계약의 실행 중 시도는 같은 invocationId로 재부착합니다. 실행 여부가 불명확한 시도는 기존 reconcile·stop-analysis 등 복구 절차를 사용하며 새 작업으로 자동 제출하지 않습니다.

SQLite 도메인 트랜잭션과 LangGraph 체크포인트 사이에는 단일 분산 트랜잭션이 없습니다. 외부 실행의 정확히 한 번 수행을 체크포인터만으로 보장한다고 주장하지 않습니다. 외부 호출 전 시도 저장, 기대 버전 검사, 프로젝트 잠금과 code-agent 원자적 접수 계약이 중복 실행을 막습니다.

분석·복구·재계획의 단계 기록은 남지만, 중간 모델 호출을 임의로 재생해 이어가지는 않습니다. 중단된 도메인 기록을 정리한 뒤 새 분석·복구를 요청합니다.

## 적용 범위와 검증

새 그래프는 기존 로컬 저장소에 적용됩니다. 체크포인트가 없는 기존 Mission도 현재 도메인 상태에서 시작할 수 있습니다. 변경된 그래프 정의를 임의의 과거 체크포인트에 연결하는 마이그레이션은 지원하지 않습니다.

회귀 테스트는 기존 권한·검증·재계획 계약과 함께 SQLite 재열기, 대기 재개, 같은 스레드의 동시 실행 차단, 프로세스 강제 종료 후 중복 배정 차단, 체크포인트 저장 실패를 검사합니다. 실제 AI를 호출하는 운영 환경 전체 사이클은 별도 검증 대상입니다.

체크포인트에는 근거·모델 응답·실행 결과가 저장될 수 있습니다. 현재 자동 보존 기간 정리는 없으므로 장기 운영에서는 DB 크기와 보존 정책을 별도로 관리해야 합니다.
