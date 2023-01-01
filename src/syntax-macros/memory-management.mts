import {
  CDT_ADDRESS_TYPE,
  isPrimitiveType,
} from "../lib/is-primitive-type.mjs";
import { ModuleInfo } from "../lib/module-info.mjs";
import { Expr, Identifier, isList, List } from "../lib/syntax/syntax.mjs";
import { toIdentifier } from "../lib/to-identifier.mjs";

export const memoryManagement = (list: List, info: ModuleInfo): List => {
  if (!info.isRoot) return list;
  const cdts = mapCDTs(list);
  return insertMemInstructions(list, cdts);
};

const insertMemInstructions = (list: List, map: CdtSizeMap): List =>
  list.reduce((expr) => {
    if (!isList(expr)) return expr;

    if (expr.calls("define-function")) return insertMemInstructions(expr, map);

    const fn = expr.at(1) as Identifier;
    const returnType = fn.props.get("returnType") as Expr;

    if (isPrimitiveType(returnType)) return insertMemInstructions(expr, map);

    const size = map.get(toIdentifier(returnTypeDef[1] as string));
    if (typeof size === "undefined") {
      throw new Error(`Unrecognized type ${returnTypeDef}`);
    }

    list.push(addMemInstructionsToFunctionDef(expr, size));
    return list;
  }, []);

const addMemInstructionsToFunctionDef = (
  ast: AST,
  allocationSize: number
): AST => {
  const body = ast[5];
  const variables = ast[3] as AST;
  const returnAddressVarName = "*__return_alloc_address";
  variables.push([returnAddressVarName, CDT_ADDRESS_TYPE]);
  ast[5] = [
    "typed-block",
    CDT_ADDRESS_TYPE,
    [
      "define",
      ["labeled-expr", returnAddressVarName, CDT_ADDRESS_TYPE],
      ["alloc", allocationSize],
    ],
    ["set-return", ["copy", body, returnAddressVarName]],
  ];
  return ast;
};

// TODO: Support scoping
type CdtSizeMap = Map<string, number>;

const mapCDTs = (ast: AST, map: CdtSizeMap = new Map()) =>
  ast.reduce((map: CdtSizeMap, expr): CdtSizeMap => {
    if (!isList(expr)) return map;
    if (expr[0] !== "define-cdt") return mapCDTs(expr, map);
    return map.set(toIdentifier(expr[1] as string), expr[3] as number);
  }, map);
