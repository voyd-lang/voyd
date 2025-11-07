import type {
  HirExpression,
  HirFunction,
  HirModule,
  HirNode,
  HirStatement,
} from "./nodes.js";
import type { HirExprId, HirId, HirStmtId } from "../ids.js";

type WithoutId<T extends { id: HirId }> = Omit<T, "id">;

export interface HirGraph {
  module: HirModule;
  functions: readonly HirFunction[];
  statements: ReadonlyMap<HirStmtId, HirStatement>;
  expressions: ReadonlyMap<HirExprId, HirExpression>;
}

export interface HirBuilder {
  readonly module: HirModule;
  addStatement(statement: WithoutId<HirStatement>): HirStmtId;
  addExpression(expression: WithoutId<HirExpression>): HirExprId;
  addFunction(fn: WithoutId<HirFunction>): HirId;
  setModuleBody(body: readonly HirStmtId[]): void;
  getNode(id: HirId): HirNode | undefined;
  finalize(): HirGraph;
}

export const createHirBuilder = (
  init: WithoutId<HirModule> & { body?: readonly HirStmtId[] }
): HirBuilder => {
  let nextId: HirId = 0;

  const expressions = new Map<HirExprId, HirExpression>();
  const statements = new Map<HirStmtId, HirStatement>();
  const functions: HirFunction[] = [];
  const nodes = new Map<HirId, HirNode>();

  const module: HirModule = {
    ...init,
    id: nextId++,
    body: [...(init.body ?? [])],
  };
  nodes.set(module.id, module);

  const cloneNode = <T extends HirNode>(node: T): T => ({ ...node });

  const addStatement = (statement: WithoutId<HirStatement>): HirStmtId => {
    const id = nextId++;
    const node = { ...statement, id } as HirStatement;
    statements.set(id, node);
    nodes.set(id, node);
    return id;
  };

  const addExpression = (
    expression: WithoutId<HirExpression>
  ): HirExprId => {
    const id = nextId++;
    const node = { ...expression, id } as HirExpression;
    expressions.set(id, node);
    nodes.set(id, node);
    return id;
  };

  const addFunction = (fn: WithoutId<HirFunction>): HirId => {
    const id = nextId++;
    const node = { ...fn, id };
    functions.push(node);
    nodes.set(id, node);
    return id;
  };

  const setModuleBody = (body: readonly HirStmtId[]): void => {
    module.body = [...body];
  };

  const getNode = (id: HirId): HirNode | undefined => nodes.get(id);

  const finalize = (): HirGraph => ({
    module: cloneNode(module),
    functions: functions.map(cloneNode),
    statements: new Map(statements),
    expressions: new Map(expressions),
  });

  return {
    module,
    addStatement,
    addExpression,
    addFunction,
    setModuleBody,
    getNode,
    finalize,
  };
};
