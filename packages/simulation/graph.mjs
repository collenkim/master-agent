import { Annotation, StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { requireThat } from '../domain/contracts.mjs';
import { checkpointer, invokeGraph } from '../orchestrator/graph-runtime.mjs';

const State = Annotation.Root({ missionId: Annotation(), ticket: Annotation(), outcome: Annotation(), result: Annotation(), route: Annotation() });
export async function simulate(engine, id, runner, all) {
  requireThat(runner?.mode === 'simulation' && typeof runner.execute === 'function', 'invalid-runner', 'An explicit simulation runner is required.');
  const store = engine.store;
  const done = (progressed, extra = {}) => ({ result: { progressed, mission: engine.describe(id), ...extra } });
  const builder = new StateGraph(State)
    .addNode('select', () => {
      const m = store.need('mission', id);
      requireThat(m.mode === 'simulation', 'live-runner-unavailable', 'Live missions cannot run in the simulation graph.');
      if (['simulation-complete', 'cancelled'].includes(m.state)) return { ...done(false), route: END };
      if (['paused', 'analyzing', 'waiting-decision'].includes(m.state) || m.planningHold) return { ...done(false), route: 'wait' };
      if (m.tasks.length && m.tasks.every(t => t.state === 'succeeded')) return { route: 'complete' };
      return { route: 'prepare' };
    })
    .addNode('prepare', () => {
      const ticket = engine.prepare(id, store.need('mission', id).revision);
      return ticket ? { ticket, route: 'execute' } : { ...done(false), route: 'wait' };
    })
    .addNode('execute', async s => {
      try { return { outcome: await runner.execute(structuredClone(s.ticket)), route: 'accept' }; }
      catch (error) { engine.markUnknown(id, s.ticket.id, store.need('mission', id).revision); return { ...done(true, { runnerError: error.message }), route: 'after' }; }
    })
    .addNode('accept', s => { engine.accept(s.ticket, s.outcome); return { ...done(true), route: 'after' }; })
    .addNode('complete', () => { engine.complete(id, store.need('mission', id).revision); return { ...done(true), route: END }; })
    .addNode('after', () => ({ route: all ? 'select' : END }))
    .addNode('wait', () => { interrupt({ kind: 'simulation-blocked', missionId: id }); return {}; });
  builder.addEdge(START, 'select');
  const edges = {
    select: [END, 'wait', 'complete', 'prepare'], prepare: ['execute', 'wait'],
    execute: ['accept', 'after'], accept: ['after'], complete: [END], after: ['select', END],
  };
  for (const [node, targets] of Object.entries(edges)) builder.addConditionalEdges(node, s => s.route, targets);
  builder.addEdge('wait', 'select');
  const state = await invokeGraph(store, builder.compile({ checkpointer: checkpointer(store) }), 'simulation', id, { missionId: id }, { resumeWait: true });
  return all ? state.result.mission : state.result;
}
