import { Call, Identifier, List, Expr } from "../../syntax-objects/index.js";
import { getExprType } from "./get-expr-type.js";

/**
 * Transforms a call that passes a single identifier referencing an object into
 * individual labeled arguments when the call's target function expects multiple
 * labeled parameters. This allows calls such as:
 *
 * ````voyd
 * let vec = { x: 1, y: 2 }
 * move(vec)
 * ````
 *
 * to be treated as `move(x: vec.x, y: vec.y)` without allocating an
 * intermediate object at compile time.
 */
export const objectArgToParams = (call: Call): void => {
  if (!call.fn?.isFn()) return;
  if (call.args.length !== 1) return;

  const firstArg = call.argAt(0);
  if (!firstArg?.isIdentifier()) return;

  const params = call.fn.parameters;
  if (params.length <= 1 || !params.every((p) => p.label)) return;

  const argId = firstArg as Identifier;
  const argType = getExprType(argId);
  if (!argType?.isObjectType()) return;

  const newArgs: Expr[] = [];

  for (const p of params) {
    const label = p.label?.value;
    if (!label || !argType.hasField(label)) return;

    const access = new Call({
      ...firstArg.metadata,
      fnName: Identifier.from("member-access"),
      args: new List({
        value: [Identifier.from(argId.value), Identifier.from(label)],
      }),
    });

    const labeledArg = new Call({
      ...firstArg.metadata,
      fnName: Identifier.from(":"),
      args: new List({ value: [Identifier.from(label), access] }),
    });
    newArgs.push(labeledArg);
  }

  call.args = new List({ value: newArgs });
  call.args.parent = call;
};

