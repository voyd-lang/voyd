import { AST, Expr } from "./parser.mjs";

type AnnotatedAST = AnnotatedExpr[];
type AnnotatedExpr = string | Scope;
type Scope = {
  parentScope?: Scope;
  functionScope?: Scope;
  functions: Map<string, { name: string; scope: Scope; returnType?: string }>;
  variables: Map<
    string,
    { name: string; index: number; type?: string; mutable: boolean }
  >;
  parameters: Map<
    string,
    { name: string; index: number; type?: string; label?: string }
  >;
  expressions: AnnotatedAST;
};

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
  const params = definitions.slice(1).map((expr) => {
    if (typeof expr === "string") {
      throw new Error("");
    }
  });
};
