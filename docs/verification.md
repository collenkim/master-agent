# 검증 기록

최신 기준일은 **2026-10-19**이다. Windows·Node.js 24.19.0에서 확인하며 모의 개발 호스트와 실제 모델 실행을 구분한다. 실제 모델 전체 흐름의 최근 검증일은 2026-10-17이다.

| 검증 | 결과 | 근거 |
| --- | --- | --- |
| 자동 회귀 | 182개 통과, 실패·건너뜀 0 | `npm.cmd test`, 로컬 `.master-agent/group-full-tests.log` |
| 설치 자동 탐색 | PATH의 실행 파일·npm shim·Windows npm 설치·명시적 override·미설치 구분, 현재 PC의 실제 설치 진입점 확인 | `tests/discovery.test.mjs` |
| 그룹·단일 요청 | 서비스 범위 고정·구성원 변경·중복 접수 방지·실행기 중단 및 이어 실행·HTTP 쓰기 인증 | `tests/requests.test.mjs` |
| 요청 전체 실행 | 그룹/단일 요청 각각 모의 AI 계획 → 템플릿 연결 → 실제 파일 변경·Node 검사 → 인계·succeeded | `tests/requests.test.mjs`; AI와 개발 호스트는 모의 응답 |
| 명령 설치 | 임시 npm 전역 prefix에 로컬 패키지 설치 후 저장소 밖에서 프로젝트 조회·데모 완료 | `npm.cmd install --global --prefix <임시경로> --offline --ignore-scripts <소스경로>` |
| 관제 서버 | 전체 등록 프로젝트·독립 작업 관측, 조회 실패·오래된 관측 구분, 중복 조회 제한, HTTP 조회 경계 | `tests/dashboard.test.mjs` 6개 |
| 실제 브라우저 | Chrome에서 그룹 생성·구성원 제외·그룹/단일 요청 전송, 렌더링·이스케이프·검색·필터·상세 유지·모바일·연결 끊김 통과 | 로컬 `.master-agent/dashboard-browser-mSL8N3/`의 desktop.png·mobile.png; 화면 시험의 실행기 접수는 모의 처리 |
| 진행 상태·병렬 제어 | 5개 회귀 통과, 실제 CLI 조회에서도 확인 | `tests/parallel-progress.test.mjs` |
| 구문·문서 | JavaScript 74개·Markdown 18개 검사 통과 | `npm.cmd run check` |
| 실제 code-agent 계약 등록 | 등록 성공, 원문과 다른 claim·변경된 문서 거부 | `tests/handoff-contracts.test.mjs`의 실제 빌드 연동 |
| 실제 code-agent 통신 | 접수·중복·이벤트·재부착·협력 정지·제어권 인계 통과 | `tests/code-agent-control.test.mjs`, 가짜 개발 호스트 |
| 앞선 답의 실제 AI 판단 | 5건 통과: routine 3·ambiguous 1·critical 1 | [판단 증거](evidence/2026-10-16-answer-context.json) |
| 실제 병렬·계약 인계·통합 | 두 프로젝트·세 작업 succeeded, 56분 30초, 계약 입력 7건 대조 | [v4 전체 흐름 증거](evidence/2026-10-17-parallel-contract-flow.json) |

code-agent 연동 시험은 외부 빌드가 없으면 건너뛴다. 위 회귀 결과에는 건너뜀이 없다. 현재 구현과 남은 작업은 [구현 현황](implementation.md)을 따른다.

## 자동 회귀의 확인 범위

- 계획·근거·의존성·완료 조건 검증, 판단 선저장, 오래된 응답 거부.
- 프로젝트 잠금, 중복 접수·늦은 결과·범위 밖 변경 차단.
- 실제 Git 스냅샷·검증 프로세스·산출물·반영 영수증 결합, 인계 후 변조 탐지.
- 실패 보류·범위 내 복구·재계획, LangGraph 재개·동시 실행 차단·pause 유지.
- 위임 권한·판단 출처·사람 이관·질문 맥락·재부착·정지·제어권 인계.
- 구조화 계약의 소스·문서·커밋 대조, 직접·간접 의존 인계, 후속 접수·계속 실행·판단 입력 전달.
- 문서 변조·원본 변경·파일 누락·프롬프트 크기 초과 차단과 실제 code-agent 계약 등록.
- 모의 전송의 독립 프로젝트 동시 실행, 후행 작업 대기, DB 재연결 후 중복 접수 방지.
- 별도 CLI 프로세스의 승인 대기·판단 처리·사람 응답·실제 장애 구분.
- 실제 단계 이벤트의 `from/to` 형식과 승인 후 호스트 재개 전의 단계 변경 반영, 다른 실행·후속 작업의 이벤트 제외, 완료 작업의 단계 표시 해제.
- 대시보드의 전체 등록 프로젝트·목표 요약, 질문 ID·미검증 답변 보존, code-agent 제어 토큰 경로 제외, 관측 실패 시 과거 작업 표시, 중복·동시 조회 제한.
- 로컬 HTTP의 Origin·화면 토큰 검사, 그룹 버전 대조, 그룹/단일 요청의 원자적 접수·중복 실행 방지와 별도 CLI 실행기의 실패 영속화.
- 자동 조회가 관측 시각만 갱신한 경우 AI 계획 유지, 실제 code-agent 상태 버전 변경 시 계획 적용 거부.

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

자동 보정도 있었다. 할인·합계 설계의 수락 기준 ID 중복, checkout 영향 조사 문서의 계약 사본 경로 누락을 검사로 거부한 뒤 수정했다. 합계 리뷰의 부연 설명은 형식 오류로 남았고, 지적에 따른 코드 수정·재검증·두 번째 리뷰가 수행됐다. 후속 생성 지침 보완은 [구현 현황](implementation.md)에 정리했다.

진행 조회에서 발견한 이벤트 필드·실행 사이의 단계 변경·후속 작업 이벤트 혼입은 표시 코드와 회귀를 수정하고 별도 CLI로 확인했다. 장기 실행 중인 drive의 실행 제어 코드는 교체하지 않았다.

v3는 샘플의 code-agent 단계 출력 디렉터리에 `contracts`가 빠져 계획 단계에서 중단됐다. 이를 초기 설정에 추가한 새 프로젝트로 v4를 실행했으며 기존 v3 상태·질문·판단은 보존했다. 원본 DB·모델 입출력·저장소는 로컬 `.master-agent/full-flow-7a0b56e5-dbdc-4b63-a0ef-02a7f897bfa8/`에 있다.

실제 실행에는 다른 세션의 변경과 섞이지 않도록 code-agent 빌드·템플릿의 별도 사본을 사용한다. 캡처 당시 HEAD `2552d3a`에는 미커밋 보완이 있었다. 이후 완료된 `8085647`의 로컬 빌드와 사본의 1,027개 파일이 동일함을 확인했다. 사본 전체 해시는 `e4cf2a7845978a83c9f7cce5154047fb607449608c52342f21db19bfa30ea021`이다. code-agent 자체 검증 결과는 해당 저장소의 `doc/reviews/2026-10-16-dependency-contracts.md`를 따른다.

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

## 보존한 이전 증거

**전체 흐름 v2:** mission `7eef8908-39b7-487b-9482-f891e268c489`, 2026-10-16 12:50~14:05 KST. 작업 세 개·mission 모두 succeeded, routine 위임 승인 9회, master 검사 8개 반영 전후 통과, 사람 이관 0건. [증거 JSON](evidence/2026-10-16-full-flow.json)에 테스트·커밋·영수증·질문 출처를 보존했다. checkout의 기존 계약 재인용이 대화 출처로 남고 세부 담당의 입력에 계약이 빠진 문제를 발견해 현재 연결을 추가했다.

**앞선 답 판단:** [집중 시험](../scripts/smoke-answer-context.mjs)에서 실제 Claude 판단과 code-agent 답 CLI를 5회 연결했다. 앞선 답이 있는 후속 질문 3회는 routine, 답이 없는 대조군은 ambiguous, 기존 답을 뒤집고 검사를 없애려는 질문은 critical이었다. 위임·전달 출처와 중복 적용 방지를 대조했다. 질문·앞선 사람 답·도입 TTY는 합성 자료이며 실제 사용자의 답변을 재현한 시험은 아니다. [증거 JSON](evidence/2026-10-16-answer-context.json)을 보존했다.

단계별 누적 테스트 수, 중복 실패 설명과 초기 구축 이력은 정리했다. 기존 증거 JSON과 로컬 실행 원본은 유지한다. v1의 샘플 명세·검사 불일치 실행은 paused이며 성공으로 집계하지 않는다.

## 미검증 범위

- 자유 목표의 AI 계획 생성부터 전체 완료까지의 연속 실행.
- 실제 모델의 실패 수정·재계획·프로세스 중단·재부착에 대한 추가 연속 시험.
- Codex 개발 호스트, 다중 사용자·원격 운영·배포, 다양한 실제 업무 규모의 판단 품질.
- 직접 실행 ClaudeHost의 전체 사이클. 현재 권장 검증 경로는 `--control`이다.

검증 상태나 완료 조건을 수동으로 바꿔 성공시키지 않는다. 미반환·미확인 실행은 자동 성공이나 중복 실행으로 바꾸지 않는다.
