# 검증 기록

기능 검증 기준은 **2026-10-21, 질문 창 표시 정리와 원격 업데이트 검증 조정 반영 후**다. Windows·Node.js 24.19.0에서 회귀·실제 CLI·브라우저를 확인했다. 실제 모델 전체 흐름의 최근 검증일은 2026-10-17이며, 관제·질문 계약·화면 시험은 해당 모델 시험의 재수행을 뜻하지 않는다.

| 검증 | 결과 | 근거 |
| --- | --- | --- |
| 자동 회귀 | 전체 281개 통과. 실패·건너뜀 0 | `npm.cmd test`(약 412초), `.master-agent/inbox-layout-update-full-tests.log`. 사용한 code-agent 빌드는 아래 참고 |
| 요청 host 선택 | host 형식 검증과 계획·판단 AI 결정(단독 CLI·교차 검증·host 없는 요청의 provider), 교차 검토의 승인만 통과·반려·검토 형식 오류·검토 host 실행 실패, 요청 기록·provider 동시 지정 거부·대시보드 표시, 준비 점검(요청별 선택 미지원·미설치·주 host 준비, 기본 host 문제는 막지 않음), 교차 계획 반려 지적의 다음 회차 전달·승인 계획만 활성화, 새 실행에만 execution 전달, 반려된 위임 판단의 사람 이관 | `tests/request-host.test.mjs` 7개. AI·code-agent 전송은 모의 |
| 실제 code-agent 요청별 host | 실제 hello의 `runSelection`, 프로젝트 설정이 Claude 단독인 저장소에서 요청의 Codex로 실행·`execution.json` 보존·같은 thread 이어 실행 | `tests/managed-host.test.mjs`. 실제 code-agent 감독과 모의 Codex 모델, 격리 프로젝트·`CODEX_HOME` |
| 요청 host 브라우저 | host 선택만 표시(계획·판단 담당 선택 없음), 프로젝트 카드의 요청별 선택 지원 표시, 그룹(설정이 다른 프로젝트) 처음 값 Claude 단독·주 host 표시 전환·안내 문구, 프로젝트별 선택 가능·미지원·준비 문제(문구는 글자로만), 프로젝트 설정의 처음 값, 제출한 host 기록·요청 카드 표시, 1440/390/320px | `scripts/smoke-dashboard-request-host.mjs`, `.master-agent/request-host-browser-a7Xo43/`. 실제 브라우저·API, 합성 hello, 요청 실행기·모델 미호출 |
| 제어 연결(페어링) | 원인별 연결 상태·다음 조치, 신뢰 키 파일 위치·컨트롤러 이름 검증, 확인 1회 연결과 토큰 경로·채널 만료만 저장, 만료 전 갱신, 내용 변경·다른 소유자·사용 중 거부(서명 전), 응답 유실 시 미확인 유지·중복 연결 차단·같은 commandId 확인, 저장소 안 토큰 거부, HTTP의 화면 토큰·확인 체크·표시 내용 해시. CLI는 TTY 없이 거부 | `tests/pairing.test.mjs` 8개, `tests/cli.test.mjs`. code-agent 응답은 `tests/pairing-fake-cli.mjs`의 계약 fixture |
| 화면 PC 신뢰 | 신뢰 기록이 없을 때만 버튼 제공(기록만 있고 키가 없으면 해제 안내), 카드 상태에 신뢰 가능 여부 전달, code-agent 문구 그대로 표시·확인 단어 필수·해시 형식·보인 내용과 다름 거부, 이미 신뢰·화면 신뢰 미지원 code-agent 구분, 호스트 표지 미전달, HTTP의 화면 토큰·Origin | `tests/pairing.test.mjs` 4개. code-agent 응답은 `tests/trust-fake-cli.mjs`의 계약 fixture |
| 실제 code-agent 화면 PC 신뢰 | 실제 문구(개인 키 자리·화면 신뢰의 한계)·미리보기 무기록, 보지 않은 해시 거부, 확인한 해시로 등록·기록의 대시보드 확인·같은 키 저장소의 키 탐색, 재등록 거부, 신뢰 직후 제어 연결. 서버 환경에 `CLAUDECODE`가 있어도 code-agent에 넘기지 않음 | `tests/code-agent-control.test.mjs`. 실제 code-agent 빌드(화면 신뢰 포함), 격리 `CODE_AGENT_HOME`·`CODEX_HOME` |
| PC 신뢰 브라우저 | 카드의 PC 신뢰 버튼·터미널 대안, code-agent 문구 표시, 확인 단어(대소문자 그대로) 전 제출 불가, 1440/390/320px, 등록 뒤 카드가 `제어 연결 가능`으로 바뀌고 이어서 제어 연결·`제어 연결됨`, DB에 개인 키 없음 | `scripts/smoke-dashboard-trust.mjs`, `.master-agent/trust-browser-wujO8r/`. 실제 브라우저·API·code-agent 빌드, 격리 키 저장소·프로젝트, 요청 실행기·모델 미호출 |
| 실제 code-agent 페어링 | 임시 code-agent 저장소에서 PC 신뢰 1회 뒤 확인한 연결로 연동 켜기·DB 등록·사람 채널 생성, 인증 heartbeat, DB에는 토큰 경로만 저장 | `tests/code-agent-control.test.mjs`. 실제 code-agent 빌드, 격리 `CODE_AGENT_HOME`·`CODEX_HOME`. 실제 사용자 신뢰·프로젝트는 변경하지 않음 |
| 호스트 설정 주입 | 호스트 공통 지시문·기능 등록·배정, Claude 파일 없는 준비 점검, Codex thread 확정·같은 thread 재개·재부착, 호스트 변경 재개 거부·미확정 세션 차단·실제 호스트 관제 | `tests/managed-host.test.mjs` 5개. 실제 code-agent 감독과 모의 Codex 모델, 격리 프로젝트의 합성 TTY·신뢰 기록. 사용자 권한·설정은 변경하지 않음 |
| 요청 준비·복구 | 표준 근거·폴더 목록·최신성, 기존 명시 근거 보존, 그룹별 설치·관리 실행 지원·소유권·인증 점검, 준비 중 모델 미호출, 기존 실패 요청의 보류·동일 TASK 재개·중복/오래된 답 거부, 검증 계약 등록 안내. 연결 없음의 원인 분류(페어링은 제안만), 커밋 없는 저장소 안내, 연결 후 이어 실행 항목의 기본 선택 없음·등록 확인 뒤 재개 | `tests/preparation.test.mjs` 10개. 실제 authorization-api의 YSIJ-254도 같은 TASK의 준비 대기·요청함 표시 확인. 개발 모델 미호출 |
| 단계 이력 | 세부 단계·검증 정보와 비공개 필드 제외, 독립 관측 누적·재시작·시도/브랜치/조회 실패 구분, 커서 격리·중복 방지·원장 교체·보존 구간 복구, 그룹/TASK 연결·페이지 조회·요청함 변화·HTTP 경계 | `tests/dashboard-history.test.mjs` 7개. 상태·이벤트 발행자는 합성 fixture |
| 단계 타임라인 브라우저 | 세부 단계·검증 표시, 실제 API의 프로젝트/그룹/TASK 필터·이전 페이지·자동 갱신 후 페이지 유지·재조회, 1440/390/320px·XSS | `scripts/smoke-dashboard-history.mjs`, `.master-agent/stage-history-browser-0F0WEp/`. 격리 카탈로그·합성 상태와 이벤트, 개발 모델 미호출 |
| 공통 요청함 회귀 | 추천 미추정·보류·답 적용, 동일 명령/두 탭·재시작·master 재개, 오래된 내용/문맥·등록 해제·업데이트, 원장 복사/교체·그룹 범위 고정, HTTP 인증, 기존 시도·세션에서 복구 후 실제 재검증 | `tests/dashboard-interactions.test.mjs` 13개 |
| 실제 code-agent 질문 API | 빈/기존 격리 프로젝트 각 10단계의 질문 수신·소비·적용, 다중 선택·옵션 입력·직접 입력, 보류/재열기, 같은 명령 재전송, 브랜치 변경·키 부재 거부, docs 동의의 실제 적용 | `scripts/smoke-interactions-live.mjs`, `.master-agent/interactions-live.json`. 발행자·최초 인증은 합성 fixture, 개발 모델 미호출 |
| 실제 API·브라우저·중단 복구 | 모바일 브라우저의 다중 답과 별도 동의가 실제 서명·CLI를 통과. 전송 전 단절 후 DB 재시작·같은 envelope 재전송, 미확인 중 삭제 거부, 실제 docs 적용 확인 | `.master-agent/interactions-live-browser.json`, `.master-agent/interactions-live-browser-2pNLLS/`. 실제 사용자 TTY·개발/반영/운영 전체 모델 완주와 구분 |
| master 질문 브라우저 | 추천의 명시적 제출, 폴링/닫기/재열기 초안 보존, 보류, 전체 답 수집 후 한 번 재개, 오래된 화면 거부, 승인 미선택·미지원 비활성, XSS·모바일·연결 끊김. 기존 준비 실패 요청의 추천 재점검·같은 TASK 한 번 재개 | `scripts/smoke-dashboard-interactions.mjs`, `.master-agent/interactions-browser-eOHOUI/`. 발행자·실행기 모의 |
| code-agent 질문 창 표시 | 실제 관측 DB 사본의 질문 3건(줄바꿈 제목, 두 질문 묶음, 업무 질문): 같은 문장 한 번 표시, 질문 칸 제목이 테두리 안, 선택지 설명 한 번, 1440/390/320px 가로 넘침 없음 | 격리 대시보드(`observe:false`)에서 수정 전후 화면 비교, `.master-agent/inbox-layout-real/`. 제출하지 않음 |
| 원격 업데이트 준비 | 실제 로컬 Git remote·pull·npm ci/build·실행 검사 후 동일 패키지 적용, 같은 커밋 완료 빌드 재사용·중단 사본 제외, 각 준비 단계 실패 시 미적용, 한도 초과는 하위 프로세스 종료 후 실패, upstream 변경·분기·미설정 거부, 원본 변경 보존·종료 처리·HTTP 비동기 실행 | `tests/source-update.test.mjs` 11개; 합성 code-agent 패키지 사용, 외부 원격 서버·실제 관리 프로젝트는 변경하지 않음 |
| 일괄 업데이트 | 설치본·카탈로그 변경 거부, 삭제된 프로젝트 제외·이전 미리보기 무효화, 작업·승인·개발 잠금 제외, 부분 실패·충돌·보류 구분, 중복 적용 방지·종료 취소·중단 점검·HTTP 인증 | `tests/dashboard-updates.test.mjs` 11개 |
| 실제 code-agent 업데이트 | 격리 프로젝트의 설치본 적용·버전 확인, 누락 템플릿 복구, 사용자 수정 보존, 접수 중 프로젝트 건너뜀 | 위 테스트의 실제 설치본 연동; 실제 관리 프로젝트는 변경하지 않음 |
| 실제 원격 업데이트 준비 시간 | 실제 code-agent 소스(커밋 `10acfa5`)의 받기·설치·빌드·실행 검사 19.0초(설치 7.8초·빌드 1.8초·검사 1.2초), 같은 커밋 재준비 8.4초(재사용·검사만). 비교 기준: 전체 테스트를 포함한 준비의 저장된 일괄 업데이트 6건은 7분 50초~20분 26초 | 격리 빌드 보관 경로에서 준비만 실행; 프로젝트 적용·실제 빌드 보관 경로 변경 없음 |
| 서버 재시작·종료 | 실제 CLI 프로세스 교체·DB/URL/설정 유지·종료 후 재시작·중복 서버 차단·무관한 서버 보호·화면 토큰 제어 거부 | `tests/dashboard-lifecycle.test.mjs` 2개 |
| 설치 자동 탐색 | PATH의 실행 파일·npm shim·Windows npm 설치·명시적 override·미설치 구분, 현재 PC의 실제 설치 진입점 확인 | `tests/discovery.test.mjs` |
| 그룹·단일 요청 | 서비스 범위 고정·중복 접수 방지, TASK 번호 입력 검증·기록·AI 계획·프로젝트별 개발 지시 전달·이어 실행 보존, HTTP 인증 | `tests/requests.test.mjs` |
| 프로젝트 후보·등록·삭제, 그룹 삭제 | 후보 조회·중복 구분·API 인증, 단독/그룹 등록·원자적 저장, 프로젝트 삭제 보호와 이력 보존. 그룹 삭제의 인증·버전 대조·기존 요청 범위와 실행 보존·삭제 ID의 새 요청/수정 거부 | `tests/project-candidates.test.mjs` 2개, `tests/project-registration.test.mjs` 11개 |
| 그룹 삭제·카드 버튼 브라우저 | 1440/390/320px 버튼 정렬, 삭제 취소·버전 충돌·빈/소속 그룹 삭제, 새로고침 후 유지·요청 대상 제외·프로젝트 보존·XSS. CLI create/delete/list도 격리 DB에서 확인 | `scripts/smoke-dashboard-groups.mjs`, `.master-agent/group-delete-browser-qhxz8i/`. 실제 브라우저·API, 격리 카탈로그이며 개발 모델 미호출 |
| 요청 전체 실행 | 그룹/단일 요청 각각 모의 AI 계획 → 템플릿 연결 → 실제 파일 변경·Node 검사 → 인계·succeeded | `tests/requests.test.mjs`; AI와 개발 호스트는 모의 응답 |
| 명령 설치 | 임시 npm 전역 prefix에 로컬 패키지 설치 후 저장소 밖에서 프로젝트 조회·데모 완료 | `npm.cmd install --global --prefix <임시경로> --offline --ignore-scripts <소스경로>` |
| 관제 서버 | 전체 등록 프로젝트·독립 작업 관측, 조회 실패·오래된 관측 구분, 중복 조회 제한, 삭제 시 기존 대기열·이후 조회에서 제외, HTTP 조회 경계 | `tests/dashboard.test.mjs` 7개 |
| 대시보드 기본 기능 | 삭제·그룹·후보·TASK·원격 업데이트·설치 감지·모바일·연결 끊김 회귀 통과 | `.master-agent/dashboard-browser-NM3mYE/`; 화면의 개발 접수·업데이트 실행은 모의 처리 |
| 진행 상태·병렬 제어 | 5개 회귀 통과, 실제 CLI 조회에서도 확인 | `tests/parallel-progress.test.mjs` |
| 구문·문서 | JavaScript 111개·Markdown 19개 검사 통과 | `npm.cmd run check` |
| 실제 code-agent 계약 등록 | 등록 성공, 원문과 다른 claim·변경된 문서 거부 | `tests/handoff-contracts.test.mjs`의 실제 빌드 연동 |
| 실제 code-agent 통신 | 접수·중복·이벤트·재부착·협력 정지·제어권 인계, 대시보드의 실제 이벤트 수집·반복 조회 중복 방지·실행 호스트 커서 보존 통과 | `tests/code-agent-control.test.mjs`, 실제 빌드와 가짜 개발 호스트. 연동 켜기 전 code-agent의 Claude 설치(`init`)를 준비 |
| 앞선 답의 실제 AI 판단 | 5건 통과: routine 3·ambiguous 1·critical 1 | [판단 증거](evidence/2026-10-16-answer-context.json) |
| 실제 병렬·계약 인계·통합 | 두 프로젝트·세 작업 succeeded, 56분 30초, 계약 입력 7건 대조 | [전체 흐름 증거](evidence/2026-10-17-parallel-contract-flow.json) |

code-agent 연동 시험은 외부 빌드가 없으면 건너뛴다. 위 회귀 결과에는 건너뜀이 없다. 현재 구현과 남은 작업은 [구현 현황](implementation.md)을 따른다.

전체 회귀에 사용한 code-agent는 옆 저장소 `../code-agent`의 빌드다. HEAD는 `10acfa5`(화면 PC 신뢰)이며, 같은 시간에 진행 중인 code-agent 작업의 미커밋 변경이 빌드에 포함됐을 수 있다. 그 작업이 `dist`를 계속 다시 만들어 내용 해시는 고정하지 않았다. 원격 업데이트 준비 시간은 같은 HEAD의 커밋만으로 격리 빌드해 측정했다.

공통 요청함의 실제 CLI·브라우저 시험은 stateSchema 7·interaction schema 1 빌드에서 수행했다. 기능 지원은 `scripts/check-interaction-support.mjs`로 실제 hello·명령·빌드 출처를 확인한다.

질문 단계별 계약 시험의 host 소비/complete는 합성 발행자가 수행했다. 실제 모델의 개발·리뷰·반영 완주나 운영 변경 전체를 검증한 결과로 확장하지 않는다.

## 자동 회귀의 확인 범위

- 계획·근거·의존성·완료 조건·판단 출처 검증, 오래된 응답과 범위 밖 변경 차단.
- 프로젝트 잠금·중복 접수 방지, 독립 실행과 선행 인계 대기, LangGraph 재개·일시 정지·실패 복구·재계획.
- Git 스냅샷·검사·산출물·반영 영수증·계약 문서 결합, 변조·누락 차단과 후속 담당 입력 전달.
- 위임·질문 맥락·사람 이관·재부착·정지·제어권 인계, 실행별 진행 상태와 단계 이벤트 구분.
- 관제·등록·그룹·요청의 HTTP 인증·원자적 저장·버전 대조와 실행기 실패 보존. 관측 시각만 갱신되면 계획을 유지하고 실제 상태가 바뀌면 적용을 거부한다.

일반 회귀의 모델·개발 호스트는 모의 응답이다. 파일·Git·SQLite·자식 프로세스는 실제 실행한다. 실제 code-agent CLI 연동 시험도 개발 모델은 호출하지 않는다.

## 실제 병렬·계약 인계 검증

mission `2a776eaa-e5dd-4e43-94e9-ace0d66e759d`, 2026-10-17 09:04:41~10:01:11 KST, 56분 30초. 두 프로젝트·세 작업이 모두 succeeded다. [검증 증거](evidence/2026-10-17-parallel-contract-flow.json)에 실제 프로세스 실행 구간·커밋·검사 출력·계약 입력 해시를 보존했다.

| 작업 | 프로젝트 전체 테스트 | master 검사 | 반영 커밋 |
| --- | ---: | ---: | --- |
| 할인 | 17개 | 2개 | `b4c22e228d154da6a6f09ef85e86ad900652f8e9` |
| 합계 | 20개 | 2개 | `26de52ce62afbaf01d0ca09ab2dbc2bf5bea8eb2` |
| checkout 통합 | 34개 | 4개 | `b06b9ac8e123252fcbe0bb98663e793814e49c3b` |

테스트 수는 bootstrap과 기존 기능을 포함한 각 시점의 프로젝트 전체 실행이다. master 검사 8개는 반영 전후 모두 통과했다. 실제 호스트의 시작·종료 시각으로 독립 프로젝트의 실행 겹침을 확인했고, checkout은 두 선행 인계가 끝난 뒤 시작했다. 위임 승인 9건은 모두 routine으로 적용됐다. 업무 질문·사람 이관은 0건이며, 두 작업 트리가 clean이고 남은 프로젝트 잠금·그래프 임대는 0개다.

할인·합계의 커밋된 계약 문서 두 개가 첫 planning 배정 전에 등록됐다. checkout의 분석·조사·설계·계획·독립 검토 등 배정 7건(보정 재배정 포함) 모두에서 사본 파일 해시와 계약 입력 해시가 일치했다. 이번 실행에서는 기존 계약을 다시 묻지 않았다. 계약 답의 `contract` 출처 재사용 명령을 실제 모델이 호출한 시험은 아니며, 해당 출처의 검증은 code-agent 자체 회귀 범위다.

원본 DB·모델 입출력·저장소는 로컬 `.master-agent/full-flow-7a0b56e5-dbdc-4b63-a0ef-02a7f897bfa8/`에 있다. 최종 성공까지 자동 보정·재검증이 포함된 결과다.

실제 시험은 code-agent `8085647` 빌드와 같은 별도 사본(1,027개 파일, 전체 해시 `e4cf2a7845978a83c9f7cce5154047fb607449608c52342f21db19bfa30ea021`)을 사용했다.

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
| [2026-10-16 앞선 답 판단](evidence/2026-10-16-answer-context.json) | 실제 Claude 판단·답 CLI 5건: routine 3, ambiguous 1, critical 1. 질문·앞선 답·도입 TTY는 합성 자료 |
| [2026-10-17 병렬·계약 인계](evidence/2026-10-17-parallel-contract-flow.json) | 프로세스 구간·커밋·검사·계약 입력 해시 |

실제 모델의 앞선 답 판단 시험은 [smoke-answer-context.mjs](../scripts/smoke-answer-context.mjs)로 재현한다. 실제 모델의 증거 JSON과 로컬 실행 원본은 보존한다. 회귀 로그·합성 브라우저 산출물은 최신 통과 결과를 유지하며, 중복 로그·실패한 시험 프로필·과거 실행 지시를 누적하지 않는다. 상세 변경은 Git 이력을 따른다.

## 미검증 범위

- 자유 목표의 AI 계획 생성부터 전체 완료까지의 연속 실행.
- 실제 모델의 실패 수정·재계획·프로세스 중단·재부착에 대한 추가 연속 시험.
- 실제 Codex 모델의 개발 전체 흐름, 다중 사용자·원격 운영·배포, 다양한 실제 업무 규모의 판단 품질.
- 직접 실행 ClaudeHost의 전체 사이클. 현재 권장 검증 경로는 `--control`이다.
- 요청 host 교차 검증의 실제 Claude·Codex 판단 품질(반려 기준·재생성). 현재는 모의 AI로 처리 경로만 확인했다.
- 사용자의 실제 PC 키 저장소에서 화면 PC 신뢰와 실제 프로젝트 제어 연결. 브라우저 조작은 격리 키 저장소로 확인했다.

검증 상태나 완료 조건을 수동으로 바꿔 성공시키지 않는다. 미반환·미확인 실행은 자동 성공이나 중복 실행으로 바꾸지 않는다.
