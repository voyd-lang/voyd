import binaryen from "binaryen";
import {
  CompileExprOpts,
  compileExpression,
  mapBinaryenType,
  asStmt,
} from "../codegen.js";
import { Closure } from "../syntax-objects/closure.js";
import { FnType } from "../syntax-objects/types.js";
import {
  defineStructType,
  initStruct,
  refFunc,
  binaryenTypeToHeapType,
} from "../lib/binaryen-gc/index.js";
import { AugmentedBinaryen, TypeRef } from "../lib/binaryen-gc/types.js";

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
  const key =
    fnType.parameters.map((p) => p.type!.id).join("_") +
    "->" +
    fnType.returnType!.id;
  let typeRef = fnTypeCache.get(key);
  if (!typeRef) {
    const superType = getClosureSuperType(opts.mod);
    const paramTypes = binaryen.createType([
      superType,
      ...fnType.parameters.map((p) => mapBinaryenType(opts, p.type!)),
    ]);
    const returnType = mapBinaryenType(opts, fnType.returnType!);
    const tempName = `__closure_type_${fnTypeCache.size}`;
    const fnRef = opts.mod.addFunction(
      tempName,
      paramTypes,
      returnType,
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

  const paramTypes = binaryen.createType([
    superType,
    ...closure.parameters.map((p) => mapBinaryenType(opts, p.type!)),
  ]);
  const returnType = mapBinaryenType(opts, closure.getReturnType());

  const bodyExpr = compileExpression({
    ...opts,
    expr: closure.body,
    isReturnExpr: returnType !== binaryen.none,
  });
  const body = returnType === binaryen.none ? asStmt(mod, bodyExpr) : bodyExpr;

  const varTypes = closure.variables.map((v) => mapBinaryenType(opts, v.type!));
  const fnName = `__closure_${closure.syntaxId}`;
  const fnRef = mod.addFunction(fnName, paramTypes, returnType, varTypes, body);
  const fnHeapType = bin._BinaryenFunctionGetType(fnRef);
  const fnType = bin._BinaryenTypeFromHeapType(fnHeapType, false);

  // Record the function type so that calls to closures with this signature can
  // cast to the correct type when invoking via `call_ref`.
  const key =
    closure.parameters.map((p) => p.type!.id).join("_") +
    "->" +
    closure.getReturnType().id;
  fnTypeCache.set(key, fnType);

  const captures = closure.captures.map((c) =>
    mod.local.get(c.getIndex(), mapBinaryenType(opts, c.type!))
  );

  return initStruct(mod, envType, [refFunc(mod, fnName, fnType), ...captures]);
};
