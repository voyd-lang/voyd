import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Keep String forwarding overloads generated from their StringSlice sources.

const routerPath = fileURLToPath(new URL("../src/router.voyd", import.meta.url));
const routesPath = fileURLToPath(new URL("../src/routes.voyd", import.meta.url));
const startMarker = "// BEGIN GENERATED STRING METHOD OVERLOADS";
const endMarker = "// END GENERATED STRING METHOD OVERLOADS";
const routesStartMarker = "// BEGIN GENERATED STRING FUNCTION OVERLOADS";
const routesEndMarker = "// END GENERATED STRING FUNCTION OVERLOADS";

const source = readFileSync(routerPath, "utf8");
const base = stripGeneratedRegion(source, startMarker, endMarker);
const methods = readMethods(base);
const signatures = new Set(methods.map(({ signature }) => signature));
const missing = methods.filter(({ signature }) => {
  const stringSignature = replaceDirectStringSlices(signature);
  return stringSignature !== signature && !signatures.has(stringSignature);
});

const generated = ["App", "Router"]
  .map((owner) => renderImpl(owner, missing))
  .filter(Boolean)
  .join("\n\n");

writeFileSync(
  routerPath,
  `${base.trimEnd()}\n\n${startMarker}\n${generated}\n${endMarker}\n`
);

const routesSource = readFileSync(routesPath, "utf8");
const routesBase = stripGeneratedRegion(
  routesSource,
  routesStartMarker,
  routesEndMarker,
);
const functions = readDeclarations(routesBase, "pub fn ");
const functionSignatures = new Set(functions.map(({ signature }) => signature));
const missingFunctions = functions.filter(({ signature }) => {
  const stringSignature = replaceDirectStringSlices(signature);
  return stringSignature !== signature && !functionSignatures.has(stringSignature);
});
const generatedFunctions = missingFunctions.map(renderFunctionOverload).join("\n\n");

writeFileSync(
  routesPath,
  `${routesBase.trimEnd()}\n\n${routesStartMarker}\n${generatedFunctions}\n${routesEndMarker}\n`,
);

function stripGeneratedRegion(value, begin, endMarkerValue) {
  const start = value.indexOf(begin);
  if (start < 0) return value;

  const end = value.indexOf(endMarkerValue, start);
  if (end < 0) throw new Error(`Missing ${endMarkerValue}`);
  return value.slice(0, start) + value.slice(end + endMarkerValue.length);
}

function readMethods(value) {
  return readDeclarations(value, "api fn ");
}

function readDeclarations(value, marker) {
  const methods = [];
  let cursor = 0;

  while ((cursor = value.indexOf(marker, cursor)) >= 0) {
    const open = value.indexOf("(", cursor);
    const close = matchingDelimiter(value, open, "(", ")") + 1;
    const end = value.indexOf("\n", close);
    const raw = value.slice(cursor, end);
    methods.push({ raw, signature: raw.replace(/\s+/g, " ") });
    cursor = end;
  }

  return methods;
}

function renderImpl(owner, methods) {
  const overloads = methods
    .filter(({ signature }) => signature.endsWith(`-> ${owner}`))
    .map(renderOverload);
  return overloads.length ? `impl ${owner}\n${overloads.join("\n\n")}` : "";
}

function renderOverload({ raw, signature }) {
  const declaration = replaceDirectStringSlices(raw);
  const name = signature.match(/^api fn ([^(<]+)/)?.[1];
  if (!name) throw new Error(`Unable to read method name: ${signature}`);

  const typeArguments = readTypeArguments(signature, name);
  const labels = readRecordLabels(signature);
  const call = `self.${name}${typeArguments}(path.as_slice()${labels
    .map((label) => `, ${label}: ${label}`)
    .join("")})`;

  return `  ${declaration.replace(/\n/g, "\n  ")}\n    ${call}`;
}

function renderFunctionOverload({ raw, signature }) {
  const declaration = replaceDirectStringSlices(raw);
  const name = signature.match(/^pub fn ([^(<]+)/)?.[1];
  if (!name) throw new Error(`Unable to read function name: ${signature}`);

  const typeArguments = readTypeArguments(signature, name, "pub fn ");
  const open = signature.indexOf("(");
  const close = matchingDelimiter(signature, open, "(", ")");
  const parameters = splitTopLevel(signature.slice(open + 1, close));
  const argumentsList = parameters.flatMap(renderFunctionParameter);
  return `${declaration}\n  ${name}${typeArguments}(${argumentsList.join(", ")})`;
}

function renderFunctionParameter(parameter) {
  const value = parameter.trim();
  if (!value) return [];
  if (value.startsWith("{") && value.endsWith("}")) {
    return splitTopLevel(value.slice(1, -1)).map((field) => {
      const [binding, type] = splitBinding(field);
      const names = binding.replaceAll("~", "").replaceAll("?", "").trim().split(/\s+/);
      const label = names[0];
      const variable = names.at(-1);
      return `${label}: ${forwardedValue(variable, type)}`;
    });
  }

  const [binding, type] = splitBinding(value);
  const variable = binding.replaceAll("~", "").replaceAll("?", "").trim().split(/\s+/).at(-1);
  return [forwardedValue(variable, type)];
}

function splitBinding(parameter) {
  let parentheses = 0;
  let braces = 0;
  let angles = 0;
  for (let index = 0; index < parameter.length; index += 1) {
    const character = parameter[index];
    if (character === ":" && parentheses === 0 && braces === 0 && angles === 0) {
      return [parameter.slice(0, index), parameter.slice(index + 1)];
    }
    if (character === "(") parentheses += 1;
    if (character === ")") parentheses -= 1;
    if (character === "{") braces += 1;
    if (character === "}") braces -= 1;
    if (character === "<") angles += 1;
    if (character === ">" && angles > 0) angles -= 1;
  }
  throw new Error(`Unable to read parameter: ${parameter}`);
}

function forwardedValue(variable, originalType) {
  return originalType.trim().startsWith("StringSlice")
    ? `${variable}.as_slice()`
    : variable;
}

function replaceDirectStringSlices(value) {
  return value.replaceAll(": StringSlice", ": String");
}

function readTypeArguments(signature, name, marker = "api fn ") {
  const start = marker.length + name.length;
  if (signature[start] !== "<") return "";

  const end = matchingDelimiter(signature, start, "<", ">");
  const parameters = splitTopLevel(signature.slice(start + 1, end));
  const names = parameters.map((parameter) => {
    const match = parameter.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (!match) throw new Error(`Unable to read type parameter: ${parameter}`);
    return match[1];
  });
  return `<${names.join(", ")}>`;
}

function readRecordLabels(signature) {
  const start = signature.indexOf(", {");
  if (start < 0) return [];

  const open = signature.indexOf("{", start);
  const close = matchingDelimiter(signature, open, "{", "}");
  return splitTopLevel(signature.slice(open + 1, close)).map((field) => {
    const match = field.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\??:/);
    if (!match) throw new Error(`Unable to read labeled argument: ${field}`);
    return match[1];
  });
}

function splitTopLevel(value) {
  const parts = [];
  let current = "";
  let parentheses = 0;
  let angles = 0;
  let braces = 0;
  let brackets = 0;

  for (const character of value) {
    if (
      character === "," &&
      parentheses === 0 &&
      angles === 0 &&
      braces === 0 &&
      brackets === 0
    ) {
      parts.push(current);
      current = "";
      continue;
    }

    current += character;
    if (character === "(") parentheses += 1;
    if (character === ")") parentheses -= 1;
    if (character === "<") angles += 1;
    if (character === ">" && angles > 0) angles -= 1;
    if (character === "{") braces += 1;
    if (character === "}") braces -= 1;
    if (character === "[") brackets += 1;
    if (character === "]") brackets -= 1;
  }

  parts.push(current);
  return parts;
}

function matchingDelimiter(value, start, open, close) {
  let depth = 0;
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === open) depth += 1;
    if (value[index] === close) depth -= 1;
    if (depth === 0) return index;
  }
  throw new Error(`Unclosed ${open} at ${start}`);
}
