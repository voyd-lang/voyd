import { Call, Identifier, List, ObjectLiteral, Expr } from "../../syntax-objects/index.js";

/**
 * Transforms a call with a single object literal argument into individual
 * labeled arguments when the call's target function expects multiple labeled
 * parameters. This allows calls such as `move({ x: 1, y: 2 })` to be treated as
 * `move(x: 1, y: 2)` without allocating an intermediate object at compile time.
 */
export const objectArgToParams = (call: Call): void => {
  if (!call.fn?.isFn()) return;
  if (call.args.length !== 1) return;

  const firstArg = call.argAt(0);
  if (!firstArg?.isObjectLiteral()) return;

  const params = call.fn.parameters;
  if (params.length <= 1 || !params.every((p) => p.label)) return;

  const obj = firstArg as ObjectLiteral;
  const newArgs: Expr[] = [];

  for (const p of params) {
    const label = p.label?.value;
    const field = obj.fields.find((f) => f.name === label);
    if (!label || !field) return; // mismatch; abort transform

    const labeledArg = new Call({
      ...field.initializer.metadata,
      fnName: Identifier.from(":"),
      args: new List({ value: [Identifier.from(label), field.initializer] }),
    });
    newArgs.push(labeledArg);
  }

  call.args = new List({ value: newArgs });
  call.args.parent = call;
};

