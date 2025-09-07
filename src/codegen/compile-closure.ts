import binaryen from "binaryen";
import {
  CompileExprOpts,
  compileExpression,
  mapBinaryenType,
  asStmt,
} from "../codegen.js";
import { Closure } from "../syntax-objects/closure.js";
import { FnType, voydBaseObject } from "../syntax-objects/types.js";
import {
  defineStructType,
  initStruct,
  refFunc,
  binaryenTypeToHeapType,
} from "../lib/binaryen-gc/index.js";
import { AugmentedBinaryen, TypeRef } from "../lib/binaryen-gc/types.js";
import { normalizeClosureFnType } from "./helpers/closure-type.js";

const bin = binaryen as unknown as AugmentedBinaryen;

let closureSuperType: TypeRef | undefined;
const envTypeMap = new Map<number, TypeRef>();
const fnTypeCache = new Map<string, TypeRef>();

export const getClosureSuperType = (mod: binaryen.Module): TypeRef => {
  if (closureSuperType) return closureSuperType;
  closureSuperType = defineStructType(mod, {
    name: "Closure",
    fields: [{ name: "__fn", type: bin.funcref, mutable: false }],
    final: false,
  });
  return closureSuperType;
};

export const getClosureEnvType = (id: number): TypeRef | undefined => {
  return envTypeMap.get(id);
};

export const getClosureFunctionType = (
  opts: CompileExprOpts,
  fnType: FnType
): TypeRef => {
  const superType = getClosureSuperType(opts.mod);
  const norm = normalizeClosureFnType(opts, fnType);
  const paramBinTypes = [superType, ...norm.paramBinTypes.slice(1)];
  const returnBinType = norm.returnBinType;
  const key = `${paramBinTypes.join(",")}->${returnBinType}`;
  let typeRef = fnTypeCache.get(key);
  if (!typeRef) {
    const paramTypes = binaryen.createType(paramBinTypes);
    const tempName = `__closure_type_${fnTypeCache.size}`;
    const fnRef = opts.mod.addFunction(
      tempName,
      paramTypes,
      returnBinType,
      [],
      opts.mod.nop()
    );
    const fnHeapType = bin._BinaryenFunctionGetType(fnRef);
    typeRef = bin._BinaryenTypeFromHeapType(fnHeapType, false);
    fnTypeCache.set(key, typeRef);
    opts.mod.removeFunction(tempName);
  }
  return typeRef;
};

export const compile = (opts: CompileExprOpts<Closure>): number => {
  const { expr: closure, mod } = opts;

  const superType = getClosureSuperType(mod);
  const envType = defineStructType(mod, {
    name: `ClosureEnv#${closure.syntaxId}`,
    // A closure environment extends the base closure type, which defines the
    // `__fn` field. When constructing a subtype Binaryen expects the complete
    // list of fields, including those from the supertype, so start with the
    // `__fn` field and then append the captured variables.
    fields: [
      { name: "__fn", type: bin.funcref, mutable: false },
      ...closure.captures.map((c, i) => ({
        name: `c${i}`,
        type: mapBinaryenType(opts, c.type!),
        mutable: false,
      })),
    ],
    supertype: binaryenTypeToHeapType(superType),
    final: true,
  });
  envTypeMap.set(closure.syntaxId, envType);

  // Prefer the call-site function signature when available to guarantee the
  // function-reference type identity matches the caller's expected type. This
  // avoids ref.cast traps when generics/contextual typing pick slightly
  // different but compatible shapes.
  const callSiteSig = closure.getAttribute(
    "parameterFnType"
  ) as FnType | undefined;
  const sigSource = callSiteSig ?? closure.getType();
  const norm = normalizeClosureFnType(opts, sigSource);
  const paramTypes = binaryen.createType([superType, ...norm.paramBinTypes.slice(1)]);
  const returnType = norm.returnBinType;

  const bodyExpr = compileExpression({
    ...opts,
    expr: closure.body,
    isReturnExpr: returnType !== binaryen.none,
  });
  const body = returnType === binaryen.none ? asStmt(mod, bodyExpr) : bodyExpr;

  const varTypes = closure.variables.map((v) => mapBinaryenType(opts, v.type!));
  const fnName = `__closure_${closure.syntaxId}`;
  mod.addFunction(fnName, paramTypes, returnType, varTypes, body);

  // Use a stable, cached typed function reference identity derived from the
  // call-site (when provided) so casts at call sites use the same heap type.
  const desiredFnType = getClosureFunctionType(opts, sigSource);

  const captures = closure.captures.map((c) =>
    mod.local.get(c.getIndex(), mapBinaryenType(opts, c.type!))
  );

  return initStruct(mod, envType, [
    refFunc(mod, fnName, desiredFnType),
    ...captures,
  ]);
};
