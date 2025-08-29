import { Call } from "../../syntax-objects/call.js";
import { Identifier, List, nop, Expr, Fn } from "../../syntax-objects/index.js";
import { ArrayLiteral } from "../../syntax-objects/array-literal.js";
import {
  dVoid,
  FixedArrayType,
  ObjectType,
  Type,
  TypeAlias,
} from "../../syntax-objects/types.js";
import { getCallFn } from "./get-call-fn.js";
import { getExprType, getIdentifierType } from "./get-expr-type.js";
import { resolveObjectType } from "./resolve-object-type.js";
import { resolveImpl } from "./resolve-impl.js";
import {
  resolveEntities,
  resolveArrayLiteral,
  resolveObjectLiteral,
} from "./resolve-entities.js";
import { resolveExport, resolveModulePath } from "./resolve-use.js";
import { combineTypes } from "./combine-types.js";
import { resolveTypeExpr, resolveFixedArrayType } from "./resolve-type-expr.js";
import { resolveTrait } from "./resolve-trait.js";
import { resolveFn } from "./resolve-fn.js";
import { tryResolveMemberAccessSugar } from "./resolve-member-access.js";
import { ObjectLiteral } from "../../syntax-objects/object-literal.js";
import { maybeExpandObjectArg } from "./object-arg-utils.js";

const resolveMemberAccessDirect = (call: Call): Call => {
  call.args = call.args.map(resolveEntities);
  const recv = call.argAt(0);
  const member = call.argAt(1);
  const recvType = getExprType(recv);
  if (recvType?.isObjectType()) {
    call.type = recvType.getField(member as Identifier)?.type;
    return call;
  }
  if (recvType?.isIntersectionType()) {
    const field =
      recvType.nominalType?.getField(member as Identifier) ??
      recvType.structuralType?.getField(member as Identifier);
    call.type = field?.type;
  }
  return call;
};

const preprocessArgs = (call: Call): void => {
  call.args = call.args.map((arg) => {
    const inner = arg.isCall() && arg.calls(":") ? arg.argAt(1) : arg;
    return hasUntypedClosure(inner) ? arg : resolveEntities(arg);
  });
};

const maybeResolveMemberAccessSugar = (call: Call): Call | undefined => {
  const firstArg = call.argAt(0);
  const shouldCheckMemberAccess = !hasUntypedClosure(firstArg);
  return shouldCheckMemberAccess ? tryResolveMemberAccessSugar(call) : undefined;
};

const resolveCalleeAndGetType = (call: Call) => {
  // Ensure the call identifier is processed so closures can capture it when
  // referenced as the callee.
  call.fnName = resolveEntities(call.fnName) as Identifier;
  const type = getIdentifierType(call.fnName);
  call.fnName.type = type;
  return type;
};

const handleObjectConstruction = (call: Call, type: ObjectType): void => {
  const objArg = call.argAt(0);
  if (objArg?.isObjectLiteral()) {
    call.args.set(0, resolveObjectLiteral(objArg, type));
  }
  // Will set call.fn/type in-place (init fn or constructor)
  resolveObjectInit(call, type);

  // If we resolved to a nominal constructor (no init fn matched) and the
  // argument is not a literal, expand it into a literal using member-access
  // so downstream type checking and codegen can proceed uniformly.
  if (call.fn?.isObjectType()) {
    const arg0 = call.argAt(0);
    if (arg0 && !arg0.isObjectLiteral()) {
      const expanded = maybeExpandObjectArg(
        resolveEntities(arg0.clone()),
        type,
        call.metadata
      );
      if (expanded) call.args.set(0, resolveEntities(expanded));
    }
  }
};

const computeCallReturnType = (call: Call, calleeType?: Type): Type | undefined =>
  call.fn?.isFn()
    ? call.fn.returnType
    : call.fn?.isObjectType()
    ? call.fn
    : calleeType?.isFnType()
    ? calleeType.returnType
    : undefined;

const resolveCallFn = (call: Call, candidateFns?: Fn[]) => {
  if (call.fn) return;

  const arg0 = call.argAt(0);
  const arg1Type =
    arg0?.isClosure() && arg0.parameters.some((p) => !p.type && !p.typeExpr)
      ? undefined
      : getExprType(arg0);

  if (arg1Type?.isTraitType()) {
    const trait = resolveTrait(arg1Type, call);
    const traitMethod = trait.methods
      .toArray()
      .find((fn) => fn.name.is(call.fnName.value));
    if (traitMethod) {
      call.fn = traitMethod;
      call.type = traitMethod.returnType;
      return;
    }
  }

  const resolvedFn = getCallFn(call, candidateFns);
  if (resolvedFn) {
    call.fn = resolvedFn;
    call.type = resolvedFn.returnType;
  }
};

const arrayElemType = (type?: Type): Type | undefined => {
  if (!type) return;
  if (type.isObjectType()) {
    if (!type.name.is("Array") && !type.genericParent?.name.is("Array")) return;
    const arg = type.appliedTypeArgs?.[0];
    return arg && arg.isTypeAlias() ? arg.type : undefined;
  }
  if (!type.isUnionType()) return;
  return type.types
    .map(arrayElemType)
    .find((t): t is Type => !!t);
};

const resolveArrayArgs = (call: Call) => {
  const fn = call.fn?.isFn() ? call.fn : undefined;
  call.args.each((arg: Expr, index: number) => {
    const param = fn?.parameters[index];
    const elemType = arrayElemType(param?.type);

    const isLabeled = arg.isCall() && arg.calls(":");
    const inner = isLabeled ? arg.argAt(1) : arg;
    const arrayCall =
      inner?.isCall() && inner.hasTmpAttribute("arrayLiteral")
        ? (inner as Call)
        : undefined;
    if (!arrayCall) return;

    const arr = arrayCall.getTmpAttribute<ArrayLiteral>("arrayLiteral")!.clone();
    const resolved = resolveArrayLiteral(arr, elemType);
    if (isLabeled) {
      arg.args.set(1, resolved);
      call.args.set(index, resolveEntities(arg));
      return;
    }
    call.args.set(index, resolved);
  });
};

const expandObjectArg = (call: Call) => {
  const fn = call.fn;
  if (!fn?.isFn() || call.args.length !== 1) return;

  const objArg = call.argAt(0)!;
  const params = fn.parameters;
  const labeledParams = params.filter((p) => p.label);
  const allLabeled = labeledParams.length === params.length;
  if (!allLabeled) return;

  // Case 1: direct object literal supplied
  if (objArg.isObjectLiteral()) {
    const coversAll = labeledParams.every((p) =>
      objArg.fields.some((f) => f.name === p.label!.value)
    );
    if (!coversAll) return;

    const newArgs = labeledParams.map((p) => {
      const fieldName = p.label!.value;
      const field = objArg.fields.find((f) => f.name === fieldName)!;
      return new Call({
        ...call.metadata,
        fnName: Identifier.from(":"),
        args: new List({
          value: [Identifier.from(fieldName), field.initializer.clone()],
        }),
        type: getExprType(field.initializer),
      });
    });

    call.args = new List({ value: newArgs });
    call.args.parent = call;
    return;
  }

  // Case 2: object reference (nominal or structural type)
  const objType = getExprType(objArg);
  const structType = objType?.isObjectType()
    ? objType
    : objType?.isIntersectionType()
    ? objType.structuralType
    : undefined;
  if (!structType) return;

  const coversAll = labeledParams.every((p) =>
    structType.hasField(p.label!.value)
  );
  if (!coversAll) return;

  const newArgs = labeledParams.map((p) => {
    const fieldName = p.label!.value;
    const fieldType = structType.getField(fieldName)?.type;
    const objClone = resolveEntities(objArg.clone());
    const access = new Call({
      ...call.metadata,
      fnName: Identifier.from("member-access"),
      args: new List({
        value: [objClone, Identifier.from(fieldName)],
      }),
      type: fieldType,
    });
    return new Call({
      ...call.metadata,
      fnName: Identifier.from(":"),
      args: new List({ value: [Identifier.from(fieldName), access] }),
      type: fieldType,
    });
  });

  call.args = new List({ value: newArgs });
  call.args.parent = call;
};

const normalizeArgsForResolvedFn = (call: Call) => {
  // Only meaningful when call.fn is a function; each helper guards internally
  resolveArrayArgs(call);
  expandObjectArg(call);
};

export const resolveModuleAccess = (call: Call) => {
  const [left, right] = call.argsArray();

  if (right?.isCall()) {
    const path = new List(["::", left, right.fnName]);
    path.parent = call.parent ?? call.parentModule;

    const candidates = resolveModulePath(path)
      .map(({ e }) => e)
      .filter((e) => e.isFn());

    return resolveCall(right, candidates);
  }

  return call;
};

export const resolveLabeledArg = (call: Call) => {
  call.args = call.args.map(resolveEntities);
  const expr = call.argAt(1);
  call.type = getExprType(expr);
  return call;
};

export const resolveObjectInit = (call: Call, type: ObjectType): Call => {
  // Ensure the object's implementations and field types are resolved so that
  // init functions are discoverable and comparable.
  type = resolveObjectType(type, call);

  // If this is a generic object construction without explicit type args, try
  // to infer them directly from the constructor argument when it’s a
  // homogeneous Array of tuple pairs (String, T), and re-resolve the object
  // type with inferred type arguments to surface specialized impl methods.
  if (type.typeParameters && !call.typeArgs) {
    const arg0 = call.argAt(0);
    const elem = arrayElemType(getExprType(arg0));
    const tuple =
      elem?.isObjectType()
        ? elem
        : elem?.isIntersectionType()
        ? elem.structuralType ?? elem.nominalType
        : undefined;
    const key = tuple?.getField("0")?.type;
    const valExpr = tuple?.getField("1")?.typeExpr;
    if (
      key?.isObjectType() &&
      key.name.is("String") &&
      valExpr
    ) {
      call.typeArgs = new List({ value: [valExpr.clone()] });
      type = resolveObjectType(type, call);
    }
  }

  // If no explicit type args are supplied, try to infer them from the
  // supplied object literal.

  // Proactively resolve implementations so their exports (e.g., `init`) are available.
  type.implementations?.forEach((impl) => resolveImpl(impl, type));

  // Gather all inline methods and identify candidate init functions
  const initFns = collectInitFns(type);

  if (initFns.length) {
    const pool = specializeGenericInitFns(initFns, call);
    const found = findCompatibleInitForCall(call, pool);
    if (found) {
      call.fn = found;
      call.type = found.returnType;
      return call;
    }
    // leave fallback to nominal constructor if not matched
  }

  const arg0 = call.argAt(0);
  if (arg0?.isObjectLiteral()) {
    call.type = type;
    call.fn = type;
    return call;
  }

  call.type = type;
  call.fn = type;
  return call;
};

// Extracted helpers to keep resolveObjectInit flat and readable
const collectInitFns = (type: ObjectType): Fn[] => {
  // Ensure impl.methods include inline function declarations (including those
  // wrapped in `export` blocks) without forcing full resolution.
  type.implementations
    ?.filter((impl) => !impl.trait)
    .forEach((impl) => {
      const block = impl.body.value;
      const gather = (b: Expr | undefined) => {
        if (!b || !b.isBlock()) return;
        b.body.forEach((e) => {
          if (e.isFn()) impl.registerMethod(e);
          else if (e.isCall() && e.calls(":")) {
            // labeled arg is irrelevant here
          } else if (e.isCall() && e.calls("export")) gather(e.argAt(0));
        });
      };
      gather(block);
    });
  return (
    type.implementations
      ?.filter((impl) => !impl.trait)
      .flatMap((impl) =>
        (impl.methods as ReadonlyArray<Fn>).filter((fn) => fn.name.is("init"))
      ) ?? []
  );
};

const specializeGenericInitFns = (fns: Fn[], call: Call): Fn[] => {
  const specialized: Fn[] = [];
  for (const f of fns) {
    const before = f.genericInstances?.length ?? 0;
    resolveFn(f, call);
    const after = f.genericInstances?.length ?? 0;
    if (after > before && f.genericInstances) specialized.push(...f.genericInstances);
  }
  return specialized.length ? specialized : fns;
};

const findCompatibleInitForCall = (call: Call, pool: Fn[]): Fn | undefined => {
  const direct = getCallFn(call, pool);
  if (direct) return direct;

  if (!pool.length) return undefined;
  const single = pool.find((f) => f.parameters.length === 1);
  const arg0 = call.argAt(0)?.clone();
  if (!single || !arg0) return undefined;

  const label = single.parameters[0]!.name.clone();
  const labeled = new Call({
    ...call.metadata,
    fnName: Identifier.from(":"),
    args: new List({ value: [label, arg0] }),
  });
  const synthetic = new Call({
    ...call.metadata,
    fnName: call.fnName.clone(),
    args: new List({ value: [labeled] }),
  });
  return getCallFn(synthetic, pool);
};

const resolveFixedArray = (call: Call) => {
  call.args = call.args.map(resolveEntities);

  const elemTypeExpr =
    call.typeArgs?.at(0) ??
    combineTypes(
      call.args
        .toArray()
        .map(getExprType)
        .filter((t) => !!t)
    ) ??
    nop();

  const arr = resolveFixedArrayType(
    new FixedArrayType({
      ...call.metadata,
      name: Identifier.from("FixedArray"),
      elemTypeExpr,
    })
  );

  call.type = arr;
  return call;
};

// moved to ./resolve-member-access.ts as tryResolveMemberAccessSugar

export const resolveIf = (call: Call) => {
  if (!call.args.hasLabeledArg("elif")) return resolveBasicIf(call);

  type Pair = { cond: Expr; thenExpr: Expr };

  const parseClauses = (): { pairs: Pair[]; elseExpr?: Expr } => {
    const args = call.args.toArray();
    const pairs: Pair[] = [];

    const firstCond = args[0];
    const firstThen = args[1];
    if (firstCond && firstThen?.isCall() && firstThen.calls(":")) {
      const firstThenLabel = firstThen.argAt(0);
      if (firstThenLabel?.isIdentifier() && firstThenLabel.value === "then") {
        pairs.push({ cond: firstCond, thenExpr: firstThen.argAt(1)! });
      }
    }

    let elseExpr: Expr | undefined;
    for (let i = 2; i < args.length; i++) {
      const labelCall = args[i];
      if (!labelCall?.isCall() || !labelCall.calls(":")) continue;
      const labelId = labelCall.argAt(0);
      if (!labelId?.isIdentifier()) continue;
      if (labelId.value === "elif") {
        const cond = labelCall.argAt(1)!;
        const thenCall = args[i + 1];
        if (thenCall?.isCall() && thenCall.calls(":")) {
          const thenLabel = thenCall.argAt(0);
          if (thenLabel?.isIdentifier() && thenLabel.value === "then") {
            pairs.push({ cond, thenExpr: thenCall.argAt(1)! });
            i++;
            continue;
          }
        }
      }
      if (labelId.value === "else") elseExpr = labelCall.argAt(1);
    }

    return { pairs, elseExpr };
  };

  const buildChain = (pairs: Pair[], elseExpr?: Expr): Call => {
    let acc = elseExpr;
    for (let i = pairs.length - 1; i >= 0; i--) {
      const { cond, thenExpr } = pairs[i];
      acc = new Call({
        ...call.metadata,
        fnName: Identifier.from("if"),
        args: new List({
          value: [
            cond,
            new Call({
              ...call.metadata,
              fnName: Identifier.from(":"),
              args: new List({
                value: [Identifier.from("then"), thenExpr],
              }),
            }),
            ...(acc
              ? [
                  new Call({
                    ...call.metadata,
                    fnName: Identifier.from(":"),
                    args: new List({
                      value: [Identifier.from("else"), acc],
                    }),
                  }),
                ]
              : []),
          ],
        }),
      });
    }
    return acc as Call;
  };

  const { pairs, elseExpr } = parseClauses();
  const transformed = buildChain(pairs, elseExpr);
  return resolveEntities(transformed) as Call;
};

const resolveBasicIf = (call: Call) => {
  call.args = call.args.map(resolveEntities);
  const thenExpr = call.argAt(1);
  const elseExpr = call.argAt(2);

  if (!elseExpr) {
    call.type = dVoid;
    return call;
  }

  const thenType = getExprType(thenExpr);
  const elseType = getExprType(elseExpr);
  call.type =
    elseType && thenType ? combineTypes([thenType, elseType]) : thenType;
  return call;
};

export const resolveWhile = (call: Call) => {
  call.args = call.args.map(resolveEntities);
  call.type = dVoid;
  return call;
};

export const resolveBinaryen = (call: Call) => {
  call.args = call.args.map(resolveEntities);
  const typeArg = call.optionalLabeledArg("return_type");

  if (!typeArg) return call;

  resolveTypeExpr(typeArg);
  call.type = getExprType(typeArg);
  return call;
};

const resolveClosureCall = (call: Call): Call => {
  call.args = call.args.map(resolveEntities);
  const closure = call.argAt(0);
  if (closure?.isClosure()) {
    call.type = closure.getReturnType();
    return call;
  }
  const closureType = getExprType(closure);
  if (closureType?.isFnType()) {
    call.type = closureType.returnType;
  }
  return call;
};

// Helpers
const hasUntypedClosure = (expr: Expr | undefined): boolean =>
  !!(expr?.isClosure() && expr.parameters.some((p) => !p.type && !p.typeExpr));

const specialCallResolvers: Record<string, (c: Call) => Call> = {
  "::": resolveModuleAccess,
  export: resolveExport,
  if: resolveIf,
  "call-closure": resolveClosureCall,
  ":": resolveLabeledArg,
  while: resolveWhile,
  FixedArray: resolveFixedArray,
  binaryen: resolveBinaryen,
  "member-access": resolveMemberAccessDirect,
};

export const resolveCall = (call: Call, candidateFns?: Fn[]): Call => {
  if (call.type) return call;

  const resolver = specialCallResolvers[call.fnName.value];
  if (resolver) return resolver(call);

  // Resolve arguments conservatively (avoid resolving closures with untyped params)
  preprocessArgs(call);

  // Optional sugar: obj.member -> member-access(obj, "member")
  const sugared = maybeResolveMemberAccessSugar(call);
  if (sugared) return sugared;

  // Ensure the callee is resolved so closures can capture it
  const calleeType = resolveCalleeAndGetType(call);

  // Constructors (object types by name)
  if (calleeType?.isObjectType()) handleObjectConstruction(call, calleeType);

  // Resolve and apply type args for the call if present
  if (call.typeArgs) call.typeArgs = call.typeArgs.map(resolveTypeExpr);

  // Bind function and normalize args
  resolveCallFn(call, candidateFns);
  normalizeArgsForResolvedFn(call);

  // Compute resulting type
  call.type = computeCallReturnType(call, calleeType);
  return call;
};
