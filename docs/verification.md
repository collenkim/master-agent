# 검증 기준과 재현 방법

기준일: 2026-10-23. Windows·Node.js 24.19.0에서 검증한다. 현재 기능과 남은 범위는 [구현 현황](implementation.md)을 따른다. 변경 과정과 폐기한 검증 방식은 Git 이력에서 확인한다.

## 최신 검증

| 검증 | 결과·범위 | 재현 |
| --- | --- | --- |
| 자동 회귀 | 전체 299건 통과, 실패·건너뜀 0(code-agent `4dd40da` 빌드 사용). 프로젝트 카드의 접수 요청 표시와 응답 거절 사유 보존은 자동 회귀로만 확인. 모델·개발 호스트는 모의 | `npm.cmd test` |
| Gradle 검증 추천·계약 | 회귀 7건 통과. Gradle 감지·Wrapper 실행·실패 코드 전달, 파일과 검사 결과의 산출물 연결, 계획 파일 패턴의 정확한 경로 변환, 계약 등록·같은 TASK 완료·원자적 실패 처리 | `node --test tests/dashboard-verification.test.mjs` |
| 질문·검증 계약 브라우저 | 조회·제출 경합, 응답 이력·다음 질문·저장한 답 재열기, 직접 입력 없는 검증 선택·산출물 연결, 검사 삭제 후 연결 보존·선택에 따른 검사 추가·초안 복원, 명시적 승인·전체 계약 등록·같은 TASK 1회 재개 통과(질문 20개·검증 계약 17개 항목). 1440/768/390/320px 화면 검사 | `node scripts/smoke-dashboard-interactions.mjs`, `node scripts/smoke-dashboard-verification.mjs` |
| 실제 대시보드 관측 | 서버 재시작 후 저장된 답변·선택값·응답 이력, 검증 계약 화면의 두 작업과 4개 화면 폭, 제어 연결 미리보기 확인. 업무 답변·검증 계약·연결은 제출하지 않음 | 로컬 브라우저에서 기존 요청 조회. 사용자별 DB를 사용하는 수동 검증 |
| 업데이트 계약·실제 설치 | 계약 회귀 18건과 격리 환경의 실제 npm 설치·빌드·릴리스 등록·프로젝트 적용·재시작 후 재확인 통과. 문구·해시·릴리스 ID·잠금·부분 실패·1440/390/320px 화면 검사 | `node --test tests/source-update.test.mjs tests/dashboard-updates.test.mjs`, `node scripts/smoke-dashboard-updates.mjs` |
| code-agent 실행 방식별 준비 | 실행 방식별 준비(`runReadiness`) 정규화, 고른 방식의 확정 준비만 접수, 옛 code-agent는 주 host 준비로 판정. 브라우저 16개 항목: 카드의 방식별 준비·차단 이유, 신뢰 필요·확인 중 차단, 교차 검증 host의 신뢰 불요, 옛 형식 문구 유지, 1440/390/320px. 실제 Codex로 조회한 code-agent hello로도 화면 확인 | `node --test tests/request-host.test.mjs tests/pairing.test.mjs tests/managed-host.test.mjs`, `node scripts/smoke-dashboard-request-host.mjs` |
| 구문·문서 링크 | JavaScript 118개·Markdown 19개 검사 | `npm.cmd run check` |

업데이트 계약 fixture는 [update-fake-cli.mjs](../tests/update-fake-cli.mjs)다. code-agent 실행 응답을 흉내 내며 실제 릴리스를 빌드하지 않는다. 실제 설치·적용 smoke는 [smoke-dashboard-updates.mjs](../scripts/smoke-dashboard-updates.mjs)를 별도로 사용한다. `CODE_AGENT_SOURCE`로 소스와 빌드가 있는 code-agent 폴더를 지정할 수 있으며 기본은 `../code-agent`다. 현재 소스의 격리 사본, 로컬 bare remote, 전용 `CODE_AGENT_HOME`·`CODE_AGENT_RELEASE_HOME`과 두 프로젝트를 만들어 사용자 프로젝트·키·릴리스 저장소를 변경하지 않는다. 모델은 호출하지 않는다.

설치 smoke는 네트워크 npm 다운로드와 받은 소스의 설치·빌드 스크립트를 실행한다. Chrome·자식 프로세스·사용자 홈 접근이 샌드박스에 막히면 같은 검사를 허용된 실행 환경에서 수행해야 한다. 외부 code-agent 빌드가 필요한 일반 연동 테스트는 빌드가 없으면 건너뛴다.

## 자동 회귀의 확인 범위

| 범위 | 주요 시험 |
| --- | --- |
| 계획·근거·의존성·완료 조건·검증 계약 | 계획 검증, 수집된 소스 ID로 응답 스키마 제한·등록 참조 거부·동일 목표의 오류 피드백 재분석, 소스·문서 해시·반영 커밋 대조, 범위 밖 변경과 변조·누락 차단, 후속 담당 입력 전달 |
| 실행·복구·위임 | 프로젝트 잠금·중복 접수 방지, 독립 실행·선행 인계 대기, LangGraph 재개·실패 복구·재계획, 위임 판단의 출처·권한·영수증 대조 |
| 실제 code-agent 통신 | `tests/code-agent-control.test.mjs`, `tests/managed-host.test.mjs`: 접수·중복·이벤트·재부착·정지·인계, 요청별 host 선택·같은 thread 재개. 개발 호스트는 모의 |
| PC 신뢰·제어 연결 | `tests/pairing.test.mjs`, `tests/code-agent-control.test.mjs`: 문구·해시·확인 단어·호스트 표지·소유권·미확인 재전송·서명 채널. 격리 키 저장소 사용 |
| 대시보드·등록·그룹·요청 | HTTP 인증·원자적 저장·버전 대조·삭제 보호, TASK와 host 보존, 준비 실패·기존 요청 재개, 독립 관측과 오류 표시 |
| 질문·승인·타임라인 | `tests/dashboard-interactions.test.mjs`, `tests/dashboard-history.test.mjs`: 명시적 응답, 수신·적용·재개 구분, 오래된 문맥 거부, 중복·재시작·전송 미확인 보호, 별도 이벤트 커서·페이지 조회 |
| 브라우저 | `scripts/smoke-dashboard-interactions.mjs`, `scripts/smoke-dashboard-history.mjs`, `scripts/smoke-dashboard-groups.mjs`, `scripts/smoke-dashboard-request-host.mjs`, `scripts/smoke-dashboard-trust.mjs`: 해당 기능의 실제 화면·API와 모바일 검사 |

일반 회귀의 모델·개발 호스트는 모의 응답이다. 파일·Git·SQLite·자식 프로세스는 실제 실행한다. 관제·질문 계약·설치 시험을 실제 모델의 개발·리뷰·반영 전체 완주로 해석하지 않는다. 질문 API의 실제 서명·CLI·docs 적용은 `scripts/smoke-interactions-live.mjs`로 재현하며 발행자·최초 인증은 합성 fixture다.

## 보존한 실제 모델 증거

질문·앞선 답·도입 TTY는 합성 자료이며 실제 Claude 판단과 code-agent 답 적용을 확인한 요약이다. 전체 흐름은 고정 master 계획으로 시작한 두 프로젝트·세 작업의 로컬 완료이며 원격 push·배포를 포함하지 않는다.

| case ID | 분류 | passed | SHA-256 | master 커밋 |
| --- | --- | --- | --- | --- |
| relayed-1 | routine | true | `7d04c9b6f0aa4608cd0a15c619457334d2e20c24f069ab78dc3db266bae737e0` | `a9b65a1f93134db74ecbacd3b3a1ff2bbc5ebb6b` |
| relayed-2 | routine | true | `8f7527fe8337a25cf7b70fe78cf2f7f81c471afcb28f16fc985d9d074fe759d0` | `a9b65a1f93134db74ecbacd3b3a1ff2bbc5ebb6b` |
| relayed-3 | routine | true | `1b8353439de1be716090577c22b5f493f24aa2db9aacb877693fb076ec39bcfc` | `a9b65a1f93134db74ecbacd3b3a1ff2bbc5ebb6b` |
| missing-context | ambiguous | true | `a2305d0226420d1a1f06e2e8dfdbc40e771bd0c234fd126008b1d3f2ccebd2a7` | `a9b65a1f93134db74ecbacd3b3a1ff2bbc5ebb6b` |
| conflicting-policy | critical | true | `6e583f077f78381cf8954d994fefcde19aa05ed3c5ff4a3e58e7753a39164754` | `a9b65a1f93134db74ecbacd3b3a1ff2bbc5ebb6b` |
| parallel-contract-flow | 병렬 개발·계약 인계·통합 | true | `97a10eeff25ddbc85b1677442cb8b617090e5a232289fce02eb9d8998a1eb35b` | `0a616e463a2af85660de79aaa0f327b350b5e3ba` + 수정 3개 |

답변 문맥의 해시는 각 질문 문서, 전체 흐름의 해시는 제거 전 증거 JSON을 식별한다. 전체 흐름은 표시한 기준 커밋에 소스 3개를 수정한 상태에서 수행했으므로 깨끗한 커밋 재현이라고 표시하지 않는다. modelCalls 전문·로컬 절대 경로를 포함한 JSON은 저장소에 보존하지 않는다.

```powershell
node scripts/smoke-answer-context.mjs
node scripts/smoke-full-flow.mjs setup
node scripts/smoke-full-flow.mjs drive <root>
node scripts/smoke-full-flow.mjs status <root>
node scripts/smoke-full-flow.mjs report <root>
```

`CLAUDE_CLI`를 지정하고 `setup`이 출력한 격리 root를 사용한다. 준비와 실행은 같은 OS 사용자로 수행한다. 산출물의 보존·정리 규칙은 [smoke 산출물 보존](#smoke-산출물-보존)을 따른다.

검증 상태나 완료 조건을 수동으로 바꿔 성공시키지 않는다. 미반환·미확인 실행은 성공이나 중복 실행으로 바꾸지 않는다.

## smoke 산출물 보존

브라우저·모델·요청함 smoke는 실행 폴더를 만들고 종류별 최신 3개를 기본으로 보존한다. 기본 위치는 실행 작업 폴더의 `.master-agent/`이며 `MASTER_AGENT_SMOKE_ROOT`로 바꾼다. 요청함의 지원 조회는 `interaction-support-*`, 전체 전송 시험은 `interactions-live-*` 아래에 결과와 격리 프로젝트를 함께 둔다. 브라우저 화면은 같은 폴더의 `browser/`에 저장한다. `smoke-code-agent.mjs`는 기존처럼 임시 시험 폴더를 종료 시 모두 삭제한다.

공유 헬퍼의 소유 표지가 있는 실행 폴더만 정리한다. 실행 중인 폴더와 다른 호스트의 실행, 결과가 확인되지 않은 외부 실행을 보존하므로 잠시 3개를 넘을 수 있다. 전체 흐름의 `drive`는 외부 실행 전 보존 표지를 남기고 시도와 제어 실행이 종료됐음을 확인한 뒤 해제한다. 실행기가 비정상 종료하면 표지를 유지하며 같은 폴더로 조회·재개한 뒤 정리할 수 있다. 링크와 소유 표지가 없는 과거 폴더는 자동 삭제하지 않는다. 기존 로컬 산출물은 목록을 확인한 뒤 별도로 정리한다.

## 미검증 범위

자유 목표의 연속 완주·실패와 중단 복구·Codex 및 교차 판단은 실제 모델로 추가 검증해야 한다. 전체 미검증 범위와 후속 시험은 [남은 작업](implementation.md#남은-작업)을 따른다.
