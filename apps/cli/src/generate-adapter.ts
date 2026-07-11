import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  ExternalFunctionRequirement,
} from "@voyd-lang/sdk/js-host";
import type {
  VoydDtoSchema,
  VoydExternalFunctionContract,
} from "@voyd-lang/package-adapter";
import { voydInterfaceFingerprint } from "@voyd-lang/package-adapter";

type PortableRequirement = VoydExternalFunctionContract;
type VoydBoundarySchema = ExternalFunctionRequirement["params"][number];

export const generatePackageAdapter = async ({
  index,
  outDir = "./generated/voyd-adapter",
  pkgDirs = [],
}: {
  index: string;
  outDir?: string;
  pkgDirs?: readonly string[];
}): Promise<void> => {
  const entryPaths = await resolvePackageEntries(index);
  const entryPath = entryPaths[0]!;
  const [{ createSdk }, { parseExternalRequirements }] = await Promise.all([
    import("@voyd-lang/sdk"),
    import("@voyd-lang/sdk/js-host"),
  ]);
  const compiledRequirements = await Promise.all(
    entryPaths.map(async (candidate) => {
      const roots = await adapterModuleRoots({ entryPath: candidate, pkgDirs });
      const result = await createSdk().compile({
        entryPath: candidate,
        roots,
        boundaryExports: "auto",
        externalDeclarations: true,
      });
      if (!result.success) throw { diagnostics: result.diagnostics };
      return parseExternalRequirements(
        new WebAssembly.Module(result.wasm as Uint8Array<ArrayBuffer>),
      ).functions;
    }),
  );
  const functions = compiledRequirements.flat();
  if (functions.length === 0) {
    throw new Error(
      `No reachable @external functions found from ${entryPath}. Re-export external functions from the package root.`,
    );
  }
  const packageName = await readPackageName(entryPath);
  const target = resolve(outDir);
  await mkdir(target, { recursive: true });
  const portableFunctions = dedupeRequirements(
    compiledRequirements.flatMap(toPortableRequirements),
  );
  const contract = {
    abiVersion: 1 as const,
    packageName,
    interfaces: [...groupBy(portableFunctions, (fn) => fn.interfaceId)].map(
      ([interfaceId, interfaceFunctions]) => ({
        interfaceId,
        fingerprint: voydInterfaceFingerprint(interfaceFunctions),
      }),
    ),
    functions: portableFunctions,
  };
  const witDocuments = renderWitDocuments(contract.functions);
  await Promise.all([
    writeFile(
      join(target, "contract.json"),
      `${JSON.stringify(contract, null, 2)}\n`,
      "utf8",
    ),
    writeFile(join(target, "contract.ts"), renderContractTs(contract), "utf8"),
    writeFile(
      join(target, "voyd-adapter.ts"),
      renderAdapterTs(contract.functions),
      "utf8",
    ),
    ...witDocuments.map((document) =>
      writeFile(join(target, document.fileName), document.content, "utf8"),
    ),
  ]);
  console.log(target);
};

export const generateAdapterRegistry = async ({
  index,
  outPath = "./generated/voyd-adapters.ts",
  pkgDirs = [],
}: {
  index: string;
  outPath?: string;
  pkgDirs?: readonly string[];
}): Promise<void> => {
  const entryPath = resolveApplicationEntry(index);
  const [{ createSdk, findVoydPackageAdapterSpecifiers }, { parseExternalRequirements }] =
    await Promise.all([
      import("@voyd-lang/sdk"),
      import("@voyd-lang/sdk/js-host"),
    ]);
  const roots = await adapterModuleRoots({ entryPath, pkgDirs });
  const result = await createSdk().compile({ entryPath, roots });
  if (!result.success) throw { diagnostics: result.diagnostics };
  const interfaces = Array.from(
    new Set(
      parseExternalRequirements(
        new WebAssembly.Module(result.wasm as Uint8Array<ArrayBuffer>),
      ).functions.map((fn) => fn.interfaceId),
    ),
  );
  const specifiers = await findVoydPackageAdapterSpecifiers({
    interfaceIds: interfaces,
    startDir: dirname(entryPath),
  });
  const target = resolve(outPath);
  await mkdir(dirname(target), { recursive: true });
  const imports = specifiers
    .map((specifier, index) => `import adapter${index} from ${JSON.stringify(specifier)};`)
    .join("\n");
  const values = specifiers.map((_, index) => `adapter${index}`).join(", ");
  await writeFile(
    target,
    `${imports}${imports ? "\n\n" : ""}export const adapters = [${values}] as const;\n`,
    "utf8",
  );
  console.log(target);
};

const resolvePackageEntries = async (index: string): Promise<string[]> => {
  const resolved = resolve(index);
  if (!existsSync(resolved)) return [resolved];
  if (!statSync(resolved).isDirectory()) return [resolved];
  const packageEntry = join(resolved, "pkg.voyd");
  if (existsSync(packageEntry)) return [packageEntry];
  const nestedPackageEntry = join(resolved, "src", "pkg.voyd");
  if (existsSync(nestedPackageEntry)) return [nestedPackageEntry];
  const externalFiles = await findExternalSourceFiles(resolved);
  if (externalFiles.length > 0) return externalFiles;
  throw new Error(`No pkg.voyd found under ${resolved}`);
};

const resolveApplicationEntry = (index: string): string => {
  const resolved = resolve(index);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return resolved;
  const main = join(resolved, "main.voyd");
  if (existsSync(main)) return main;
  const nestedMain = join(resolved, "src", "main.voyd");
  if (existsSync(nestedMain)) return nestedMain;
  throw new Error(`No main.voyd found under ${resolved}`);
};

const findExternalSourceFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.name !== "node_modules" && entry.name !== "dist")
      .map(async (entry) => {
        const path = join(root, entry.name);
        if (entry.isDirectory()) return findExternalSourceFiles(path);
        if (!entry.isFile() || !entry.name.endsWith(".voyd")) return [];
        return (await readFile(path, "utf8")).includes("@external") ? [path] : [];
      }),
  );
  return nested.flat().sort();
};

const dedupeRequirements = (
  functions: readonly PortableRequirement[],
): PortableRequirement[] => {
  const byKey = new Map<string, PortableRequirement>();
  functions.forEach((fn) => {
    const key = `${fn.interfaceId}::${fn.functionName}`;
    const existing = byKey.get(key);
    if (existing && canonicalRequirement(existing) !== canonicalRequirement(fn)) {
      throw new Error(`Conflicting external function declarations for ${key}`);
    }
    byKey.set(key, fn);
  });
  return [...byKey.values()].sort((left, right) =>
    `${left.interfaceId}::${left.functionName}`.localeCompare(
      `${right.interfaceId}::${right.functionName}`,
    ),
  );
};

const canonicalRequirement = (
  requirement: PortableRequirement,
): string => JSON.stringify(requirement);

const toPortableRequirements = (
  functions: readonly ExternalFunctionRequirement[],
): PortableRequirement[] => {
  const schemas = new Map<number, VoydBoundarySchema>();
  const register = (schema: VoydBoundarySchema): void => {
    if (schema.kind === "ref") return;
    if (schema.typeId !== undefined) {
      schemas.set(schema.typeId, schema);
      if (schema.kind === "array" || schema.kind === "record" || schema.kind === "union") {
        schema.aliases?.forEach((alias) => schemas.set(alias, schema));
      }
    }
    if (schema.kind === "array") register(schema.element);
    if (schema.kind === "record") schema.fields.forEach((field) => register(field.schema));
    if (schema.kind === "union") {
      schema.variants.forEach((variant) => variant.fields.forEach((field) => register(field.schema)));
    }
  };
  functions.forEach((fn) => [...fn.params, fn.result].forEach(register));

  const portable = (schema: VoydBoundarySchema, active = new Set<number>()): VoydDtoSchema => {
    if (schema.kind === "ref") {
      const target = schemas.get(schema.typeId);
      if (!target) throw new Error(`External DTO references unknown compiler type ${schema.typeId}`);
      if (active.has(schema.typeId)) {
        throw new Error("Recursive external DTOs are not supported");
      }
      return portable(target, new Set(active).add(schema.typeId));
    }
    if (schema.kind === "array") return { kind: "array", element: portable(schema.element, active) };
    if (schema.kind === "record") return {
      kind: "record",
      ...(schema.tag ? { tag: schema.tag } : {}),
      fields: schema.fields.map((field) => ({
        name: field.name,
        ...(field.optional ? { optional: true } : {}),
        schema: portable(field.schema, active),
      })),
    };
    if (schema.kind === "union") return {
      kind: "union",
      variants: schema.variants.map((variant) => ({
        name: variant.name,
        fields: variant.fields.map((field) => ({
          name: field.name,
          ...(field.optional ? { optional: true } : {}),
          schema: portable(field.schema, active),
        })),
      })),
    };
    return { kind: schema.kind };
  };
  return functions.map((fn) => ({
    kind: fn.kind,
    interfaceId: fn.interfaceId,
    functionName: fn.functionName,
    params: fn.params.map((schema) => portable(schema)),
    result: portable(fn.result),
  }));
};

const adapterModuleRoots = async ({
  entryPath,
  pkgDirs,
}: {
  entryPath: string;
  pkgDirs: readonly string[];
}) => {
  const [{ detectSrcRootForPath }, { resolveStdRoot }, { resolvePackageDirs }] =
    await Promise.all([
      import("@voyd-lang/sdk"),
      import("@voyd-lang/lib/resolve-std.js"),
      import("./package-dirs.js"),
    ]);
  const srcRoot = detectSrcRootForPath(entryPath);
  return {
    src: srcRoot,
    std: resolveStdRoot(),
    pkgDirs: resolvePackageDirs({
      srcRoot,
      additionalPkgDirs: pkgDirs,
    }),
  };
};

const readPackageName = async (entryPath: string): Promise<string> => {
  let current = dirname(entryPath);
  while (true) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as {
        name?: unknown;
      };
      if (typeof parsed.name === "string" && parsed.name.trim()) {
        return parsed.name;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Unable to find package.json for ${entryPath}`);
};

const renderContractTs = (contract: {
  abiVersion: 1;
  packageName: string;
  interfaces: readonly { interfaceId: string; fingerprint: string }[];
  functions: readonly PortableRequirement[];
}): string => `import type { VoydPackageAdapterContract } from "@voyd-lang/package-adapter";

export const contract = ${JSON.stringify(contract, null, 2)} as const satisfies VoydPackageAdapterContract;
`;

const renderAdapterTs = (
  functions: readonly PortableRequirement[],
): string => {
  const interfaces = groupBy(functions, (fn) => fn.interfaceId);
  const implementation = [...interfaces.entries()]
    .map(([interfaceId, entries]) => {
      const members = entries
        .map((fn) => {
          const params = fn.params
            .map((schema, index) => `arg${index}: ${typescriptType(schema)}`)
            .join(", ");
          const result = typescriptType(fn.result);
          return `    readonly ${JSON.stringify(fn.functionName)}: (this: VoydPackageAdapterInvocationContext${params ? `, ${params}` : ""}) => ${fn.kind === "async" ? `Promise<${result}> | ${result}` : result};`;
        })
        .join("\n");
      return `  readonly ${JSON.stringify(interfaceId)}: {\n${members}\n  };`;
    })
    .join("\n");
  return `import { defineVoydPackageAdapter } from "@voyd-lang/package-adapter";
import type { VoydPackageAdapterInvocationContext } from "@voyd-lang/package-adapter";
import { contract } from "./contract.js";

export type AdapterImplementation = {
${implementation}
};

export const defineAdapter = (implementation: AdapterImplementation) =>
  defineVoydPackageAdapter(contract, implementation);
`;
};

const typescriptType = (
  schema: VoydDtoSchema,
): string => {
  switch (schema.kind) {
    case "bool": return "boolean";
    case "i32": case "f32": case "f64": return "number";
    case "i64": return "bigint | number";
    case "void": return "void";
    case "string": return "string";
    case "array": return `readonly ${typescriptType(schema.element)}[]`;
    case "record":
      return `{ ${schema.tag ? `tag: ${JSON.stringify(schema.tag)}; ` : ""}${schema.fields.map((field) => `${JSON.stringify(field.name)}${field.optional ? "?" : ""}: ${typescriptType(field.schema)}`).join("; ")} }`;
    case "union":
      return schema.variants.map((variant) => `{ tag: ${JSON.stringify(variant.name)}; ${variant.fields.map((field) => `${JSON.stringify(field.name)}${field.optional ? "?" : ""}: ${typescriptType(field.schema)}`).join("; ")} }`).join(" | ");
  }
};

const renderWitDocuments = (
  functions: readonly PortableRequirement[],
): Array<{ fileName: string; content: string }> => {
  assertUniqueWitNames(
    [...new Set(functions.map(({ interfaceId }) => interfaceId))].map((interfaceId) => {
      const parsed = parseWitInterfaceId(interfaceId);
      return { source: interfaceId, normalized: `${parsed.packageId}/${parsed.interfaceName}` };
    }),
    "external interfaces",
  );
  const interfaces = groupBy(functions, (fn) => fn.interfaceId);
  const byPackage = groupBy(
    [...interfaces.entries()],
    ([interfaceId]) => parseWitInterfaceId(interfaceId).packageId,
  );
  return [...byPackage.entries()].map(([packageId, packageInterfaces], packageIndex) => {
    const body = packageInterfaces
    .map(([interfaceId, entries]) => {
      const name = parseWitInterfaceId(interfaceId).interfaceName;
      assertUniqueWitNames(
        entries.map(({ functionName }) => ({
          source: functionName,
          normalized: witIdentifier(functionName),
        })),
        `functions in ${interfaceId}`,
      );
      const renderer = createWitRenderer(entries);
      const methods = entries.map((fn) => {
        const params = fn.params.map((schema, index) => `arg${index}: ${renderer.type(schema)}`).join(", ");
        const result = fn.result.kind === "void" ? "" : ` -> ${renderer.type(fn.result)}`;
        return `  ${witIdentifier(fn.functionName)}: func(${params})${result};`;
      }).join("\n");
      const declarations = renderer.declarations();
      return `interface ${name} {\n${declarations}${declarations ? "\n\n" : ""}${methods}\n}`;
    })
    .join("\n\n");
    return {
      fileName: packageIndex === 0
        ? "interface.wit"
        : `interface-${witIdentifier(packageId)}.wit`,
      content: `package ${packageId};\n\n${body}\n`,
    };
  });
};

const parseWitInterfaceId = (
  interfaceId: string,
): { packageId: string; interfaceName: string } => {
  const match = /^([a-zA-Z][a-zA-Z0-9-]*):([a-zA-Z][a-zA-Z0-9-]*)\/([a-zA-Z][a-zA-Z0-9-]*)@(\d+(?:\.\d+){0,2})$/.exec(interfaceId);
  if (!match) {
    throw new Error(
      `External interface ID ${interfaceId} must use namespace:package/interface@version for WIT generation`,
    );
  }
  const versionParts = match[4]!.split(".");
  while (versionParts.length < 3) versionParts.push("0");
  return {
    packageId: `${witIdentifier(match[1]!)}:${witIdentifier(match[2]!)}@${versionParts.join(".")}`,
    interfaceName: witIdentifier(match[3]!),
  };
};

const createWitRenderer = (functions: readonly PortableRequirement[]) => {
  const schemas = new Map<string, VoydDtoSchema>();
  const schemaKey = (schema: VoydDtoSchema): string => JSON.stringify(schema);
  const nameFor = (schema: VoydDtoSchema): string => {
    const key = schemaKey(schema);
    const hash = stableHash(key);
    const name = `type-${hash}`;
    const existing = schemas.get(name);
    if (existing && schemaKey(existing) !== key) {
      throw new Error(`WIT structural type hash collision for ${name}`);
    }
    schemas.set(name, schema);
    return name;
  };
  const register = (schema: VoydDtoSchema): void => {
    if (schema.kind === "array" || schema.kind === "record" || schema.kind === "union") nameFor(schema);
    if (schema.kind === "array") register(schema.element);
    if (schema.kind === "record") schema.fields.forEach((field) => register(field.schema));
    if (schema.kind === "union") schema.variants.forEach((variant) => variant.fields.forEach((field) => register(field.schema)));
  };
  functions.forEach((fn) => [...fn.params, fn.result].forEach(register));
  const inlineType = (schema: VoydDtoSchema, declaration = false): string => {
    if (!declaration && (schema.kind === "array" || schema.kind === "record" || schema.kind === "union")) {
      return nameFor(schema);
    }
    switch (schema.kind) {
      case "bool": return "bool";
      case "i32": return "s32";
      case "i64": return "s64";
      case "f32": return "float32";
      case "f64": return "float64";
      case "string": return "string";
      case "void": return "tuple<>";
      case "array": return `list<${inlineType(schema.element)}>`;
      case "record": return nameFor(schema);
      case "union": return nameFor(schema);
    }
  };
  const declarations = (): string => [...schemas.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, schema]) => {
      if (schema.kind === "array") return [`  type ${name} = ${inlineType(schema, true)};`];
      if (schema.kind === "record") {
        assertUniqueWitNames(
          [
            ...(schema.tag ? [{ source: "generated tag", normalized: witIdentifier("tag") }] : []),
            ...schema.fields.map((field) => ({
              source: field.name,
              normalized: witIdentifier(field.name),
            })),
          ],
          `fields in WIT record ${name}`,
        );
        const fields = [
          ...(schema.tag ? ["    tag: string,"] : []),
          ...schema.fields.map((field) =>
          `    ${witIdentifier(field.name)}: ${field.optional ? `option<${inlineType(field.schema)}>` : inlineType(field.schema)},`
          ),
        ].join("\n");
        return [`  record ${name} {\n${fields}\n  }`];
      }
      if (schema.kind === "union") {
        assertUniqueWitNames(
          schema.variants.map((variant) => ({
            source: variant.name,
            normalized: witIdentifier(variant.name),
          })),
          `variants in WIT type ${name}`,
        );
        const payloadRecords: string[] = [];
        const variants = schema.variants.map((variant) => {
          if (variant.fields.length === 0) return `    ${witIdentifier(variant.name)},`;
          const payloadName = `${name}-${witIdentifier(variant.name)}-payload`;
          assertUniqueWitNames(
            variant.fields.map((field) => ({
              source: field.name,
              normalized: witIdentifier(field.name),
            })),
            `fields in WIT variant ${variant.name}`,
          );
          const fields = variant.fields.map((field) =>
            `    ${witIdentifier(field.name)}: ${field.optional ? `option<${inlineType(field.schema)}>` : inlineType(field.schema)},`
          ).join("\n");
          payloadRecords.push(`  record ${payloadName} {\n${fields}\n  }`);
          return `    ${witIdentifier(variant.name)}(${payloadName}),`;
        }).join("\n");
        return [...payloadRecords, `  variant ${name} {\n${variants}\n  }`];
      }
      return [];
    })
    .join("\n");
  return { type: (schema: VoydDtoSchema) => inlineType(schema), declarations };
};

const stableHash = (value: string): string => {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
};

const witIdentifier = (value: string): string =>
  escapeWitKeyword(
    value.replace(/_/g, "-").replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase(),
  );

const assertUniqueWitNames = (
  names: readonly { source: string; normalized: string }[],
  scope: string,
): void => {
  const byNormalized = new Map<string, string>();
  names.forEach(({ source, normalized }) => {
    const existing = byNormalized.get(normalized);
    if (existing !== undefined) {
      throw new Error(
        `WIT name collision in ${scope}: ${JSON.stringify(existing)} and ${JSON.stringify(source)} both normalize to ${JSON.stringify(normalized)}`,
      );
    }
    byNormalized.set(normalized, source);
  });
};

const WIT_KEYWORDS = new Set([
  "as", "borrow", "constructor", "enum", "export", "flags", "func",
  "future", "import", "include", "interface", "list", "option", "own",
  "package", "record", "resource", "result", "static", "stream", "tuple",
  "type", "union", "use", "variant", "with", "world",
]);

const escapeWitKeyword = (value: string): string =>
  WIT_KEYWORDS.has(value) ? `%${value}` : value;

const groupBy = <T, K>(
  values: Iterable<T>,
  keyFor: (value: T) => K,
): Map<K, T[]> => {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return groups;
};
