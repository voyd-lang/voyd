import binaryen from "binaryen";
import { CompileExprOpts, compileExpression, mapBinaryenType } from "../assembler.js";
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
    fnType.parameters.map((p) => p.type!.id).join("_") + "->" + fnType.returnType.id;
  if (fnTypeCache.has(key)) return fnTypeCache.get(key)!;
  const params = [
    getClosureSuperType(opts.mod),
    ...fnType.parameters.map((p) => mapBinaryenType(opts, p.type!)),
  ];
  const paramType = binaryen.createType(params);
  const retType = mapBinaryenType(opts, fnType.returnType);
  const typeRef = (opts.mod as any).addFunctionType(
    `closure_type_${fnTypeCache.size}`,
    paramType,
    retType
  );
  fnTypeCache.set(key, typeRef);
  return typeRef;
};

export const compile = (opts: CompileExprOpts<Closure>): number => {
  const { expr: closure, mod } = opts;

  const superType = getClosureSuperType(mod);
  const envType = defineStructType(mod, {
    name: `ClosureEnv#${closure.syntaxId}`,
    fields: closure.captures.map((c, i) => ({
      name: `c${i}`,
      type: mapBinaryenType(opts, c.type!),
      mutable: false,
    })),
    supertype: binaryenTypeToHeapType(superType),
  });
  envTypeMap.set(closure.syntaxId, envType);

  const paramTypes = binaryen.createType([
    superType,
    ...closure.parameters.map((p) => mapBinaryenType(opts, p.type!)),
  ]);
  const returnType = mapBinaryenType(opts, closure.getReturnType());

  const body = compileExpression({
    ...opts,
    expr: closure.body,
    isReturnExpr: true,
  });

  const varTypes = closure.variables.map((v) => mapBinaryenType(opts, v.type!));
  const fnName = `__closure_${closure.syntaxId}`;
  const fnRef = mod.addFunction(fnName, paramTypes, returnType, varTypes, body);
  const fnHeapType = bin._BinaryenFunctionGetType(fnRef);
  const fnType = bin._BinaryenTypeFromHeapType(fnHeapType, false);

  const captures = closure.captures.map((c) =>
    mod.local.get(c.getIndex(), mapBinaryenType(opts, c.type!))
  );

  return initStruct(mod, envType, [
    refFunc(mod, fnName, fnType),
    ...captures,
  ]);
};

