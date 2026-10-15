import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import { checkpointer, invokeGraph } from './graph-runtime.mjs';

/** Each command has a named graph entry; longer services expose their own graphs. */
export async function runCommand(store, missionId, command, execute) {
  const State = Annotation.Root({ result: Annotation() });
  const graph = new StateGraph(State)
    .addNode(command, async () => ({ result: await execute() }))
    .addEdge(START, command).addEdge(command, END)
    .compile({ checkpointer: checkpointer(store) });
  const output = await invokeGraph(store, graph, `command-${command}`, `${missionId}:${randomUUID()}`, {});
  return output.result;
}

/** Review callbacks are individual nodes; routing and retry limits belong to LangGraph. */
export async function reviewGraph(store, name, id, { prepare, generate, validate, record, finish, maxPasses }) {
  const State = Annotation.Root({ frame: Annotation(), response: Annotation(), error: Annotation(), pass: Annotation(), result: Annotation(), route: Annotation() });
  const graph = new StateGraph(State)
    .addNode('prepare', async () => ({ frame: await prepare(), pass: 1, response: null, error: null }))
    .addNode('generate', async s => ({ response: await generate(s), error: null }))
    .addNode('validate', async s => ({ error: await validate(s) }))
    .addNode('record-review', async s => {
      const frame = await record(s);
      return { frame, route: frame.ready || s.pass >= maxPasses ? 'finish' : 'next-pass' };
    })
    .addNode('next-pass', s => ({ pass: s.pass + 1 }))
    .addNode('finish', async s => ({ result: await finish(s) }))
    .addEdge(START, 'prepare').addEdge('prepare', 'generate').addEdge('generate', 'validate')
    .addEdge('validate', 'record-review').addConditionalEdges('record-review', s => s.route, ['finish', 'next-pass'])
    .addEdge('next-pass', 'generate').addEdge('finish', END)
    .compile({ checkpointer: checkpointer(store) });
  const result = await invokeGraph(store, graph, name, id, {});
  return result.result;
}

/** Named phases with checkpointed data and explicit conditional transitions. */
export async function phaseGraph(store, name, id, stages) {
  const State = Annotation.Root({ frame: Annotation() });
  const builder = new StateGraph(State);
  for (const stage of stages) builder.addNode(stage.name, async s => ({ frame: { ...s.frame, ...await stage.run(s.frame) } }));
  builder.addEdge(START, stages[0].name);
  stages.forEach((stage, i) => {
    if (stage.next) builder.addConditionalEdges(stage.name, s => stage.next(s.frame), [...stages.map(s => s.name), END]);
    else builder.addEdge(stage.name, stages[i + 1]?.name ?? END);
  });
  const output = await invokeGraph(store, builder.compile({ checkpointer: checkpointer(store) }), name, id, { frame: {} });
  return output.frame.result;
}
