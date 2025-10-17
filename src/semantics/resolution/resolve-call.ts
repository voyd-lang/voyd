import { Call } from "../../syntax-objects/call.js";
import {
  Identifier,
  List,
  nop,
  Expr,
  Fn,
  Block,
  Parameter,
} from "../../syntax-objects/index.js";
import { ArrayLiteral } from "../../syntax-objects/array-literal.js";
import {
  dVoid,
  FixedArrayType,
  ObjectType,
  Type,
} from "../../syntax-objects/types.js";
import { getCallFn } from "./get-call-fn.js";
import { getExprType, getIdentifierType } from "./get-expr-type.js";
import {
  resolveObjectType,
  containsUnresolvedTypeId,
} from "./resolve-object-type.js";
import { resolveImpl } from "./resolve-impl.js";
import {
  resolveEntities,
  resolveArrayLiteral,
  resolveObjectLiteral,
} from "./resolve-entities.js";
import { resolveWithExpected } from "./resolve-entities.js";
import { resolveClosure } from "./resolve-closure.js";
import { resolveExport, resolveModulePath } from "./resolve-use.js";
import { resolveModule } from "./resolve-entities.js";
import { combineTypes } from "./combine-types.js";
import { resolveTypeExpr, resolveFixedArrayType } from "./resolve-type-expr.js";
import { resolveTrait } from "./resolve-trait.js";
import { resolveFn, resolveFnSignature } from "./resolve-fn.js";
import { tryResolveMemberAccessSugar } from "./resolve-member-access.js";
import { maybeExpandObjectArg } from "./object-arg-utils.js";
import { typesAreCompatible } from "./types-are-compatible.js";
import { registerTypeInstance } from "../../syntax-objects/type-context.js";
import { canonicalType } from "../types/canonicalize.js";

export const resolveCall = (call: Call, candidateFns?: Fn[]): Expr => {
  if (call.type) return call;

  const resolver = specialCallResolvers[call.fnName.value];
  if (resolver) return resolver(call);

  preprocessArgs(call);

  // Optional sugar: obj.member -> member-access(obj, "member")
  const sugared = maybeResolveMemberAccessSugar(call);
  if (sugared) return sugared;

  // Ensure the callee is resolved so closures can capture it
  const calleeType = resolveCalleeAndGetType(call);

  // Resolve and apply type args for the call if present
  if (call.typeArgs) call.typeArgs = call.typeArgs.map(resolveTypeExpr);

  // Constructors (object types by name)
  if (calleeType?.isObjectType()) handleObjectConstruction(call, calleeType);

  // Bind function and normalize args
  resolveCallFn(call, candidateFns);
  if (!call.fn && calleeType?.isFnType()) {
    const tmpFn = new Fn({
      ...call.metadata,
      name: Identifier.from("closure"),
      parameters: cloneParams(calleeType.parameters),
    });
    const tmpCall = new Call({
      ...call.metadata,
      fnName: call.fnName.clone(),
      fn: tmpFn,
      args: call.args,
    });
    normalizeArgsForResolvedFn(tmpCall);
    call.args = tmpCall.args;
    call.args.parent = call;
    call.fnName.parent = call;
  } else {
    normalizeArgsForResolvedFn(call);
  }

  // Compute resulting type
  call.type = computeCallReturnType(call, calleeType);
  return call;
};

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
  call.args = call.args.map(resolveEntities);
};

const cloneParams = (params: Parameter[]): Parameter[] =>
  params.map((p) => {
    const cloned = p.clone();
    cloned.type = p.type;
    cloned.isOptional = p.isOptional;
    return cloned;
  });

// Normalize any expression to a block expression
const toBlock = (e: Expr): Block =>
  e.isBlock() ? e : new Block({ ...e.metadata, body: [e] });

// Build a labeled arg call `label: expr`
const makeLabeled = (label: string, expr: Expr, meta: any): Call =>
  new Call({
    ...meta,
    fnName: Identifier.from(":"),
    args: new List({ value: [Identifier.from(label), expr] }),
  });

const maybeResolveMemberAccessSugar = (call: Call): Call | undefined => {
  const firstArg = call.argAt(0);
  const shouldCheckMemberAccess = !hasUntypedClosure(firstArg);
  return shouldCheckMemberAccess
    ? tryResolveMemberAccessSugar(call)
    : undefined;
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
  // If explicit type args contain unknown identifiers, avoid generic
  // specialization to prevent infinite recursion. Defer to later type
  // checking to report the unknown type.
  if (call.typeArgs) {
    const unknownIds: string[] = [];
    const visit = (e: Expr | undefined) => {
      if (!e) return;
      if (e.isIdentifier() && !getExprType(e)) unknownIds.push(e.value);
      else if (e.isCall() && e.typeArgs)
        e.typeArgs.toArray().forEach((a) => visit(a));
      else if (e.isList()) e.toArray().forEach((a) => visit(a));
    };
    call.typeArgs.toArray().forEach((a) => visit(a));
    if (unknownIds.length) {
      const allowedNames = new Set<string>();
      type.typeParameters?.forEach((param) => allowedNames.add(param.value));
      call.parentFn?.typeParameters?.forEach((param) =>
        allowedNames.add(param.value)
      );
      call.parentImpl
        ?.typeParams?.toArray()
        .forEach((param) => allowedNames.add(param.value));
      call.parentTrait?.typeParameters?.forEach((param) =>
        allowedNames.add(param.value)
      );
      const unresolved = unknownIds.filter(
        (name) => !allowedNames.has(name)
      );
      if (unresolved.length) {
        throw new Error(
          `Unrecognized identifier(s) ${unresolved.join(", ")} for ${
            type.name
          } at ${call.location}`
        );
      }
    }
    const allowedTypeParams = new Set<string>();
    type.typeParameters?.forEach((param) =>
      allowedTypeParams.add(param.value)
    );
    call.parentFn?.typeParameters?.forEach((param) =>
      allowedTypeParams.add(param.value)
    );
    call.parentImpl
      ?.typeParams?.toArray()
      .forEach((param) => allowedTypeParams.add(param.value));
    call.parentTrait?.typeParameters?.forEach((param) =>
      allowedTypeParams.add(param.value)
    );
    if (call.typeArgs.toArray().some((arg) => containsUnresolvedTypeId(arg, allowedTypeParams))) {
      return;
    }
  }
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

const computeCallReturnType = (
  call: Call,
  calleeType?: Type
): Type | undefined =>
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
  const t = canonicalType(type);
  if (t.isObjectType()) {
    if (!t.name.is("Array") && !t.genericParent?.name.is("Array")) return;
    const arg = t.appliedTypeArgs?.[0];
    return arg ? canonicalType(arg) : undefined;
  }
  if (!t.isUnionType()) return;
  return t.types.map(arrayElemType).find((tt): tt is Type => !!tt);
};

const resolveArrayArgs = (call: Call) => {
  const fn = call.fn?.isFn() ? call.fn : undefined;
  // Fall back to candidate functions when unresolved to infer expected element types.
  const candidates = !fn ? call.resolveFns(call.fnName) : [];
  if (!fn) {
    // Ensure candidate signatures are ready
    candidates.forEach((c) => resolveFnSignature(c));
  } else {
    // Ensure resolved function's parameter types are available
    resolveFnSignature(fn);
  }
  call.args.each((arg: Expr, index: number) => {
    const param = fn?.parameters[index];
    let elemType = arrayElemType(param?.type);
    if (!elemType && candidates.length) {
      const elems = candidates
        .map((c) => arrayElemType(c.parameters[index]?.type))
        .filter((t): t is Type => !!t);
      if (elems.length === 1) elemType = elems[0];
      else if (elems.length > 1) elemType = combineTypes(elems);
    }

    const isLabeled = arg.isCall() && arg.calls(":");
    const inner = isLabeled ? arg.argAt(1) : arg;

    // Support both early-resolved array arguments (new_array call carrying
    // the original ArrayLiteral via the 'arrayLiteral' attribute) and raw
    // ArrayLiteral nodes when preprocessArgs skipped resolution.
    let originalArr: ArrayLiteral | undefined;
    if (inner?.isCall() && inner.hasAttribute("arrayLiteral")) {
      originalArr = (inner as Call).getAttribute(
        "arrayLiteral"
      ) as ArrayLiteral;
    } else if (inner?.isArrayLiteral()) {
      originalArr = inner as ArrayLiteral;
    }
    if (!originalArr) return;

    const arr = originalArr.clone();
    // Only use candidate-derived elemType when the array is empty to avoid
    // masking helpful overload errors on mismatched non-empty arrays.
    const effectiveElemType =
      arr.elements.length === 0 ? elemType : arrayElemType(param?.type);
    const resolved = resolveArrayLiteral(arr, effectiveElemType);
    const canonicalElem = effectiveElemType
      ? registerTypeInstance(effectiveElemType)
      : undefined;
    if (
      resolved?.isCall?.() &&
      resolved.fnName.is("new_array") &&
      canonicalElem
    ) {
      resolved.setAttribute("expectedArrayElemType", canonicalElem);
    }
    if (isLabeled) {
      arg.args.set(1, resolved);
      const normalized = resolveEntities(arg);
      if (
        normalized?.isCall?.() &&
        normalized.calls(":") &&
        canonicalElem
      ) {
        const innerCall = normalized.argAt(1);
        if (innerCall?.isCall?.() && innerCall.fnName.is("new_array")) {
          innerCall.setAttribute("expectedArrayElemType", canonicalElem);
        }
      }
      call.args.set(index, normalized);
      return;
    }
    call.args.set(index, resolved);
  });
};

const resolveClosureArgs = (call: Call) => {
  const fn = call.fn;
  if (!fn?.isFn()) return;
  call.args.each((arg: Expr, index: number) => {
    const paramType = fn.parameters[index]?.type;
    const isLabeled = arg.isCall() && arg.calls(":");
    const inner = isLabeled ? arg.argAt(1) : arg;
    if (!inner?.isClosure()) return;
    // Derive expected closure type either from a resolved parameter type or
    // by resolving the parameter's type expression when the type has not yet
    // been materialized (common for generics).
    let expected = paramType ? canonicalType(paramType) : undefined;
    if (!expected) {
      const paramTypeExpr = fn.parameters[index]?.typeExpr;
      const resolvedExprType = paramTypeExpr
        ? getExprType(resolveTypeExpr(paramTypeExpr))
        : undefined;
      expected = resolvedExprType ? canonicalType(resolvedExprType) : undefined;
    }
    if (expected?.isFnType()) {
      // Attach the expected function type on the closure so codegen can
      // align the compiled function-reference heap type with the caller's
      // expectation, avoiding ref.cast traps.
      inner.setAttribute("parameterFnType", expected);
      inner.parameters.forEach((p, i) => {
        const expParam = expected.parameters[i];
        const exp =
          expParam?.type ??
          (expParam?.typeExpr
            ? getExprType(resolveTypeExpr(expParam.typeExpr))
            : undefined);
        if (!p.type && !p.typeExpr && exp) p.type = canonicalType(exp);
      });
      if (!inner.returnTypeExpr && !inner.annotatedReturnType) {
        inner.annotatedReturnType =
          expected.returnType && canonicalType(expected.returnType);
      }
    }
    const resolved = resolveClosure(inner);
    if (expected?.isFnType()) {
      resolved.returnType =
        expected.returnType && canonicalType(expected.returnType);
    }
    if (isLabeled) {
      arg.args.set(1, resolved);
      call.args.set(index, resolveEntities(arg));
      return;
    }
    call.args.set(index, resolved);
  });
};

const resolveOptionalArgs = (call: Call) => {
  const fn = call.fn;
  if (!fn?.isFn()) return;
  fn.parameters.forEach((param, index) => {
    if (!param.isOptional) return;
    const label = param.label?.value;

    let argIndex = index;
    let argExpr: Expr | undefined;
    let wrapper: Call | undefined;

    if (label) {
      argIndex = call.args.findIndex((e) => {
        if (!e.isCall() || !e.calls(":")) return false;
        const id = e.argAt(0);
        return !!(id?.isIdentifier() && id.is(label));
      });
      if (argIndex !== -1) {
        wrapper = call.args.at(argIndex) as Call;
        argExpr = wrapper.argAt(1);
      }
    } else {
      const candidate = call.args.at(index);
      const labelExpr =
        candidate?.isCall() && candidate.calls(":")
          ? candidate.argAt(0)
          : undefined;
      argExpr =
        labelExpr?.isIdentifier() &&
        fn.parameters.some((p, i) => i >= index && p.label?.is(labelExpr))
          ? undefined
          : candidate;
    }

    if (!argExpr) {
      const noneCall = resolveEntities(
        new Call({
          ...call.metadata,
          fnName: Identifier.from("none"),
          args: new List({ value: [] }),
        })
      );
      const toInsert = label
        ? resolveEntities(makeLabeled(label, noneCall, call.metadata))
        : noneCall;
      call.args.insert(toInsert, index);
      return;
    }

    const argType = getExprType(argExpr);
    const paramType = param.type;
    if (
      typesAreCompatible(
        argType && canonicalType(argType),
        paramType && canonicalType(paramType)
      )
    )
      return;

    const someCall = resolveEntities(
      new Call({
        ...argExpr.metadata,
        fnName: Identifier.from("some"),
        args: new List({ value: [argExpr] }),
      })
    );

    if (label && wrapper) {
      wrapper.args.set(1, someCall);
      call.args.set(argIndex, resolveEntities(wrapper));
    } else {
      call.args.set(index, someCall);
    }
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

  const requiredParams = labeledParams.filter((p) => !p.isOptional);

  // Case 1: direct object literal supplied
  if (objArg.isObjectLiteral()) {
    const coversRequired = requiredParams.every((p) =>
      objArg.fields.some((f) => f.name === p.label!.value)
    );
    if (!coversRequired) return;

    const newArgs = labeledParams
      .map((p) => {
        const fieldName = p.label!.value;
        const field = objArg.fields.find((f) => f.name === fieldName);
        if (!field) return undefined;
        return new Call({
          ...call.metadata,
          fnName: Identifier.from(":"),
          args: new List({
            value: [Identifier.from(fieldName), field.initializer],
          }),
          type: getExprType(field.initializer),
        });
      })
      .filter((a): a is Call => !!a);

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

  const coversRequired = requiredParams.every((p) =>
    structType.hasField(p.label!.value)
  );
  if (!coversRequired) return;

  const newArgs = labeledParams
    .map((p) => {
      const fieldName = p.label!.value;
      if (!structType.hasField(fieldName)) return undefined;
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
    })
    .filter((a): a is Call => !!a);

  call.args = new List({ value: newArgs });
  call.args.parent = call;
};

const normalizeArgsForResolvedFn = (call: Call) => {
  // Only meaningful when call.fn is a function; each helper guards internally
  // Expand object-arg into labeled args first so array literals inside
  // labeled params can be coerced with the correct element types.
  expandObjectArg(call);
  resolveArrayArgs(call);
  resolveClosureArgs(call);
  resolveOptionalArgs(call);
};

export const resolveModuleAccess = (call: Call) => {
  const [left, right] = call.argsArray();

  if (right?.isCall()) {
    const path = new List(["::", left, right.fnName]);
    path.parent = call.parent ?? call.parentModule;

    const candidates = resolveModulePath(path, resolveModule)
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
    const tuple = elem?.isObjectType()
      ? elem
      : elem?.isIntersectionType()
      ? elem.structuralType ?? elem.nominalType
      : undefined;
    const key = tuple?.getField("0")?.type;
    const valExpr = tuple?.getField("1")?.typeExpr;
    if (key?.isObjectType() && key.name.is("String") && valExpr) {
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
    if (!found) {
      const uniquePool = Array.from(
        new Map(pool.map((fn) => [fn.id, fn])).values()
      );
      const fallback = uniquePool.length === 1 ? uniquePool[0] : undefined;
      if (fallback) {
        call.fn = fallback;
        call.type = fallback.returnType;
        return call;
      }
    } else {
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
    if (after > before && f.genericInstances)
      specialized.push(...f.genericInstances);
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
  // First resolve elements normally; we will re-apply expected element typing
  // below once we know or infer the element type.
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

  const fixedArray = resolveFixedArrayType(
    new FixedArrayType({
      ...call.metadata,
      name: Identifier.from("FixedArray"),
      elemTypeExpr,
    })
  );

  const arr = registerTypeInstance(fixedArray);

  // Propagate the resolved element type back into elements so structural
  // literals (e.g., tuples) adopt the expected field types instead of their
  // initializer-inferred types.
  if (arr.elemType) {
    call.args = call.args.map((e) => resolveWithExpected(e, arr.elemType));
  }

  call.type = arr;
  return call;
};

const findSomeVariant = (type?: Type) => {
  if (!type?.isUnionType()) return undefined;
  return type.types.find(
    (t) =>
      t.isObjectType() &&
      (t.name.is("Some") || t.genericParent?.name.is("Some"))
  );
};

export const resolveCond = (call: Call) => {
  const defaultExpr = call.optionalLabeledArg("default");
  if (defaultExpr) defaultExpr.setAttribute("condDefault", true);
  const cases = call.argsWithLabel("case");
  const dos = call.argsWithLabel("do");
  const pairs = cases.map((arg, index) => {
    const caseDo = dos[index];
    if (!caseDo) throw new Error(`Expected do after case at ${arg.location}`);
    return new List([arg, caseDo]);
  });

  call.args = new List({
    value: [...pairs, ...(defaultExpr ? [defaultExpr] : [])],
  });
  call.args.parent = call;
  call.args = call.args.map(resolveEntities);
  const resolvedArgs = call.args.toArray();

  const hasDefault = defaultExpr !== undefined;

  const branchTypes: Type[] = [];
  resolvedArgs.forEach((arg) => {
    if (arg.isList() && !arg.hasAttribute("condDefault")) {
      const blockField = arg.at(1);
      const t = getExprType(blockField);
      if (t) branchTypes.push(t);
      return;
    }
    const t = getExprType(arg);
    if (t) branchTypes.push(t);
  });

  call.type = hasDefault
    ? branchTypes.length > 1
      ? combineTypes(branchTypes)
      : branchTypes[0]
    : dVoid;
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
  if (!closure) return call;

  const closureType = closure.isClosure()
    ? closure.getType()
    : getExprType(closure);
  // Propagate the expected function type identity to the callee identifier so
  // codegen can align the call_ref heap type with the closure's compiled type.
  if (closureType?.isFnType())
    closure.setAttribute("parameterFnType", closureType);
  const params = closure.isClosure()
    ? closure.parameters
    : closureType?.isFnType()
    ? closureType.parameters
    : [];

  if (params.length) {
    const tmpFn = new Fn({
      ...call.metadata,
      name: Identifier.from("closure"),
      parameters: cloneParams(params),
    });
    const tmpArgs = new List({ value: call.args.toArray().slice(1) });
    const tmpCall = new Call({
      ...call.metadata,
      fnName: call.fnName.clone(),
      fn: tmpFn,
      args: tmpArgs,
    });
    normalizeArgsForResolvedFn(tmpCall);
    call.args = new List({ value: [closure, ...tmpCall.args.toArray()] });
    call.args.parent = call;
    call.fnName.parent = call;
  }

  if (closure.isClosure()) {
    call.type = closure.getReturnType();
    return call;
  }

  if (closureType?.isFnType()) call.type = closureType.returnType;
  return call;
};

// Helpers
const hasUntypedClosure = (expr: Expr | undefined): boolean =>
  !!(expr?.isClosure() && expr.parameters.some((p) => !p.type && !p.typeExpr));

const specialCallResolvers: Record<string, (c: Call) => Expr> = {
  "::": resolveModuleAccess,
  export: resolveExport,
  cond: resolveCond,
  "call-closure": resolveClosureCall,
  ":": resolveLabeledArg,
  while: resolveWhile,
  FixedArray: resolveFixedArray,
  binaryen: resolveBinaryen,
  "member-access": resolveMemberAccessDirect,
  break: (c: Call) => {
    c.type = dVoid;
    return c;
  },
};
