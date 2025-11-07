import type {
  HirExpression,
  HirExportEntry,
  HirFunction,
  HirItem,
  HirModule,
  HirNode,
  HirStatement,
} from "./nodes.js";
import type {
  HirExprId,
  HirId,
  HirItemId,
  HirStmtId,
  NodeId,
  SourceSpan,
  SymbolId,
} from "../ids.js";

type WithoutId<T extends { id: HirId }> = Omit<T, "id">;

export interface HirGraph {
  module: HirModule;
  items: ReadonlyMap<HirItemId, HirItem>;
  statements: ReadonlyMap<HirStmtId, HirStatement>;
  expressions: ReadonlyMap<HirExprId, HirExpression>;
}

interface HirBuilderInit {
  path: string;
  scope: SymbolId;
  ast: NodeId;
  span: SourceSpan;
  items?: readonly HirItemId[];
  exports?: readonly HirExportEntry[];
}

export interface HirBuilder {
  readonly module: HirModule;
  addStatement(statement: WithoutId<HirStatement>): HirStmtId;
  addExpression(expression: WithoutId<HirExpression>): HirExprId;
  addItem(
    item: WithoutId<HirItem>,
    options?: { moduleScoped?: boolean }
  ): HirItemId;
  addFunction(
    fn: WithoutId<HirFunction>,
    options?: { moduleScoped?: boolean }
  ): HirItemId;
  recordExport(entry: Omit<HirExportEntry, "item"> & { item: HirItemId }): void;
  setModuleItems(items: readonly HirItemId[]): void;
  getNode(id: HirId): HirNode | undefined;
  finalize(): HirGraph;
}

export const createHirBuilder = (
  init: HirBuilderInit
): HirBuilder => {
  let nextId: HirId = 0;

  const expressions = new Map<HirExprId, HirExpression>();
  const statements = new Map<HirStmtId, HirStatement>();
  const items = new Map<HirItemId, HirItem>();
  const nodes = new Map<HirId, HirNode>();

  const module: HirModule = {
    kind: "module",
    id: nextId++,
    path: init.path,
    scope: init.scope,
    ast: init.ast,
    span: init.span,
    items: [...(init.items ?? [])],
    exports: [...(init.exports ?? [])],
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

  const pushModuleItem = (id: HirItemId): void => {
    module.items = [...module.items, id];
  };

  const addItem = (
    item: WithoutId<HirItem>,
    options: { moduleScoped?: boolean } = {}
  ): HirItemId => {
    const id = nextId++;
    const node = { ...item, id } as HirItem;
    items.set(id, node);
    nodes.set(id, node);
    if (options.moduleScoped !== false) {
      pushModuleItem(id);
    }
    return id;
  };

  const addFunction = (
    fn: WithoutId<HirFunction>,
    options?: { moduleScoped?: boolean }
  ): HirItemId => addItem(fn, options);

  const recordExport = (
    entry: Omit<HirExportEntry, "item"> & { item: HirItemId }
  ): void => {
    module.exports = [
      ...module.exports,
      { ...entry, item: entry.item },
    ];
  };

  const setModuleItems = (nextItems: readonly HirItemId[]): void => {
    module.items = [...nextItems];
  };

  const getNode = (id: HirId): HirNode | undefined => nodes.get(id);

  const finalize = (): HirGraph => ({
    module: cloneNode(module),
    items: new Map(items),
    statements: new Map(statements),
    expressions: new Map(expressions),
  });

  return {
    module,
    addStatement,
    addExpression,
    addFunction,
    addItem,
    recordExport,
    setModuleItems,
    getNode,
    finalize,
  };
};
