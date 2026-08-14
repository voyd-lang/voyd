import { incrementCompilerPerfCounter } from "../../perf.js";
import {
  walkExpression,
  type HirGraph,
  type HirPattern,
} from "../hir/index.js";
import type { HirExprId, SymbolId } from "../ids.js";
import type { ResolveContext } from "./call-resolution.js";
import type { CallableBorrowIndex } from "./callable-borrow-index.js";
import { placeOfExpression } from "./places.js";

export type OrdinaryMutationLiveness = {
  readonly trackedCapabilities: number;
  readonly cfgBlocks: number;
  readonly cfgEdges: number;
  readonly stateInsertions: number;
  readonly workItems: number;
  hasLiveCapabilityAfter(expression: HirExprId): boolean;
  liveCapabilitiesAfter(expression: HirExprId): readonly number[];
};

type CfgBlock = {
  expression?: HirExprId;
  successors: number[];
  predecessors: number[];
  uses: number[];
};

type CapabilityOrigins = ReadonlyMap<SymbolId, ReadonlySet<number>>;

type OriginTransfer = {
  targets: readonly { symbol: SymbolId; killsPrevious: boolean }[];
  sourceRoots: readonly SymbolId[];
  kind: "assign" | "let";
};

type LoopTargets = {
  breakTarget: number;
  continueTarget: number;
};

const counterPrefix = "borrowing.ordinary.liveness";

/**
 * Compute callable-local liveness for ordinary exclusive capabilities.
 *
 * Capabilities are mutable parameters, represented by dense parameter bits.
 * Locally derived aliases retain their source bits. The CFG never crosses a
 * lambda/callable boundary, and the backward solver only inserts bits, giving
 * the bounds `insertions <= blocks * capabilities` and
 * `work <= blocks + edges * capabilities`.
 */
export const analyzeOrdinaryMutationLiveness = ({
  body,
  index,
  hir,
  resolveContext,
}: {
  body: HirExprId;
  index: CallableBorrowIndex;
  hir: HirGraph;
  resolveContext: ResolveContext;
}): OrdinaryMutationLiveness => {
  const capabilities = index.parameters.filter(
    (parameter) => parameter.bindingKind === "mutable-ref",
  );
  if (capabilities.length === 0) return emptyLiveness();

  const capabilityByParameter = new Map(
    capabilities.map((parameter, capability) => [
      parameter.parameter,
      capability,
    ]),
  );
  const cfg = buildCallableCfg({ body, hir });
  const originsByBlock = collectLocalCapabilityOrigins({
    body,
    index,
    hir,
    resolveContext,
    capabilityByParameter,
    cfg,
  });
  const usesByExpression = collectCapabilityUses({
    index,
    originsByBlock,
    blockByExpression: cfg.blockByExpression,
    capabilityByParameter,
  });
  usesByExpression.forEach((uses, expression) => {
    const block = cfg.blockByExpression.get(expression);
    if (block !== undefined) cfg.blocks[block]!.uses = Array.from(uses);
  });
  const wordCount = Math.ceil(capabilities.length / 32);
  const liveIn = cfg.blocks.map(() => new Uint32Array(wordCount));
  const liveOut = cfg.blocks.map(() => new Uint32Array(wordCount));
  const pending = cfg.blocks.map((_block, block) => block);
  const queued = new Set(pending);
  let stateInsertions = 0;
  let workItems = 0;

  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const blockId = pending[cursor]!;
    queued.delete(blockId);
    workItems += 1;
    const block = cfg.blocks[blockId]!;
    const nextOut = new Uint32Array(wordCount);
    block.successors.forEach((successor) =>
      unionBits(nextOut, liveIn[successor]!),
    );
    const nextIn = nextOut.slice();
    block.uses.forEach((capability) => insertBit(nextIn, capability));
    const inserted = countInsertedBits(liveIn[blockId]!, nextIn);
    liveOut[blockId] = nextOut;
    if (inserted === 0) continue;
    stateInsertions += inserted;
    liveIn[blockId] = nextIn;
    block.predecessors.forEach((predecessor) => {
      if (queued.has(predecessor)) return;
      queued.add(predecessor);
      pending.push(predecessor);
    });
  }

  const insertionBound = cfg.blocks.length * capabilities.length;
  const workBound = cfg.blocks.length + cfg.edgeCount * capabilities.length;
  if (stateInsertions > insertionBound || workItems > workBound) {
    throw new Error(
      `ordinary mutation liveness exceeded its monotone bounds: ` +
        `insertions ${stateInsertions}/${insertionBound}, ` +
        `work ${workItems}/${workBound}`,
    );
  }

  recordCounters({
    cfgBlocks: cfg.blocks.length,
    cfgEdges: cfg.edgeCount,
    trackedCapabilities: capabilities.length,
    stateInsertions,
    workItems,
  });
  const blockByExpression = cfg.blockByExpression;
  return {
    trackedCapabilities: capabilities.length,
    cfgBlocks: cfg.blocks.length,
    cfgEdges: cfg.edgeCount,
    stateInsertions,
    workItems,
    hasLiveCapabilityAfter: (expression) => {
      const block = blockByExpression.get(expression);
      return block !== undefined && hasAnyBit(liveOut[block]!);
    },
    liveCapabilitiesAfter: (expression) => {
      const block = blockByExpression.get(expression);
      return block === undefined
        ? []
        : bitsIn(liveOut[block]!, capabilities.length);
    },
  };
};

const emptyLiveness = (): OrdinaryMutationLiveness => {
  recordCounters({
    cfgBlocks: 0,
    cfgEdges: 0,
    trackedCapabilities: 0,
    stateInsertions: 0,
    workItems: 0,
  });
  return {
    trackedCapabilities: 0,
    cfgBlocks: 0,
    cfgEdges: 0,
    stateInsertions: 0,
    workItems: 0,
    hasLiveCapabilityAfter: () => false,
    liveCapabilitiesAfter: () => [],
  };
};

const recordCounters = (stats: {
  cfgBlocks: number;
  cfgEdges: number;
  trackedCapabilities: number;
  stateInsertions: number;
  workItems: number;
}): void => {
  incrementCompilerPerfCounter(`${counterPrefix}.cfgBlocks`, stats.cfgBlocks);
  incrementCompilerPerfCounter(`${counterPrefix}.cfgEdges`, stats.cfgEdges);
  incrementCompilerPerfCounter(
    `${counterPrefix}.trackedCapabilities`,
    stats.trackedCapabilities,
  );
  incrementCompilerPerfCounter(
    `${counterPrefix}.stateInsertions`,
    stats.stateInsertions,
  );
  incrementCompilerPerfCounter(`${counterPrefix}.workItems`, stats.workItems);
};

const collectLocalCapabilityOrigins = ({
  body,
  index,
  hir,
  resolveContext,
  capabilityByParameter,
  cfg,
}: {
  body: HirExprId;
  index: CallableBorrowIndex;
  hir: HirGraph;
  resolveContext: ResolveContext;
  capabilityByParameter: ReadonlyMap<number, number>;
  cfg: ReturnType<typeof buildCallableCfg>;
}): readonly CapabilityOrigins[] => {
  const initialOrigins = new Map<SymbolId, Set<number>>();
  index.parameterPlaces.forEach(({ parameter }, symbol) => {
    const capability = capabilityByParameter.get(parameter);
    if (capability !== undefined) {
      initialOrigins.set(symbol, new Set([capability]));
    }
  });
  const transfers = new Map<number, OriginTransfer[]>();
  const addTransfer = ({
    expression,
    targets,
    source,
    kind,
  }: {
    expression: HirExprId;
    targets: OriginTransfer["targets"];
    source: HirExprId;
    kind: OriginTransfer["kind"];
  }): void => {
    const block = cfg.blockByExpression.get(expression);
    if (block === undefined || targets.length === 0) return;
    const sourceRoots = new Set<SymbolId>();
    walkExpression({
      exprId: source,
      hir,
      options: { skipLambdas: true },
      onEnterExpression: (expressionId) => {
        const place = placeOfExpression(expressionId, hir, resolveContext);
        if (place) sourceRoots.add(place.root);
      },
    });
    const current = transfers.get(block) ?? [];
    current.push({ targets, sourceRoots: Array.from(sourceRoots), kind });
    transfers.set(block, current);
  };
  walkExpression({
    exprId: body,
    hir,
    options: { skipLambdas: true },
    onEnterStatement: (_statementId, statement) => {
      if (statement.kind !== "let") return;
      addTransfer({
        expression: statement.initializer,
        targets: patternSymbols(statement.pattern).map((symbol) => ({
          symbol,
          killsPrevious: true,
        })),
        source: statement.initializer,
        kind: "let",
      });
    },
    onEnterExpression: (expressionId, expression) => {
      if (expression.exprKind !== "assign") return;
      const target =
        typeof expression.target === "number"
          ? placeOfExpression(expression.target, hir, resolveContext)
          : undefined;
      addTransfer({
        expression: expressionId,
        targets: [
          ...(target !== undefined
            ? [
                {
                  symbol: target.root,
                  killsPrevious: target.projections.length === 0,
                },
              ]
            : []),
          ...(expression.pattern
            ? patternSymbols(expression.pattern).map((symbol) => ({
                symbol,
                killsPrevious: true,
              }))
            : []),
        ],
        source: expression.value,
        kind: "assign",
      });
    },
  });
  transfers.forEach((entries) =>
    entries.sort((left, right) =>
      left.kind === right.kind ? 0 : left.kind === "assign" ? -1 : 1,
    ),
  );

  const originsIn = cfg.blocks.map(() => new Map<SymbolId, Set<number>>());
  const originsOut = cfg.blocks.map(() => new Map<SymbolId, Set<number>>());
  const pending = cfg.blocks.map((_block, block) => block);
  const queued = new Set(pending);
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const block = pending[cursor]!;
    queued.delete(block);
    const nextIn = new Map<SymbolId, Set<number>>();
    if (block === cfg.entry) mergeOrigins(nextIn, initialOrigins);
    cfg.blocks[block]!.predecessors.forEach((predecessor) =>
      mergeOrigins(nextIn, originsOut[predecessor]!),
    );
    const nextOut = cloneOrigins(nextIn);
    (transfers.get(block) ?? []).forEach((transfer) => {
      const sourceOrigins = new Set<number>();
      transfer.sourceRoots.forEach((root) =>
        nextOut.get(root)?.forEach((origin) => sourceOrigins.add(origin)),
      );
      transfer.targets.forEach(({ symbol, killsPrevious }) => {
        if (killsPrevious) {
          if (sourceOrigins.size === 0) nextOut.delete(symbol);
          else nextOut.set(symbol, new Set(sourceOrigins));
          return;
        }
        if (sourceOrigins.size === 0) return;
        const current = nextOut.get(symbol) ?? new Set<number>();
        sourceOrigins.forEach((origin) => current.add(origin));
        nextOut.set(symbol, current);
      });
    });
    originsIn[block] = nextIn;
    if (originsEqual(originsOut[block]!, nextOut)) continue;
    originsOut[block] = nextOut;
    cfg.blocks[block]!.successors.forEach((successor) => {
      if (queued.has(successor)) return;
      queued.add(successor);
      pending.push(successor);
    });
  }
  return originsIn;
};

const collectCapabilityUses = ({
  index,
  originsByBlock,
  blockByExpression,
  capabilityByParameter,
}: {
  index: CallableBorrowIndex;
  originsByBlock: readonly CapabilityOrigins[];
  blockByExpression: ReadonlyMap<HirExprId, number>;
  capabilityByParameter: ReadonlyMap<number, number>;
}): ReadonlyMap<HirExprId, ReadonlySet<number>> => {
  const result = new Map<HirExprId, Set<number>>();
  const add = (expression: HirExprId, capabilities: Iterable<number>): void => {
    const current = result.get(expression) ?? new Set<number>();
    for (const capability of capabilities) current.add(capability);
    if (current.size > 0) result.set(expression, current);
  };
  index.accesses.forEach((access) => {
    if (access.place) {
      const block = blockByExpression.get(access.exprId);
      add(
        access.exprId,
        block === undefined
          ? []
          : (originsByBlock[block]?.get(access.place.root) ?? []),
      );
    }
  });
  index.calls.forEach((call) =>
    call.arguments.forEach((argument) => {
      const block = blockByExpression.get(call.exprId);
      if (argument.place && block !== undefined) {
        add(call.exprId, originsByBlock[block]?.get(argument.place.root) ?? []);
        return;
      }
      add(
        call.exprId,
        (argument.callerParameterOrigins ?? []).flatMap((parameter) => {
          const capability = capabilityByParameter.get(parameter);
          return capability === undefined ? [] : [capability];
        }),
      );
    }),
  );
  return result;
};

const buildCallableCfg = ({
  body,
  hir,
}: {
  body: HirExprId;
  hir: HirGraph;
}): {
  blocks: CfgBlock[];
  blockByExpression: ReadonlyMap<HirExprId, number>;
  edgeCount: number;
  entry: number;
} => {
  const blocks: CfgBlock[] = [];
  const blockByExpression = new Map<HirExprId, number>();
  const createBlock = (expression?: HirExprId): number => {
    const block = blocks.length;
    blocks.push({
      ...(expression !== undefined ? { expression } : {}),
      successors: [],
      predecessors: [],
      uses: [],
    });
    if (expression !== undefined) blockByExpression.set(expression, block);
    return block;
  };
  const addEdge = (from: number, to: number): void => {
    if (blocks[from]!.successors.includes(to)) return;
    blocks[from]!.successors.push(to);
    blocks[to]!.predecessors.push(from);
  };
  const exit = createBlock();

  const build = (
    expressionId: HirExprId,
    successors: readonly number[],
    loop?: LoopTargets,
  ): number => {
    const expression = hir.expressions.get(expressionId);
    if (!expression) throw new Error(`missing HirExpression ${expressionId}`);
    const block = createBlock(expressionId);
    const linkBlock = (): number => {
      successors.forEach((successor) => addEdge(block, successor));
      return block;
    };
    const sequence = (children: readonly HirExprId[]): number =>
      children.reduceRight(
        (next, child) => build(child, [next], loop),
        linkBlock(),
      );
    switch (expression.exprKind) {
      case "literal":
      case "identifier":
      case "overload-set":
      case "lambda":
        return linkBlock();
      case "call":
        return sequence([
          expression.callee,
          ...expression.args.map((argument) => argument.expr),
        ]);
      case "method-call":
        return sequence([
          expression.target,
          ...expression.args.map((argument) => argument.expr),
        ]);
      case "tuple":
        return sequence(expression.elements);
      case "object-literal":
        return sequence(expression.entries.map((entry) => entry.value));
      case "field-access":
        return sequence([expression.target]);
      case "assign":
        return sequence([
          ...(typeof expression.target === "number" ? [expression.target] : []),
          expression.value,
        ]);
      case "block": {
        linkBlock();
        const expressions: {
          expression?: HirExprId;
          returns: boolean;
        }[] = [
          ...expression.statements.flatMap((statementId) => {
            const statement = hir.statements.get(statementId);
            if (!statement) return [];
            if (statement.kind === "return") {
              return [
                {
                  ...(typeof statement.value === "number"
                    ? { expression: statement.value }
                    : {}),
                  returns: true,
                },
              ];
            }
            return [
              {
                expression:
                  statement.kind === "let"
                    ? statement.initializer
                    : statement.expr,
                returns: false,
              },
            ];
          }),
          ...(typeof expression.value === "number"
            ? [{ expression: expression.value, returns: false }]
            : []),
        ];
        return expressions.reduceRight((next, child) => {
          if (child.expression === undefined) return exit;
          return build(child.expression, child.returns ? [exit] : [next], loop);
        }, block);
      }
      case "if":
      case "cond": {
        linkBlock();
        let falseTarget =
          typeof expression.defaultBranch === "number"
            ? build(expression.defaultBranch, [block], loop)
            : block;
        [...expression.branches].reverse().forEach((branch) => {
          const value = build(branch.value, [block], loop);
          falseTarget = build(branch.condition, [value, falseTarget], loop);
        });
        return falseTarget;
      }
      case "match": {
        linkBlock();
        const arms = expression.arms.map((arm) => {
          const value = build(arm.value, [block], loop);
          return typeof arm.guard === "number"
            ? build(arm.guard, [value, block], loop)
            : value;
        });
        return build(expression.discriminant, [...arms, block], loop);
      }
      case "effect-handler": {
        linkBlock();
        const afterBody =
          typeof expression.finallyBranch === "number"
            ? build(expression.finallyBranch, [block], loop)
            : block;
        const handlerEntries = expression.handlers.map((handler) =>
          build(handler.body, [afterBody], loop),
        );
        const bodyBlockStart = blocks.length;
        const bodyEntry = build(expression.body, [afterBody], loop);
        for (
          let bodyBlock = bodyBlockStart;
          bodyBlock < blocks.length;
          bodyBlock += 1
        ) {
          handlerEntries.forEach((handlerEntry) =>
            addEdge(bodyBlock, handlerEntry),
          );
        }
        const alternatives = [bodyEntry, ...handlerEntries];
        const entry = createBlock();
        alternatives.forEach((alternative) => addEdge(entry, alternative));
        return entry;
      }
      case "while": {
        linkBlock();
        const header = createBlock();
        const bodyEntry = build(expression.body, [header], {
          breakTarget: block,
          continueTarget: header,
        });
        const conditionEntry = build(
          expression.condition,
          [bodyEntry, block],
          loop,
        );
        addEdge(header, conditionEntry);
        return header;
      }
      case "loop": {
        linkBlock();
        const header = createBlock();
        const bodyEntry = build(expression.body, [header], {
          breakTarget: block,
          continueTarget: header,
        });
        addEdge(header, bodyEntry);
        return header;
      }
      case "break": {
        const target = loop?.breakTarget ?? exit;
        addEdge(block, target);
        return typeof expression.value === "number"
          ? build(expression.value, [block], loop)
          : block;
      }
      case "continue":
        addEdge(block, loop?.continueTarget ?? exit);
        return block;
    }
  };

  const entry = build(body, [exit]);
  return {
    blocks,
    blockByExpression,
    edgeCount: blocks.reduce(
      (count, block) => count + block.successors.length,
      0,
    ),
    entry,
  };
};

const cloneOrigins = (
  origins: ReadonlyMap<SymbolId, ReadonlySet<number>>,
): Map<SymbolId, Set<number>> =>
  new Map(Array.from(origins, ([symbol, values]) => [symbol, new Set(values)]));

const mergeOrigins = (
  target: Map<SymbolId, Set<number>>,
  source: ReadonlyMap<SymbolId, ReadonlySet<number>>,
): void => {
  source.forEach((values, symbol) => {
    const current = target.get(symbol) ?? new Set<number>();
    values.forEach((value) => current.add(value));
    target.set(symbol, current);
  });
};

const originsEqual = (
  left: ReadonlyMap<SymbolId, ReadonlySet<number>>,
  right: ReadonlyMap<SymbolId, ReadonlySet<number>>,
): boolean =>
  left.size === right.size &&
  Array.from(left).every(([symbol, values]) => {
    const other = right.get(symbol);
    return (
      other !== undefined &&
      values.size === other.size &&
      Array.from(values).every((value) => other.has(value))
    );
  });

const patternSymbols = (pattern: HirPattern): readonly SymbolId[] => {
  switch (pattern.kind) {
    case "identifier":
      return [pattern.symbol];
    case "tuple":
      return pattern.elements.flatMap(patternSymbols);
    case "destructure":
      return [
        ...pattern.fields.flatMap((field) => patternSymbols(field.pattern)),
        ...(pattern.spread ? patternSymbols(pattern.spread) : []),
      ];
    case "type":
      return pattern.binding ? patternSymbols(pattern.binding) : [];
    case "wildcard":
      return [];
  }
};

const insertBit = (bits: Uint32Array, bit: number): void => {
  bits[bit >>> 5] = bits[bit >>> 5]! | (1 << (bit & 31));
};

const unionBits = (target: Uint32Array, source: Uint32Array): void => {
  for (let word = 0; word < target.length; word += 1) {
    target[word] = target[word]! | source[word]!;
  }
};

const countInsertedBits = (
  previous: Uint32Array,
  next: Uint32Array,
): number => {
  let count = 0;
  for (let word = 0; word < previous.length; word += 1) {
    let inserted = (next[word]! & ~previous[word]!) >>> 0;
    while (inserted !== 0) {
      inserted &= inserted - 1;
      count += 1;
    }
  }
  return count;
};

const hasAnyBit = (bits: Uint32Array): boolean =>
  bits.some((word) => word !== 0);

const bitsIn = (bits: Uint32Array, bitCount: number): readonly number[] =>
  Array.from({ length: bitCount }, (_entry, bit) => bit).filter(
    (bit) => (bits[bit >>> 5]! & (1 << (bit & 31))) !== 0,
  );
