#!/usr/bin/env node
import { runCommand } from '../../packages/orchestrator/operation-graph.mjs';
import { graphStatus } from '../../packages/orchestrator/graph-runtime.mjs';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from '../../packages/storage/store.mjs';
import { Engine } from '../../packages/orchestrator/engine.mjs';
import { SimulationRunner } from '../../packages/runner/simulation.mjs';
import { runDemo } from '../../packages/runner/demo.mjs';
import { observeProject } from '../../packages/code-agent-adapter/observe.mjs';
import { requireThat } from '../../packages/domain/contracts.mjs';
import { Knowledge } from '../../packages/knowledge/sources.mjs';
import { Planner } from '../../packages/reasoning/planner.mjs';
import { CliProvider } from '../../packages/reasoning/cli-provider.mjs';
import { ClaudeHost } from '../../packages/runner/claude-host.mjs';
import { LiveExecution } from '../../packages/orchestrator/live.mjs';
import { LiveVerification } from '../../packages/verification/live-verification.mjs';
import { LiveWorkflow } from '../../packages/orchestrator/drive.mjs';
import { Recovery } from '../../packages/orchestrator/recovery.mjs';
import { Replanning } from '../../packages/orchestrator/replan.mjs';
import { Reconciliation } from '../../packages/orchestrator/reconcile.mjs';
import { stopAnalysis } from '../../packages/orchestrator/analysis-control.mjs';
import { VerificationTemplates } from '../../packages/verification/templates.mjs';
import { ControlHost, bindControl, requestControlHandover, acceptControl } from '../../packages/runner/control-host.mjs';
import { DecisionDelegation } from '../../packages/orchestrator/decisions.mjs';
import { findCodeAgent } from '../../packages/code-agent-adapter/discovery.mjs';
import { acceptRequest, launchRequest, runRequest, continueRequest, requestStatus } from '../../packages/orchestrator/requests.mjs';

const help = `master-agent — 근거 수집·AI 계획 생성·개발 호스트 배정

모든 명령: --db <파일> (기본 .master-agent/master.db)
code-agent는 설치된 명령에서 자동 탐색합니다. --cli는 별도 빌드 지정용입니다.
  dashboard [--port 4310] [--cli <code-agent경로>] [--refresh-ms 5000]
                                      등록 프로젝트·목표의 로컬 관제·그룹·요청 화면; 설치된 code-agent 자동 탐색
  dashboard restart                   같은 DB의 서버를 종료하고 이전 포트·조회 설정으로 다시 실행
  dashboard status                    같은 DB의 대시보드 실행 상태·URL 조회
  dashboard stop                      대시보드만 종료 (접수한 개발 요청은 유지)
  demo                                세 프로젝트 고정 계획 모의 실행
  project add <JSON>                   프로젝트 도메인·근거·경로 등록
  project list                        프로젝트·잠금·마지막 관측 조회
  project update <ID> <JSON> --revision <N>  도메인·구현 범위·현재 계획 갱신
  project observe <ID> [--cli <절대경로>] code-agent status --json 읽기 전용 조회
  project collect <ID> <목록JSON> --revision <N>  지정 문서·코드의 근거 스냅샷 수집
  project sources <ID>                현재 근거 출처·해시·경로 조회
  project search <ID> <검색어>         근거에서 문장과 줄 번호 검색
  project control <ID> [--cli <경로>] --controller <이름> --token-file <절대경로>
                                      사람이 켠 code-agent 연동에 제어자로 연결(연결은 승인 권한이 아님)
  project snapshot <ID> [--cli <경로>]    code-agent 실행·소유·이벤트 위치·상태 한 번에 조회
  project handover <ID> [--cli <경로>] --to <제어자> [--wait-ms <N>]  실행 정지 확인 후 제어권 이전
  project accept <ID> [--cli <경로>] --controller <이름> --token-file <절대경로>  넘어온 제어권 인수
  group save <JSON> [--revision <N>]   그룹 생성 또는 기대 버전으로 수정
  group list                          그룹 목록
  group create <ID> <이름> [--description <서비스범위>]  빈 프로젝트 그룹 생성
  group show <ID>                      그룹 구성·버전 조회
  group add <ID> <프로젝트ID> --revision <N>    그룹에 프로젝트 추가
  group remove <ID> <프로젝트ID> --revision <N> 그룹에서 프로젝트 제외
  group request <ID> <요청내용> [--task-number <TASK번호>] [--criterion <완료조건>] [--input <JSON>] 그룹 요청·실행
  project request <ID> <요청내용> [--task-number <TASK번호>] [--criterion <완료조건>] [--input <JSON>] 단일 요청·실행
  request list                        접수한 요청·실행 상태 조회
  request show <ID>                    요청 상태·대기·실패 사유 조회
  request continue <ID> --revision <N> 설정·응답 보완 후 기존 목표 이어 실행
  mission create <JSON>                목표 접수 (mode: live|simulation)
  mission list                        목표 목록
  mission graph <ID>                   LangGraph checkpoint and last execution
  mission show <ID>                    계획·판단·상태·증거·이벤트
  mission progress <ID>                작업별 실행·승인 처리·사람 답·장애와 마지막 진척
  mission plan <ID> <JSON> --revision <N>  검증 후 계획 활성화
  mission analyze <ID> --revision <N> --provider codex|claude [--ai-cli <절대경로>] [--model <모델>]
                                      AI 분석·자동 재검토·계획 검증과 활성화
  mission clarify <ID> <응답JSON> --revision <N> [--provider codex|claude]
                                      현재 질문 응답; provider 지정 시 바로 재분석
  mission step <ID> --simulate         준비된 작업 하나 모의 실행
  mission run <ID> --simulate          진행 가능한 작업 모의 실행
  mission dispatch <ID> <작업ID> --revision <N> --expect-state <버전> [--cli <code-agent경로>] [--host-cli <Claude경로>] [--work <기존작업ID>]
                                      live 목표의 작업을 Claude 호스트에 배정
  mission continue <ID> <시도ID> --revision <N> --expect-state <버전> [--cli <code-agent경로>] [--host-cli <Claude경로>]
                                      종료가 관측된 기존 호스트 작업 계속
  mission verification-template <ID> <템플릿JSON> --revision <N>  지정 범위의 검증 계약 자동 연결·재사용 허용
  mission verification <ID> <계약JSON> --revision <N>  배정 전 파일 범위·검증 명령·산출물 연결 등록
  mission verify <ID> <시도ID> --revision <N> --expect-state <버전> [--cli <code-agent경로>]
                                      독립 검증 명령 실행·증거 저장
  mission handoff <ID> <시도ID> --revision <N> --expect-state <버전> [--cli <code-agent경로>]
                                      검증된 산출물·외부 작업 종료 확인 후 잠금 해제
  mission complete <ID> --revision <N> 모든 live 작업·조건·최신 증거 대조 후 완료
  mission stop-analysis <ID> <분석ID> --revision <N>  읽기 전용 분석 결과 적용 취소·재분석 준비
  mission reconcile-verification <ID> <시도ID> --revision <N> --expect-state <버전> [--cli <경로>]
                                      모든 검증 명령 반환·입력 대조 후 새 검증 단계로 복구
  mission reconcile <ID> <시도ID> --revision <N> --expect-state <버전> [--cli <경로>]
                                      영속 호스트 반환·현재 상태 대조 후 재실행 없이 독립 검증으로 복구
  mission replan <ID> <시도ID> --revision <N> --expect-state <버전> [--cli <경로>] [--provider codex|claude]
                                      외부 작업 종료 확인·변경 보존·잠금 정리·근거 재수집 후 재계획
  mission recover <ID> <시도ID> --revision <N> --expect-state <버전> [--cli <경로>] --provider codex|claude [--context <추가근거>]
                                      실패 분석·재검토·범위 내 복구 판단 후 실행
  mission advance <ID> [--cli <code-agent경로>] [--provider codex|claude]  가능한 live 단계 자동 판단; provider 지정 시 실패 복구
  mission drive <ID> [--cli <code-agent경로>]    가능한 live 작업을 진행하고 승인·실패 경계에서 대기
  mission reattach <ID> <시도ID> [--cli <경로>]  재시작 뒤 같은 호출의 실행에 다시 붙어 결과 기록(재실행 없음)
  mission stop <ID> <시도ID> [--cli <경로>] --mode pause|cancel [--force] [--wait-ms <N>]
                                      시도의 실행만 정지·취소 요청(정지 확인은 결과·이벤트로)
  mission delegate <ID> <시도ID> [--cli <경로>] --provider codex|claude  기다리는 동의·질문 위임 판단 1회
  mission escalations <ID>             사람에게 넘긴 판단·보낸 위임 판단 기록
  mission relay <ID> <시도ID> <답JSON> [--cli <경로>]  사람에게 넘긴 질문의 사람 답 전달
  mission pause <ID> --revision <N>    새 배정 일시 정지
  mission resume <ID> --revision <N>   배정 재개
  mission retry <ID> <작업ID> --revision <N>  실패한 모의 작업 재시도 준비
  mission unknown <ID> <시도ID> --revision <N>  관측 불가 기록·잠금 유지

--control: dispatch·continue·verify·handoff·reconcile·replan·recover·advance·drive 를 code-agent 통신 계약(원자적 접수·이벤트·정지·위임 판단)으로
           실행합니다. project control 연결이 필요하고 reattach·stop·delegate·relay 는 항상 이 경로입니다. --poll-ms·--follow-timeout-ms 로 주기를 정합니다.
JSON은 UTF-8입니다. live 호스트 종료는 작업 완료가 아닙니다. 사람 질문·승인은 대시보드 공통 요청함(별도 사람 채널 연결 필요) 또는 원래 code-agent 호스트에서 처리합니다.
위임 판단은 사람이 code-agent 에서 준 권한(grant) 범위의 routine 판단만 보내고, 나머지는 사람에게 넘깁니다.
모의 실행은 실제 프로젝트를 수정하지 않으며 simulation-complete로 종료합니다.`;

function json(path) { return JSON.parse(readFileSync(resolve(path), 'utf8').replace(/^\uFEFF/, '')); }
function summary(m) { return { id: m.id, goal: m.goal, mode: m.mode, state: m.state, revision: m.revision, reason: m.reason, tasks: m.tasks }; }

async function main() {
  const { values, positionals: args } = parseArgs({ allowPositionals: true, strict: true, options: {
    db: { type: 'string' }, cli: { type: 'string' }, revision: { type: 'string' }, simulate: { type: 'boolean' }, help: { type: 'boolean' },
    provider: { type: 'string' }, 'ai-cli': { type: 'string' }, model: { type: 'string' }, context: { type: 'string' },
    'host-cli': { type: 'string' }, 'expect-state': { type: 'string' }, work: { type: 'string' },
    control: { type: 'boolean' }, controller: { type: 'string' }, 'token-file': { type: 'string' }, to: { type: 'string' }, mode: { type: 'string' },
    force: { type: 'boolean' }, 'wait-ms': { type: 'string' }, 'poll-ms': { type: 'string' }, 'follow-timeout-ms': { type: 'string' },
    port: { type: 'string' }, 'refresh-ms': { type: 'string' },
    saved: { type: 'boolean' }, description: { type: 'string' }, input: { type: 'string' },
    criterion: { type: 'string', multiple: true }, 'request-key': { type: 'string' }, 'task-number': { type: 'string' },
  } });
  if (values.help || !args.length || args[0] === 'help') { console.log(help); return; }
  if (args[0] === 'dashboard') {
    requireThat(args.length <= 2, 'usage', help);
    const { dashboardCommand } = await import('../../packages/dashboard/lifecycle.mjs');
    const dashboard = await dashboardCommand(args[1] ?? 'start', { dbPath: resolve(values.db ?? '.master-agent/master.db'), cliPath: values.cli,
      observe: values.saved === undefined ? undefined : !values.saved,
      port: values.port === undefined ? undefined : Number(values.port), intervalMs: values['refresh-ms'] === undefined ? undefined : Number(values['refresh-ms']) });
    console.log(JSON.stringify(dashboard.info));
    if (dashboard.close) {
      const stop = () => { dashboard.close().catch(error => { console.error(error.message); process.exitCode = 1; }); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    }
    return;
  }
  const [category, action, id, file, extra] = args;
  const counts = { demo: 1, 'project add': 3, 'project update': 4, 'project list': 2, 'project observe': 3, 'group save': 3, 'group list': 2,
    'project collect': 4, 'project sources': 3, 'project search': 4, 'mission analyze': 3, 'mission clarify': 4,
    'mission dispatch': 4, 'mission continue': 4, 'mission recover': 4, 'mission replan': 4, 'mission reconcile': 4,
    'mission stop-analysis': 4, 'mission reconcile-verification': 4, 'mission verification-template': 4,
    'mission verification': 4, 'mission verify': 4, 'mission handoff': 4, 'mission complete': 3,
    'mission advance': 3, 'mission drive': 3, 'mission progress': 3,
    'project control': 3, 'project snapshot': 3, 'project handover': 3, 'project accept': 3,
    'mission reattach': 4, 'mission stop': 4, 'mission delegate': 4, 'mission escalations': 3, 'mission relay': 5,
    'mission create': 3, 'mission list': 2, 'mission show': 3, 'mission graph': 3, 'mission plan': 4, 'mission step': 3, 'mission run': 3,
    'mission pause': 3, 'mission resume': 3, 'mission retry': 4, 'mission unknown': 4,
    'group create': 4, 'group show': 3, 'group add': 4, 'group remove': 4, 'group request': 4, 'project request': 4,
    'request list': 2, 'request show': 3, 'request run': 3, 'request continue': 3 };
  const key = category === 'demo' ? 'demo' : `${category} ${action}`;
  requireThat(counts[key] === args.length, 'usage', help);
  const revision = values.revision === undefined ? undefined : Number(values.revision);
  if (values.revision !== undefined) requireThat(Number.isSafeInteger(revision) && revision > 0, 'usage', '--revision은 양의 정수입니다.');
  if (['project update', 'project collect', 'mission analyze', 'mission clarify', 'mission plan', 'mission pause', 'mission resume', 'mission retry', 'mission unknown', 'mission dispatch', 'mission continue', 'mission verification', 'mission verify', 'mission handoff', 'mission complete'].includes(key)) requireThat(revision, 'usage', '--revision이 필요합니다.');
  if (['mission dispatch', 'mission continue', 'mission verify', 'mission handoff'].includes(key)) requireThat(values['expect-state'] && !values.simulate, 'usage', '--expect-state가 필요합니다. 모의 실행 옵션과 함께 사용할 수 없습니다.');
  if (['mission advance', 'mission drive'].includes(key)) requireThat(!values.simulate, 'usage', '모의 옵션은 사용할 수 없습니다.');
  if (key === 'mission analyze') requireThat(['codex', 'claude'].includes(values.provider), 'usage', '--provider codex 또는 claude가 필요합니다.');
  if (key === 'mission recover') requireThat(revision && values['expect-state'] && ['codex', 'claude'].includes(values.provider) && !values.simulate, 'usage', '--revision, --expect-state, --provider가 필요합니다.');
  if (['mission replan', 'mission reconcile', 'mission reconcile-verification'].includes(key)) requireThat(revision && values['expect-state'] && !values.simulate, 'usage', '--revision, --expect-state가 필요합니다.');
  if (key === 'mission stop-analysis') requireThat(revision && !values.simulate, 'usage', '--revision이 필요합니다.');
  if (['project control', 'project snapshot', 'project handover', 'project accept', 'mission reattach', 'mission stop', 'mission delegate', 'mission relay', 'group request', 'project request'].includes(key)) requireThat(!values.simulate, 'usage', '모의 옵션은 사용할 수 없습니다.');
  if (['group add', 'group remove', 'request continue'].includes(key)) requireThat(revision, 'usage', '--revision이 필요합니다.');
  if (['project control', 'project accept'].includes(key)) requireThat(values.controller && values['token-file'], 'usage', '--controller와 --token-file이 필요합니다.');
  if (key === 'project handover') requireThat(values.to, 'usage', '--to가 필요합니다.');
  if (key === 'mission stop') requireThat(['pause', 'cancel'].includes(values.mode), 'usage', '--mode pause 또는 cancel이 필요합니다.');
  if (key === 'mission delegate') requireThat(['codex', 'claude'].includes(values.provider), 'usage', '--provider codex 또는 claude가 필요합니다.');
  const ms = (name, fallback) => {
    if (values[name] === undefined) return fallback;
    const value = Number(values[name]);
    requireThat(Number.isSafeInteger(value) && value >= 0, 'usage', `--${name}은 0 이상의 정수입니다.`);
    return value;
  };
  if (key === 'mission verification-template') requireThat(revision, 'usage', '--revision이 필요합니다.');
  if (key === 'mission step' || key === 'mission run') requireThat(values.simulate, 'usage', '모의 실행은 --simulate로 명시해야 합니다. 실제 호스트 배정은 mission dispatch를 사용하세요.');
  if (['project observe', 'project control', 'project snapshot', 'project handover', 'project accept',
    ...['dispatch', 'continue', 'verify', 'handoff', 'recover', 'replan', 'reconcile', 'reconcile-verification', 'advance', 'drive', 'reattach', 'stop', 'delegate', 'relay'].map(a => `mission ${a}`)].includes(key)) values.cli = findCodeAgent(values.cli);
  const dbPath = resolve(values.db ?? '.master-agent/master.db');
  const store = new Store(dbPath); const engine = new Engine(store);
  const controlHost = () => new ControlHost(store, { cliPath: values.cli, model: values.model, pollMs: ms('poll-ms', 2000), followTimeoutMs: ms('follow-timeout-ms', 4 * 3600 * 1000) });
  // --control 이면 code-agent 통신 계약 호스트, 아니면 기존 직접 실행 호스트 — 기존 명령의 동작은 바꾸지 않는다
  const liveHost = options => values.control ? controlHost() : new ClaudeHost({ cliPath: values.cli, hostPath: values['host-cli'], ...options });
  try {
    const execute = async () => {
    let result;
    switch (key) {
      case 'demo': result = summary(await runDemo(engine, resolve('.master-agent/demo-projects'))); break;
      case 'project add': result = engine.catalog.register(json(id)); break;
      case 'project list': result = engine.catalog.status(); break;
      case 'project update': result = engine.catalog.updateKnowledge(id, json(file), revision); break;
      case 'project observe': result = await observeProject(store, id, { cliPath: values.cli }); break;
      case 'project collect': {
        const collected = new Knowledge(store).collect(id, json(file), revision);
        result = { project: collected.project, snapshotId: collected.snapshot.id, changed: collected.changed, sources: collected.snapshot.sources.map(({ content, actual, ...source }) => source) }; break;
      }
      case 'project sources': {
        const snapshot = new Knowledge(store).current(id);
        result = { id: snapshot.id, projectId: id, collectedAt: snapshot.collectedAt, sources: snapshot.sources.map(({ content, actual, ...source }) => source) }; break;
      }
      case 'project search': result = new Knowledge(store).search(id, file); break;
      case 'project control': result = await bindControl(store, id, { cliPath: values.cli, controller: values.controller, tokenFile: resolve(values['token-file']) }); break;
      case 'project snapshot': result = await controlHost().client(store.need('project', id)).result('snapshot'); break;
      case 'project handover': result = await requestControlHandover(store, id, { cliPath: values.cli, to: values.to, commandId: `ho-${randomUUID()}`, waitMs: ms('wait-ms', 0), pollMs: ms('poll-ms', 2000) }); break;
      case 'project accept': result = await acceptControl(store, id, { cliPath: values.cli, controller: values.controller, tokenFile: resolve(values['token-file']) }); break;
      case 'group save': result = engine.catalog.group(json(id), revision ?? 0); break;
      case 'group list': result = store.list('group'); break;
      case 'group create': result = engine.catalog.group({ id, name: file, description: values.description ?? '', projectIds: [] }); break;
      case 'group show': result = store.need('group', id); break;
      case 'group add': case 'group remove': result = engine.catalog.membership(id, file, action, revision); break;
      case 'group request': case 'project request': {
        const input = values.input ? json(values.input) : {};
        const accepted = acceptRequest(store, { ...input, targetType: category, targetId: id, goal: file,
          ...(values['task-number'] === undefined ? {} : { taskNumber: values['task-number'] }),
          ...(values.criterion ? { criteria: values.criterion.map((description, i) => ({ id: `criterion-${i + 1}`, description })) } : {}),
          ...(values.provider ? { provider: values.provider } : {}), ...(values.model ? { model: values.model } : {}),
          ...(values['request-key'] ? { requestKey: values['request-key'] } : {}), ...(revision ? { groupRevision: revision } : {}) });
        result = accepted.created ? await launchRequest(store, accepted.request.id, { dbPath, cliPath: values.cli }) : accepted.request;
        break;
      }
      case 'request list': result = store.list('target-request').map(requestStatus); break;
      case 'request show': result = requestStatus(store.need('target-request', id)); break;
      case 'request run': result = await runRequest(store, id, { cliPath: values.cli }); if (result.state === 'failed') process.exitCode = 1; break;
      case 'request continue': continueRequest(store, id, revision); result = await launchRequest(store, id, { dbPath, cliPath: values.cli }); break;
      case 'mission create': result = engine.create(json(id)); break;
      case 'mission list': result = store.list('mission').map(summary); break;
      case 'mission graph': result = await graphStatus(store, store.need('mission', id).mode === 'live' ? 'mission' : 'simulation', id); break;
      case 'mission show': result = engine.describe(id); break;
      case 'mission progress': { const m = engine.describe(id); result = { id: m.id, state: m.state, ...m.progress }; break; }
      case 'mission plan': result = engine.plan(id, json(file), revision); break;
      case 'mission analyze': {
        const provider = new CliProvider({ provider: values.provider, cliPath: values['ai-cli'], model: values.model });
        const analyzed = await new Planner(store).analyze(id, provider, { expectedRevision: revision });
        result = analyzed.mission; break;
      }
      case 'mission clarify': {
        const planner = new Planner(store);
        const provider = values.provider ? new CliProvider({ provider: values.provider, cliPath: values['ai-cli'], model: values.model }) : undefined;
        result = planner.clarify(id, json(file), revision);
        if (provider) result = (await planner.analyze(id, provider, { expectedRevision: result.revision })).mission;
        break;
      }
      case 'mission step': result = await engine.step(id, new SimulationRunner()); break;
      case 'mission run': result = await engine.run(id, new SimulationRunner()); break;
      case 'mission dispatch': case 'mission continue': {
        const host = liveHost({ model: values.model });
        const live = new LiveExecution(store);
        result = await live[action](id, file, host, { expectedRevision: revision, expectedState: values['expect-state'], workId: values.work });
        break;
      }
      case 'mission stop-analysis': result = stopAnalysis(store, id, file, revision); break;
      case 'mission reconcile': case 'mission reconcile-verification': {
        const host = liveHost({});
        result = await new Reconciliation(store)[action === 'reconcile' ? 'reconcile' : 'verification'](id, file, host, { expectedRevision: revision, expectedState: values['expect-state'] }); break;
      }
      case 'mission replan': {
        const host = liveHost({});
        const provider = values.provider ? new CliProvider({ provider: values.provider, cliPath: values['ai-cli'], model: values.model }) : undefined;
        result = await new Replanning(store).transition(id, file, host, provider, { expectedRevision: revision, expectedState: values['expect-state'] }); break;
      }
      case 'mission recover': {
        const host = liveHost({ model: values.model });
        const provider = new CliProvider({ provider: values.provider, cliPath: values['ai-cli'], model: values.model });
        result = await new Recovery(store).recover(id, file, host, provider, { expectedRevision: revision, expectedState: values['expect-state'], context: values.context }); break;
      }
      case 'mission verification-template': result = new VerificationTemplates(store).register(id, json(file), revision); break;
      case 'mission verification': result = new LiveVerification(store).configure(id, json(file), revision); break;
      case 'mission verify': case 'mission handoff': {
        const host = liveHost({});
        result = await new LiveVerification(store)[action](id, file, host, { expectedRevision: revision, expectedState: values['expect-state'] }); break;
      }
      case 'mission complete': result = new LiveVerification(store).complete(id, revision); break;
      case 'mission advance': case 'mission drive': {
        const host = liveHost({ model: values.model });
        const workflow = new LiveWorkflow(store);
        const provider = values.provider ? new CliProvider({ provider: values.provider, cliPath: values['ai-cli'], model: values.model }) : undefined;
        result = await workflow[action === 'drive' ? 'run' : 'advance'](id, host, provider); break;
      }
      case 'mission reattach': result = await new LiveExecution(store).reattach(id, file, controlHost()); break;
      case 'mission stop': result = await controlHost().stopAttempt(id, file, values.mode, { force: values.force === true, waitMs: ms('wait-ms', 0) }); break;
      case 'mission delegate': {
        const provider = new CliProvider({ provider: values.provider, cliPath: values['ai-cli'], model: values.model });
        result = await new DecisionDelegation(store).resolve(id, file, controlHost(), provider); break;
      }
      case 'mission escalations': { const d = new DecisionDelegation(store); result = { escalations: d.escalations(id), delegations: d.delegations(id) }; break; }
      case 'mission relay': {
        const input = json(extra);
        result = await new DecisionDelegation(store).relay(id, file, controlHost(), Array.isArray(input) ? { answers: input } : input); break;
      }
      case 'mission pause': case 'mission resume': case 'mission retry': result = engine.control(id, action, revision, file); break;
      case 'mission unknown': result = engine.markUnknown(id, file, revision); break;
    }
    return result;
    };
    const result = category === 'mission' && !['list', 'show', 'progress', 'graph', 'escalations'].includes(action)
      ? await runCommand(store, id, action, execute) : await execute();
    console.log(JSON.stringify(result, null, 2));
  } finally { store.close(); }
}
main().catch(error => {
  console.error(JSON.stringify({ error: error.code ?? 'internal-error', message: error.message }));
  process.exitCode = 1;
});
