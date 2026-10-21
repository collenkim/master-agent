# code-agent 통신 계약 연동

code-agent가 제공하는 master 통신 계약(`code-agent.master` v1, code-agent 저장소 `doc/master-control.md`)으로 실행을 접수·관찰·정지·재개·인계하고, 사람이 code-agent에서 준 권한 범위의 일상 판단을 위임 판단으로 보낸다. 대시보드·CLI의 프로젝트/그룹 요청과 `--control` 실행이 이 경로를 쓴다. 직접 실행 호스트(`ClaudeHost`)는 [별도 계약](live-execution.md)을 따른다.

## 역할과 적용 조건

관리 실행의 호스트는 요청에서 고른 host다. master는 요청의 host(`claude`·`codex`, `both`면 주 host와 교차 검증)를 새 실행 접수(`submit mode:start`)의 `execution`으로 보내고, code-agent는 그 실행에만 적용한다. 프로젝트의 `execution.json`은 바꾸지 않는다. code-agent는 실행이 연 작업에 이 선택을 고정한다. 같은 작업의 이어 실행·새 실행과 교차 검증·단독 호스트 판정은 작업이 끝날 때까지 같은 선택을 따른다. 이어 실행(`continue`)에는 `execution`을 보내지 않는다. 실행 파일·모델·권한은 사람이 `master enable --host <JSON 파일>`로 등록한 그 host의 설정(없으면 제한된 기본값)을 code-agent가 주입한다.

host를 고르지 않은 요청은 프로젝트의 `execution claude|codex`·`execution both --main claude|codex`를 따르고, `auto` 또는 main 없는 `both`는 등록된 기본 호스트를 사용한다. 고른 host는 master의 계획·판단 AI도 정한다. 단독이면 그 CLI 하나, both면 주 host가 만들고 다른 host가 승인한 결과만 쓴다([AI 계획](ai-planning.md#요청-host와-교차-검증)). host를 고르지 않은 요청의 `--provider`·`--model`은 계획·판단 설정이며 관리 개발 호스트를 덮어쓰지 않는다.

새 프로젝트 등록의 기본 기능은 `code-agent:managed`다. 기존 `code-agent:claude`와 명시적 `code-agent:codex` 등록·계획도 관리 경로에서 받으며 실제 호스트는 code-agent가 선택한다. 준비 점검은 설치 마커·지원 프로토콜/호스트·제어권·인증을 확인한다. 선택된 호스트의 설치·권한·Codex 프로젝트/hook 신뢰 판정은 code-agent의 접수·감독을 따른다. master는 권한 설정이나 신뢰를 자동 변경하지 않는다.

관리 실행의 지시문은 `.claude` 경로를 지정하지 않고 주입된 호스트 지침과 `code-agent flow advance --json`이 반환한 `procedure`·`instruction`·`agent`·`contextFile`을 따른다. 결과 기록 후 `resume`으로 이어가고 `human`·`wait`는 대기로 남긴다. Claude 직접 실행은 별도의 기존 경로다.

Codex 접수의 세션 ID는 임시 별칭일 수 있다. master는 결과의 `hostKind`·`sessionConfirmed`·`sessionAlias`와 확정된 thread ID를 기록하고 같은 thread만 재개한다. thread 미확인은 새 세션으로 대체하지 않는다. 호스트·권한 설정이 바뀐 세션의 재개는 code-agent가 거부하며, 호스트 전환은 사용자의 `execution --handoff` 절차와 별도 실행 인계가 필요하다. 요청에서 host를 고른 작업도 같으며, 사람이 `execution <host> --handoff`로 인계하면 그 작업에 고정된 선택도 인계한 host로 바뀐다.

| 주체 | 하는 일 |
| --- | --- |
| master-agent | 목표 분석·작업 배분·의존성·진행·재계획·독립 검증·전체 완료 판정, 위임 판단의 분류·이유·근거 기록 |
| code-agent | 프로젝트 안의 접수·계획·구현·검증·반영 절차와 승인 조건, 원자적 접수, 위임 판단의 범위 검증과 적용, 사람 응답과의 구분 기록 |
| code-agent 감독 프로세스 | 등록된 호스트 설정을 주입해 Claude·Codex 실행 세션 시작·생존 확인·협력 정지·강제 종료·종료 기록 |
| 사람 | 연동 켜기·제어자 등록, 위임 권한(grant) 부여·회수, 중대한 판단, 강제 인계 |

1. 사람이 대상 프로젝트의 TTY에서 `code-agent master enable --controller <ID> --token-out <저장소 밖 파일>`로 연동을 켠다. 켜지 않은 프로젝트는 연결되지 않고(`control-not-enabled`) 기존 직접 실행 경로만 쓴다.
2. master는 `project control`로 제어자로 연결한다. 페어링을 지원하는 code-agent에서는 1번 대신 사람이 확인한 [제어 연결(페어링)](#제어-연결페어링)으로 켜기·연결을 한 번에 한다. 연결 기록에는 토큰 파일 경로만 남기고 토큰 값은 저장하지 않는다. **연결은 승인 권한이 아니다** — 위임 판단은 사람이 `code-agent master grant <권한.json>`으로 준 범위(동작·임무 또는 작업·경로·만료·사용 횟수)에서만 code-agent가 받는다.
3. 사람만 하는 동작(setup·docs·baseline·model·plugin·update·abort 등)과 master 실행이 준비하지 않은 확인 요청은 위임 대상이 아니다.
4. 대시보드의 명시적 사람 답은 별도 `dashboard-human` 채널을 사용한다. 사용자가 `code-agent master human enable --controller <ID>`로 등록한 Ed25519 키로만 서명하며 AI grant·기존 `answer actor:human`과 구분한다. `interactions`·`interaction.respond`·`interaction.result` 계약과 지원 범위는 [공통 요청함](dashboard-interactions.md)을 따른다. 사람 전용 동의도 이 채널에서 원래 검증·적용 함수로 처리한다.

## 명령

```powershell
master-agent project control <프로젝트ID> --cli <code-agent cli.js> --controller <제어자ID> --token-file <절대경로>
master-agent project snapshot <프로젝트ID> --cli <경로>
master-agent mission drive <목표ID> --cli <경로> --control --provider claude [--poll-ms 2000] [--follow-timeout-ms 14400000]
master-agent mission dispatch <목표ID> <작업ID> --revision <N> --expect-state <버전> --cli <경로> --control
master-agent mission reattach <목표ID> <시도ID> --cli <경로>
master-agent mission stop <목표ID> <시도ID> --cli <경로> --mode pause|cancel [--force] [--wait-ms <N>]
master-agent mission delegate <목표ID> <시도ID> --cli <경로> --provider claude
master-agent mission escalations <목표ID>
master-agent mission relay <목표ID> <시도ID> <답JSON> --cli <경로>
master-agent project handover <프로젝트ID> --cli <경로> --to <새 제어자> [--wait-ms <N>]
master-agent project accept <프로젝트ID> --cli <경로> --controller <새 제어자> --token-file <절대경로>
master-agent project pair <프로젝트ID> --cli <경로> [--controller dashboard]   # TTY에서 확인 단어 pair
```

`--control`은 dispatch·continue·verify·handoff·reconcile·replan·recover·advance·drive에 붙인다. reattach·stop·delegate·relay는 항상 이 경로다. `--poll-ms`(결과·이벤트 조회 주기)와 `--follow-timeout-ms`(한 실행을 기다리는 상한 — 넘으면 기다림만 멈추고 실행은 code-agent에서 계속된다)는 master 쪽 설정이다. heartbeat·연결 끊김 판단·정지 유예·실행 시간 상한 등은 code-agent 정책(`code-agent master enable --policy`, 통신 `policy`)이 정한다.

`drive --control`은 독립 프로젝트를 먼저 접수하고 실행 ID를 저장한 뒤, 각 결과를 한 번씩 조회한다. 하나가 실행 중이어도 다른 프로젝트를 접수할 수 있다. 동일 프로젝트 잠금·선행 인계 조건은 유지하며 판단과 검사는 순차 수행한다. 이 경로의 관측 상한은 저장된 acceptedAt부터 계산하므로 재연결로 초기화되지 않는다. 초과·관측 불가는 unknown으로 보존하고 잠금·외부 실행은 그대로 둔다. 개별 dispatch·continue·reattach는 기존처럼 종료를 기다린다.

`mission progress <ID>`는 원격 호출 없이 최근 저장 관측을 읽는다. 정상 위임 대기는 approval-pending, 판단·전송 중은 approval-processing, 사람 이관은 human-input, 실패·범위 위반·미확인은 blocked로 표시한다. 기존 state와 nextAction은 호환성을 위해 보존하며 새 관제에서는 progress.status·progress.nextAction과 작업별 phase·reason·runId·lastProgressAt을 사용한다.

## 제어 연결(페어링)

PC당 한 번의 신뢰 등록과 프로젝트별 화면 확인 한 번으로 연동 켜기·DB 등록·사람 채널 생성을 함께 한다. 터미널 절차(`master enable`·`master human enable`·`project control`)도 그대로 쓸 수 있다. 계약은 code-agent `doc/master-control.md`(§12.1)가 기준이다. 아래는 master가 쓰는 부분의 요약이다. 페어링을 지원하지 않는 code-agent는 `hello.pairing`이 없으므로 기존 터미널 안내(`control-not-bound`)로 대신한다.

```
PC 신뢰 (code-agent, 터미널, PC당 1회)
  code-agent master trust --controller dashboard        # 확인 단어: trust
  개인 키: <storeDir>/master-trust/<controller>.pem      # storeDir = CODE_AGENT_HOME 또는 ~/.code-agent

hello (인증 없음) — 추가 필드
  pairing:     { supported: true, version: 1, signature: "Ed25519", domain: "code-agent.master-pair.v1", trustedControllers: ["dashboard"] }
  managedHost: { selected, source, installedHosts, execution, ready, problems: [{ code, message }],
                 runSelection: { supported: true, modes: ["claude", "codex", "both"] },   # submit execution 으로 고를 수 있는 방식
                 hosts: { claude: { ready, problems }, codex: { ready, problems } } }       # 설치된 host마다의 준비

pair.challenge (인증 없음)
  요청 payload: { controller }
  결과: { challengeId, nonce, projectRoot, controller, expiresAt, project: { enabled, owner, handover } }

pair (인증 = PC 신뢰 키 서명, 토큰 없음)
  요청: { type: "pair", commandId, payload: { challengeId, controller, approval: { actor, approvedAt, shownHash: "sha256:<hex 64>" }, signature } }
  서명 대상: canonicalJson({ domain: "code-agent.master-pair.v1", challengeId, nonce, projectRoot, controller, commandId, approval }) — Ed25519, base64
  결과: { outcome: "enabled" | "rotated", projectId, controller, generation, owner: true, tokenFile, humanChannel: { channelId, expiresAt, ... } }
  오류: unauthorized · stale-state · fenced · conflict · busy · invalid-request · policy-forbids
```

master 쪽 동작(`packages/runner/control-pairing.mjs`, 어댑터 `packages/code-agent-adapter/pairing.mjs`):

1. 확인 화면 내용은 서버가 토큰 없는 hello로 만든다. 경로·제어자·기본 개발 호스트(요청에서 host를 고르지 않을 때)와 준비 상태·요청별 host 선택 지원·연결은 승인 권한이 아니라는 문장·사람 응답 채널 만료 안내를 담고, 그 내용의 해시(`shownHash`, `sha256:<hex>`)를 함께 낸다. `approvedAt`은 사람이 제출한 시각이며 code-agent는 챌린지 발급 시각과 2분 이상 어긋나면 거부한다.
2. 제출에는 프로젝트 버전·`shownHash`·`commandId`·확인 체크가 필요하다. 서버가 내용을 다시 만들어 해시가 다르면 `stale-state`로 거부한다. 프로젝트가 실행·업데이트·사람 응답 전송 중이면 `project-busy`다.
3. `pair.challenge`의 projectRoot·controller·만료를 대조하고 다른 소유자·인계 중이면 서명하지 않는다. 서버 계정의 신뢰 키로 서명해 연결 기록(`control-pairing`, 상태 `sending`)을 먼저 저장한 뒤 보낸다. 개인 키는 서명 순간에만 읽는다.
4. 결과는 owner·generation·저장소 밖 절대 경로의 tokenFile을 확인한 뒤 `bindControl`로 등록하고 `control-paired` 이벤트를 남긴다. `rotated`는 같은 연결의 토큰 갱신이다. 바인딩에는 토큰 파일 경로와 사람 응답 채널 ID·만료만 더한다. 신뢰 키·사람 채널 키는 code-agent 키 저장소(`CODE_AGENT_HOME` 또는 `~/.code-agent`)에서 찾는다.
5. 응답을 잃으면 같은 commandId로 두 번 다시 보낸다. 그래도 모르면 `unknown`으로 남기고 같은 프로젝트의 새 연결을 막는다. 화면·`/api/projects/pair/retry`는 같은 서명을 다시 보내 기록된 결과를 받는다. DB 등록만 실패하면(`bind-failed`) 받은 결과로 등록만 다시 한다.

페어링은 사람이 화면(확인 체크) 또는 TTY(`project pair`, 확인 단어 `pair`)에서 확인할 때만 한다. 요청 실행기·AI 계획·복구·백그라운드 순회는 hello로 상태를 읽기만 한다. 준비 점검은 연결이 없을 때 원인을 `control-pairing-available`·`control-trust-missing`·`control-owned-by-other`·`control-enabled-unbound`로 나누고, 미지원 code-agent는 기존 `control-not-bound` 안내를 낸다. host를 고른 요청은 `managedHost.runSelection`이 없으면 `host-selection-unsupported`(프로젝트 설정으로 대신 실행하지 않는다), 고른 방식이 `modes`에 없으면 `host-not-installed`, 고른 주 host의 `hosts.<host>.ready === false`면 `host-not-ready`를 낸다. host 없이 접수된 요청은 `managedHost.ready === false`면 `host-not-ready`를 낸다. 관측한 저장소에 커밋이 없으면 `repository-no-commit`(안내: `code-agent setup baseline`)을 함께 낸다.

## 실행 — 원자적 접수와 관찰

1. 배정·계속 실행은 기존과 같이 판단·시도·잠금을 한 트랜잭션으로 저장한 뒤 시작한다.
2. 시작은 `submit` 한 번이다. 새 실행이면 요청에서 고른 host를 `payload.execution`(`{ mode, main? }`)으로 함께 보낸다. commandId는 `inv-<invocationId>`이고 기대 상태 버전(`expect.stateVersion`)과 master 식별자(`links`: 임무·작업·시도·계획 버전·호출)를 함께 보낸다. code-agent가 상태·소유·임대·작업 연결을 한 잠금 안에서 확인하고 받는다. 응답을 잃어 같은 commandId로 다시 보내면 기록된 응답이 돌아오고 실행은 하나다. 같은 commandId에 다른 내용은 `control-conflict`로 거부된다. code-agent가 이어 실행 접수를 응답으로 거부하면(`ok: false` — 재개 판정·임대·소유 등) 실행을 만들지 않았다는 확인이므로 같은 세션의 막힘(`blocked`, 결과의 `control.state: rejected`)으로 남기고 `control-submit-rejected`를 기록한다. 자동으로 다시 보내지 않는다. 통신 실패나 세션이 없는 첫 실행의 거부는 시도를 unknown으로 남긴다. 실행이 시작되면 세션 임대·hook 기록으로 상태 버전이 바뀌므로, 실행 프롬프트는 세션에 기대 상태를 다시 대조시키지 않고 지정된 작업인지만 확인하게 한다. 실행 세션 안의 `code-agent status --json`은 그 실행의 세션으로 임대를 본다. 프롬프트는 검증 계약의 독립 검사와 변경 범위 제약을 code-agent의 수락 기준·테스트 케이스로 옮기지 말라고 알린다 — 그것은 master가 반영 뒤 확인한다. 같은 프로젝트의 선행 작업이 반영한 커밋이 있으면 `codeAgentBase`로 넣어 새 작업을 그 위에서 시작하게 한다(code-agent 접수의 `--base`). 기본 기준 브랜치에서 시작하면 선행 산출물이 빠지기 때문이다. 선행 작업 증거는 요약(작업·프로젝트·검사 결과·산출물 해시·반영 커밋)만 싣는다 — 파일 트리 스냅샷·원격 상태·검사 출력은 master 기록에 남고, 통합 작업처럼 선행이 여럿이면 code-agent 접수 한도(프롬프트 20000자)를 넘기 때문이다.
3. 접수된 실행은 `control-run` 기록으로 남기고, 끝 상태가 될 때까지(끝 상태를 본 뒤 한 번 더) 이벤트를 커서(`control-cursor`: 기록 ID·순번)로 받아 진척·질문·동의·검증·실행·연결 이벤트를 `control-event`로 남긴다. 기록 ID가 바뀌거나 구간이 비면(gap) 누락을 추측하지 않고 스냅샷으로 다시 맞춘다(`control-resynced`).
4. 결과는 code-agent의 결과 근거(종료 코드·최종 메시지·권한 거부·실행 전후 상태·변경 파일·커밋·검증 기록)를 호스트 결과로 옮긴다. 모델의 완료 발언은 요약일 뿐이고, 회차의 처분은 기존처럼 실행 뒤 code-agent 상태와 master의 독립 검증으로 정한다. `unknown`·`abandoned` 실행은 결과로 받지 않고 시도를 unknown으로 남긴다(자동 재실행 없음).

연결 상태(통신), 프로세스 생존(감독·호스트 pid와 heartbeat), 업무 진척(단계·재개 판정)은 code-agent가 따로 보고한다. 통신이 끊긴 것만으로 실패·재배정하지 않는다 — 잠금은 시도가 끝날 때까지 유지되고, 실행은 code-agent 정책(`onMasterDisconnect`)에 따라 계속되거나 협력 정지한다.

## 재시작 뒤 재부착

master가 결과를 받기 전에 멈추면 시도가 `running`으로 남는다. `mission drive`(또는 `mission reattach`)는 그 시도의 commandId로 code-agent의 명령 기록을 조회해 같은 실행에 다시 붙고, 커서 다음부터 이벤트를 받아 결과를 기록한다. 실행을 새로 접수하지 않는다. code-agent가 그 호출을 받은 기록이 없으면(`control-not-submitted`) 실행되지 않은 것으로 보고 시도를 unknown으로 남긴다 — 다시 배정하려면 상태를 대조한 뒤 새 호출로 한다.

## 정지·취소

`mission stop`은 그 시도의 지금 호출로 접수된 실행 하나만 대상으로 한다(commandId `stop-<runId>-<mode>`). 응답의 `requested`는 요청 접수, `stopped`는 끝 상태 확인이다. pause는 hook을 통한 협력 정지이고, 유예가 지나거나 `--force`면 code-agent가 확인된 프로세스만 강제 종료한다(결과에 협력·강제가 구분돼 남는다). 취소는 파일·커밋을 되돌리지 않는다. 시도의 상태는 결과를 받는 쪽(진행 중인 drive 또는 reattach)이 실행의 끝 상태로 남긴다. `mission pause`는 기존처럼 새 배정만 멈춘다. drive가 실행을 따라가는 동안 다른 터미널에서 `mission stop`·`mission relay`·`mission escalations`를 부를 수 있다 — 같은 DB의 쓰기는 잠금이 풀릴 때까지 최대 5초 기다린다.

## 위임 판단

drive는 code-agent 통신 계약 호스트에서 판단기(`--provider`)가 있으면, 판단을 기다리는 시도(`waiting-decision`, 반영 동의는 `verified`)의 확인 요청·업무 질문을 먼저 위임 판단으로 처리한다. 업무 질문의 판단 자료에는 그 질문과 배정·목표에 더해 같은 작업에서 이미 답한 질문(답과 출처 — 사람 답인지 위임 판단인지)이 실린다. 뒤 질문은 앞 답을 전제로 묻고(예: 사람 답을 반영하려 앞 단계로 되감을지), 판단기는 사람이 정한 답을 뒤집거나 넓히지 않는다. 요청에서 both를 고르면 판단기는 주 host가 만든 판단을 다른 host가 검토하는 교차 판단기다. 검토가 반려하면 보내지 않고 검토 지적을 사유로 사람에게 넘긴다(`mission escalations`).

| 분류 | 처리 |
| --- | --- |
| routine | 배정된 목표·완료 조건·허용 범위 안에서 근거로 바로 판단할 수 있다 — 승인 또는 답을 보낸다 |
| ambiguous | 근거가 부족하거나 해석이 둘 이상이다 — 수정 요청(재검토)만 보내고, 그 밖은 "추가 정보 필요"로 사람에게 넘긴다 |
| critical | 범위·정책·보안·데이터·외부 영향·되돌리기 어려운 변경·완료 조건 완화 — 보내지 않고 사람에게 넘긴다 |

- 판단(분류·결론·이유·근거·입력 해시·권한 ID)을 master 기록(`decision` actor `ai-delegate`, `delegation` state `recorded`)에 먼저 남긴 뒤 보낸다. 판단 ID가 commandId(`dec-…`·`ans-…`)라 보내기 전후에 끊겨도 한 번만 적용된다.
- 보내지 않고 사람에게 넘기는 경우(`escalation`): 사람만 하는 동작, master 실행이 준비하지 않은 확인 요청, 판단기 없음, 맞는 권한 없음, 판단 실패, critical, 승인을 내린 ambiguous. 사람에게 넘긴 대상은 사람이 닫을 때까지 다시 판단하지 않는다. 사람이 code-agent에서 직접 처리하면 다음 판단 때 관찰로 닫는다.
- 반영(deliver) 확인은 master의 독립 검증(`verified`)이 끝난 시도에서만 판단한다. 반영 확인의 문서 변경 후보(지식 문서 갱신)는 위임 판단이 적용하지 않는다 — 모두 유지로 보내고 판단기에도 그렇게 알린다. 갱신은 사람이 따로 정한다.
- 보낸 판단이 모두 적용·수정 요청·답으로 끝나고 사람에게 넘긴 것이 없으면 그 회차에 한해 같은 세션을 자동으로 이어 간다(`delegatedTurnId`). 수정 요청을 보낸 회차는 code-agent가 다시 받을 확인 요청을 사람 몫(`needs-human`·`reapproval-required`의 요구 확정·계획·반영 확인)으로 보여도 같은 세션이 고쳐 다시 준비한다 — 이어 가는 프롬프트에 수정 지시 전문을 넣고, 다시 준비한 확인 요청은 다시 판단한다. 사람이 직접 응답한 회차는 기존 조건(요구 확정·계획 승인)으로만 자동 계속한다.
- code-agent는 권한 범위·준비 세션·보여 준 내용의 해시·상태 버전·중복 사용·회수를 다시 검사하고, 사람의 응답과 같은 적용 함수로 적용하되 원장·동의·영수증에 `master-delegation`(사람 응답 아님)으로 남긴다.
- `mission escalations`는 사람에게 넘긴 판단과 보낸 위임 판단을 보여 준다. 사람에게 넘긴 업무 질문의 사람 답은 `mission relay`로 전달할 수 있다(code-agent가 '관찰되지 않은 사람 답'으로 구분해 남긴다). 확인 요청(동의)은 사람이 code-agent 세션이나 TTY에서 직접 응답한다.

## 검증·인계에서 달라지는 점

- `exports[].documentPath`를 지정한 작업은 구현과 계약 문서를 함께 반영한다. master가 문서·검사·커밋을 대조한 뒤 후속 호스트에 `dependencyContracts`를 전달하고, 호스트는 첫 planning 담당 배정 전에 `code-agent planning contracts <파일>`로 등록한다. code-agent의 검증된 사본이 담당 입력과 입력 해시에 포함된다. 형식·한도·호환 조건은 [검증 계약](live-verification.md)을 따른다.
- 검증 계약의 `codeAgentRecords: true`는 그 작업의 code-agent 기록(`doc/work/<작업ID>/`, `.code-agent/work/<작업ID>/`, `.code-agent/approvals/<작업ID>/`)을 변경 범위로 허용한다. 제품 파일·다른 작업의 기록은 여기에 들지 않는다.
- 독립 검증은 code-agent 작업이 반영 단계에 닿은 뒤에만 한다(반영 동의를 아직 준비하지 않았거나, 반영 동의 하나가 응답을 기다리는 자리). code-agent의 check·test가 통과했어도 리뷰·통합 검증이 남아 있으면 같은 세션을 먼저 이어 간다. 반영 동의는 그 검증이 끝난 뒤에만 판단한다.
- 검증 뒤 code-agent 작업이 반영 단계를 떠나거나(되감기) 반영 확인이 위임 수정 요청을 받으면 그 검증으로 인계하지 않는다. 같은 세션을 이어 가고 반영 단계에서 다시 검증한다 — 인계 증거는 다시 한 검증에 결합한다. 이 계속 실행은 통신 계약 호스트에만 있다.
- 반영 영수증은 사람이 고른 응답(observed) 또는 위임 영수증이어야 한다. 위임 영수증은 `master-delegation` 통로이고, 이 시도의 deliver 위임 기록(승인·적용 완료)과 판단 ID·확인 요청 ID·작업 ID가 같아야 하며, 사람 응답이 섞이지 않아야 한다.
- 반영 뒤 남은 지난 작업의 임대(`other-work`)는 인계를 막지 않는다 — code-agent도 다음 진행 명령에서 넘겨받는 기록이다.

## 제어권 인계

`project handover`는 지금 소유자만 보낸다. code-agent가 실행을 협력 정지로 멈추고 끝난 것을 확인한 뒤 세대를 올려 넘기며, 그 세션의 작업 임대를 푼다. heartbeat 만료나 오래된 임대만으로 넘기지 않는다. 넘어가면 이 연결은 소유자가 아니고 이전 세대의 상태 변경 요청은 `control-fenced`로 거부된다. 새 제어자는 `project accept`로 새 세대를 인수한 뒤 연결을 다시 맺는다 — 인수 전에는 새 제어자의 실행·판단도 받지 않는다. 인계 도중 끊기면 code-agent가 기록한 단계부터 이어 간다.

## 시험

- 모의 시험(`tests/control.test.mjs`): code-agent 통신 계약을 흉내 낸 전송과 가짜 판단기로 두 프로젝트의 위임 → 독립 검증 → 위임 반영 → 인계 → 통합 완료, 판단 기록 선행, critical·ambiguous·권한 없음·준비하지 않은 동의의 사람 이관, 검증 전 반영 판단 금지, 위임 영수증 결합, 재부착, commandId 충돌·이벤트 재동기화, 정지 대상 제한, 독립 프로젝트 진행과 의존 작업 대기, 반영 단계에서만 하는 독립 검증과 반영 단계를 떠난 검증된 시도의 계속 실행, 위임 수정 요청 뒤 같은 세션의 재준비, 이어 실행 접수 거부의 막힘 기록, 반영 확인 수정 요청 뒤 재준비와 재검증, 선행 증거 요약 프롬프트, 업무 질문 판단 자료의 앞선 답을 본다.
- 페어링 시험(`tests/pairing.test.mjs`): 계약을 흉내 낸 시험 대역(`tests/pairing-fake-cli.mjs`)과 임시 Ed25519 키로 연결 상태 분류, 확인 내용 해시 대조, 서명 검증·일회성 challenge, 토큰 파일 경로만 저장, 만료 임박 갱신(rotated), 다른 소유자·사용 중 프로젝트 거부, 응답 유실 뒤 같은 commandId 정산, 저장소 안 토큰 파일 거부, HTTP 확인 체크·화면 토큰을 본다. 실제 빌드와의 호환은 아래 연동 시험의 페어링 항목이 본다(빌드에 페어링이 없으면 건너뛴다).
- 실제 code-agent CLI 연동 시험(`tests/code-agent-control.test.mjs`): 빌드된 code-agent(`CODE_AGENT_DIST` 또는 옆 저장소)와 가짜 호스트로 연결·원자적 접수·중복 거부·이벤트 커서·결과·재부착·정지·제어권 인계와 이전 소유자 거부를 본다. 시험 프로젝트에는 `init`으로 Claude 실행 절차·hook을 설치한다(관리 실행 설치 검사). 페어링 항목은 시험 폴더의 `CODE_AGENT_HOME`에서 PC 신뢰 → 확인한 연결 → 인증된 heartbeat·사람 채널 키 탐색을 본다. code-agent 빌드가 없으면 건너뛴다.
- 실제 AI 전체 사이클과 앞선 답 판단의 최신 결과·실패 이력·미검증 범위는 [검증 기록](verification.md)을 따른다.
