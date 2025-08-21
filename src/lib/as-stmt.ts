import binaryen from "binaryen";

export const asStmt = (mod: binaryen.Module, e: binaryen.ExpressionRef) => {
  const bin = binaryen as any;
  const t = bin.getExpressionType(e) ?? bin.getExpressionInfo(e).type;
  if (t === binaryen.none || t === binaryen.unreachable) return e;
  const parts = bin.expandType ? bin.expandType(t) : [t];
  if (parts.length > 1) return (mod as any).tuple.drop(e);
  return mod.drop(e);
};
