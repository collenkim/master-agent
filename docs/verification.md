# 검증 기준과 재현 방법

기준일: 2026-10-22. Windows·Node.js 24.19.0에서 검증한다. 현재 기능과 남은 범위는 [구현 현황](implementation.md)을 따른다. 변경 과정과 폐기한 검증 방식은 Git 이력에서 확인한다.

## 최신 검증

| 검증 | 결과·범위 | 재현 |
| --- | --- | --- |
| 자동 회귀 | 전체 289건 통과, 실패·건너뜀 0. 이후 보완한 분석 복구·근거·검증 계약 회귀 51건과 마지막 요청함 변경 관련 24건도 통과. 모델·개발 호스트는 모의 | `npm.cmd test`; 요청함 회귀: `node --test tests/dashboard-recovery.test.mjs tests/dashboard-interactions.test.mjs tests/dashboard-verification.test.mjs` |
| 질문·검증 계약 브라우저 | 조회·제출 경합, 성공 후 이력 갱신·다음 질문·저장한 답 재열기, 실제 변경 시 입력 보존, 명시적 승인·전체 계약 등록·같은 TASK 1회 재개 통과. 긴 설명·경로를 1440/768/390/320px에서 확인 | `node scripts/smoke-dashboard-interactions.mjs`, `node scripts/smoke-dashboard-verification.mjs` |
| 실제 대시보드 관측 | 서버 재시작 후 저장된 답변·선택값·응답 이력, 검증 계약 화면의 두 작업과 4개 화면 폭, 제어 연결 미리보기 확인. 업무 답변·검증 계약·연결은 제출하지 않음 | 로컬 브라우저에서 기존 요청 조회. 사용자별 DB를 사용하는 수동 검증 |
| 업데이트 계약·실제 설치 | 계약 회귀 18건과 격리 환경의 실제 npm 설치·빌드·릴리스 등록·프로젝트 적용·재시작 후 재확인 통과. 문구·해시·릴리스 ID·잠금·부분 실패·1440/390/320px 화면 검사 | `node --test tests/source-update.test.mjs tests/dashboard-updates.test.mjs`, `node scripts/smoke-dashboard-updates.mjs` |
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

| 증거 | 확인한 내용과 한계 |
| --- | --- |
| [앞선 답 판단](evidence/2026-10-16-answer-context.json) | 실제 Claude 판단·답 CLI 5건: routine 3, ambiguous 1, critical 1. 질문·앞선 답·도입 TTY는 합성 자료. `scripts/smoke-answer-context.mjs`로 재현 |
| [병렬·계약 인계](evidence/2026-10-17-parallel-contract-flow.json) | 두 프로젝트·세 작업 succeeded, 실제 프로세스 구간·커밋·검사·계약 입력 해시. 고정 master 계획으로 시작하며 원격 push·배포는 제외 |

```powershell
node scripts/smoke-full-flow.mjs setup
node scripts/smoke-full-flow.mjs drive <root>
node scripts/smoke-full-flow.mjs status <root>
node scripts/smoke-full-flow.mjs report <root>
```

`setup`이 출력한 격리 root를 사용하며 준비와 실행은 같은 OS 사용자로 수행한다. 실제 모델 증거 JSON은 보존하고, 회귀 로그·브라우저 산출물은 최신 결과를 기준으로 관리한다.

## 미검증 범위

- 자유 목표의 AI 계획 생성부터 전체 완료까지 연속 실행.
- 실제 모델의 실패 수정·재계획·프로세스 중단·재부착을 묶은 추가 연속 시험.
- 실제 Codex 모델의 개발 전체 흐름과 Claude·Codex 교차 판단 품질.
- 다중 사용자·원격 운영·배포, 다양한 실제 업무 규모의 판단 품질.
- 직접 실행 ClaudeHost의 전체 사이클. 현재 전체 흐름 검증 경로는 `--control`이다.
- 사용자의 실제 PC 키 저장소와 실제 프로젝트에서 화면 신뢰·제어 연결. 해당 기능은 격리 환경에서 확인한다.

검증 상태나 완료 조건을 수동으로 바꿔 성공시키지 않는다. 미반환·미확인 실행은 성공이나 중복 실행으로 바꾸지 않는다.
