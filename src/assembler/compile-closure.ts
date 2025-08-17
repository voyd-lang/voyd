import binaryen from "binaryen";
import {
  CompileExprOpts,
  compileExpression,
  mapBinaryenType,
} from "../assembler.js";
import { Closure } from "../syntax-objects/closure.js";
import { FnType } from "../syntax-objects/types.js";
import {
  defineStructType,
  initStruct,
  refFunc,
  refCast,
  binaryenTypeToHeapType,
} from "../lib/binaryen-gc/index.js";
import { AugmentedBinaryen } from "../lib/binaryen-gc/types.js";

const bin = binaryen as unknown as AugmentedBinaryen;

let baseClosureType: number | undefined;

export const getClosureBaseType = (mod: binaryen.Module) => {
  if (!baseClosureType) {
    baseClosureType = defineStructType(mod, {
      name: "ClosureBase",
      fields: [{ name: "__fn_ptr", type: bin.funcref, mutable: false }],
      final: false,
    });
  }
  return baseClosureType;
};

export const getFnBinaryenType = (
  _opts: CompileExprOpts,
  fnType: FnType
): number => {
  if (!fnType.hasAttribute("binaryenFunctionType")) {
    throw new Error("Fn type not yet compiled");
  }
  return fnType.getAttribute("binaryenFunctionType") as number;
};

export const compile = (opts: CompileExprOpts<Closure>): number => {
  const { expr: closure, mod } = opts;

  const fnType = closure.getType();

  const closureStruct = defineStructType(mod, {
    name: `Closure#${closure.syntaxId}`,
    fields: [
      { name: "__fn_ptr", type: bin.funcref, mutable: false },
      ...closure.captures.map((c) => ({
        name: c.name.value,
        type: mapBinaryenType(opts, c.type!),
        mutable: false,
      })),
    ],
    supertype: binaryenTypeToHeapType(getClosureBaseType(mod)),
  });

  closure.setAttribute("binaryenType", closureStruct);

  const paramTypes = binaryen.createType([
    bin.eqref,
    ...closure.parameters.map((p) => mapBinaryenType(opts, p.type!)),
  ]);
  const returnType = mapBinaryenType(opts, closure.getReturnType());

  const body = compileExpression({
    ...opts,
    expr: closure.body,
    isReturnExpr: true,
  });

  const varTypes = closure.variables.map((v) => mapBinaryenType(opts, v.type!));

  const fnRef = mod.addFunction(fnType.id, paramTypes, returnType, varTypes, body);
  const heapType = bin._BinaryenFunctionGetType(fnRef);
  const fnBinaryenType = bin._BinaryenTypeFromHeapType(heapType, false);
  fnType.setAttribute("binaryenFunctionType", fnBinaryenType);

  const funcRef = refFunc(mod, fnType.id, fnBinaryenType);

  const captureValues = closure.captures.map((entity) => {
    const valueType = mapBinaryenType(opts, entity.type!);
    let val = mod.local.get(
      entity.getIndex(),
      mapBinaryenType(opts, entity.originalType ?? entity.type!)
    );
    if (entity.requiresCast) {
      val = refCast(mod, val, valueType);
    }
    return val;
  });

  return initStruct(mod, closureStruct, [funcRef, ...captureValues]);
};

