# 검증 기준과 재현 방법

현재 구현의 검사 방법과 확인 범위를 정리한다. 기능과 후속 작업은 [구현 현황](implementation.md)을 따른다.

## 최신 검증

2026-11-03, Windows·Node.js 24.19.0과 로컬 code-agent 빌드(작업 트리 변경 포함) 기준이다. 최신 결과만 유지한다.

| 검사 | 결과 | 재현 |
| --- | --- | --- |
| 전체 자동 회귀 | 485건 통과, 실패·건너뜀 0 | `npm.cmd test` |
| 구문·문서 링크·앵커 | JavaScript 138개·Markdown 19개 통과 | `npm.cmd run check` |
| 린트 | 미사용 변수·import와 미정의 이름 검사 통과 | `npm.cmd run lint` |
| code-agent smoke | 상태 조회, 요청함 22개 시나리오, 공개 지원 조회 통과 | `npm.cmd run smoke:code-agent` |
| 브라우저 smoke | 그룹·이력·요청함·요청 host·PC 신뢰·설치 업데이트·검증 설정 7종 통과 | `npm.cmd run smoke:browser` |
| 모의 실행 | 임시 DB의 demo가 `simulation-complete`로 종료 | `master-agent demo --db <임시 DB>` |

전체 회귀를 세 번 실행한 중 한 번은 `tests/dashboard-updates.test.mjs`의 설치 업데이트 시험 1건이 실패했고, 같은 파일 단독 실행과 나머지 전체 실행에서는 통과했다. 동시 실행 경합으로 보이며 원인은 확정하지 않았다.

회귀 시험은 격리된 임시 프로젝트에서 수행한다. 모델·개발 호스트는 모의 응답이며 파일·Git·SQLite·자식 프로세스와 code-agent 통신은 실제 실행한다. 외부 빌드가 필요한 시험은 빌드가 없으면 건너뛰므로 결과의 skipped 수를 함께 확인한다. 이번 검사에서 실제 모델 smoke와 원격 CI는 실행하지 않았다.

## 자동 회귀의 확인 범위

| 범위 | 주요 시험 |
| --- | --- |
| 계획·근거·검증 계약 | 소스 ID·인용·범위·계획 검증, 근거 변경 감지, 조건별 검사·산출물·반영 증거 결속, code-agent 계약 등록과 drift 알림 |
| 실행·복구 | 취소 후 잠금 해제·TASK 재사용, 실행 중 취소 거부, 재계획 트리 변경 감지·재동기화, 실패·중단 복구 |
| 저장·임대 | v1→v2 데이터 보존, 오래된 임대 회수·생존 프로세스 보호, 종료 체크포인트 삭제, 분석·실행 회차의 저장 크기 제한 |
| 관리 통신·위임 | 원자적 접수·중복 거부·이벤트·재부착·정지·인계, 위임 출처·권한·영수증 대조, relay 전송 실패 마감 |
| 관리 실행 소유권 | 실제 호스트·세션 대조, Codex·Claude 동의 대기·재개, 다른 작업 격리, 임대 상태·호스트 누락 호환 |
| 대시보드·조회 | 200개 목표·2만 이벤트 조회, 읽기 전용 GET·페이지·필드 투영, 설치 지문 재사용·변경 감지, 설치 없는 경로의 연동 조회 생략 |
| HTTP·입력 보호 | 인증·Host/Origin·cross-site 거부, 비도메인 오류의 고정 500 응답, 원격 숫자·답변 타입 검증 |
| 요청함·타임라인 | 응답 중복·버전 대조, 재기동 후 sending 결과 확인, gap 계약 위반 거부와 커서 복구 |
| 프로세스·파일 | 호스트 표지 제거·프로세스 트리 종료, 손상 외부 JSON, npm Claude JS 진입점 탐색 |
| 모듈·개발 도구 | 범위·진행·재계획 보호·위임·명령·seal·복구 스키마·카탈로그, 문서 앵커·smoke 보존 정책 |

시험 파일은 `tests/*.test.mjs`이며 `node --test`로 실행한다. 브라우저와 실제 모델 smoke의 실행 전제는 [개발 검사와 선택 실행](../README.md#개발-검사와-선택-실행)을 따른다.

## 선택 실행

`npm run smoke:browser`, `npm run smoke:code-agent`, `npm run smoke:model`로 종류별 시나리오를 순서대로 실행한다. `-- --list`를 붙이면 실제 실행 없이 목록을 확인한다. code-agent 공개 지원 조회는 `node scripts/smoke-interactions-live.mjs --support-only`를 사용한다.

설치·적용 시험인 `scripts/smoke-dashboard-updates.mjs`는 code-agent 소스의 격리 사본, 로컬 bare remote, 전용 키·릴리스 저장소와 프로젝트를 사용한다. `CODE_AGENT_SOURCE`의 기본값은 `../code-agent`다. 네트워크 다운로드와 받은 소스의 설치·빌드 스크립트를 실행하므로 계약 fixture 시험과 구분한다.

실제 모델 시험은 사용량이 발생한다. 앞선 답 문맥과 전체 흐름은 `CLAUDE_CLI`를 지정한 뒤 아래 명령으로 재현한다. 전체 흐름은 고정 master 계획으로 시작하며 `setup`이 출력한 격리 root를 같은 OS 사용자로 사용한다.

```powershell
node scripts/smoke-answer-context.mjs
node scripts/smoke-full-flow.mjs setup
node scripts/smoke-full-flow.mjs drive <root>
node scripts/smoke-full-flow.mjs status <root>
node scripts/smoke-full-flow.mjs report <root>
```

검증 상태나 완료 조건을 수동으로 바꿔 성공시키지 않는다. 미반환·미확인 실행은 성공이나 중복 실행으로 바꾸지 않는다.

## smoke 산출물 보존

브라우저·모델·요청함 smoke는 종류별 최신 3개 실행 폴더를 기본으로 보존한다. 기본 위치는 실행 작업 폴더의 `.master-agent/`이며 `MASTER_AGENT_SMOKE_ROOT`로 바꾼다. 결과·격리 fixture·브라우저 화면은 같은 실행 폴더에 둔다. `smoke-code-agent.mjs`는 임시 시험 폴더를 종료 시 삭제한다.

공유 헬퍼의 소유 표지가 있는 폴더만 정리한다. 실행 중이거나 다른 호스트에 속한 폴더, 외부 실행 결과가 미확인인 폴더는 보존하므로 일시적으로 3개를 넘을 수 있다. 전체 흐름의 `drive`는 외부 실행 전에 보존 표지를 남기고 시도·제어 실행의 종료를 확인한 뒤 해제한다. 비정상 종료하면 같은 폴더로 조회·재개한 뒤 정리한다. 링크와 소유 표지가 없는 폴더는 자동 삭제하지 않는다.
