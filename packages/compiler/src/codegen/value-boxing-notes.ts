import type { SourceSpan } from "../diagnostics/types.js";
import { diagnosticFromCode } from "../diagnostics/index.js";
import type { CodegenContext, HirExprId } from "./context.js";
import { getInlineHeapBoxType } from "./types.js";

const VALUE_BOXING_NOTE_STATE = Symbol.for("voyd.codegen.valueBoxingNotes");

type ValueBoxingNoteState = {
  seen?: Set<string>;
};

export const maybeReportValueBoxingNote = ({
  valueTypeId,
  context,
  exprId,
  span,
  ctx,
}: {
  valueTypeId: number;
  context: string;
  exprId?: HirExprId;
  span?: SourceSpan;
  ctx: CodegenContext;
}): void => {
  const boxType = getInlineHeapBoxType({ typeId: valueTypeId, ctx });
  if (typeof boxType !== "number") {
    return;
  }
  const resolvedSpan =
    span ??
    (typeof exprId === "number"
      ? ctx.module.hir.expressions.get(exprId)?.span
      : undefined);
  if (!resolvedSpan) {
    return;
  }
  const desc = ctx.program.types.getTypeDesc(valueTypeId);
  const valueTypeName =
    "name" in desc && typeof desc.name === "string" && desc.name.length > 0
      ? desc.name
      : `value ${valueTypeId}`;
  const state = ctx.programHelpers.getHelperState<ValueBoxingNoteState>(
    VALUE_BOXING_NOTE_STATE,
    () => ({ seen: new Set<string>() }),
  );
  const seen = state.seen ?? new Set<string>();
  state.seen = seen;
  const key = `${resolvedSpan.file}:${resolvedSpan.start}:${resolvedSpan.end}:${valueTypeId}:${context}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  ctx.diagnostics.report(
    diagnosticFromCode({
      code: "TY0045",
      params: {
        kind: "value-boxing-note",
        valueTypeName,
        context,
      },
      span: resolvedSpan,
      severity: "note",
    }),
  );
};
