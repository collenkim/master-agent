# master-agent

여러 프로젝트의 code-agent를 연결해 사용자의 목표를 달성하는 **AI 오케스트레이션 시스템**입니다. master-agent가 목표와 영향 범위를 분석하고, 작업을 분해·배정하며, 실행 결과에 따라 재계획하고 통합 검증까지 수행합니다.

실행 오케스트레이션은 LangGraph JS로 통일했습니다. 계획·배정·검증·복구·재계획을 그래프 노드로 실행하고 SQLite에 체크포인트를 저장합니다. 기존 CLI 명령을 유지하며, `mission graph <ID>`로 체크포인트와 최근 실행 상태를 조회합니다. [전환 구조와 재개 규칙](docs/langgraph.md)을 참고하세요.

현재는 **AI 계획·개발 호스트 배정·실제 검증·후행 작업 진행에 범위 내 실패 복구를 연결한 상태**입니다. 프로젝트·그룹·목표 관리, 근거 수집, Codex·Claude CLI 분석, 자동 재검토, 계획 검증, Claude 호스트 실행과 상태 관측을 제공합니다. 검증 실패 시 원인·대안·수정 단계를 기록하고 기존 세션에서 수정하거나 재검증할 수 있습니다. 외부 종료를 확인한 실패 작업은 최신 근거로 재계획합니다. 반영 커밋·동의 기록 대조, 읽기 전용 분석 적용 취소, 호스트·검증 명령 반환 후 관측 중단 복구를 지원합니다. 외부 승인 위임·실행 중 취소·일반 중단 복구와 UI는 후속 범위입니다. 실제 AI와 승인까지 포함한 전체 다중 프로젝트 개발 사이클 검증은 아직 남아 있습니다.

실제 실행의 사용법과 현재 계약 범위는 [개발 호스트 연결](docs/live-execution.md)을 참고하세요.
완료 판정과 `drive` 자동 진행은 [실제 검증과 자동 진행](docs/live-verification.md)에 정리했습니다.
실패 분석·재검토·기존 세션 수정은 [자동 복구](docs/recovery.md)를 참고하세요.
실패 작업의 종료 확인·변경 보존·새 계획 전환은 [재계획 인계](docs/replanning.md)에 정리했습니다.
커밋·영수증 대조와 호스트 반환 후 중단 복구는 [반영 기록과 관측 복구](docs/delivery-reconciliation.md)를 참고하세요.
읽기 전용 분석의 적용 취소와 검증 명령 반환 후 복구는 [분석·검증 중단 처리](docs/interruption.md)에 정리했습니다.
독립 프로젝트 진행, 기존 승인 후 자동 재개와 검증 계약 재사용은 [자동 진행 보완](docs/autonomous-progress.md)을 참고하세요.
code-agent 통신 계약(원자적 접수·이벤트·정지·재부착·위임 판단·제어권 인계)은 [code-agent 통신 계약 연동](docs/code-agent-control.md)을 참고하세요.

Node.js 24.19 이상 24.x에서 `npm.cmd ci --ignore-scripts`로 의존성을 설치한 뒤 실행합니다.

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run demo
npm.cmd test
npm.cmd run check
```

데모는 고정 계획으로 세 프로젝트의 모의 구현과 통합 검증을 수행합니다. 실제 개발 결과와 구분해 `simulation-complete`로 기록하며 데이터는 `.master-agent/` 아래에 저장합니다.

- [LangGraph 실행 구조와 재개](docs/langgraph.md)
- [요구사항 범위와 수용 기준](docs/requirements.md) — 제품 목표와 자율 수행 원칙의 기준
- [시스템 설계 초안](docs/architecture.md)
- [AI 오케스트레이션 핵심 설계](docs/orchestration.md)
- [UI 구성과 화면 흐름](docs/ui.md)
- [구현 단계와 완료 기준](docs/implementation.md)
- [첫 구축 작업 계획](docs/build-plan.md)
- [프로젝트 근거 수집과 AI 계획 생성](docs/ai-planning.md)
- [CLI 사용법과 구현 경계](docs/usage.md)
- [code-agent 통신 계약 연동](docs/code-agent-control.md)
- [검증 기록](docs/verification.md)

구성 위치는 `C:\IdeaProjects\master-agent`입니다. `C:\Users\kai\Desktop\blog\master-agent`의 구상과 현재 `C:\IdeaProjects\code-agent`의 소스를 참고했습니다. 블로그와 code-agent 소스는 수정하지 않습니다.

## 핵심 사용 흐름

1. 사용자가 달성할 목표, 완료 조건과 허용 범위를 전달합니다.
2. master가 프로젝트 카탈로그와 정책·계약·경험을 검색해 관련 프로젝트와 근거를 찾습니다.
3. 프로젝트별 도메인·구현 가능 범위·현재 계획을 대조해 역할, 작업 의존 관계와 검증 방법을 정합니다.
4. 판단 근거와 실행 내용을 기록한 뒤 code-agent에 자동 배정하고 상태·발견·결과를 수집합니다. 모호함은 재검토하고 사람이 결정해야 하는 중대한 사안만 판단을 요청합니다.
5. 실패나 새로운 영향을 반영해 제한 안에서 재시도·재계획합니다.
6. 프로젝트별 근거와 서비스 간 통합 검증을 대조해 목표 달성 여부를 판정합니다.

개별·선택·그룹 명령은 같은 실행·소유권·검증 경로를 사용하는 보조 진입점입니다. UI 없이도 핵심 흐름을 실행하고 재개할 수 있어야 합니다. 개별 프로젝트의 외부 code-agent 작업은 별도로 관측하고 실행 충돌을 방지합니다.

운영 조건은 보류하며, 기존 설계의 예산·복구·배포 등 운영 관련 제안은 확정된 요구사항이 아닙니다. 위 핵심 사용 흐름 전체가 현재 구현됐다는 의미는 아니며 실제 제공 기능은 사용법의 구현 경계에 명시했습니다.
