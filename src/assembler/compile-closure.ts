import binaryen from "binaryen";
import { CompileExprOpts, compileExpression, mapBinaryenType } from "../assembler.js";
import { Closure } from "../syntax-objects/closure.js";
import { Expr } from "../syntax-objects/expr.js";
import { Identifier } from "../syntax-objects/identifier.js";
import { NamedEntity } from "../syntax-objects/named-entity.js";
import { refFunc, initStruct } from "../lib/binaryen-gc/index.js";
import * as gc from "../lib/binaryen-gc/index.js";
import { AugmentedBinaryen } from "../lib/binaryen-gc/types.js";
import { Parameter } from "../syntax-objects/parameter.js";
import { Variable } from "../syntax-objects/variable.js";

const bin = binaryen as unknown as AugmentedBinaryen;

const collectCaptured = (
  expr: Expr,
  closure: Closure,
  captured: Map<NamedEntity, number>
) => {
  if (expr.isIdentifier()) {
    const entity = (expr as Identifier).resolve();
    if (
      entity &&
      (entity.isVariable() || entity.isParameter()) &&
      entity.parentFn !== closure
    ) {
      if (!captured.has(entity)) {
        captured.set(entity, captured.size);
      }
    }
  }
  const children = (expr as any).children as Expr[] | undefined;
  if (children) {
    children.forEach((child) => collectCaptured(child, closure, captured));
  }
};

export const compile = (opts: CompileExprOpts<Closure>): number => {
  const { expr: closure, mod } = opts;

  const captured = new Map<NamedEntity, number>();
  collectCaptured(closure.body, closure, captured);

  const fields = [
    { name: "__fn", type: bin.funcref, mutable: false },
    ...Array.from(captured.keys()).map((entity) => ({
      name: entity.name.value,
      type: mapBinaryenType(opts, (entity as any).type!),
      mutable: false,
    })),
  ];

  const envType = gc.defineStructType(mod, {
    name: `closure_env_${closure.syntaxId}`,
    fields,
  });

  const capturedFieldMap = new Map<NamedEntity, number>();
  Array.from(captured.entries()).forEach(([entity, index]) => {
    capturedFieldMap.set(entity, index + 1); // offset for fn field
  });

  const body = compileExpression({
    ...opts,
    expr: closure.body,
    isReturnExpr: true,
    closureContext: {
      envType,
      capturedFieldIndices: capturedFieldMap,
    },
  });

  const paramTypes = [
    envType,
    ...closure.parameters.map((p: Parameter) => mapBinaryenType(opts, p.type!)),
  ];
  const returnType = mapBinaryenType(opts, closure.getReturnType());
  const localTypes = closure.variables.map((v: Variable) =>
    mapBinaryenType(opts, v.type!)
  );

  const fnName = `__closure_fn_${closure.syntaxId}`;
  const fnRef = mod.addFunction(
    fnName,
    binaryen.createType(paramTypes),
    returnType,
    localTypes,
    body
  );

  // Obtain function type for ref.func
  const fnHeap = bin._BinaryenFunctionGetType(fnRef);
  const fnType = bin._BinaryenTypeFromHeapType(fnHeap, false);

  const capturedValues = Array.from(captured.keys()).map((entity) => {
    const type = mapBinaryenType(opts, (entity as any).type!);
    return mod.local.get((entity as any).getIndex(), type);
  });

  const closureValue = initStruct(mod, envType, [
    refFunc(mod, fnName, fnType),
    ...capturedValues,
  ]);

  // store types on closure type for later use
  const fnTypeObj = closure.getType();
  fnTypeObj.setAttribute("binaryenType", envType);
  fnTypeObj.setAttribute("binaryenFnRefType", fnType);

  return closureValue;
};

