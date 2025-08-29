import { Fn, Parameter } from "../syntax-objects/index.js";
import { formatTypeName } from "./type-format.js";

/** Format a function's signature for display in error messages. */
export const formatFnSignature = (fn: Fn): string => {
  const params = fn.parameters.map(formatParam).join(", ");
  const ret = fn.returnType ? formatTypeName(fn.returnType) : undefined;
  return ret ? `${fn.name}(${params}) -> ${ret}` : `${fn.name}(${params})`;
};

const formatParam = (p: Parameter): string => {
  const name = p.label?.value ?? p.name.value;
  const type = p.type ? formatTypeName(p.type) : "unknown";
  return `${name}: ${type}`;
};
