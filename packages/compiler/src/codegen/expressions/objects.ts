import binaryen from "binaryen";
import { refCast, structGetFieldValue } from "@voyd-lang/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirExprId,
  HirExpression,
  HirFieldAccessExpr,
  HirObjectLiteralExpr,
} from "../context.js";
import {
  allocateTempLocal,
  getRequiredBinding,
  loadBindingStorageRef,
  loadBindingValue,
  loadLocalValue,
  storeLocalValue,
} from "../locals.js";
import {
  coerceValueToType,
  initStructuralValue,
  liftHeapValueToInline,
  lowerValueForHeapField,
  loadStructuralField,
  storeValueIntoStorageRef,
} from "../structural.js";
import { compileOptionalNoneValue } from "../optionals.js";
import {
  getExprBinaryenType,
  getInlineHeapBoxType,
  getInlineUnionLayout,
  getOptionalLayoutInfo,
  getRequiredExprType,
  getStructuralTypeInfo,
  getSymbolTypeId,
  getUnresolvedExprType,
  shouldInlineUnionLayout,
  wasmTypeFor,
} from "../types.js";
import { coerceExprToWasmType } from "../wasm-type-coercions.js";
import { maybeReportValueBoxingNote } from "../value-boxing-notes.js";
import { tryCompileProjectedFieldAccess } from "../projected-element-views.js";

export const compileObjectLiteralExpr = (
  expr: HirObjectLiteralExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  expectedResultTypeId?: number,
  outResultStorageRef?: binaryen.ExpressionRef,
): CompiledExpression => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const typeId = getRequiredExprType(expr.id, ctx, typeInstanceId);
  const structInfo = getStructuralTypeInfo(typeId, ctx);
  if (!structInfo) {
    throw new Error("object literal missing structural type information");
  }

  const expectedOptionalInfo =
    typeof expectedResultTypeId === "number" &&
    shouldInlineUnionLayout(expectedResultTypeId, ctx)
      ? getOptionalLayoutInfo(expectedResultTypeId, ctx)
      : undefined;
  const isDirectSomeToOptional =
    expectedOptionalInfo &&
    structInfo.fields.length === 1 &&
    structInfo.fields[0]?.name === "value" &&
    expr.entries.length === 1 &&
    expr.entries[0]?.kind === "field" &&
    expr.entries[0]?.name === "value";
  const isDirectNoneToOptional =
    expectedOptionalInfo &&
    structInfo.fields.length === 0 &&
    expr.entries.length === 0;
  if (isDirectSomeToOptional) {
    const valueEntry = expr.entries[0]!;
    const payloadTypeId = getRequiredExprType(valueEntry.value, ctx, typeInstanceId);
    const payload = compileExpr({
      exprId: valueEntry.value,
      ctx,
      fnCtx,
      expectedResultTypeId: expectedOptionalInfo.innerType,
    }).expr;
    const coerced = coerceValueToType({
      value: payload,
      actualType: payloadTypeId,
      targetType: expectedResultTypeId!,
      ctx,
      fnCtx,
    });
    const direct = storeDirectOutResultValue({
      value: coerced,
      actualTypeId: expectedResultTypeId!,
      targetTypeId: expectedResultTypeId!,
      outResultStorageRef,
      ops: [],
      ctx,
      fnCtx,
    });
    if (direct) {
      return direct;
    }
    return {
      expr: coerced,
      usedReturnCall: false,
    };
  }
  if (isDirectNoneToOptional) {
    const noneValue = compileOptionalNoneValue({
      targetTypeId: expectedResultTypeId!,
      ctx,
      fnCtx,
    });
    const direct = storeDirectOutResultValue({
      value: noneValue,
      actualTypeId: expectedResultTypeId!,
      targetTypeId: expectedResultTypeId!,
      outResultStorageRef,
      ops: [],
      ctx,
      fnCtx,
    });
    if (direct) {
      return direct;
    }
    return {
      expr: noneValue,
      usedReturnCall: false,
    };
  }

  const ops: binaryen.ExpressionRef[] = [];
  const fieldTemps = new Map<string, ReturnType<typeof allocateTempLocal>>();
  const initialized = new Set<string>();
  const usesInlineLayout = structInfo.layoutKind === "value-object";

  structInfo.fields.forEach((field) => {
      fieldTemps.set(
        field.name,
        allocateTempLocal(
          usesInlineLayout ? field.wasmType : field.heapWasmType,
          fnCtx,
          field.typeId,
          ctx,
        ),
      );
  });

  expr.entries.forEach((entry) => {
    if (entry.kind === "field") {
      const binding = fieldTemps.get(entry.name);
      if (!binding) {
        throw new Error(
          `object literal cannot set unknown field ${entry.name}`
        );
      }
      const expectedTypeId = structInfo.fieldMap.get(entry.name)?.typeId;
      const actualTypeId = getRequiredExprType(entry.value, ctx, typeInstanceId);
      const value = compileExpr({
        exprId: entry.value,
        ctx,
        fnCtx,
        expectedResultTypeId: expectedTypeId,
      });
      const coerced = coerceValueToType({
        value: value.expr,
        actualType: actualTypeId,
        targetType: expectedTypeId,
        ctx,
        fnCtx,
      });
      const stored = usesInlineLayout
        ? coerced
        : lowerValueForHeapField({
            value: coerced,
            typeId: expectedTypeId ?? actualTypeId,
            targetType: binding.type,
            ctx,
            fnCtx,
          });
      if (!usesInlineLayout && typeof expectedTypeId === "number") {
        maybeReportValueBoxingNote({
          valueTypeId: expectedTypeId,
          context: `object field '${entry.name}'`,
          exprId: entry.value,
          ctx,
        });
      }
      ops.push(storeLocalValue({ binding, value: stored, ctx, fnCtx }));
      initialized.add(entry.name);
      return;
    }

    const spreadType = getRequiredExprType(
      entry.value,
      ctx,
      typeInstanceId
    );
    const spreadInfo = getStructuralTypeInfo(spreadType, ctx);
    if (!spreadInfo) {
      throw new Error("object spread requires a structural object");
    }

    const spreadTemp = allocateTempLocal(
      spreadInfo.interfaceType,
      fnCtx,
      spreadType,
      ctx,
    );
    ops.push(
      storeLocalValue({
        binding: spreadTemp,
        value: compileExpr({
          exprId: entry.value,
          ctx,
          fnCtx,
          expectedResultTypeId: spreadType,
        }).expr,
        ctx,
        fnCtx,
      }),
    );

    spreadInfo.fields.forEach((sourceField) => {
      const target = fieldTemps.get(sourceField.name);
      if (!target) {
        return;
      }
      const load = loadStructuralField({
        structInfo: spreadInfo,
        field: sourceField,
        pointer: () => loadLocalValue(spreadTemp, ctx),
        ctx,
      });
      const expectedTypeId = structInfo.fieldMap.get(sourceField.name)?.typeId;
      const coerced = coerceValueToType({
        value: load,
        actualType: sourceField.typeId,
        targetType: expectedTypeId,
        ctx,
        fnCtx,
      });
      const stored = usesInlineLayout
        ? coerced
        : lowerValueForHeapField({
            value: coerced,
            typeId: expectedTypeId ?? sourceField.typeId,
            targetType: target.type,
            ctx,
            fnCtx,
          });
      if (!usesInlineLayout && typeof expectedTypeId === "number") {
        maybeReportValueBoxingNote({
          valueTypeId: expectedTypeId,
          context: `object spread field '${sourceField.name}'`,
          exprId: entry.value,
          ctx,
        });
      }
      ops.push(storeLocalValue({ binding: target, value: stored, ctx, fnCtx }));
      initialized.add(sourceField.name);
    });
  });

  structInfo.fields.forEach((field) => {
    if (!initialized.has(field.name)) {
      if (field.optional) {
        const binding = fieldTemps.get(field.name);
        if (!binding) {
          throw new Error(`missing binding for field ${field.name}`);
        }
        const noneValue =
          usesInlineLayout
            ? compileOptionalNoneValue({
                targetTypeId: field.typeId,
                ctx,
                fnCtx,
              })
            : lowerValueForHeapField({
                value: compileOptionalNoneValue({
                  targetTypeId: field.typeId,
                  ctx,
                  fnCtx,
                }),
                typeId: field.typeId,
                targetType: binding.type,
                ctx,
                fnCtx,
              });
        ops.push(
          storeLocalValue({
            binding,
            value: noneValue,
            ctx,
            fnCtx,
          }),
        );
        initialized.add(field.name);
        return;
      }
      throw new Error(`missing initializer for field ${field.name}`);
    }
  });

  const fieldValues = structInfo.fields.map((field) => {
    const binding = fieldTemps.get(field.name);
    if (!binding) {
      throw new Error(`missing binding for field ${field.name}`);
    }
    const value = loadLocalValue(binding, ctx);
    if (usesInlineLayout) {
      return coerceExprToWasmType({
        expr: value,
        targetType: field.wasmType,
        ctx,
      });
    }
    return coerceExprToWasmType({
      expr: value,
      targetType: field.heapWasmType,
      ctx,
    });
  });
  const literal = initStructuralValue({
    structInfo,
    fieldValues,
    ctx,
  });
  const direct = storeDirectOutResultValue({
    value: literal,
    actualTypeId: typeId,
    targetTypeId: expectedResultTypeId ?? typeId,
    outResultStorageRef,
    ops,
    ctx,
    fnCtx,
  });
  if (direct) {
    return direct;
  }
  const stabilizedLiteral = (() => {
    const literalType = binaryen.getExpressionType(literal);
    if (binaryen.expandType(literalType).length <= 1) {
      return literal;
    }
    const temp = allocateTempLocal(literalType, fnCtx, typeId, ctx);
    return ctx.mod.block(
      null,
      [
        storeLocalValue({
          binding: temp,
          value: literal,
          ctx,
          fnCtx,
        }),
        loadLocalValue(temp, ctx),
      ],
      literalType,
    );
  })();
  if (ops.length === 0) {
    return { expr: stabilizedLiteral, usedReturnCall: false };
  }
  ops.push(stabilizedLiteral);
  return {
    expr: ctx.mod.block(
      null,
      ops,
      binaryen.getExpressionType(stabilizedLiteral)
    ),
    usedReturnCall: false,
  };
};

export const compileTupleExpr = (
  expr: HirExpression & { exprKind: "tuple"; elements: readonly HirExprId[] },
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  expectedResultTypeId?: number,
  outResultStorageRef?: binaryen.ExpressionRef,
): CompiledExpression => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const typeId = getRequiredExprType(expr.id, ctx, typeInstanceId);
  const structInfo = getStructuralTypeInfo(typeId, ctx);
  if (!structInfo) {
    throw new Error("tuple missing structural type information");
  }

  if (structInfo.fields.length !== expr.elements.length) {
    throw new Error("tuple arity does not match inferred structural type");
  }

  const ops: binaryen.ExpressionRef[] = [];
  const fieldTemps = new Map<string, ReturnType<typeof allocateTempLocal>>();
  const usesInlineLayout = structInfo.layoutKind === "value-object";

  expr.elements.forEach((elementId, index) => {
    const fieldName = `${index}`;
    const field = structInfo.fieldMap.get(fieldName);
    if (!field) {
      throw new Error(`tuple element ${index} missing corresponding field`);
    }
    const temp = allocateTempLocal(
      usesInlineLayout ? field.wasmType : field.heapWasmType,
      fnCtx,
      field.typeId,
      ctx,
    );
    fieldTemps.set(field.name, temp);
    const compiled = compileExpr({
      exprId: elementId,
      ctx,
      fnCtx,
      expectedResultTypeId: field.typeId,
    }).expr;
    ops.push(
      storeLocalValue({
        binding: temp,
        value: usesInlineLayout
          ? compiled
          : lowerValueForHeapField({
              value: compiled,
              typeId: field.typeId,
              targetType: temp.type,
              ctx,
              fnCtx,
            }),
        ctx,
        fnCtx,
      }),
    );
  });

  const fieldValues = structInfo.fields.map((field) => {
    const temp = fieldTemps.get(field.name);
    if (!temp) {
      throw new Error(`missing binding for tuple field ${field.name}`);
    }
    const value = loadLocalValue(temp, ctx);
    if (usesInlineLayout) {
      return coerceExprToWasmType({
        expr: value,
        targetType: field.wasmType,
        ctx,
      });
    }
    return coerceExprToWasmType({
      expr: value,
      targetType: field.heapWasmType,
      ctx,
    });
  });

  const tupleValue = initStructuralValue({
    structInfo,
    fieldValues,
    ctx,
  });
  const direct = storeDirectOutResultValue({
    value: tupleValue,
    actualTypeId: typeId,
    targetTypeId: expectedResultTypeId ?? typeId,
    outResultStorageRef,
    ops,
    ctx,
    fnCtx,
  });
  if (direct) {
    return direct;
  }
  const stabilizedTupleValue = (() => {
    const tupleType = binaryen.getExpressionType(tupleValue);
    if (binaryen.expandType(tupleType).length <= 1) {
      return tupleValue;
    }
    const temp = allocateTempLocal(tupleType, fnCtx, typeId, ctx);
    return ctx.mod.block(
      null,
      [
        storeLocalValue({
          binding: temp,
          value: tupleValue,
          ctx,
          fnCtx,
        }),
        loadLocalValue(temp, ctx),
      ],
      tupleType,
    );
  })();
  if (ops.length === 0) {
    return { expr: stabilizedTupleValue, usedReturnCall: false };
  }
  ops.push(stabilizedTupleValue);
  return {
    expr: ctx.mod.block(
      null,
      ops,
      binaryen.getExpressionType(stabilizedTupleValue)
    ),
    usedReturnCall: false,
  };
};

const storeDirectOutResultValue = ({
  value,
  actualTypeId,
  targetTypeId,
  outResultStorageRef,
  ops,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  actualTypeId: number;
  targetTypeId: number;
  outResultStorageRef?: binaryen.ExpressionRef;
  ops: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): CompiledExpression | undefined => {
  if (typeof outResultStorageRef !== "number") {
    return undefined;
  }

  if (typeof getInlineHeapBoxType({ typeId: targetTypeId, ctx }) !== "number") {
    return undefined;
  }

  if (
    actualTypeId !== targetTypeId &&
    wasmTypeFor(actualTypeId, ctx) !== wasmTypeFor(targetTypeId, ctx)
  ) {
    return undefined;
  }

  return {
    expr: ctx.mod.block(
      null,
      [
        ...ops,
        storeValueIntoStorageRef({
          pointer: () => outResultStorageRef,
          value,
          typeId: targetTypeId,
          ctx,
          fnCtx,
        }),
      ],
      binaryen.none,
    ),
    usedReturnCall: false,
    usedOutResultStorageRef: true,
  };
};

export const compileFieldAccessExpr = (
  expr: HirFieldAccessExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): CompiledExpression => {
  const projected = tryCompileProjectedFieldAccess({
    expr,
    ctx,
    fnCtx,
    compileExpr,
  });
  if (projected) {
    return projected;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const expectedFieldTypeId = getRequiredExprType(expr.id, ctx, typeInstanceId);
  const expectedFieldWasmType = getExprBinaryenType(expr.id, ctx, typeInstanceId);
  const targetExpr = ctx.module.hir.expressions.get(expr.target);

  const actualTargetTypeId = getUnresolvedExprType(expr.target, ctx, typeInstanceId);
  const bindingActualTargetTypeId =
    targetExpr?.exprKind === "identifier"
      ? getRequiredBinding(targetExpr.symbol, ctx, fnCtx).typeId
      : undefined;
  const declaredTargetTypeId =
    targetExpr?.exprKind === "identifier"
      ? getSymbolTypeId(targetExpr.symbol, ctx, typeInstanceId)
      : undefined;
  const declaredOptionalInfo =
    typeof declaredTargetTypeId === "number" &&
    shouldInlineUnionLayout(declaredTargetTypeId, ctx)
      ? getOptionalLayoutInfo(declaredTargetTypeId, ctx)
      : undefined;
  const bindingMatchesDeclaredSome =
    declaredOptionalInfo &&
    typeof bindingActualTargetTypeId === "number"
      &&
      !getOptionalLayoutInfo(bindingActualTargetTypeId, ctx)
      ? ctx.program.types.unify(
          bindingActualTargetTypeId,
          declaredOptionalInfo.someType,
          {
            location: ctx.module.hir.module.ast,
            reason: "narrowed optional member field access",
            variance: "covariant",
            allowUnknown: true,
          },
        ).ok
      : false;
  let sourceTargetTypeId = bindingActualTargetTypeId ?? actualTargetTypeId;
  const actualStructInfo = getStructuralTypeInfo(actualTargetTypeId, ctx);

  const requiredTargetTypeId = getRequiredExprType(expr.target, ctx, typeInstanceId);
  const requiredStructInfo = getStructuralTypeInfo(requiredTargetTypeId, ctx);
  if (
    expr.field === "value" &&
    typeof declaredTargetTypeId === "number" &&
    declaredOptionalInfo &&
    requiredTargetTypeId === declaredOptionalInfo.someType
  ) {
    sourceTargetTypeId = declaredTargetTypeId;
  }
  const structInfo = requiredStructInfo ?? actualStructInfo;
  if (!structInfo) {
    throw new Error("field access requires a structural object");
  }
  const targetTypeId = requiredStructInfo ? requiredTargetTypeId : actualTargetTypeId;

  const actualField = structInfo.fieldMap.get(expr.field);
  if (!actualField) {
    throw new Error(`object does not contain field ${expr.field}`);
  }
  const targetBinding =
    targetExpr?.exprKind === "identifier"
      ? getRequiredBinding(targetExpr.symbol, ctx, fnCtx)
      : undefined;
  const borrowedTargetPointer =
    targetBinding ? loadBindingStorageRef(targetBinding, ctx) : undefined;

  const optionalInfo = shouldInlineUnionLayout(sourceTargetTypeId, ctx)
    ? getOptionalLayoutInfo(sourceTargetTypeId, ctx)
    : undefined;
  if (
    optionalInfo &&
    targetTypeId === optionalInfo.someType &&
    expr.field === "value"
  ) {
    if (
      targetExpr?.exprKind === "identifier" &&
      bindingMatchesDeclaredSome
    ) {
      const someInfo = getStructuralTypeInfo(optionalInfo.someType, ctx);
      const someField = someInfo?.fieldMap.get("value");
      if (!someInfo || !someField) {
        throw new Error("inline optional Some member is missing its value field");
      }
      const pointerTemp = allocateTempLocal(
        someInfo.interfaceType,
        fnCtx,
        optionalInfo.someType,
        ctx,
      );
      const storePointer = storeLocalValue({
        binding: pointerTemp,
        value: coerceValueToType({
          value: loadBindingValue(getRequiredBinding(targetExpr.symbol, ctx, fnCtx), ctx),
          actualType: bindingActualTargetTypeId ?? optionalInfo.someType,
          targetType: optionalInfo.someType,
          ctx,
          fnCtx,
        }),
        ctx,
        fnCtx,
      });
      const directRaw = liftHeapValueToInline({
        value: structGetFieldValue({
          mod: ctx.mod,
          fieldType: someField.heapWasmType,
          fieldIndex: someField.runtimeIndex,
          exprRef: refCast(
            ctx.mod,
            loadLocalValue(pointerTemp, ctx),
            someInfo.runtimeType,
          ),
        }),
        typeId: someField.typeId,
        ctx,
      });
      const value = coerceExprToWasmType({
        expr: coerceValueToType({
          value: directRaw,
          actualType: someField.typeId,
          targetType: expectedFieldTypeId,
          ctx,
          fnCtx,
        }),
        targetType: expectedFieldWasmType,
        ctx,
      });
      return {
        expr: ctx.mod.block(null, [storePointer, value], expectedFieldWasmType),
        usedReturnCall: false,
      };
    }
    const someLayout = getInlineUnionLayout(sourceTargetTypeId, ctx).members.find(
      (member) => member.typeId === optionalInfo.someType,
    );
    if (!someLayout) {
      throw new Error("inline optional layout is missing Some member");
    }
    const targetValue =
      targetExpr?.exprKind === "identifier"
        ? loadBindingValue(getRequiredBinding(targetExpr.symbol, ctx, fnCtx), ctx)
        : (() => {
            const targetTemp = allocateTempLocal(
              wasmTypeFor(sourceTargetTypeId, ctx),
              fnCtx,
              sourceTargetTypeId,
              ctx,
            );
            const storeTarget = storeLocalValue({
              binding: targetTemp,
              value: coerceValueToType({
                value: compileExpr({
                  exprId: expr.target,
                  ctx,
                  fnCtx,
                  expectedResultTypeId: sourceTargetTypeId,
                }).expr,
                actualType: sourceTargetTypeId,
                targetType: sourceTargetTypeId,
                ctx,
                fnCtx,
              }),
              ctx,
              fnCtx,
            });
            return ctx.mod.block(
              null,
              [storeTarget, loadLocalValue(targetTemp, ctx)],
              wasmTypeFor(sourceTargetTypeId, ctx),
            );
          })();
    const payload =
      someLayout.abiTypes.length === 1
        ? ctx.mod.tuple.extract(targetValue, someLayout.abiStart)
        : ctx.mod.tuple.make(
            someLayout.abiTypes.map((_, index) =>
              ctx.mod.tuple.extract(targetValue, someLayout.abiStart + index),
            ),
          );
    const value = coerceExprToWasmType({
      expr: coerceValueToType({
        value: payload,
        actualType: optionalInfo.innerType,
        targetType: expectedFieldTypeId,
        ctx,
        fnCtx,
      }),
      targetType: expectedFieldWasmType,
      ctx,
    });
    return {
      expr: value,
      usedReturnCall: false,
    };
  }

  if (structInfo.layoutKind === "value-object") {
    if (borrowedTargetPointer) {
      const raw = loadStructuralField({
        structInfo,
        field: actualField,
        pointer: () => borrowedTargetPointer,
        ctx,
      });
      const coerced = coerceValueToType({
        value: raw,
        actualType: actualField.typeId,
        targetType: expectedFieldTypeId,
        ctx,
        fnCtx,
      });
      return {
        expr: coerceExprToWasmType({
          expr: coerced,
          targetType: expectedFieldWasmType,
          ctx,
        }),
        usedReturnCall: false,
      };
    }
    const inlineTarget =
      targetExpr?.exprKind === "identifier"
        ? coerceValueToType({
            value: loadBindingValue(targetBinding!, ctx),
            actualType: sourceTargetTypeId,
            targetType: targetTypeId,
            ctx,
            fnCtx,
          })
        : coerceValueToType({
            value: compileExpr({
              exprId: expr.target,
              ctx,
              fnCtx,
              expectedResultTypeId: targetTypeId,
            }).expr,
            actualType: sourceTargetTypeId,
            targetType: targetTypeId,
            ctx,
            fnCtx,
          });
    const targetTemp = allocateTempLocal(
      wasmTypeFor(targetTypeId, ctx),
      fnCtx,
      targetTypeId,
      ctx,
    );
    const storeTarget = storeLocalValue({
      binding: targetTemp,
      value: coerceExprToWasmType({
        expr: inlineTarget,
        targetType: wasmTypeFor(targetTypeId, ctx),
        ctx,
      }),
      ctx,
      fnCtx,
    });
    const raw = loadStructuralField({
      structInfo,
      field: actualField,
      pointer: () => loadLocalValue(targetTemp, ctx),
      ctx,
    });
    const coerced = coerceValueToType({
      value: raw,
      actualType: actualField.typeId,
      targetType: expectedFieldTypeId,
      ctx,
      fnCtx,
    });
    const fieldTemp = allocateTempLocal(
      expectedFieldWasmType,
      fnCtx,
      expectedFieldTypeId,
      ctx,
    );
    const storeField = storeLocalValue({
      binding: fieldTemp,
      value: coerceExprToWasmType({
        expr: coerced,
        targetType: expectedFieldWasmType,
        ctx,
      }),
      ctx,
      fnCtx,
    });
    return {
      expr: ctx.mod.block(
        null,
        [
          storeTarget,
          storeField,
          loadLocalValue(fieldTemp, ctx),
        ],
        expectedFieldWasmType,
      ),
      usedReturnCall: false,
    };
  }

  const pointerTemp = allocateTempLocal(
    structInfo.interfaceType,
    fnCtx,
    targetTypeId,
    ctx,
  );
  const directPointer = borrowedTargetPointer;
  const storePointer = directPointer
    ? undefined
    : storeLocalValue({
        binding: pointerTemp,
        value: targetExpr?.exprKind === "identifier"
          ? coerceValueToType({
              value: loadBindingValue(targetBinding!, ctx),
              actualType: sourceTargetTypeId,
              targetType: targetTypeId,
              ctx,
              fnCtx,
            })
          : coerceValueToType({
              value: compileExpr({
                exprId: expr.target,
                ctx,
                fnCtx,
                expectedResultTypeId: targetTypeId,
              }).expr,
              actualType: sourceTargetTypeId,
              targetType: targetTypeId,
              ctx,
              fnCtx,
            }),
        ctx,
        fnCtx,
      });
  const raw = loadStructuralField({
    structInfo,
    field: actualField,
    pointer: () => directPointer ?? loadLocalValue(pointerTemp, ctx),
    ctx,
  });

  const coerced = coerceValueToType({
    value: raw,
    actualType: actualField.typeId,
    targetType: expectedFieldTypeId,
    ctx,
    fnCtx,
  });
  const value = coerceExprToWasmType({
    expr: coerced,
    targetType: expectedFieldWasmType,
    ctx,
  });

  return {
    expr:
      storePointer
        ? ctx.mod.block(null, [storePointer, value], expectedFieldWasmType)
        : value,
    usedReturnCall: false,
  };
};
