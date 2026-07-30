import type { HirExpression, HirGraph } from "../hir/index.js";
import type { HirExprId } from "../ids.js";
import type { CallArgumentPlanEntry } from "./types.js";

export type CallParameterBinding = {
  label?: string;
  defaultValue?: HirExprId;
  defaulted?: boolean;
};

export type CallArgumentSource = {
  moduleId: string;
  expression: HirExprId;
  field?: string;
};

/**
 * Canonically aligns call-site arguments with declaration parameters.
 *
 * Typing plans take precedence. Direct calls without a plan use declaration
 * labels and defaults, so semantic consumers do not need independent
 * positional fallbacks.
 */
export const bindCallArgumentSources = ({
  expression,
  plan,
  parameters,
  callerModuleId,
  parameterModuleId = callerModuleId,
  hir,
}: {
  expression: HirExpression;
  plan?: readonly CallArgumentPlanEntry[];
  parameters?: readonly CallParameterBinding[];
  callerModuleId: string;
  parameterModuleId?: string;
  hir: HirGraph;
}): readonly (CallArgumentSource | undefined)[] => {
  const raw = rawCallArgumentSources(expression, callerModuleId);
  if (plan) {
    return plan.map((entry, index) => {
      if (entry.kind === "direct") {
        return raw[entry.argIndex];
      }
      if (entry.kind === "container-field") {
        const container = raw[entry.containerArgIndex];
        if (!container) {
          return undefined;
        }
        const containerExpression = hir.expressions.get(container.expression);
        const field =
          containerExpression?.exprKind === "object-literal"
            ? containerExpression.entries.find(
                (candidate) =>
                  candidate.kind === "field" &&
                  candidate.name === entry.fieldName,
              )
            : undefined;
        return field?.kind === "field"
          ? { moduleId: callerModuleId, expression: field.value }
          : { ...container, field: entry.fieldName };
      }
      return entry.kind === "omitted-default"
        ? defaultSource(parameters?.[index], parameterModuleId)
        : undefined;
    });
  }
  if (!parameters) {
    return raw;
  }
  const offset = expression.exprKind === "method-call" ? 1 : 0;
  const aligned: (CallArgumentSource | undefined)[] = Array(
    parameters.length,
  ).fill(undefined);
  if (expression.exprKind === "method-call") {
    aligned[0] = {
      moduleId: callerModuleId,
      expression: expression.target,
    };
  }
  const explicit =
    expression.exprKind === "call" || expression.exprKind === "method-call"
      ? expression.args
      : [];
  let positional = offset;
  explicit.forEach((argument) => {
    if (argument.label) {
      const index = parameters
        .slice(offset)
        .findIndex((parameter) => parameter.label === argument.label);
      if (index >= 0) {
        aligned[index + offset] = {
          moduleId: callerModuleId,
          expression: argument.expr,
        };
      }
      return;
    }
    while (aligned[positional] !== undefined) {
      positional += 1;
    }
    if (positional < aligned.length) {
      aligned[positional] = {
        moduleId: callerModuleId,
        expression: argument.expr,
      };
      positional += 1;
    }
  });
  return aligned.map(
    (argument, index) =>
      argument ?? defaultSource(parameters[index], parameterModuleId),
  );
};

export const bindCallArgumentExpressions = (
  input: Parameters<typeof bindCallArgumentSources>[0],
): readonly (HirExprId | undefined)[] =>
  bindCallArgumentSources(input).map((source) =>
    source?.moduleId === input.callerModuleId ? source.expression : undefined,
  );

export const omittedDefaultParameterIndices = ({
  expression,
  plan,
  parameters,
  callerModuleId,
  hir,
}: {
  expression: HirExpression;
  plan?: readonly CallArgumentPlanEntry[];
  parameters?: readonly CallParameterBinding[];
  callerModuleId: string;
  hir: HirGraph;
}): readonly number[] => {
  if (plan) {
    return plan.flatMap((entry, index) =>
      entry.kind === "omitted-default" ? [index] : [],
    );
  }
  if (!parameters) {
    return [];
  }
  const explicit = bindCallArgumentSources({
    expression,
    parameters: parameters.map((parameter) => ({
      label: parameter.label,
    })),
    callerModuleId,
    hir,
  });
  return parameters.flatMap((parameter, index) =>
    explicit[index] === undefined &&
    (parameter.defaulted === true || typeof parameter.defaultValue === "number")
      ? [index]
      : [],
  );
};

const rawCallArgumentSources = (
  expression: HirExpression,
  moduleId: string,
): readonly CallArgumentSource[] => {
  if (expression.exprKind === "method-call") {
    return [
      { moduleId, expression: expression.target },
      ...expression.args.map((argument) => ({
        moduleId,
        expression: argument.expr,
      })),
    ];
  }
  return expression.exprKind === "call"
    ? expression.args.map((argument) => ({
        moduleId,
        expression: argument.expr,
      }))
    : [];
};

const defaultSource = (
  parameter: CallParameterBinding | undefined,
  moduleId: string,
): CallArgumentSource | undefined =>
  typeof parameter?.defaultValue === "number"
    ? { moduleId, expression: parameter.defaultValue }
    : undefined;
