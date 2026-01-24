import type { Expr } from "../../parser/index.js";
import { isForm, isIdentifierAtom } from "../../parser/index.js";
import type { SerializerAttribute } from "../../parser/attributes.js";
import type { BindingContext } from "./types.js";

type SymbolRef = { moduleId: string; symbol: number };

const pathFromExpr = (expr: Expr): string[] | null => {
  if (isIdentifierAtom(expr)) {
    return [expr.value];
  }
  if (!isForm(expr) || !expr.calls("::") || expr.length !== 3) {
    return null;
  }
  const left = expr.at(1);
  const right = expr.at(2);
  if (!left || !right) {
    return null;
  }
  const leftPath = pathFromExpr(left);
  if (!leftPath) {
    return null;
  }
  if (isIdentifierAtom(right)) {
    return [...leftPath, right.value];
  }
  return null;
};

const resolveSymbolRefFromPath = ({
  path,
  ctx,
}: {
  path: readonly string[];
  ctx: BindingContext;
}): SymbolRef | undefined => {
  if (path.length === 0) {
    return undefined;
  }
  if (path.length === 1) {
    const symbol = ctx.symbolTable.resolve(path[0]!, ctx.symbolTable.rootScope);
    if (typeof symbol !== "number") {
      return undefined;
    }
    const record = ctx.symbolTable.getSymbol(symbol);
    const importMeta = (record.metadata ?? {}) as {
      import?: { moduleId?: string; symbol?: number };
    };
    if (
      importMeta.import &&
      typeof importMeta.import.moduleId === "string" &&
      typeof importMeta.import.symbol === "number"
    ) {
      return {
        moduleId: importMeta.import.moduleId,
        symbol: importMeta.import.symbol,
      };
    }
    return { moduleId: ctx.module.id, symbol };
  }

  const moduleId = path.slice(0, -1).join("::");
  const exports = ctx.moduleExports.get(moduleId);
  if (!exports) {
    return undefined;
  }
  const targetName = path[path.length - 1]!;
  const entry = exports.get(targetName);
  if (!entry) {
    return undefined;
  }
  return { moduleId: entry.moduleId, symbol: entry.symbol };
};

const resolveSerializerAttribute = ({
  attr,
  ctx,
}: {
  attr: SerializerAttribute;
  ctx: BindingContext;
}): { formatId: string; encode: SymbolRef; decode: SymbolRef } => {
  const encodePath = pathFromExpr(attr.encode);
  if (!encodePath) {
    throw new Error("@serializer encode fn must be a path or identifier");
  }
  const decodePath = pathFromExpr(attr.decode);
  if (!decodePath) {
    throw new Error("@serializer decode fn must be a path or identifier");
  }
  const encode = resolveSymbolRefFromPath({ path: encodePath, ctx });
  if (!encode) {
    throw new Error(`@serializer encode fn not found: ${encodePath.join("::")}`);
  }
  const decode = resolveSymbolRefFromPath({ path: decodePath, ctx });
  if (!decode) {
    throw new Error(`@serializer decode fn not found: ${decodePath.join("::")}`);
  }
  return { formatId: attr.formatId, encode, decode };
};

export const resolveSerializerAttributes = (ctx: BindingContext): void => {
  ctx.decls.typeAliases.forEach((decl) => {
    const attr = decl.form?.attributes?.serializer as
      | SerializerAttribute
      | undefined;
    if (!attr) {
      return;
    }
    const serializer = resolveSerializerAttribute({ attr, ctx });
    ctx.symbolTable.setSymbolMetadata(decl.symbol, { serializer });
  });

  ctx.decls.objects.forEach((decl) => {
    const attr = decl.form?.attributes?.serializer as
      | SerializerAttribute
      | undefined;
    if (!attr) {
      return;
    }
    const serializer = resolveSerializerAttribute({ attr, ctx });
    ctx.symbolTable.setSymbolMetadata(decl.symbol, { serializer });
  });
};
