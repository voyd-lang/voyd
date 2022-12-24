import { isList } from "../lib/is-list.mjs";
import {
  CDT_ADDRESS_TYPE,
  isPrimitiveType,
} from "../lib/is-primitive-type.mjs";
import { ModuleInfo } from "../lib/module-info.mjs";
import { toIdentifier } from "../lib/to-identifier.mjs";
import { AST } from "../parser.mjs";

export const memoryManagement = (ast: AST, info: ModuleInfo): AST => {
  if (!info.isRoot) return ast;
  const cdts = mapCDTs(ast);
  return insertMemInstructions(ast, cdts);
};

const insertMemInstructions = (ast: AST, map: CdtSizeMap): AST =>
  ast.reduce((ast: AST, expr): AST => {
    if (!isList(expr)) {
      ast.push(expr);
      return ast;
    }

    if (expr[0] !== "define-function") {
      ast.push(insertMemInstructions(expr, map));
      return ast;
    }

    const returnTypeDef = expr[4] as AST;
    if (isPrimitiveType(returnTypeDef[1])) {
      ast.push(insertMemInstructions(expr, map));
      return ast;
    }

    // For now, the only list return type is (cdt-pointer $name $size). Which does not need memory management
    if (isList(returnTypeDef[1])) {
      returnTypeDef[1] = returnTypeDef[1][1]; // Change return type just to the name
      ast.push(insertMemInstructions(expr, map));
      return ast;
    }

    const size = map.get(toIdentifier(returnTypeDef[1] as string));
    if (typeof size === "undefined") {
      throw new Error(`Unrecognized type ${returnTypeDef}`);
    }

    ast.push(addMemInstructionsToFunctionDef(expr, size));
    return ast;
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
    "block",
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
