import { idIs, isOp } from "../grammar.js";
import { Expr, List, ListValue } from "../../syntax-objects/index.js";

export const functionalNotation = (list: List): List => {
  return processList(list);
};

const processList = (initialList: List): List => {
  const stack: {
    list: List;
    array: Expr[];
    index: number;
    result: ListValue[];
    isTuple: boolean;
    skip: number;
  }[] = [];

  stack.push({
    list: initialList,
    array: initialList.toArray(),
    index: 0,
    result: [],
    isTuple: false,
    skip: 0,
  });

  while (stack.length > 0) {
    const ctx = stack[stack.length - 1];

    if (ctx.index >= ctx.array.length) {
      const finalizedList = finalizeResult(ctx.result, ctx.isTuple, ctx.list);
      stack.pop();

      if (stack.length > 0) {
        const parentCtx = stack[stack.length - 1];
        parentCtx.result.push(finalizedList);
        parentCtx.index++;
      } else {
        return finalizedList;
      }
      continue;
    }

    if (ctx.skip > 0) {
      ctx.skip--;
      ctx.index++;
      continue;
    }

    const expr = ctx.array[ctx.index];

    if (expr.isList()) {
      stack.push({
        list: expr as List,
        array: (expr as List).toArray(),
        index: 0,
        result: [],
        isTuple: false,
        skip: 0,
      });
      continue;
    }

    if (expr.isWhitespace()) {
      ctx.result.push(expr);
      ctx.index++;
      continue;
    }

    const nextExpr = ctx.array[ctx.index + 1];

    if (nextExpr && nextExpr.isList() && !(isOp(expr) || idIs(expr, ","))) {
      if ((nextExpr as List).calls("generics")) {
        const generics = nextExpr as List;
        const nextNextExpr = ctx.array[ctx.index + 2];
        if (nextNextExpr && nextNextExpr.isList()) {
          const functional = processGenerics(
            expr,
            generics,
            nextNextExpr as List
          );
          ctx.result.push(functional);
          ctx.skip = 2;
        } else {
          const functional = processGenerics(expr, generics);
          ctx.result.push(functional);
          ctx.skip = 1;
        }
      } else {
        const functional = processParamList(expr, nextExpr as List);
        ctx.result.push(functional);
        ctx.skip = 1;
      }
      ctx.index++;
      continue;
    }

    if (ctx.list.getAttribute("tuple?") && idIs(expr, ",")) {
      ctx.isTuple = true;
    }

    ctx.result.push(expr);
    ctx.index++;
  }

  throw new Error("Unexpected end of processList");
};

const finalizeResult = (
  result: ListValue[],
  isTuple: boolean,
  originalList: List
): List => {
  if (isTuple) {
    result.unshift(",");
    result.unshift("tuple");
  }
  return new List({ ...originalList.metadata, value: result });
};

const processGenerics = (expr: Expr, generics: List, params?: List): List => {
  generics.setAttribute("tuple?", false);

  const list = params || new List([]);
  list.insert(expr);
  list.insert(",", 1);
  list.setAttribute("tuple?", false);

  const functional = processList(list);
  const processedGenerics = processList(generics);

  functional.insert(processedGenerics, 2);
  functional.insert(",", 3);
  return functional;
};

const processParamList = (expr: Expr, params: List): List => {
  params.insert(expr);
  params.insert(",", 1);
  params.setAttribute("tuple?", false);
  return processList(params);
};
