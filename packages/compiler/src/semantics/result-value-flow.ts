import type { HirExpression, HirPattern, HirGraph } from "./hir/index.js";
import { walkExpression } from "./hir/index.js";
import type { HirExprId, SymbolId, TypeId } from "./ids.js";
import { objectLiteralFieldProvider } from "./borrowing/object-literal-providers.js";

export type ResultValueProjection =
  | { kind: "field"; name: string }
  | { kind: "tuple"; index: number };

export type ResultValueSource = {
  expression: HirExprId;
  projections: readonly ResultValueProjection[];
  typeFilter?: TypeId;
};

type Place = {
  root: SymbolId;
  projections: readonly ResultValueProjection[];
};

type StoredResultValueSource = ResultValueSource & {
  sequence: number;
};

type ResultValueSourceFlow = {
  sources: readonly ResultValueSource[];
  recursive: boolean;
};

/**
 * Builds a conservative graph of the values that can reach local bindings and
 * their aggregate projections. Straight-line assignments use strong updates;
 * assignments in alternative control-flow paths are merged.
 *
 * Export analysis uses this graph to retain separate-compilation metadata for
 * private values that escape through public results. Keeping the graph
 * independent of export policy makes result flow reusable and prevents the
 * export collector from growing its own partial HIR data-flow model.
 */
export const analyzeResultValueFlow = ({
  hir,
  spreadProvidesField,
  expressionMayHaveType,
}: {
  hir: HirGraph;
  spreadProvidesField: (value: HirExprId, field: string) => boolean;
  expressionMayHaveType: (value: HirExprId, type: TypeId) => boolean;
}): {
  valuesForExpression: (
    expression: HirExprId,
    projections?: readonly ResultValueProjection[],
    useAtExpression?: HirExprId,
  ) => readonly HirExprId[];
  sourcesForExpression: (
    expression: HirExprId,
    projections?: readonly ResultValueProjection[],
    useAtExpression?: HirExprId,
  ) => readonly ResultValueSource[];
  sourceFlowForExpression: (
    expression: HirExprId,
    projections?: readonly ResultValueProjection[],
    useAtExpression?: HirExprId,
  ) => ResultValueSourceFlow;
  resultsForCallable: (body: HirExprId) => readonly HirExprId[];
} => {
  const definitions = new Map<string, Map<string, StoredResultValueSource>>();
  const strongUpdateSequences = new Map<string, number[]>();
  const expressionSequences = new Map<HirExprId, number>();
  const recursiveDefinitionSequences = new Set<number>();
  let nextProgramPoint = 0;
  const projectionPathKey = (
    projections: readonly ResultValueProjection[],
  ): string =>
    projections
      .map((projection) =>
        projection.kind === "tuple"
          ? `t${projection.index};`
          : `f${projection.name.length}:${projection.name};`,
      )
      .join("");
  const placeKey = (place: Place): string =>
    `${place.root}|${projectionPathKey(place.projections)}`;
  const sourceKey = (source: ResultValueSource): string =>
    `${source.expression}|${source.typeFilter ?? ""}|${projectionPathKey(source.projections)}`;
  const queryKey = ({
    expression,
    projections,
    typeFilter,
    useSequence,
  }: {
    expression: HirExprId;
    projections: readonly ResultValueProjection[];
    typeFilter?: TypeId;
    useSequence: number;
  }): string =>
    `${expression}|${typeFilter ?? ""}|${useSequence}|${projectionPathKey(projections)}`;
  const projectionForField = (field: string): ResultValueProjection => {
    const index = Number(field);
    return Number.isInteger(index)
      ? { kind: "tuple", index }
      : { kind: "field", name: field };
  };
  const addDefinition = (
    place: Place,
    source: ResultValueSource,
    replace = false,
    recursive = false,
  ): void => {
    const key = placeKey(place);
    const sequence = nextProgramPoint;
    nextProgramPoint += 1;
    if (replace) {
      const updates = strongUpdateSequences.get(key) ?? [];
      updates.push(sequence);
      strongUpdateSequences.set(key, updates);
    }
    if (recursive) {
      recursiveDefinitionSequences.add(sequence);
    }
    const values =
      definitions.get(key) ?? new Map<string, StoredResultValueSource>();
    values.set(`${sourceKey(source)}:${sequence}`, { ...source, sequence });
    definitions.set(key, values);
  };
  const placeForExpression = (expressionId: HirExprId): Place | undefined => {
    const expression = hir.expressions.get(expressionId);
    if (expression?.exprKind === "identifier") {
      return { root: expression.symbol, projections: [] };
    }
    if (expression?.exprKind !== "field-access") {
      return undefined;
    }
    const target = placeForExpression(expression.target);
    return target
      ? {
          root: target.root,
          projections: [
            ...target.projections,
            projectionForField(expression.field),
          ],
        }
      : undefined;
  };
  const expressionStoresTargetAllocation = (
    expressionId: HirExprId,
    target: Place,
    active = new Set<HirExprId>(),
  ): boolean => {
    if (active.has(expressionId)) {
      return false;
    }
    const nextActive = new Set(active).add(expressionId);
    const place = placeForExpression(expressionId);
    if (place) {
      return (
        place.root === target.root &&
        place.projections.length < target.projections.length &&
        place.projections.every(
          (projection, index) =>
            JSON.stringify(projection) ===
            JSON.stringify(target.projections[index]),
        )
      );
    }
    const expression = hir.expressions.get(expressionId);
    if (!expression) {
      return false;
    }
    if (expression.exprKind === "tuple") {
      return expression.elements.some((element) =>
        expressionStoresTargetAllocation(element, target, nextActive),
      );
    }
    if (expression.exprKind === "object-literal") {
      return expression.entries.some((entry) =>
        expressionStoresTargetAllocation(entry.value, target, nextActive),
      );
    }
    if (expression.exprKind === "block") {
      return (
        typeof expression.value === "number" &&
        expressionStoresTargetAllocation(expression.value, target, nextActive)
      );
    }
    if (expression.exprKind === "if" || expression.exprKind === "cond") {
      return [
        ...expression.branches.map((branch) => branch.value),
        ...(typeof expression.defaultBranch === "number"
          ? [expression.defaultBranch]
          : []),
      ].some((value) =>
        expressionStoresTargetAllocation(value, target, nextActive),
      );
    }
    if (expression.exprKind === "match") {
      return expression.arms.some((arm) =>
        expressionStoresTargetAllocation(arm.value, target, nextActive),
      );
    }
    if (expression.exprKind === "assign") {
      return expressionStoresTargetAllocation(
        expression.value,
        target,
        nextActive,
      );
    }
    if (expression.exprKind === "effect-handler") {
      return [
        expression.body,
        ...expression.handlers.map((handler) => handler.body),
      ].some((value) =>
        expressionStoresTargetAllocation(value, target, nextActive),
      );
    }
    return false;
  };
  const addPatternDefinitions = ({
    pattern,
    source,
    projections = [],
    typeFilter,
    replace = false,
  }: {
    pattern: HirPattern;
    source: HirExprId;
    projections?: readonly ResultValueProjection[];
    typeFilter?: TypeId;
    replace?: boolean;
  }): void => {
    if (pattern.kind === "identifier") {
      addDefinition(
        { root: pattern.symbol, projections: [] },
        { expression: source, projections, typeFilter },
        replace,
      );
      return;
    }
    if (pattern.kind === "destructure") {
      pattern.fields.forEach((field) =>
        addPatternDefinitions({
          pattern: field.pattern,
          source,
          projections: [...projections, { kind: "field", name: field.name }],
          typeFilter,
          replace,
        }),
      );
      if (pattern.spread) {
        addPatternDefinitions({
          pattern: pattern.spread,
          source,
          projections,
          typeFilter,
          replace,
        });
      }
      return;
    }
    if (pattern.kind === "tuple") {
      pattern.elements.forEach((element, index) =>
        addPatternDefinitions({
          pattern: element,
          source,
          projections: [...projections, { kind: "tuple", index }],
          typeFilter,
          replace,
        }),
      );
      return;
    }
    if (pattern.kind === "type" && pattern.binding) {
      addPatternDefinitions({
        pattern: pattern.binding,
        source,
        projections,
        typeFilter: pattern.typeId ?? typeFilter,
        replace,
      });
    }
  };
  const introducesAlternatives = (expression: HirExpression): boolean =>
    expression.exprKind === "if" ||
    expression.exprKind === "cond" ||
    expression.exprKind === "match" ||
    expression.exprKind === "loop" ||
    expression.exprKind === "while" ||
    expression.exprKind === "effect-handler";
  const collectDefinitions = (root: HirExprId): void => {
    let alternativeDepth = 0;
    walkExpression({
      exprId: root,
      hir,
      options: { skipLambdas: true },
      onEnterStatement: (_statementId, statement) => {
        if (statement.kind === "let") {
          addPatternDefinitions({
            pattern: statement.pattern,
            source: statement.initializer,
            replace: true,
          });
        }
      },
      onEnterExpression: (expressionId, expression) => {
        expressionSequences.set(expressionId, nextProgramPoint);
        nextProgramPoint += 1;
        if (expression.exprKind === "lambda") {
          collectDefinitions(expression.body);
          return;
        }
        if (introducesAlternatives(expression)) {
          alternativeDepth += 1;
        }
        if (expression.exprKind === "match") {
          expression.arms.forEach((arm) =>
            addPatternDefinitions({
              pattern: arm.pattern,
              source: expression.discriminant,
            }),
          );
        }
      },
      onExitExpression: (_expressionId, expression) => {
        if (
          expression.exprKind === "assign" &&
          typeof expression.target === "number"
        ) {
          const place = placeForExpression(expression.target);
          if (place) {
            addDefinition(
              place,
              {
                expression: expression.value,
                projections: [],
              },
              alternativeDepth === 0,
              place.projections.length > 0 &&
                expressionStoresTargetAllocation(expression.value, place),
            );
          }
        }
        if (expression.exprKind === "assign" && expression.pattern) {
          addPatternDefinitions({
            pattern: expression.pattern,
            source: expression.value,
            replace: alternativeDepth === 0,
          });
        }
        if (introducesAlternatives(expression)) {
          alternativeDepth -= 1;
        }
      },
    });
  };
  Array.from(hir.items.values()).forEach((item) => {
    if (item.kind === "module-let") {
      addDefinition(
        { root: item.symbol, projections: [] },
        { expression: item.initializer, projections: [] },
        true,
      );
      collectDefinitions(item.initializer);
      return;
    }
    if (item.kind === "function") {
      collectDefinitions(item.body);
    }
  });

  const valuesForExpression = (
    expressionId: HirExprId,
    projections: readonly ResultValueProjection[] = [],
    active = new Set<string>(),
    typeFilter?: TypeId,
    useSequence = expressionSequences.get(expressionId) ??
      Number.MAX_SAFE_INTEGER,
  ): readonly HirExprId[] => {
    const activeKey = queryKey({
      expression: expressionId,
      projections,
      typeFilter,
      useSequence,
    });
    if (active.has(activeKey)) {
      return [];
    }
    const nextActive = new Set(active).add(activeKey);
    const expression = hir.expressions.get(expressionId);
    if (!expression) {
      return [];
    }
    if (
      typeof typeFilter === "number" &&
      !expressionMayHaveType(expressionId, typeFilter)
    ) {
      return [];
    }
    if (expression.exprKind === "identifier") {
      return valuesForPlace(
        { root: expression.symbol, projections },
        nextActive,
        typeFilter,
        useSequence,
      );
    }
    if (expression.exprKind === "field-access") {
      return valuesForExpression(
        expression.target,
        [projectionForField(expression.field), ...projections],
        nextActive,
        undefined,
        useSequence,
      );
    }
    if (expression.exprKind === "block") {
      return typeof expression.value === "number"
        ? valuesForExpression(
            expression.value,
            projections,
            nextActive,
            typeFilter,
            useSequence,
          )
        : [];
    }
    if (expression.exprKind === "if" || expression.exprKind === "cond") {
      return [
        ...expression.branches.flatMap((branch) =>
          valuesForExpression(
            branch.value,
            projections,
            nextActive,
            typeFilter,
            useSequence,
          ),
        ),
        ...(typeof expression.defaultBranch === "number"
          ? valuesForExpression(
              expression.defaultBranch,
              projections,
              nextActive,
              typeFilter,
              useSequence,
            )
          : []),
      ];
    }
    if (expression.exprKind === "match") {
      return expression.arms.flatMap((arm) =>
        valuesForExpression(
          arm.value,
          projections,
          nextActive,
          typeFilter,
          Math.max(
            useSequence,
            expressionSequences.get(arm.value) ?? useSequence,
          ),
        ),
      );
    }
    if (expression.exprKind === "assign") {
      return valuesForExpression(
        expression.value,
        projections,
        nextActive,
        typeFilter,
        useSequence,
      );
    }
    if (expression.exprKind === "effect-handler") {
      return [
        expression.body,
        ...expression.handlers.map((handler) => handler.body),
      ].flatMap((value) =>
        valuesForExpression(
          value,
          projections,
          nextActive,
          typeFilter,
          useSequence,
        ),
      );
    }
    const [projection, ...remaining] = projections;
    if (!projection) {
      return [expressionId];
    }
    if (expression.exprKind === "tuple" && projection.kind === "tuple") {
      const value = expression.elements[projection.index];
      return typeof value === "number"
        ? valuesForExpression(
            value,
            remaining,
            nextActive,
            undefined,
            useSequence,
          )
        : [];
    }
    if (
      expression.exprKind === "object-literal" &&
      projection.kind === "field"
    ) {
      const provider = objectLiteralFieldProvider({
        expression,
        field: projection.name,
        spreadProvidesField: (value) =>
          spreadProvidesField(value, projection.name),
      });
      return provider
        ? valuesForExpression(
            provider.value,
            provider.kind === "spread" ? projections : remaining,
            nextActive,
            provider.kind === "spread" ? typeFilter : undefined,
            useSequence,
          )
        : [];
    }
    return [];
  };
  const valuesForPlace = (
    place: Place,
    active: Set<string>,
    typeFilter?: TypeId,
    useSequence = Number.MAX_SAFE_INTEGER,
    minimumSequence = 0,
  ): readonly HirExprId[] => {
    const key = placeKey(place);
    const activeKey = `place:${key}:${typeFilter ?? ""}:${useSequence}:${minimumSequence}`;
    if (active.has(activeKey)) {
      return [];
    }
    const nextActive = new Set(active).add(activeKey);
    const latestStrongUpdate = (
      candidate: Place,
      minimum: number,
    ): number | undefined =>
      strongUpdateSequences
        .get(placeKey(candidate))
        ?.findLast(
          (sequence) => sequence <= useSequence && sequence >= minimum,
        );
    const ancestorStrongSequence = place.projections
      .map((_, index) => ({
        root: place.root,
        projections: place.projections.slice(0, index),
      }))
      .map((ancestor) => latestStrongUpdate(ancestor, minimumSequence))
      .filter((sequence): sequence is number => typeof sequence === "number")
      .reduce(
        (latest, sequence) => Math.max(latest, sequence),
        minimumSequence,
      );
    const currentStrongSequence = latestStrongUpdate(
      place,
      ancestorStrongSequence,
    );
    const exactMinimumSequence = Math.max(
      ancestorStrongSequence,
      currentStrongSequence ?? minimumSequence,
    );
    const exact = Array.from(definitions.get(key)?.values() ?? [])
      .filter(
        (source) =>
          source.sequence >= exactMinimumSequence &&
          source.sequence <= useSequence,
      )
      .flatMap((source) =>
        valuesForExpression(
          source.expression,
          source.projections,
          nextActive,
          source.typeFilter ?? typeFilter,
          Math.min(
            useSequence,
            expressionSequences.get(source.expression) ?? source.sequence,
          ),
        ),
      );
    const [projection] = place.projections.slice(-1);
    if (!projection) {
      return exact;
    }
    const parent = {
      root: place.root,
      projections: place.projections.slice(0, -1),
    };
    const parentMinimumSequence = Math.max(
      ancestorStrongSequence,
      typeof currentStrongSequence === "number"
        ? currentStrongSequence + 1
        : minimumSequence,
    );
    return [
      ...exact,
      ...valuesForPlace(
        parent,
        nextActive,
        typeFilter,
        useSequence,
        parentMinimumSequence,
      ).flatMap((value) =>
        valuesForExpression(
          value,
          [projection],
          nextActive,
          undefined,
          useSequence,
        ),
      ),
    ];
  };
  const sourcesForExpression = (
    expressionId: HirExprId,
    projections: readonly ResultValueProjection[] = [],
    active = new Set<string>(),
    cycle: { detected: boolean },
    typeFilter?: TypeId,
    useSequence = expressionSequences.get(expressionId) ??
      Number.MAX_SAFE_INTEGER,
  ): readonly ResultValueSource[] => {
    const activeKey = `source:${queryKey({
      expression: expressionId,
      projections,
      typeFilter,
      useSequence,
    })}`;
    if (active.has(activeKey)) {
      cycle.detected = true;
      return [];
    }
    const nextActive = new Set(active).add(activeKey);
    const expression = hir.expressions.get(expressionId);
    if (
      !expression ||
      (typeof typeFilter === "number" &&
        !expressionMayHaveType(expressionId, typeFilter))
    ) {
      return [];
    }
    if (expression.exprKind === "identifier") {
      const resolved = sourcesForPlace(
        { root: expression.symbol, projections },
        nextActive,
        cycle,
        typeFilter,
        useSequence,
      );
      return resolved.length > 0
        ? resolved
        : [{ expression: expressionId, projections, typeFilter }];
    }
    if (expression.exprKind === "field-access") {
      return sourcesForExpression(
        expression.target,
        [projectionForField(expression.field), ...projections],
        nextActive,
        cycle,
        undefined,
        useSequence,
      ).map((source) =>
        typeof typeFilter === "number" && source.typeFilter === undefined
          ? { ...source, typeFilter }
          : source,
      );
    }
    if (expression.exprKind === "block") {
      return typeof expression.value === "number"
        ? sourcesForExpression(
            expression.value,
            projections,
            nextActive,
            cycle,
            typeFilter,
            useSequence,
          )
        : [];
    }
    if (expression.exprKind === "if" || expression.exprKind === "cond") {
      return [
        ...expression.branches.flatMap((branch) =>
          sourcesForExpression(
            branch.value,
            projections,
            nextActive,
            cycle,
            typeFilter,
            useSequence,
          ),
        ),
        ...(typeof expression.defaultBranch === "number"
          ? sourcesForExpression(
              expression.defaultBranch,
              projections,
              nextActive,
              cycle,
              typeFilter,
              useSequence,
            )
          : []),
      ];
    }
    if (expression.exprKind === "match") {
      return expression.arms.flatMap((arm) =>
        sourcesForExpression(
          arm.value,
          projections,
          nextActive,
          cycle,
          typeFilter,
          Math.max(
            useSequence,
            expressionSequences.get(arm.value) ?? useSequence,
          ),
        ),
      );
    }
    if (expression.exprKind === "assign") {
      return sourcesForExpression(
        expression.value,
        projections,
        nextActive,
        cycle,
        typeFilter,
        useSequence,
      );
    }
    if (expression.exprKind === "effect-handler") {
      return [
        expression.body,
        ...expression.handlers.map((handler) => handler.body),
      ].flatMap((value) =>
        sourcesForExpression(
          value,
          projections,
          nextActive,
          cycle,
          typeFilter,
          useSequence,
        ),
      );
    }
    const [projection, ...remaining] = projections;
    if (!projection) {
      return [{ expression: expressionId, projections: [], typeFilter }];
    }
    if (expression.exprKind === "tuple" && projection.kind === "tuple") {
      const value = expression.elements[projection.index];
      return typeof value === "number"
        ? sourcesForExpression(
            value,
            remaining,
            nextActive,
            cycle,
            undefined,
            useSequence,
          )
        : [];
    }
    if (
      expression.exprKind === "object-literal" &&
      projection.kind === "field"
    ) {
      const provider = objectLiteralFieldProvider({
        expression,
        field: projection.name,
        spreadProvidesField: (value) =>
          spreadProvidesField(value, projection.name),
      });
      return provider
        ? sourcesForExpression(
            provider.value,
            provider.kind === "spread" ? projections : remaining,
            nextActive,
            cycle,
            provider.kind === "spread" ? typeFilter : undefined,
            useSequence,
          )
        : [];
    }
    return [{ expression: expressionId, projections, typeFilter }];
  };
  const sourcesForPlace = (
    place: Place,
    active: Set<string>,
    cycle: { detected: boolean },
    typeFilter?: TypeId,
    useSequence = Number.MAX_SAFE_INTEGER,
    minimumSequence = 0,
  ): readonly ResultValueSource[] => {
    const key = placeKey(place);
    const activeKey = `source-place:${key}:${typeFilter ?? ""}:${useSequence}:${minimumSequence}`;
    if (active.has(activeKey)) {
      cycle.detected = true;
      return [];
    }
    const nextActive = new Set(active).add(activeKey);
    const latestStrongUpdate = (
      candidate: Place,
      minimum: number,
    ): number | undefined =>
      strongUpdateSequences
        .get(placeKey(candidate))
        ?.findLast(
          (sequence) => sequence <= useSequence && sequence >= minimum,
        );
    const ancestorStrongSequence = place.projections
      .map((_, index) => ({
        root: place.root,
        projections: place.projections.slice(0, index),
      }))
      .map((ancestor) => latestStrongUpdate(ancestor, minimumSequence))
      .filter((sequence): sequence is number => typeof sequence === "number")
      .reduce(
        (latest, sequence) => Math.max(latest, sequence),
        minimumSequence,
      );
    const currentStrongSequence = latestStrongUpdate(
      place,
      ancestorStrongSequence,
    );
    const exactMinimumSequence = Math.max(
      ancestorStrongSequence,
      currentStrongSequence ?? minimumSequence,
    );
    const selectedDefinitions = Array.from(
      definitions.get(key)?.values() ?? [],
    ).filter(
      (source) =>
        source.sequence >= exactMinimumSequence &&
        source.sequence <= useSequence,
    );
    if (
      selectedDefinitions.some((source) =>
        recursiveDefinitionSequences.has(source.sequence),
      )
    ) {
      cycle.detected = true;
    }
    const exact = selectedDefinitions.flatMap((source) =>
      sourcesForExpression(
        source.expression,
        source.projections,
        nextActive,
        cycle,
        source.typeFilter ?? typeFilter,
        Math.min(
          useSequence,
          expressionSequences.get(source.expression) ?? source.sequence,
        ),
      ),
    );
    const [projection] = place.projections.slice(-1);
    if (!projection) {
      return exact;
    }
    const parent = {
      root: place.root,
      projections: place.projections.slice(0, -1),
    };
    const parentMinimumSequence = Math.max(
      ancestorStrongSequence,
      typeof currentStrongSequence === "number"
        ? currentStrongSequence + 1
        : minimumSequence,
    );
    const inherited = sourcesForPlace(
      parent,
      nextActive,
      cycle,
      typeFilter,
      useSequence,
      parentMinimumSequence,
    ).flatMap((source) =>
      sourcesForExpression(
        source.expression,
        [...source.projections, projection],
        nextActive,
        cycle,
        undefined,
        useSequence,
      ).map((resolved) =>
        resolved.typeFilter === undefined &&
        (source.typeFilter !== undefined || typeFilter !== undefined)
          ? {
              ...resolved,
              typeFilter: source.typeFilter ?? typeFilter,
            }
          : resolved,
      ),
    );
    return [...exact, ...inherited];
  };
  const callableResults = new Map<HirExprId, readonly HirExprId[]>();
  const resultsForCallable = (body: HirExprId): readonly HirExprId[] => {
    const cached = callableResults.get(body);
    if (cached) {
      return cached;
    }
    const results = new Set<HirExprId>([body]);
    walkExpression({
      exprId: body,
      hir,
      options: { skipLambdas: true },
      onEnterStatement: (_statementId, statement) => {
        if (
          statement.kind === "return" &&
          typeof statement.value === "number"
        ) {
          results.add(statement.value);
        }
      },
    });
    const collected = Array.from(results);
    callableResults.set(body, collected);
    return collected;
  };
  const sourceFlows = new Map<string, ResultValueSourceFlow>();
  const sourceFlowForExpression = (
    expression: HirExprId,
    projections: readonly ResultValueProjection[] = [],
    useAtExpression: HirExprId = expression,
  ): ResultValueSourceFlow => {
    const useSequence =
      expressionSequences.get(useAtExpression) ?? Number.MAX_SAFE_INTEGER;
    const key = queryKey({
      expression,
      projections,
      useSequence,
    });
    const cached = sourceFlows.get(key);
    if (cached) {
      return cached;
    }
    const cycle = { detected: false };
    const sources = Array.from(
      new Map(
        sourcesForExpression(
          expression,
          projections,
          new Set(),
          cycle,
          undefined,
          useSequence,
        ).map((source) => [sourceKey(source), source]),
      ).values(),
    );
    const flow = { sources, recursive: cycle.detected };
    sourceFlows.set(key, flow);
    return flow;
  };
  const resolvedValues = new Map<string, readonly HirExprId[]>();
  return {
    valuesForExpression: (
      expression,
      projections = [],
      useAtExpression = expression,
    ) => {
      const useSequence =
        expressionSequences.get(useAtExpression) ?? Number.MAX_SAFE_INTEGER;
      const key = queryKey({
        expression,
        projections,
        useSequence,
      });
      const cached = resolvedValues.get(key);
      if (cached) {
        return cached;
      }
      const values = valuesForExpression(
        expression,
        projections,
        new Set(),
        undefined,
        useSequence,
      );
      resolvedValues.set(key, values);
      return values;
    },
    sourcesForExpression: (
      expression,
      projections = [],
      useAtExpression = expression,
    ) =>
      sourceFlowForExpression(expression, projections, useAtExpression).sources,
    sourceFlowForExpression,
    resultsForCallable,
  };
};
