import { Call } from "../call.js";
import { Identifier } from "../identifier.js";
import { Int } from "../int.js";
import { List } from "../list.js";
import { ObjectLiteral } from "../object-literal.js";
import { i32 } from "../types.js";
import type { SyntaxMetadata } from "../syntax.js";

export const makeString = (value: string, metadata: SyntaxMetadata = {}) => {
  const codes = value
    .split("")
    .map((c) => new Int({ ...metadata, value: c.charCodeAt(0) }));

  const fixedArray = new Call({
    ...metadata,
    fnName: Identifier.from("FixedArray"),
    args: new List({ value: codes }),
    typeArgs: new List({ value: [i32.clone()] }),
  });

  const objLiteral = new ObjectLiteral({
    ...metadata,
    fields: [{ name: "from", initializer: fixedArray }],
  });

  return new Call({
    ...metadata,
    fnName: Identifier.from("new_string"),
    args: new List({ value: [objLiteral] }),
  });
};
