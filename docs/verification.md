# 검증 기록

기능 검증 기준은 **2026-10-19, 공통 요청함 연결 및 문서·중복 코드 정리 후**다. Windows·Node.js 24.19.0에서 회귀·실제 CLI·브라우저를 확인했다. 실제 모델 전체 흐름의 최근 검증일은 2026-10-17이며, 이번 질문 계약 시험은 해당 모델 시험의 재수행을 뜻하지 않는다.

| 검증 | 결과 | 근거 |
| --- | --- | --- |
| 자동 회귀 | 232개 통과, 실패·건너뜀 0 | `npm.cmd test`, 로컬 `.master-agent/interactions-tests.log` |
| 공통 요청함 회귀 | 추천 미추정·보류·답 적용, 동일 명령/두 탭·재시작·master 재개, 오래된 내용/문맥·등록 해제·업데이트, 원장 복사/교체·그룹 범위 고정, HTTP 인증, 기존 시도·세션에서 복구 후 실제 재검증 | `tests/dashboard-interactions.test.mjs` 13개 |
| 실제 code-agent 질문 API | 빈/기존 격리 프로젝트 각 10단계의 질문 수신·소비·적용, 다중 선택·옵션 입력·직접 입력, 보류/재열기, 같은 명령 재전송, 브랜치 변경·키 부재 거부, docs 동의의 실제 적용 | `scripts/smoke-interactions-live.mjs`, `.master-agent/interactions-live.json`. 발행자·최초 인증은 합성 fixture, 개발 모델 미호출 |
| 실제 API·브라우저·중단 복구 | 모바일 브라우저의 다중 답과 별도 동의가 실제 서명·CLI를 통과. 전송 전 단절 후 DB 재시작·같은 envelope 재전송, 미확인 중 삭제 거부, 실제 docs 적용 확인 | `.master-agent/interactions-live-browser.json`, `.master-agent/interactions-live-browser-2pNLLS/`. 실제 사용자 TTY·개발/반영/운영 전체 모델 완주와 구분 |
| master 질문 브라우저 | 추천의 명시적 제출, 폴링/닫기/재열기 초안 보존, 보류, 전체 답 수집 후 한 번 재개, 오래된 화면 거부, 승인 미선택·미지원 비활성, XSS·모바일·연결 끊김 | `scripts/smoke-dashboard-interactions.mjs`, `.master-agent/interactions-browser-maqKx5/`. 발행자·실행기 모의 |
| 원격 업데이트 준비 | 실제 로컬 Git remote·pull·npm ci/build/test 후 동일 패키지 적용, 각 준비 단계 실패 시 미적용, upstream 변경·분기·미설정 거부, 원본 변경 보존·종료 처리·HTTP 비동기 실행 | `tests/source-update.test.mjs` 9개; 합성 code-agent 패키지 사용, 외부 원격 서버·실제 관리 프로젝트는 변경하지 않음 |
| 일괄 업데이트 | 설치본·카탈로그 변경 거부, 삭제된 프로젝트 제외·이전 미리보기 무효화, 작업·승인·개발 잠금 제외, 부분 실패·충돌·보류 구분, 중복 적용 방지·종료 취소·중단 점검·HTTP 인증 | `tests/dashboard-updates.test.mjs` 11개 |
| 실제 code-agent 업데이트 | 격리 프로젝트의 설치본 적용·버전 확인, 누락 템플릿 복구, 사용자 수정 보존, 접수 중 프로젝트 건너뜀 | 위 테스트의 실제 설치본 연동; 실제 관리 프로젝트는 변경하지 않음 |
| 서버 재시작·종료 | 실제 CLI 프로세스 교체·DB/URL/설정 유지·종료 후 재시작·중복 서버 차단·무관한 서버 보호·화면 토큰 제어 거부 | `tests/dashboard-lifecycle.test.mjs` 2개 |
| 설치 자동 탐색 | PATH의 실행 파일·npm shim·Windows npm 설치·명시적 override·미설치 구분, 현재 PC의 실제 설치 진입점 확인 | `tests/discovery.test.mjs` |
| 그룹·단일 요청 | 서비스 범위 고정·중복 접수 방지, TASK 번호 입력 검증·기록·AI 계획·프로젝트별 개발 지시 전달·이어 실행 보존, HTTP 인증 | `tests/requests.test.mjs` |
| 프로젝트 후보·등록·삭제 | 후보 조회·중복 구분·API 인증, 단독/그룹 등록·원자적 저장, 삭제 시 그룹 제외·폴더와 완료 이력 보존·새 ID 재등록·오래된 편집 거부·미완료 목표/실행/업데이트 보호 | `tests/project-candidates.test.mjs` 2개, `tests/project-registration.test.mjs` 9개 |
| 요청 전체 실행 | 그룹/단일 요청 각각 모의 AI 계획 → 템플릿 연결 → 실제 파일 변경·Node 검사 → 인계·succeeded | `tests/requests.test.mjs`; AI와 개발 호스트는 모의 응답 |
| 명령 설치 | 임시 npm 전역 prefix에 로컬 패키지 설치 후 저장소 밖에서 프로젝트 조회·데모 완료 | `npm.cmd install --global --prefix <임시경로> --offline --ignore-scripts <소스경로>` |
| 관제 서버 | 전체 등록 프로젝트·독립 작업 관측, 조회 실패·오래된 관측 구분, 중복 조회 제한, 삭제 시 기존 대기열·이후 조회에서 제외, HTTP 조회 경계 | `tests/dashboard.test.mjs` 7개 |
| 기존 대시보드 브라우저 | 삭제·그룹·후보·TASK·원격 업데이트·설치 감지·모바일·연결 끊김 회귀 통과 | 로컬 `.master-agent/dashboard-browser-NM3mYE/`; 화면의 개발 접수·업데이트 실행은 모의 처리 |
| 브랜치별 작업과 업데이트 판정 | 다른 브랜치 체크아웃에서 `status --json`은 `work: null`·`no-work`, `version --json`은 이전 브랜치 미완료 작업을 `project.busy`로 반환함을 읽기 전용 확인 | code-agent 소스·빌드·설치 릴리스의 `currentCursor`/`allCursors` 사용 대조; 실제 프로젝트 상태·브랜치는 변경하지 않음 |
| 진행 상태·병렬 제어 | 5개 회귀 통과, 실제 CLI 조회에서도 확인 | `tests/parallel-progress.test.mjs` |
| 구문·문서 | JavaScript 93개·Markdown 19개 검사 통과 | `npm.cmd run check` |
| 실제 code-agent 계약 등록 | 등록 성공, 원문과 다른 claim·변경된 문서 거부 | `tests/handoff-contracts.test.mjs`의 실제 빌드 연동 |
| 실제 code-agent 통신 | 접수·중복·이벤트·재부착·협력 정지·제어권 인계 통과 | `tests/code-agent-control.test.mjs`, 가짜 개발 호스트 |
| 앞선 답의 실제 AI 판단 | 5건 통과: routine 3·ambiguous 1·critical 1 | [판단 증거](evidence/2026-10-16-answer-context.json) |
| 실제 병렬·계약 인계·통합 | 두 프로젝트·세 작업 succeeded, 56분 30초, 계약 입력 7건 대조 | [v4 전체 흐름 증거](evidence/2026-10-17-parallel-contract-flow.json) |

code-agent 연동 시험은 외부 빌드가 없으면 건너뛴다. 위 회귀 결과에는 건너뜀이 없다. 현재 구현과 남은 작업은 [구현 현황](implementation.md)을 따른다.

공통 요청함은 `C:/IdeaProjects/code-agent/dist/agent/cli.js`의 1.0.0·stateSchema 7·interaction schema 1에서 확인했다. 확인 당시 소스 HEAD는 `e289829`이며 interaction 변경이 아직 커밋되지 않은 작업 빌드였다. 이 커밋만 체크아웃하면 새 기능이 있다는 뜻이 아니다. `scripts/check-interaction-support.mjs`가 빈/기존 두 격리 저장소에서 실제 hello·명령·빌드 수정 시각·소스 변경 여부를 저장한다. 프로젝트 식별자는 실제 응답의 `hello.result.project.projectId`를 사용한다.

질문 단계별 계약 시험의 host 소비/complete는 합성 발행자가 수행했다. 실제 모델의 개발·리뷰·반영 완주나 운영 변경 전체를 검증한 결과로 확장하지 않는다.

## 자동 회귀의 확인 범위

- 계획·근거·의존성·완료 조건·판단 출처 검증, 오래된 응답과 범위 밖 변경 차단.
- 프로젝트 잠금·중복 접수 방지, 독립 실행과 선행 인계 대기, LangGraph 재개·일시 정지·실패 복구·재계획.
- Git 스냅샷·검사·산출물·반영 영수증·계약 문서 결합, 변조·누락 차단과 후속 담당 입력 전달.
- 위임·질문 맥락·사람 이관·재부착·정지·제어권 인계, 실행별 진행 상태와 단계 이벤트 구분.
- 관제·등록·그룹·요청의 HTTP 인증·원자적 저장·버전 대조와 실행기 실패 보존. 관측 시각만 갱신되면 계획을 유지하고 실제 상태가 바뀌면 적용을 거부한다.

일반 회귀의 모델·개발 호스트는 모의 응답이다. 파일·Git·SQLite·자식 프로세스는 실제 실행한다. 실제 code-agent CLI 연동 시험도 개발 모델은 호출하지 않는다.

## 실제 병렬·계약 인계 검증

**v4 완료:** mission `2a776eaa-e5dd-4e43-94e9-ace0d66e759d`, 2026-10-17 09:04:41~10:01:11 KST, 56분 30초. 두 프로젝트·세 작업이 모두 succeeded다. [검증 증거](evidence/2026-10-17-parallel-contract-flow.json)에 실제 프로세스 실행 구간·커밋·검사 출력·계약 입력 해시를 보존했다.

| 작업 | 프로젝트 전체 테스트 | master 검사 | 반영 커밋 |
| --- | ---: | ---: | --- |
| 할인 | 17개 | 2개 | `b4c22e228d154da6a6f09ef85e86ad900652f8e9` |
| 합계 | 20개 | 2개 | `26de52ce62afbaf01d0ca09ab2dbc2bf5bea8eb2` |
| checkout 통합 | 34개 | 4개 | `b06b9ac8e123252fcbe0bb98663e793814e49c3b` |

테스트 수는 bootstrap과 기존 기능을 포함한 각 시점의 프로젝트 전체 실행이다. master 검사 8개는 반영 전후 모두 통과했다. 실제 호스트의 시작·종료 시각으로 독립 프로젝트의 실행 겹침을 확인했고, checkout은 두 선행 인계가 끝난 뒤 시작했다. 위임 승인 9건은 모두 routine으로 적용됐다. 업무 질문·사람 이관은 0건이며, 두 작업 트리가 clean이고 남은 프로젝트 잠금·그래프 임대는 0개다.

할인·합계의 커밋된 계약 문서 두 개가 첫 planning 배정 전에 등록됐다. checkout의 분석·조사·설계·계획·독립 검토 등 배정 7건(보정 재배정 포함) 모두에서 사본 파일 해시와 계약 입력 해시가 일치했다. 이번 실행에서는 기존 계약을 다시 묻지 않았다. 계약 답의 `contract` 출처 재사용 명령을 실제 모델이 호출한 시험은 아니며, 해당 출처의 검증은 code-agent 자체 회귀 범위다.

자동 보정도 있었다. 할인·합계 설계의 수락 기준 ID 중복, checkout 영향 조사 문서의 계약 사본 경로 누락을 검사로 거부한 뒤 수정했다. 합계 리뷰의 부연 설명은 형식 오류로 남았고, 지적에 따른 코드 수정·재검증·두 번째 리뷰가 수행됐다. 최신 빌드에서 다시 확인할 생성 품질 항목은 [구현 현황](implementation.md#code-agent-연동-후속-확인)에 정리했다.

원본 DB·모델 입출력·저장소는 로컬 `.master-agent/full-flow-7a0b56e5-dbdc-4b63-a0ef-02a7f897bfa8/`에 있다. 앞선 중단 시도는 성공으로 집계하지 않는다.

실제 시험은 code-agent 빌드·템플릿의 별도 사본을 사용했다. 캡처 당시 HEAD `2552d3a`에는 미커밋 보완이 있었으며, 당시 후속 `8085647` 빌드와 사본의 1,027개 파일이 동일함을 확인했다. 사본 전체 해시는 `e4cf2a7845978a83c9f7cce5154047fb607449608c52342f21db19bfa30ea021`이다. 이는 시험 시점의 출처 기록이며 이후 code-agent 빌드와의 동일성을 보장하지 않는다.

## 재현 방법과 경계

[전체 흐름 스크립트](../scripts/smoke-full-flow.mjs)는 격리 Git 프로젝트 두 개를 만들고 실제 Claude 개발·위임 판단·독립 검사·로컬 커밋·인계·통합을 수행한다.

```powershell
# 필요하면 CODE_AGENT_CLI, CLAUDE_CLI로 로컬 실행 파일을 지정한다.
# 고정 사본을 쓰는 경우 CODE_AGENT_RELEASE_HOME도 별도 경로로 지정한다.
node scripts/smoke-full-flow.mjs setup
# 위 명령이 출력한 root를 사용한다. 준비와 실행은 같은 OS 사용자로 수행한다.
node scripts/smoke-full-flow.mjs drive <root>
node scripts/smoke-full-flow.mjs status <root>
node scripts/smoke-full-flow.mjs report <root>
```

시험은 고정 master 계획으로 시작한다. 공통 문서 확정·master enable·grant의 TTY만 시험 도구로 흉내 낸다. 작업별 승인 판단과 개발·검증·반영은 실제 경로를 사용한다. 원격 push·배포는 포함하지 않는다.

## 보존 증거 색인

| 증거 | 확인한 내용과 한계 |
| --- | --- |
| [2026-10-16 전체 흐름](evidence/2026-10-16-full-flow.json) | 세 작업 완료. 후속 담당 입력의 계약 누락을 발견해 v4에서 보완 검증 |
| [2026-10-16 앞선 답 판단](evidence/2026-10-16-answer-context.json) | 실제 Claude 판단·답 CLI 5건: routine 3, ambiguous 1, critical 1. 질문·앞선 답·도입 TTY는 합성 자료 |
| [2026-10-17 병렬·계약 인계](evidence/2026-10-17-parallel-contract-flow.json) | 위 v4 결과의 프로세스 구간·커밋·검사·계약 입력 해시 |

실제 모델의 앞선 답 판단 시험은 [smoke-answer-context.mjs](../scripts/smoke-answer-context.mjs)로 재현한다. 실제 모델의 증거 JSON과 로컬 실행 원본은 보존한다. 회귀 로그·합성 브라우저 산출물은 최신 통과 결과를 유지하며, 중복 로그·실패한 시험 프로필·과거 실행 지시를 누적하지 않는다. 상세 변경은 Git 이력을 따른다.

## 미검증 범위

- 자유 목표의 AI 계획 생성부터 전체 완료까지의 연속 실행.
- 실제 모델의 실패 수정·재계획·프로세스 중단·재부착에 대한 추가 연속 시험.
- Codex 개발 호스트, 다중 사용자·원격 운영·배포, 다양한 실제 업무 규모의 판단 품질.
- 직접 실행 ClaudeHost의 전체 사이클. 현재 권장 검증 경로는 `--control`이다.

검증 상태나 완료 조건을 수동으로 바꿔 성공시키지 않는다. 미반환·미확인 실행은 자동 성공이나 중복 실행으로 바꾸지 않는다.
