import type { EffectRowId } from "../ids.js";
import type { EffectOp, EffectTable } from "./effect-table.js";

export const formatEffectOp = (op: EffectOp): string =>
  typeof op.region === "number" ? `${op.name}@${op.region}` : op.name;

export const formatEffectRow = (
  row: EffectRowId,
  effects: Pick<EffectTable, "getRow">,
): string => {
  const desc = effects.getRow(row);
  const ops = desc.operations.map(formatEffectOp);
  if (ops.length === 0 && desc.tailVar) {
    return "open effect row";
  }
  if (ops.length === 0) {
    return "()";
  }
  const suffix = desc.tailVar ? ", ..." : "";
  return `${ops.join(", ")}${suffix}`;
};

