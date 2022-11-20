import { AST, Expr } from "./parser.mjs";

export const analyzeSemantics = (ast: AST): AnnotatedAST => {
  const annotated = ast.map(annotateExpr);

  return annotated;
};

const annotateExpr = (expr: Expr): AnnotatedExpr => {
  if (typeof expr === "string") return expr;

  const car = expr[0];

  if (car === "fn") return annotateFn(expr);
};

const annotateFn = (fn: AST): Scope => {
  const definitions = fn[1];

  if (!(definitions instanceof Array)) {
    throw new Error("Expected function definitions list");
  }

  const fnIdentifier = definitions[0];
  const params = extractParamsFromFn(definitions);
  const body = fn.slice(4);
  const scope;
  const variables = annotateFnBody(body, params.size - 1);
};

const annotateFnBody = (body: AST, ctx: Context): AnnotatedAST => {};

const extractParamsFromFn = (definitions: AST): Parameters =>
  definitions.slice(1).map(fnParamMapper).reduce(fnParamReducer, new Map());

const fnParamReducer = (map: Parameters, param: Parameter) => {
  if (map.has(param.name)) {
    throw new Error(`Duplicate param identifier ${param.name}`);
  }

  map.set(param.name, param);
  return map;
};

const fnParamMapper = (expr: Expr, index: number): Parameter => {
  if (typeof expr === "string" || expr.every((e) => typeof e === "string")) {
    throw new Error("Expected Parameter");
  }

  let parts = expr as string[];

  // No label: i.e. ["typed-parameter", "n", "Int"]
  if (parts.length === 3) {
    return { name: parts[1], index, type: parts[2] };
  }

  // Label: ["typed-parameter", "label", "n", "Float"]
  return { name: parts[2], index, type: parts[3], label: parts[1] };
};

type Context = {
  parentScope?: Scope;
  functionScope?: Scope;
  startVariableIndex?: number;
};

type AnnotatedAST = AnnotatedExpr[];

type AnnotatedExpr = string | Scope;

type Variable = {
  name: string;
  index: number;
  type?: string;
  mutable: boolean;
};

type Variables = Map<string, Variable>;

type Parameters = Map<string, Parameter>;

type Parameter = { name: string; index: number; type?: string; label?: string };

type Fn = { name: string; scope: Scope; returnType?: string };

type Functions = Map<string, Fn[]>;

type Scope = {
  parentScope?: Scope;
  functionScope?: Scope;
  functions: Functions; // There may be multiple functions with the same name.
  variables: Variables;
  parameters: Parameters;
  expressions: AnnotatedAST;
};
