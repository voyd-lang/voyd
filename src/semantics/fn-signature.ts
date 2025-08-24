import { Fn, Parameter } from "../syntax-objects/index.js";

/** Format a function's signature for display in error messages. */
export const formatFnSignature = (fn: Fn): string => {
  const params = fn.parameters.map(formatParam).join(", ");
  const ret = fn.returnType?.name?.toString();
  return ret ? `${fn.name}(${params}) -> ${ret}` : `${fn.name}(${params})`;
};

const formatParam = (p: Parameter): string => {
  const name = p.label?.value ?? p.name.value;
  const type = p.type ? p.type.name.toString() : "unknown";
  return `${name}: ${type}`;
};
