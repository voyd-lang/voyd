import type {
  CodegenContext,
  HirExprId,
  HirPattern,
  HirStmtId,
  SymbolId,
  TypeId,
} from "../../context.js";
import { effectsFacade } from "../facade.js";

export interface TempCaptureDraft {
  key: string;
  callExprId: HirExprId;
  argIndex: number;
  typeId: TypeId;
}

export interface SiteDraft {
  kind: "perform" | "call";
  exprId: HirExprId;
  liveAfter: ReadonlySet<SymbolId>;
  effectSymbol?: SymbolId;
  tempCaptures?: TempCaptureDraft[];
}

export type LiveResult = {
  live: Set<SymbolId>;
  sites: SiteDraft[];
};

type NodeId = number;

type SiteBase = Omit<SiteDraft, "liveAfter">;

interface CfgNode {
  id: NodeId;
  uses: ReadonlySet<SymbolId>;
  defs: ReadonlySet<SymbolId>;
  succ: NodeId[];
  site?: SiteBase;
  tempCaptures?: TempCaptureDraft[];
}

interface Subgraph {
  entry: NodeId;
  exits: NodeId[];
  siteNodes: NodeId[];
}

interface FlowTargets {
  breakTarget?: NodeId;
  continueTarget?: NodeId;
  returnTarget: NodeId;
}

export const analyzeExpr = ({
  exprId,
  liveAfter,
  ctx,
}: {
  exprId: HirExprId;
  liveAfter: ReadonlySet<SymbolId>;
  ctx: CodegenContext;
}): LiveResult => {
  const { nodes, entry, siteNodeIds } = buildCfg({
    exprId,
    liveAfter,
    ctx,
  });
  const reachable = computeReachable({ nodes, entry });
  const { liveInById, liveOutById } = computeLiveness({ nodes, reachable });

  const sites = siteNodeIds
    .filter((nodeId) => reachable.has(nodeId))
    .map((nodeId) => {
      const node = nodes[nodeId]!;
      const site = node.site;
      if (!site) {
        throw new Error("expected site metadata on site node");
      }
      return {
        ...site,
        liveAfter: new Set(liveOutById.get(nodeId) ?? []),
        tempCaptures: node.tempCaptures ? [...node.tempCaptures] : undefined,
      };
    });

  return {
    live: new Set(liveInById.get(entry) ?? []),
    sites,
  };
};

const setsEqual = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean => {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
};

const unionInto = <T>(into: Set<T>, from: ReadonlySet<T>): void => {
  from.forEach((value) => into.add(value));
};

const union = <T>(...sets: ReadonlySet<T>[]): Set<T> => {
  const merged = new Set<T>();
  sets.forEach((set) => unionInto(merged, set));
  return merged;
};

const callArgTempKey = ({
  callExprId,
  argIndex,
}: {
  callExprId: HirExprId;
  argIndex: number;
}): string => `callArg:${callExprId}:${argIndex}`;

const appendTempCaptures = (
  node: CfgNode,
  captures: readonly TempCaptureDraft[]
): void => {
  if (captures.length === 0) return;

  if (!node.tempCaptures) {
    node.tempCaptures = [...captures];
    return;
  }

  const existing = new Set(node.tempCaptures.map((capture) => capture.key));
  captures.forEach((capture) => {
    if (existing.has(capture.key)) return;
    existing.add(capture.key);
    node.tempCaptures!.push(capture);
  });
};

const collectPatternSymbols = (pattern: HirPattern, into: Set<SymbolId>): void => {
  switch (pattern.kind) {
    case "identifier":
      into.add(pattern.symbol);
      return;
    case "destructure":
      pattern.fields.forEach((field) => collectPatternSymbols(field.pattern, into));
      if (pattern.spread) {
        collectPatternSymbols(pattern.spread, into);
      }
      return;
    case "tuple":
      pattern.elements.forEach((element) => collectPatternSymbols(element, into));
      return;
    case "type":
      if (pattern.binding) {
        collectPatternSymbols(pattern.binding, into);
      }
      return;
    case "wildcard":
      return;
  }
};

const computeReachable = ({
  nodes,
  entry,
}: {
  nodes: readonly CfgNode[];
  entry: NodeId;
}): Set<NodeId> => {
  const reachable = new Set<NodeId>();
  const stack = [entry];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    const node = nodes[current];
    if (!node) continue;
    node.succ.forEach((next) => {
      if (reachable.has(next)) return;
      stack.push(next);
    });
  }

  return reachable;
};

const computeLiveness = ({
  nodes,
  reachable,
}: {
  nodes: readonly CfgNode[];
  reachable: ReadonlySet<NodeId>;
}): {
  liveInById: Map<NodeId, Set<SymbolId>>;
  liveOutById: Map<NodeId, Set<SymbolId>>;
} => {
  const liveInById = new Map<NodeId, Set<SymbolId>>();
  const liveOutById = new Map<NodeId, Set<SymbolId>>();
  const worklist: NodeId[] = [];
  const predecessors = new Map<NodeId, Set<NodeId>>();

  reachable.forEach((nodeId) => {
    worklist.push(nodeId);
    liveInById.set(nodeId, new Set());
    liveOutById.set(nodeId, new Set());
    predecessors.set(nodeId, new Set());
  });

  reachable.forEach((nodeId) => {
    const node = nodes[nodeId];
    if (!node) return;
    node.succ.forEach((succId) => {
      if (!reachable.has(succId)) return;
      const preds = predecessors.get(succId);
      if (!preds) return;
      preds.add(nodeId);
    });
  });

  while (worklist.length > 0) {
    const nodeId = worklist.pop()!;
    const node = nodes[nodeId];
    if (!node) continue;

    const oldIn = liveInById.get(nodeId) ?? new Set();
    const oldOut = liveOutById.get(nodeId) ?? new Set();

    const out = union<SymbolId>(
      ...node.succ
        .filter((succId) => reachable.has(succId))
        .map((succId) => liveInById.get(succId) ?? new Set<SymbolId>())
    );

    const inSet = union<SymbolId>(
      node.uses,
      new Set<SymbolId>([...out].filter((sym) => !node.defs.has(sym)))
    );

    const changed = !setsEqual(oldIn, inSet) || !setsEqual(oldOut, out);
    if (!changed) continue;

    liveInById.set(nodeId, inSet);
    liveOutById.set(nodeId, out);

    const preds = predecessors.get(nodeId);
    if (!preds) continue;
    preds.forEach((predId) => worklist.push(predId));
  }

  return { liveInById, liveOutById };
};

const shouldSkipCalleeIdentifierUse = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: CodegenContext;
}): boolean => {
  if (!ctx.program.functions.getSignature(ctx.moduleId, symbol)) {
    return false;
  }
  const canonicalId = ctx.program.symbols.canonicalIdOf(ctx.moduleId, symbol);
  return ctx.program.symbols.isModuleScoped(canonicalId);
};

const buildCfg = ({
  exprId,
  liveAfter,
  ctx,
}: {
  exprId: HirExprId;
  liveAfter: ReadonlySet<SymbolId>;
  ctx: CodegenContext;
}): {
  nodes: CfgNode[];
  entry: NodeId;
  siteNodeIds: NodeId[];
} => {
  const nodes: CfgNode[] = [];
  const siteNodeIds: NodeId[] = [];

  const addNode = ({
    uses = new Set<SymbolId>(),
    defs = new Set<SymbolId>(),
    site,
  }: {
    uses?: ReadonlySet<SymbolId>;
    defs?: ReadonlySet<SymbolId>;
    site?: SiteBase;
  }): NodeId => {
    const id = nodes.length;
    nodes.push({ id, uses, defs, succ: [], site });
    if (site) {
      siteNodeIds.push(id);
    }
    return id;
  };

  const addEdge = (from: NodeId, to: NodeId): void => {
    const node = nodes[from];
    if (!node) {
      throw new Error(`invalid cfg edge from ${from}`);
    }
    node.succ.push(to);
  };

  const nop = (): Subgraph => {
    const id = addNode({});
    return { entry: id, exits: [id], siteNodes: [] };
  };

  const sequence = (graphs: readonly Subgraph[]): Subgraph => {
    if (graphs.length === 0) return nop();

    let entry = graphs[0]!.entry;
    let exits = graphs[0]!.exits;
    const siteNodes: NodeId[] = [...graphs[0]!.siteNodes];

    for (let index = 1; index < graphs.length; index += 1) {
      const next = graphs[index]!;
      siteNodes.push(...next.siteNodes);
      if (exits.length === 0) {
        exits = [];
        continue;
      }
      exits.forEach((exit) => addEdge(exit, next.entry));
      exits = next.exits;
    }

    return { entry, exits, siteNodes };
  };

  const attachCallArgTempCaptures = ({
    callExprId,
    argExprIds,
    argGraphs,
    argIndexOffset = 0,
  }: {
    callExprId: HirExprId;
    argExprIds: readonly HirExprId[];
    argGraphs: readonly Subgraph[];
    argIndexOffset?: number;
  }): void => {
    if (argExprIds.length === 0) return;

    const hasSitesInArg = argGraphs.map((graph) => graph.siteNodes.length > 0);
    const needsTemp = new Array(argExprIds.length).fill(false);
    let suffixHasSites = false;
    for (let index = argExprIds.length - 2; index >= 0; index -= 1) {
      suffixHasSites ||= hasSitesInArg[index + 1] ?? false;
      needsTemp[index] = suffixHasSites;
    }

    const tempCapturesByIndex: Array<TempCaptureDraft | undefined> = new Array(
      argExprIds.length
    ).fill(undefined);
    needsTemp.forEach((needed, argIndex) => {
      if (!needed) return;
      const argExprId = argExprIds[argIndex]!;
      const typeId =
        ctx.module.types.getResolvedExprType(argExprId) ??
        ctx.module.types.getExprType(argExprId) ??
        ctx.program.primitives.unknown;
      tempCapturesByIndex[argIndex] = {
        key: callArgTempKey({ callExprId, argIndex: argIndex + argIndexOffset }),
        callExprId,
        argIndex: argIndex + argIndexOffset,
        typeId,
      };
    });

    for (let argIndex = 0; argIndex < argGraphs.length; argIndex += 1) {
      const graph = argGraphs[argIndex]!;
      if (graph.siteNodes.length === 0) continue;
      const captures = tempCapturesByIndex
        .slice(0, argIndex)
        .filter((capture): capture is TempCaptureDraft => !!capture);
      if (captures.length === 0) continue;
      graph.siteNodes.forEach((siteNodeId) => {
        const node = nodes[siteNodeId];
        if (!node?.site) return;
        appendTempCaptures(node, captures);
      });
    }
  };

  const buildStmt = (stmtId: HirStmtId, flow: FlowTargets): Subgraph => {
    const stmt = ctx.module.hir.statements.get(stmtId);
    if (!stmt) {
      throw new Error(`codegen missing HirStatement ${stmtId}`);
    }

    switch (stmt.kind) {
      case "expr-stmt":
        return buildExpr(stmt.expr, flow);
      case "return": {
        const valueGraph =
          typeof stmt.value === "number" ? buildExpr(stmt.value, flow) : nop();
        if (valueGraph.exits.length > 0) {
          valueGraph.exits.forEach((exit) => addEdge(exit, flow.returnTarget));
        }
        return { entry: valueGraph.entry, exits: [], siteNodes: valueGraph.siteNodes };
      }
      case "let": {
        const initGraph = buildExpr(stmt.initializer, flow);
        const defs = new Set<SymbolId>();
        collectPatternSymbols(stmt.pattern, defs);
        const bindNode = addNode({ defs });
        initGraph.exits.forEach((exit) => addEdge(exit, bindNode));
        return {
          entry: initGraph.entry,
          exits: [bindNode],
          siteNodes: initGraph.siteNodes,
        };
      }
    }
  };

  const buildExpr = (id: HirExprId, flow: FlowTargets): Subgraph => {
    const expr = ctx.module.hir.expressions.get(id);
    if (!expr) {
      throw new Error(`codegen missing HirExpression ${id}`);
    }

    switch (expr.exprKind) {
      case "literal":
      case "overload-set": {
        return nop();
      }
      case "identifier": {
        const nodeId = addNode({ uses: new Set([expr.symbol]) });
        return { entry: nodeId, exits: [nodeId], siteNodes: [] };
      }
      case "lambda": {
        return nop();
      }
      case "continue": {
        const nodeId = addNode({});
        if (typeof flow.continueTarget === "number") {
          addEdge(nodeId, flow.continueTarget);
        }
        return { entry: nodeId, exits: [], siteNodes: [] };
      }
      case "break": {
        const valueGraph =
          typeof expr.value === "number" ? buildExpr(expr.value, flow) : nop();
        if (valueGraph.exits.length > 0 && typeof flow.breakTarget === "number") {
          valueGraph.exits.forEach((exit) => addEdge(exit, flow.breakTarget!));
        }
        return { entry: valueGraph.entry, exits: [], siteNodes: valueGraph.siteNodes };
      }
      case "tuple": {
        const graphs = expr.elements.map((element) => buildExpr(element, flow));
        return sequence(graphs);
      }
      case "field-access": {
        return buildExpr(expr.target, flow);
      }
      case "object-literal": {
        const graphs = expr.entries.map((entry) => buildExpr(entry.value, flow));
        return sequence(graphs);
      }
      case "assign": {
        const targetGraph =
          typeof expr.target === "number" ? buildExpr(expr.target, flow) : nop();
        const valueGraph = buildExpr(expr.value, flow);
        const patternSymbols = new Set<SymbolId>();
        if (expr.pattern) {
          collectPatternSymbols(expr.pattern, patternSymbols);
        }
        const assignNode = addNode({ uses: patternSymbols });
        const graph = sequence([targetGraph, valueGraph]);
        graph.exits.forEach((exit) => addEdge(exit, assignNode));
        return {
          entry: graph.entry,
          exits: [assignNode],
          siteNodes: [...graph.siteNodes],
        };
      }
      case "block": {
        const stmtGraphs = expr.statements.map((stmtId) => buildStmt(stmtId, flow));
        const valueGraph = typeof expr.value === "number" ? buildExpr(expr.value, flow) : nop();
        return sequence([...stmtGraphs, valueGraph]);
      }
      case "loop": {
        const loopEntry = addNode({});
        const breakJoin = addNode({});
        const bodyGraph = buildExpr(expr.body, {
          ...flow,
          breakTarget: breakJoin,
          continueTarget: loopEntry,
        });
        addEdge(loopEntry, bodyGraph.entry);
        bodyGraph.exits.forEach((exit) => addEdge(exit, loopEntry));
        return {
          entry: loopEntry,
          exits: [breakJoin],
          siteNodes: [...bodyGraph.siteNodes],
        };
      }
      case "while": {
        const conditionGraph = buildExpr(expr.condition, flow);
        const breakJoin = addNode({});
        const bodyGraph = buildExpr(expr.body, {
          ...flow,
          breakTarget: breakJoin,
          continueTarget: conditionGraph.entry,
        });
        const conditionBranch = addNode({});
        conditionGraph.exits.forEach((exit) => addEdge(exit, conditionBranch));
        addEdge(conditionBranch, bodyGraph.entry);
        addEdge(conditionBranch, breakJoin);
        bodyGraph.exits.forEach((exit) => addEdge(exit, conditionGraph.entry));
        return {
          entry: conditionGraph.entry,
          exits: [breakJoin],
          siteNodes: [...conditionGraph.siteNodes, ...bodyGraph.siteNodes],
        };
      }
      case "cond":
      case "if": {
        const join = addNode({});
        const defaultGraph =
          typeof expr.defaultBranch === "number" ? buildExpr(expr.defaultBranch, flow) : undefined;
        const defaultEntry = defaultGraph ? defaultGraph.entry : join;
        defaultGraph?.exits.forEach((exit) => addEdge(exit, join));

        const branches = expr.branches.map((branch) => ({
          condition: buildExpr(branch.condition, flow),
          value: buildExpr(branch.value, flow),
        }));
        branches.forEach((branch) => branch.value.exits.forEach((exit) => addEdge(exit, join)));

        for (let index = branches.length - 1; index >= 0; index -= 1) {
          const branch = branches[index]!;
          const nextEntry = index === branches.length - 1 ? defaultEntry : branches[index + 1]!.condition.entry;
          branch.condition.exits.forEach((exit) => {
            addEdge(exit, branch.value.entry);
            addEdge(exit, nextEntry);
          });
        }

        const entry = branches.length > 0 ? branches[0]!.condition.entry : defaultEntry;
        const siteNodes = [
          ...(defaultGraph ? defaultGraph.siteNodes : []),
          ...branches.flatMap((branch) => [...branch.condition.siteNodes, ...branch.value.siteNodes]),
        ];

        return { entry, exits: [join], siteNodes };
      }
      case "match": {
        const join = addNode({});
        const discriminantGraph = buildExpr(expr.discriminant, flow);
        let nextEntry: NodeId = join;
        const siteNodes: NodeId[] = [...discriminantGraph.siteNodes];

        for (let index = expr.arms.length - 1; index >= 0; index -= 1) {
          const arm = expr.arms[index]!;
          const defs = new Set<SymbolId>();
          collectPatternSymbols(arm.pattern, defs);
          const bindNode = addNode({ defs });
          addEdge(bindNode, nextEntry);

          const valueGraph = buildExpr(arm.value, flow);
          valueGraph.exits.forEach((exit) => addEdge(exit, join));
          siteNodes.push(...valueGraph.siteNodes);

          if (typeof arm.guard === "number") {
            const guardGraph = buildExpr(arm.guard, flow);
            guardGraph.exits.forEach((exit) => {
              addEdge(exit, valueGraph.entry);
              addEdge(exit, nextEntry);
            });
            addEdge(bindNode, guardGraph.entry);
            siteNodes.push(...guardGraph.siteNodes);
          } else {
            addEdge(bindNode, valueGraph.entry);
          }

          nextEntry = bindNode;
        }

        discriminantGraph.exits.forEach((exit) => addEdge(exit, nextEntry));

        return { entry: discriminantGraph.entry, exits: [join], siteNodes };
      }
      case "effect-handler": {
        const bodyGraph = buildExpr(expr.body, flow);
        const finallyGraph =
          typeof expr.finallyBranch === "number" ? buildExpr(expr.finallyBranch, flow) : undefined;
        if (!finallyGraph) {
          return bodyGraph;
        }
        return sequence([bodyGraph, finallyGraph]);
      }
      case "call": {
        const calleeExpr = ctx.module.hir.expressions.get(expr.callee);
        const calleeIdentifierIsModuleScoped =
          calleeExpr?.exprKind === "identifier"
            ? ctx.program.symbols.isModuleScoped(
                ctx.program.symbols.canonicalIdOf(ctx.moduleId, calleeExpr.symbol)
              )
            : false;
        const skipCalleeIdentifierUse =
          calleeExpr?.exprKind === "identifier"
            ? shouldSkipCalleeIdentifierUse({ symbol: calleeExpr.symbol, ctx })
            : false;
        const calleeGraph =
          calleeExpr && calleeExpr.exprKind === "identifier"
            ? skipCalleeIdentifierUse
              ? nop()
              : buildExpr(expr.callee, flow)
            : calleeExpr && calleeExpr.exprKind === "overload-set"
              ? nop()
              : buildExpr(expr.callee, flow);

        const argGraphs = expr.args.map((arg) => buildExpr(arg.expr, flow));
        const kind = effectsFacade(ctx).callKind(expr.id);
        const applyNode = addNode({
          site:
            kind === "perform"
              ? (() => {
                  const calleeSymbol =
                    calleeExpr && calleeExpr.exprKind === "identifier"
                      ? calleeExpr.symbol
                      : undefined;
                  if (typeof calleeSymbol !== "number") {
                    throw new Error("perform site missing callee symbol");
                  }
                  return {
                    kind: "perform",
                    exprId: expr.id,
                    effectSymbol: calleeSymbol,
                  };
                })()
              : kind === "effectful-call"
                ? {
                    kind: "call",
                    exprId: expr.id,
                  }
                : undefined,
        });

        const includeCalleeTempCapture =
          calleeExpr?.exprKind === "overload-set"
            ? false
            : calleeExpr?.exprKind === "identifier"
              ? !calleeIdentifierIsModuleScoped
              : true;
        attachCallArgTempCaptures(
          includeCalleeTempCapture
            ? {
                callExprId: expr.id,
                argExprIds: [expr.callee, ...expr.args.map((arg) => arg.expr)],
                argGraphs: [calleeGraph, ...argGraphs],
                argIndexOffset: -1,
              }
            : {
                callExprId: expr.id,
                argExprIds: expr.args.map((arg) => arg.expr),
                argGraphs,
              }
        );

        const graph = sequence([calleeGraph, ...argGraphs]);
        graph.exits.forEach((exit) => addEdge(exit, applyNode));
        return {
          entry: graph.entry,
          exits: [applyNode],
          siteNodes: [...graph.siteNodes, ...(nodes[applyNode]!.site ? [applyNode] : [])],
        };
      }
      case "method-call": {
        const receiverGraph = buildExpr(expr.target, flow);
        const argGraphs = expr.args.map((arg) => buildExpr(arg.expr, flow));
        const callArgGraphs = [receiverGraph, ...argGraphs];
        const kind = effectsFacade(ctx).callKind(expr.id);
        const applyNode = addNode({
          site:
            kind === "perform"
              ? (() => {
                  throw new Error("perform site missing callee symbol");
                })()
              : kind === "effectful-call"
                ? {
                    kind: "call",
                    exprId: expr.id,
                  }
                : undefined,
        });

        attachCallArgTempCaptures({
          callExprId: expr.id,
          argExprIds: [expr.target, ...expr.args.map((arg) => arg.expr)],
          argGraphs: callArgGraphs,
        });

        const graph = sequence([receiverGraph, ...argGraphs]);
        graph.exits.forEach((exit) => addEdge(exit, applyNode));
        return {
          entry: graph.entry,
          exits: [applyNode],
          siteNodes: [...graph.siteNodes, ...(nodes[applyNode]!.site ? [applyNode] : [])],
        };
      }
    }
  };

  const afterNode = addNode({ uses: liveAfter });
  const returnSink = addNode({});
  const graph = buildExpr(exprId, { returnTarget: returnSink });
  graph.exits.forEach((exit) => addEdge(exit, afterNode));

  return { nodes, entry: graph.entry, siteNodeIds };
};
