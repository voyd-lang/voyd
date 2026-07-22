import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Keep String forwarding overloads generated from their StringSlice sources.

const routerPath = fileURLToPath(new URL("../src/router.voyd", import.meta.url));
const routesPath = fileURLToPath(new URL("../src/routes.voyd", import.meta.url));
const startMarker = "// BEGIN GENERATED STRING METHOD OVERLOADS";
const endMarker = "// END GENERATED STRING METHOD OVERLOADS";
const httpStartMarker = "// BEGIN GENERATED HTTP METHOD OVERLOADS";
const httpEndMarker = "// END GENERATED HTTP METHOD OVERLOADS";
const routesStartMarker = "// BEGIN GENERATED STRING FUNCTION OVERLOADS";
const routesEndMarker = "// END GENERATED STRING FUNCTION OVERLOADS";
const checkOnly = process.argv.includes("--check");

const source = readFileSync(routerPath, "utf8");
const withoutStrings = stripGeneratedRegion(source, startMarker, endMarker);
const base = stripGeneratedRegion(
  withoutStrings,
  httpStartMarker,
  httpEndMarker,
);
const httpOverloads = generateHttpMethodOverloads(base);
const sourceWithHttp = `${base.trimEnd()}\n\n${httpStartMarker}\n${httpOverloads}\n${httpEndMarker}\n`;
const methods = readMethods(sourceWithHttp);
validateExplicitOverloads(
  methods.filter(
    ({ signature }) =>
      signature.includes("path: StringSlice") &&
      signature.endsWith("-> App"),
  ),
  renderOverload,
);
const signatures = new Set(methods.map(({ signature }) => signature));
const missing = methods.filter(({ signature }) => {
  const stringSignature = replaceDirectStringSlices(signature);
  return stringSignature !== signature && !signatures.has(stringSignature);
});

const generated = ["App", "Router"]
  .map((owner) => renderImpl(owner, missing))
  .filter(Boolean)
  .join("\n\n");

const generatedRouterSource = `${sourceWithHttp.trimEnd()}\n\n${startMarker}\n${generated}\n${endMarker}\n`;

const routesSource = readFileSync(routesPath, "utf8");
const routesBase = stripGeneratedRegion(
  routesSource,
  routesStartMarker,
  routesEndMarker,
);
const functions = readDeclarations(routesBase, "pub fn ");
validateExplicitOverloads(functions, renderFunctionOverload);
const functionSignatures = new Set(functions.map(({ signature }) => signature));
const missingFunctions = functions.filter(({ signature }) => {
  const stringSignature = replaceDirectStringSlices(signature);
  return stringSignature !== signature && !functionSignatures.has(stringSignature);
});
const generatedFunctions = missingFunctions.map(renderFunctionOverload).join("\n\n");

const generatedRoutesSource = `${routesBase.trimEnd()}\n\n${routesStartMarker}\n${generatedFunctions}\n${routesEndMarker}\n`;

if (checkOnly) {
  const stale = [
    ...(source === generatedRouterSource ? [] : [routerPath]),
    ...(routesSource === generatedRoutesSource ? [] : [routesPath]),
  ];
  if (stale.length > 0) {
    throw new Error(
      `Generated web overloads are stale: ${stale.join(", ")}. Run npm run generate:string-overloads --workspace @voyd-lang/web.`,
    );
  }
} else {
  writeFileSync(routerPath, generatedRouterSource);
  writeFileSync(routesPath, generatedRoutesSource);
}

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
    const separator = value.indexOf("\n\n", end + 1);
    const bodyEnd = separator < 0 ? value.length : separator;
    const body = value.slice(end + 1, bodyEnd);
    methods.push({ raw, body, signature: raw.replace(/\s+/g, " ") });
    cursor = end;
  }

  return methods;
}

function validateExplicitOverloads(declarations, render) {
  const bySignature = new Map(
    declarations.map((declaration) => [declaration.signature, declaration]),
  );

  declarations.forEach((declaration) => {
    const stringSignature = replaceDirectStringSlices(declaration.signature);
    if (stringSignature === declaration.signature) return;
    const explicit = bySignature.get(stringSignature);
    if (!explicit) return;

    const rendered = render(declaration);
    const expected = normalizeForwardingCall(
      rendered.slice(rendered.lastIndexOf("\n") + 1),
    );
    const actual = normalizeForwardingCall(explicit.body);
    if (actual !== expected) {
      throw new Error(
        `Explicit String overload must forward to its StringSlice twin: ${stringSignature}\nExpected: ${expected}\nActual: ${actual}`,
      );
    }
  });
}

function normalizeWhitespace(value) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
}

function normalizeForwardingCall(value) {
  const normalized = normalizeWhitespace(value);
  const openParen = normalized.indexOf("(");
  const openAngle = normalized.indexOf("<");
  if (openAngle < 0 || openAngle > openParen) return normalized;

  const closeAngle = matchingDelimiter(normalized, openAngle, "<", ">");
  return normalized.slice(0, openAngle) + normalized.slice(closeAngle + 1);
}

function renderImpl(owner, methods) {
  const overloads = methods
    .filter(({ signature }) => signature.endsWith(`-> ${owner}`))
    .map(renderOverload);
  return overloads.length ? `impl ${owner}\n${overloads.join("\n\n")}` : "";
}

function generateHttpMethodOverloads(sourceValue) {
  const appStart = sourceValue.indexOf("impl App\n");
  const routerStart = sourceValue.indexOf("\nimpl Router\n", appStart);
  if (appStart < 0 || routerStart < 0) {
    throw new Error("Unable to locate App and Router implementations");
  }

  const appSource = sourceValue.slice(appStart, routerStart);
  const baseAppMethods = readMethods(appSource);
  const existingAppSignatures = new Set(
    baseAppMethods.map(({ signature }) => canonicalSignature(signature)),
  );
  const methodSpecs = [
    ["get", "Get", false],
    ["post", "Post", true],
    ["put", "Put", true],
    ["patch", "Patch", true],
    ["delete", "Delete", true],
  ];
  const generatedApp = [];
  const generatedSignatures = new Set();

  baseAppMethods
    .filter(
      ({ signature }) =>
        /^api fn route(?:<|\()/.test(signature) &&
        signature.includes("path: StringSlice") &&
        signature.includes("method: Method") &&
        !signature.includes("handler: Handler") &&
        signature.endsWith("-> App"),
    )
    .forEach((routeMethod) => {
      methodSpecs.forEach(([name, methodCase, bodyAllowed]) => {
        if (!bodyAllowed && routeMethod.signature.includes("body:")) return;
        const rendered = renderNamedHttpMethod(routeMethod, name, methodCase);
        const signature = renderedSignature(rendered);
        const canonical = canonicalSignature(signature);
        if (
          existingAppSignatures.has(canonical) ||
          generatedSignatures.has(canonical)
        ) {
          return;
        }
        generatedSignatures.add(canonical);
        generatedApp.push(rendered);
      });
    });

  const appBlock = generatedApp.length
    ? `impl App\n${generatedApp.join("\n\n")}`
    : "";
  const appWithGenerated = `${appSource}\n${appBlock}`;
  const allAppHttpMethods = readMethods(appWithGenerated).filter(({ signature }) => {
    const name = signature.match(/^api fn ([^(<]+)/)?.[1];
    return (
      typeof name === "string" &&
      methodSpecs.some(([methodName]) =>
        name === methodName || name.startsWith(`${methodName}_`),
      ) &&
      signature.includes("path: StringSlice") &&
      signature.endsWith("-> App")
    );
  });
  const routerSource = sourceValue.slice(routerStart);
  const existingRouterSignatures = new Set(
    readMethods(routerSource).map(({ signature }) => canonicalSignature(signature)),
  );
  const generatedRouter = allAppHttpMethods.flatMap((method) => {
    const rendered = renderRouterDelegate(method);
    const signature = renderedSignature(rendered);
    const canonical = canonicalSignature(signature);
    if (existingRouterSignatures.has(canonical)) return [];
    existingRouterSignatures.add(canonical);
    return [rendered];
  });
  baseAppMethods
    .filter(
      ({ signature }) =>
        /^api fn route(?:<|\()/.test(signature) &&
        signature.includes("path: StringSlice") &&
        signature.includes("method: Method") &&
        signature.endsWith("-> App"),
    )
    .forEach((method) => {
      const rendered = renderRouterRouteDelegate(method);
      const signature = renderedSignature(rendered);
      const canonical = canonicalSignature(signature);
      if (existingRouterSignatures.has(canonical)) return;
      existingRouterSignatures.add(canonical);
      generatedRouter.push(rendered);
    });
  const routerBlock = generatedRouter.length
    ? `impl Router\n${generatedRouter.join("\n\n")}`
    : "";
  return [appBlock, routerBlock].filter(Boolean).join("\n\n");
}

function renderRouterRouteDelegate({ raw, signature, body }) {
  const declaration = raw.replace(/-> App$/, "-> Router");
  const implementation = body.trim();
  if (!implementation.startsWith("self.")) {
    throw new Error(
      `App.route implementations must delegate to one shared App helper before Router generation: ${signature}`,
    );
  }
  const delegated = implementation
    .replace(/^self\./, "self.app.")
    .replace(/\n/g, "\n    ");
  return `  ${declaration.replace(/\n/g, "\n  ")}\n    Router { app: ${delegated} }`;
}

function renderNamedHttpMethod({ raw, signature }, name, methodCase) {
  const declaration = raw
    .replace(/^api fn route/, `api fn ${name}`)
    .replace(/\{\s*method: Method,\s*/, "{ ")
    .replace(/,\s*method: Method(?=\s*})/, "");
  const typeArguments = signature.includes("body: JsonBody")
    ? ""
    : readTypeArguments(signature, "route");
  const labels = readRecordLabels(signature).filter((label) => label !== "method");
  const call = `self.route${typeArguments}(path, method: Method::${methodCase} {}${labels
    .map((label) => `, ${label}: ${label}`)
    .join("")})`;
  return `  ${declaration.replace(/\n/g, "\n  ")}\n    ${call}`;
}

function renderRouterDelegate({ raw, signature }) {
  const declaration = raw.replace(/-> App$/, "-> Router");
  const name = signature.match(/^api fn ([^(<]+)/)?.[1];
  if (!name) throw new Error(`Unable to read App method name: ${signature}`);
  const typeArguments = readTypeArguments(signature, name);
  const labels = readRecordLabels(signature);
  const methodCase = new Map([
    ["get", "Get"],
    ["post", "Post"],
    ["put", "Put"],
    ["patch", "Patch"],
    ["delete", "Delete"],
  ]).get(name);
  if (
    methodCase &&
    !signature.includes("body:") &&
    !signature.includes("auth:")
  ) {
    const call = `self.route${typeArguments}(path, method: Method::${methodCase} {}${labels
      .map((label) => `, ${label}: ${label}`)
      .join("")})`;
    return `  ${declaration.replace(/\n/g, "\n  ")}\n    ${call}`;
  }
  if (
    methodCase &&
    signature.includes("body: JsonBody") &&
    !signature.includes("auth:") &&
    !signature.includes(", Context)")
  ) {
    const responseType =
      signature.match(/IntoResponse<([A-Za-z][A-Za-z0-9_]*)>/)?.[1] ??
      "Response";
    const contract = signature.includes("docs: RouteDocs")
      ? `typed_json_fragment<I, ${responseType}>(docs)`
      : /, D>/.test(signature)
        ? `typed_json_fragment<I, ${responseType}, D>(docs)`
        : responseType === "Response"
          ? "json_request_fragment<I>()"
          : `typed_json_request_fragment<I, ${responseType}>()`;
    const forwarded = labels
      .filter((label) => label !== "docs")
      .map((label) => `, ${label}: ${label}`)
      .join("");
    return `  ${declaration.replace(/\n/g, "\n  ")}\n    Router { app: self.app.with_json_body_route<I, ${responseType}>(path, method: Method::${methodCase} {}${forwarded}, contract: ${contract}) }`;
  }
  const call = `self.app.${name}${typeArguments}(path${labels
    .map((label) => `, ${label}: ${label}`)
    .join("")})`;
  return `  ${declaration.replace(/\n/g, "\n  ")}\n    Router { app: ${call} }`;
}

function renderedSignature(rendered) {
  const [declaration] = readDeclarations(rendered, "api fn ");
  if (!declaration) {
    throw new Error(`Unable to read rendered declaration: ${rendered}`);
  }
  return declaration.signature;
}

function canonicalSignature(signature) {
  const normalized = normalizeWhitespace(signature);
  const open = normalized.indexOf("<");
  const parametersOpen = normalized.indexOf("(");
  if (open < 0 || open > parametersOpen) return normalized;

  const close = matchingDelimiter(normalized, open, "<", ">");
  const parameters = splitTopLevel(normalized.slice(open + 1, close));
  return parameters.reduce((value, parameter, index) => {
    const name = parameter.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
    if (!name) return value;
    return value.replace(
      new RegExp(`\\b${name}\\b`, "g"),
      () => `__type_${index}`,
    );
  }, normalized);
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
