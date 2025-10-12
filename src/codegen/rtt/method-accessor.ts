import binaryen from "binaryen";
import { AugmentedBinaryen } from "../../lib/binaryen-gc/types.js";
import {
  defineArrayType,
  arrayLen,
  arrayGet,
  arrayNewFixed,
  binaryenTypeToHeapType,
  defineStructType,
  initStruct,
  structGetFieldValue,
  refFunc,
  refCast,
  callRef,
} from "../../lib/binaryen-gc/index.js";
import { ObjectType, voydBaseObject } from "../../syntax-objects/types.js";
import { murmurHash3 } from "../../lib/murmur-hash.js";
import { CompileExprOpts, mapBinaryenType, compileExpression } from "../../codegen.js";
import { Call } from "../../syntax-objects/call.js";
import { Fn } from "../../syntax-objects/fn.js";

const bin = binaryen as unknown as AugmentedBinaryen;

export const initMethodLookupHelpers = (mod: binaryen.Module) => {
  const methodAccessorStruct = defineStructType(mod, {
    name: "MethodAccessor",
    fields: [
      { name: "__method_hash", type: bin.i32, mutable: false },
      { name: "__method_ref", type: bin.funcref, mutable: false },
    ],
  });
  const lookupTableType = defineArrayType(mod, methodAccessorStruct, true);
  const LOOKUP_NAME = "__lookup_method_accessor";

  mod.addFunction(
    LOOKUP_NAME,
    bin.createType([bin.i32, lookupTableType]),
    bin.funcref,
    [bin.i32],
    mod.block(null, [
      mod.local.set(2, mod.i32.const(0)),
      mod.loop(
        "loop",
        mod.block(null, [
          mod.if(
            mod.i32.eq(
              mod.local.get(2, bin.i32),
              arrayLen(mod, mod.local.get(1, lookupTableType))
            ),
            mod.unreachable()
          ),
          mod.if(
            mod.i32.eq(
              mod.local.get(0, bin.i32),
              structGetFieldValue({
                mod,
                fieldType: bin.i32,
                fieldIndex: 0,
                exprRef: arrayGet(
                  mod,
                  mod.local.get(1, lookupTableType),
                  mod.local.get(2, bin.i32),
                  methodAccessorStruct,
                  false
                ),
              })
            ),
            mod.return(
              structGetFieldValue({
                mod,
                fieldType: bin.funcref,
                fieldIndex: 1,
                exprRef: arrayGet(
                  mod,
                  mod.local.get(1, lookupTableType),
                  mod.local.get(2, bin.i32),
                  methodAccessorStruct,
                  false
                ),
              })
            )
          ),
          mod.local.set(
            2,
            mod.i32.add(mod.local.get(2, bin.i32), mod.i32.const(1))
          ),
          mod.br("loop"),
        ])
      ),
    ])
  );

  const initMethodTable = (opts: CompileExprOpts<ObjectType>) => {
    const { mod, expr: obj } = opts;
    const seenTraits = new Set<string>();
    const seenWrappers = new Set<string>();
    const accessors = obj.implementations
      ?.flatMap((impl) => {
        if (!impl.trait) return [] as number[];
        const traitKey = impl.trait.id;
        if (seenTraits.has(traitKey)) return [] as number[];
        seenTraits.add(traitKey);
        return impl.trait.methods.toArray().flatMap((traitMethod) => {
          const implMethod = impl.methods.find((m) =>
            m.name.is(traitMethod.name.value)
          );
          if (!implMethod) {
            throw new Error(
              `Method ${traitMethod.name.value} not implemented for trait ${impl.trait!.name}`
            );
          }

          const wrapperName = `obj_method_${obj.id}_${traitMethod.id}`;
          if (seenWrappers.has(wrapperName)) return [] as number[];
          seenWrappers.add(wrapperName);
          const paramTypes = bin.createType([
            mapBinaryenType(opts, voydBaseObject),
            ...traitMethod.parameters
              .slice(1)
              .map((p) => mapBinaryenType(opts, p.type!)),
          ]);
          const wrapperReturnType = mapBinaryenType(
            opts,
            traitMethod.returnType!
          );
          const body = mod.call(
            implMethod.id,
            [
              refCast(
                mod,
                mod.local.get(0, mapBinaryenType(opts, voydBaseObject)),
                mapBinaryenType(opts, obj)
              ),
              ...traitMethod.parameters
                .slice(1)
                .map((_, i) =>
                  mod.local.get(i + 1, mapBinaryenType(opts, _.type!))
                ),
            ],
            mapBinaryenType(opts, implMethod.returnType!)
          );
          const fnRef = mod.addFunction(
            wrapperName,
            paramTypes,
            wrapperReturnType,
            [],
            body
          );
          const heapType = bin._BinaryenFunctionGetType(fnRef);
          const fnType = bin._BinaryenTypeFromHeapType(heapType, false);
          traitMethod.setAttribute("binaryenType", fnType);

          return [
            initStruct(mod, methodAccessorStruct, [
              mod.i32.const(murmurHash3(traitMethod.id)),
              refFunc(mod, wrapperName, fnType),
            ]),
          ];
        });
      }) ?? [];

    return arrayNewFixed(
      mod,
      binaryenTypeToHeapType(lookupTableType),
      accessors
    );
  };

  const callMethodByAccessor = (opts: CompileExprOpts<Call>) => {
    const { mod, expr } = opts;
    const obj = expr.argAt(0)!;
    const fn = expr.fn as Fn;
    const lookupTable = structGetFieldValue({
      mod,
      fieldType: lookupTableType,
      fieldIndex: 2,
      exprRef: compileExpression({ ...opts, expr: obj, isReturnExpr: false }),
    });

    const funcRef = mod.call(
      LOOKUP_NAME,
      [mod.i32.const(murmurHash3(fn.id)), lookupTable],
      bin.funcref
    );
    const target = refCast(mod, funcRef, fn.getAttribute("binaryenType") as number);
    const args = expr.args
      .toArray()
      .map((arg) => compileExpression({ ...opts, expr: arg, isReturnExpr: false }));
    return callRef(mod, target, args, mapBinaryenType(opts, fn.returnType!));
  };

  return { initMethodTable, lookupTableType, LOOKUP_NAME, callMethodByAccessor };
};
