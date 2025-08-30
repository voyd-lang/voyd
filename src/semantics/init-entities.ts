import { Declaration } from "../syntax-objects/declaration.js";
import { Implementation } from "../syntax-objects/implementation.js";
import {
  List,
  Fn,
  Parameter,
  Expr,
  Variable,
  Call,
  Block,
  TypeAlias,
  ObjectType,
  ObjectLiteral,
  FixedArrayType,
  nop,
  UnionType,
  IntersectionType,
  Identifier,
  ArrayLiteral,
  Closure,
  FnType,
  dVoid,
} from "../syntax-objects/index.js";
import { Match, MatchCase } from "../syntax-objects/match.js";
import { TraitType } from "../syntax-objects/types/trait.js";
import { SemanticProcessor } from "./types.js";

export const initEntities: SemanticProcessor = (expr) => {
  if (expr.isModule()) {
    return expr.applyMap(initEntities);
  }

  if (!expr.isList()) return expr;

  if (expr.calls("define_function")) {
    return initFn(expr);
  }

  if (expr.calls("define") || expr.calls("define_mut")) {
    const identifierExpr = expr.at(1);
    if (identifierExpr?.isList()) {
      if (identifierExpr.calls("tuple")) {
        return initTupleDestructure(expr, identifierExpr);
      }
      if (identifierExpr.calls("object")) {
        return initObjectDestructure(expr, identifierExpr);
      }
    }
    return initVar(expr);
  }

  if (expr.calls("block")) {
    return initBlock(expr);
  }

  if (expr.calls("declare")) {
    return initDeclaration(expr);
  }

  if (expr.calls("type")) {
    return initTypeAlias(expr);
  }

  // Array literal
  if (expr.calls("array") && expr.hasAttribute("array-literal")) {
    return initArrayLiteral(expr);
  }

  // Tuple literal
  if (expr.calls("tuple")) {
    return initTupleLiteral(expr);
  }

  // Object literal
  if (expr.calls("object")) {
    return initObjectLiteral(expr);
  }

  // Nominal object definition
  if (expr.calls("obj")) {
    return initNominalObjectType(expr);
  }

  if (expr.calls("match")) {
    // Only treat `match(...)` as a match-expression when followed by one or
    // more labeled cases (":" entries). This lets predicate-style usages like
    // `if opt.match(Some<T>) then:` pass through as a normal call so they can
    // be lowered later during resolution (e.g., if/while sugar).
    const hasBinder = !!expr.at(2)?.isIdentifier();
    const casesStart = hasBinder ? 3 : 2;
    const hasCases = expr
      .sliceAsArray(casesStart)
      .some((e) => e.isList() && e.calls(":"));

    if (hasCases) return initMatch(expr);
    // Fall through to generic call init when no cases are present
  }

  if (expr.calls("impl")) {
    return initImpl(expr);
  }

  if (expr.calls("trait")) {
    return initTrait(expr);
  }

  if (expr.calls("=>")) {
    return initClosure(expr);
  }

  return initCall(expr);
};

const initBlock = (block: List): Block => {
  const body = block.sliceAsArray(1).flatMap((expr) => {
    const inited = initEntities(expr);
    if (inited.isBlock() && inited.hasAttribute("flatten")) {
      return (inited as Block).body;
    }
    return [inited];
  });
  return new Block({ ...block.metadata, body });
};

const initFn = (expr: List): Fn => {
  const name = expr.identifierAt(1);
  const parameterList = expr.listAt(2);

  const typeParameters =
    parameterList.at(1)?.isList() && parameterList.listAt(1).calls("generics")
      ? extractTypeParams(parameterList.listAt(1))
      : undefined;

  const parameters = parameterList
    .sliceAsArray(typeParameters ? 2 : 1)
    .flatMap((p) => {
      if (p.isIdentifier()) {
        return new Parameter({
          name: p,
          typeExpr: undefined,
        });
      }

      if (!p.isList()) {
        throw new Error("Invalid parameter");
      }

      return initParameter(p);
    });

  const returnTypeExpr = getReturnTypeExprForFn(expr, 3);

  const fn = new Fn({
    name,
    returnTypeExpr: returnTypeExpr,
    parameters,
    typeParameters,
    ...expr.metadata,
  });

  const body = expr.at(4);

  if (body) {
    body.parent = fn;
    fn.body = initEntities(body);
  }

  return fn;
};

const initClosure = (expr: List): Closure => {
  const paramsExpr = expr.at(1);
  let parameters: Parameter[] = [];
  let returnTypeExpr: Expr | undefined;

  if (paramsExpr?.isList()) {
    if (paramsExpr.calls("->")) {
      const fnType = initFnType(paramsExpr);
      parameters = fnType.parameters;
      returnTypeExpr = fnType.returnTypeExpr;
    } else if (paramsExpr.calls(":")) {
      const param = initParameter(paramsExpr);
      parameters = Array.isArray(param) ? param : [param];
    } else {
      parameters = paramsExpr.sliceAsArray().flatMap((p) => {
        if (p.isIdentifier()) {
          return new Parameter({ name: p, typeExpr: undefined });
        }
        if (!p.isList()) {
          throw new Error("Invalid parameter");
        }
        return initParameter(p);
      });
    }
  } else if (paramsExpr?.isIdentifier()) {
    parameters = [new Parameter({ name: paramsExpr, typeExpr: undefined })];
  }

  const bodyExpr = initEntities(expr.exprAt(2));
  const body = bodyExpr?.isBlock()
    ? bodyExpr
    : new Block({
        ...(bodyExpr?.metadata ?? {}),
        body: bodyExpr ? [bodyExpr] : [],
      });

  return new Closure({
    ...expr.metadata,
    parameters,
    body,
    returnTypeExpr,
  });
};

const initParameter = (
  list: List,
  labeled = false,
  labelOverride?: Identifier
): Parameter | Parameter[] => {
  if (list.identifierAt(0).is("generics")) {
    return [];
  }

  if (list.identifierAt(0).is("object")) {
    return list.sliceAsArray(1).flatMap((e) => initParameter(e as List, true));
  }

  const first = list.at(0);
  const second = list.at(1);
  if (first?.isIdentifier() && second?.isList() && second.calls(":")) {
    return initParameter(second, true, first);
  }

  const { name, typeExpr, isMutableRef } = unwrapVariableIdentifier(list);

  if (!name) throw new Error("Invalid parameter");
  return new Parameter({
    ...list.metadata,
    name,
    typeExpr,
    label: labelOverride ?? (labeled ? name : undefined),
    attributes: { isMutableRef },
  });
};

const getReturnTypeExprForFn = (fn: List, index: number): Expr | undefined => {
  const returnDec = fn.at(index);
  if (!returnDec?.isList()) return undefined;
  if (!returnDec.calls("return_type")) return undefined;
  return initTypeExprEntities(returnDec.at(1));
};

const initArrayLiteral = (arr: List): ArrayLiteral => {
  return new ArrayLiteral({
    ...arr.metadata,
    elements: arr.sliceAsArray(1).map((e) => initEntities(e)),
  });
};

const initTupleLiteral = (tuple: List): ObjectLiteral => {
  return new ObjectLiteral({
    ...tuple.metadata,
    fields: tuple.sliceAsArray(1).map((e, i) => ({
      name: i.toString(),
      initializer: initEntities(e),
    })),
  });
};

const initObjectLiteral = (obj: List) => {
  return new ObjectLiteral({
    ...obj.metadata,
    fields: obj.sliceAsArray(1).map((f) => {
      // Support object literal field shorthand: `{ a }` becomes
      // `{ a: a }`
      if (f.isIdentifier()) {
        return { name: f.value, initializer: initEntities(f) };
      }

      if (f.isList()) {
        const name = f.identifierAt(1);
        const initializer = f.at(2);

        if (!name || !initializer) {
          throw new Error("Invalid object field");
        }

        return { name: name.value, initializer: initEntities(initializer) };
      }

      throw new Error("Invalid object field");
    }),
  });
};

const initPipedUnionType = (union: List) => {
  const children: Expr[] = [];

  const extractChildren = (list: List) => {
    const child = initEntities(list.exprAt(1));
    children.push(child);

    if (list.at(2)?.isList() && list.listAt(2).calls("|")) {
      extractChildren(list.listAt(2));
      return;
    }

    children.push(initEntities(list.exprAt(2)));
  };

  extractChildren(union);

  return new UnionType({
    ...union.metadata,
    childTypeExprs: children,
    name: union.syntaxId.toString(),
  });
};

const initIntersection = (intersection: List): IntersectionType => {
  const nominalObjectExpr = initTypeExprEntities(intersection.at(1));
  const structuralObjectExpr = initTypeExprEntities(intersection.at(2));

  if (!nominalObjectExpr || !structuralObjectExpr) {
    throw new Error("Invalid intersection type");
  }

  return new IntersectionType({
    ...intersection.metadata,
    name: intersection.syntaxId.toString(),
    nominalObjectExpr,
    structuralObjectExpr,
  });
};

const initVar = (varDef: List): Variable => {
  const isMutable = varDef.calls("define_mut");
  const idExpr = varDef.at(1);
  const { name, typeExpr, isMutableRef } = unwrapVariableIdentifier(idExpr);

  if (!name) {
    throw new Error("Invalid variable definition, invalid identifier");
  }

  if (name.resolve()) {
    throw new Error(
      `Variable name already in use: ${name} at ${name.location}`
    );
  }

  const initializer = varDef.at(2);

  if (!initializer) {
    throw new Error("Invalid variable definition, missing initializer");
  }

  return new Variable({
    ...varDef.metadata,
    name,
    typeExpr,
    initializer: initEntities(initializer),
    isMutable,
    attributes: { isMutableRef },
  });
};

const unwrapVariableIdentifier = (expr?: Expr) => {
  if (expr?.isIdentifier()) return { name: expr };
  if (!expr?.isList()) return {};

  const [nameExpr, typeExpr] = expr.calls(":")
    ? [expr.at(1), initTypeExprEntities(expr.at(2))]
    : [expr];

  if (nameExpr?.isList() && nameExpr.calls("&")) {
    const name = nameExpr.optionalIdentifierAt(1);
    return { name, isMutableRef: true, typeExpr };
  }

  if (nameExpr?.isIdentifier()) return { name: nameExpr, typeExpr };
  return {};
};

const initTupleDestructure = (varDef: List, tuple: List): Block => {
  const initializer = varDef.at(2);

  if (!initializer) {
    throw new Error("Invalid variable definition, missing initializer");
  }

  const vars = tuple.sliceAsArray(1).map((name, index) => {
    if (!name.isIdentifier()) {
      throw new Error("Invalid tuple destructure");
    }

    const accessExpr = new List([index, initializer.clone()]);
    const varList = new List([varDef.identifierAt(0), name, accessExpr]);
    return initVar(varList);
  });
  const block = new Block({ ...varDef.metadata, body: vars });
  block.setAttribute("flatten", true);
  return block;
};

const initObjectDestructure = (varDef: List, obj: List): Block => {
  const initializer = varDef.at(2);

  if (!initializer) {
    throw new Error("Invalid variable definition, missing initializer");
  }

  const vars = obj.sliceAsArray(1).map((field) => {
    if (field.isIdentifier()) {
      const accessExpr = new List([field.clone(), initializer.clone()]);
      const varList = new List([varDef.identifierAt(0), field, accessExpr]);
      return initVar(varList);
    }

    if (field.isList() && field.calls(":")) {
      const propName = field.identifierAt(1);
      const name = field.at(2);
      if (!propName?.isIdentifier() || !name?.isIdentifier()) {
        throw new Error("Invalid object destructure");
      }
      const accessExpr = new List([propName.clone(), initializer.clone()]);
      const varList = new List([varDef.identifierAt(0), name, accessExpr]);
      return initVar(varList);
    }

    throw new Error("Invalid object destructure");
  });

  const block = new Block({ ...varDef.metadata, body: vars });
  block.setAttribute("flatten", true);
  return block;
};

const initDeclaration = (decl: List) => {
  const namespace = decl.at(1);

  if (!namespace?.isIdentifier()) {
    throw new Error("Expected namespace identifier");
  }

  const fns = decl
    .listAt(2)
    .sliceAsArray(1)
    .map(initEntities)
    .filter((e) => e.isFn()) as Fn[];

  return new Declaration({
    ...decl.metadata,
    namespace: namespace.value,
    fns,
  });
};

const initTypeAlias = (type: List) => {
  const assignment = type.listAt(1);
  const nameExpr = assignment.at(1);
  const typeExpr = initTypeExprEntities(assignment.at(2));

  const nameIsList = nameExpr?.isList();

  const name = nameIsList
    ? nameExpr.identifierAt(0)
    : nameExpr?.isIdentifier()
    ? nameExpr
    : undefined;

  const typeParameters = nameIsList
    ? extractTypeParams(nameExpr.listAt(1))
    : undefined;

  if (!name || !typeExpr) {
    throw new Error(`Invalid type alias ${type.location}`);
  }

  if (typeExpr.isType()) {
    typeExpr.setName(name.value);
  }

  return new TypeAlias({ ...type.metadata, name, typeExpr, typeParameters });
};

const initCall = (call: List) => {
  if (!call.length) {
    throw new Error("Invalid fn call");
  }

  let fnName = call.at(0);
  if (fnName?.isInt()) {
    const val =
      typeof fnName.value === "number" ? fnName.value : fnName.value.value;
    fnName = Identifier.from(val.toString());
  }

  if (!fnName?.isIdentifier()) {
    throw new Error("Invalid fn call");
  }

  const typeArgs =
    call.at(1)?.isList() && call.listAt(1).calls("generics")
      ? call
          .listAt(1)
          .slice(1)
          .map((expr) => initTypeExprEntities(expr)!)
      : undefined;

  const args = call.slice(typeArgs ? 2 : 1).map(initEntities);
  return new Call({ ...call.metadata, fnName, args, typeArgs });
};

const initFnType = (fn: List): FnType => {
  const paramsExpr = fn.at(1);
  let parameters: Parameter[] = [];

  if (paramsExpr?.isList()) {
    if (paramsExpr.calls(":")) {
      const param = initParameter(paramsExpr);
      parameters = Array.isArray(param) ? param : [param];
    } else if (paramsExpr.calls("tuple")) {
      parameters = paramsExpr.sliceAsArray(1).flatMap((p) => {
        if (p.isIdentifier()) {
          return [new Parameter({ name: p, typeExpr: undefined })];
        }
        if (!p.isList()) {
          throw new Error("Invalid parameter");
        }
        const param = initParameter(p);
        return Array.isArray(param) ? param : [param];
      });
    } else {
      parameters = paramsExpr.sliceAsArray().flatMap((p) => {
        if (p.isIdentifier()) {
          return [new Parameter({ name: p, typeExpr: undefined })];
        }
        if (!p.isList()) {
          throw new Error("Invalid parameter");
        }
        const param = initParameter(p);
        return Array.isArray(param) ? param : [param];
      });
    }
  } else if (paramsExpr?.isIdentifier()) {
    parameters = [new Parameter({ name: paramsExpr, typeExpr: undefined })];
  }

  const returnTypeExpr = initTypeExprEntities(fn.at(2));

  const fnType = new FnType({
    ...fn.metadata,
    name: Identifier.from(`FnType#${fn.syntaxId}`),
    parameters,
    returnType: dVoid,
    returnTypeExpr: returnTypeExpr,
  });

  fnType.parameters.forEach((p) => (p.parent = fnType));
  if (fnType.returnTypeExpr) {
    fnType.returnTypeExpr.parent = fnType;
  }

  return fnType;
};

const initTypeExprEntities = (type?: Expr): Expr | undefined => {
  if (!type) return undefined;

  if (type.isIdentifier()) {
    return type;
  }

  if (type.isType()) {
    return type;
  }

  if (!type.isList()) {
    // Provide a clear error without noisy console logging
    const rendered = JSON.stringify(type, undefined, 2);
    throw new Error(`Invalid type entity: ${rendered}`);
  }

  if (type.calls("tuple")) {
    return initTupleType(type);
  }

  if (type.calls("object")) {
    return initStructuralObjectType(type);
  }

  if (type.calls("->")) {
    return initFnType(type);
  }

  if (type.calls("FixedArray")) {
    return initFixedArrayType(type);
  }

  if (type.calls("|")) {
    return initPipedUnionType(type);
  }

  if (type.calls("+")) {
    return initIntersection(type);
  }

  return initCall(type);
};

const initTupleType = (tuple: List) => {
  return new ObjectType({
    ...tuple.metadata,
    name: tuple.syntaxId.toString(),
    value: tuple.sliceAsArray(1).map((t, i) => ({
      name: i.toString(),
      typeExpr: initTypeExprEntities(t)!,
    })),
    isStructural: true,
  });
};

const initFixedArrayType = (type: List) => {
  const generics = type.listAt(1);
  const elemTypeExpr = initTypeExprEntities(generics.at(1));

  if (!elemTypeExpr) {
    throw new Error("Invalid FixedArray type");
  }

  return new FixedArrayType({
    ...type.metadata,
    elemTypeExpr,
    name: type.syntaxId.toString(),
  });
};

const initNominalObjectType = (obj: List) => {
  const header = obj.at(1);

  const [nameExpr, parentExpr] =
    header?.isList() && header.calls(":")
      ? [header.at(1), header.at(2)]
      : [header, undefined];

  if (!nameExpr) throw new Error("Invalid object definition: missing name");

  const [name, typeParameters] = nameExpr.isList()
    ? [nameExpr.identifierAt(0), extractTypeParams(nameExpr.listAt(1))]
    : nameExpr.isIdentifier()
    ? [nameExpr, undefined]
    : [undefined, undefined];

  if (!name)
    throw new Error("Invalid object definition: invalid name expression");

  return new ObjectType({
    ...obj.metadata,
    name,
    typeParameters,
    parentObjExpr: parentExpr ? initEntities(parentExpr) : undefined,
    value: extractObjectFields(obj.listAt(2)),
  });
};

const initStructuralObjectType = (obj: List) => {
  return new ObjectType({
    ...obj.metadata,
    name: obj.syntaxId.toString(),
    value: extractObjectFields(obj),
    isStructural: true,
  });
};

export const initMatch = (match: List): Match => {
  const operand = initEntities(match.exprAt(1));
  const identifierIndex = match.at(2)?.isIdentifier() ? 2 : 1;
  const identifier = match.identifierAt(identifierIndex);
  const caseExprs = match.sliceAsArray(identifierIndex + 1);
  const cases = initMatchCases(caseExprs);

  return new Match({
    ...match.metadata,
    operand,
    cases: cases.cases,
    defaultCase: cases.defaultCase,
    bindIdentifier: identifier,
    bindVariable:
      identifierIndex === 2 // We need a new variable if the second argument is an identifier (to support dot notation)
        ? new Variable({
            name: identifier.clone(),
            location: identifier.location,
            initializer: operand,
            isMutable: false,
            parent: match,
          })
        : undefined,
  });
};

const initMatchCases = (
  cases: Expr[]
): { cases: MatchCase[]; defaultCase?: MatchCase } => {
  return cases.reduce(
    ({ cases, defaultCase }, expr) => {
      if (!expr.isList() || !expr.calls(":")) {
        throw new Error(
          `Match cases must be in the form of : at ${expr.location}`
        );
      }

      const isElse =
        expr.at(1)?.isIdentifier() && expr.identifierAt(1).is("else");

      const typeExpr = !isElse ? initEntities(expr.exprAt(1)) : undefined;

      const caseExpr = initEntities(expr.exprAt(2));

      const scopedCaseExpr = caseExpr?.isBlock()
        ? caseExpr
        : new Block({ ...caseExpr.metadata, body: [caseExpr] });

      const mCase = { matchTypeExpr: typeExpr, expr: scopedCaseExpr };

      if (isElse) {
        return { cases, defaultCase: mCase };
      }

      return { cases: [...cases, mCase], defaultCase };
    },
    {
      cases: [] as MatchCase[],
      defaultCase: undefined as MatchCase | undefined,
    }
  );
};

const extractObjectFields = (obj: List) => {
  return obj.sliceAsArray(1).map((v) => {
    if (!v.isList()) {
      throw new Error("Invalid object field");
    }
    const name = v.identifierAt(1);
    const typeExpr = initTypeExprEntities(v.at(2));

    if (!name || !typeExpr) {
      throw new Error("Invalid object field");
    }

    return { name: name.value, typeExpr };
  });
};

const initImpl = (impl: List): Implementation => {
  const first = impl.exprAt(1);
  const generics =
    first.isList() && first.calls("generics")
      ? first.sliceAsArray(1).flatMap((p) => (p.isIdentifier() ? p : []))
      : undefined;

  const possibleTraitIndex = generics ? 2 : 1;
  const possibleFor = impl.at(possibleTraitIndex + 1);
  const traitExpr =
    possibleFor?.isIdentifier() && possibleFor.is("for")
      ? initEntities(impl.exprAt(possibleTraitIndex))
      : undefined;

  let targetTypeIndex = 1;
  if (generics) targetTypeIndex += 1;
  if (traitExpr) targetTypeIndex += 2;

  const targetTypeExpr = initEntities(impl.exprAt(targetTypeIndex));

  const init = new Implementation({
    ...impl.metadata,
    typeParams: generics ?? [],
    targetTypeExpr,
    body: nop(),
    traitExpr,
  });

  const body = impl.exprAt(targetTypeIndex + 1);
  body.parent = init;
  init.body.value = initEntities(body);
  return init;
};

const initTrait = (trait: List) => {
  const nameExpr = trait.at(1);
  const [name, typeParameters] = nameExpr?.isList()
    ? [nameExpr.identifierAt(0), extractTypeParams(nameExpr.listAt(1))]
    : [trait.identifierAt(1), undefined];

  const methods = trait
    .listAt(2)
    .sliceAsArray(1)
    .map(initEntities)
    .filter((e) => e.isFn()) as Fn[];

  return new TraitType({ ...trait.metadata, name, methods, typeParameters });
};

/** Expects ["generics", ...Identifiers] */
const extractTypeParams = (list: List) =>
  list.sliceAsArray(1).flatMap((p) => (p.isIdentifier() ? p : []));
