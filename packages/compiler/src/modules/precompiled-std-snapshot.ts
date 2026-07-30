import {
  Atom,
  BoolAtom,
  CallForm,
  CommentAtom,
  FloatAtom,
  Form,
  IdentifierAtom,
  IntAtom,
  InternalIdentifierAtom,
  PossibleMissingCommaField,
  StringAtom,
  Syntax,
  WhitespaceAtom,
  createModuleHeaderView,
  createSurfaceModuleView,
} from "../parser/index.js";
import {
  SourceLocation,
  reserveSyntaxIdsThrough,
  type Attributes,
  type SourceLocationJSON,
} from "../parser/ast/syntax.js";
import {
  MacroScope,
  type MacroScopeSnapshot,
} from "../parser/syntax-macros/functional-macro-expander/scope.js";
import type { EffectInterner } from "../semantics/effects/effect-table.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";
import type { TypeArena } from "../semantics/typing/type-arena.js";
import { VOYD_COMPILER_VERSION } from "../version.js";
import { modulePathToString } from "./path.js";
import type { ReusableDependencySemanticsSnapshot } from "./semantic-analysis.js";
import {
  restoreSemanticsMapFromPersistence,
  snapshotSemanticsMapForPersistence,
  type PersistentSemanticsMapSnapshot,
} from "./semantic-snapshot.js";
import type { ModuleNode } from "./types.js";

export const PRECOMPILED_STD_SNAPSHOT_SCHEMA =
  "voyd.precompiled-std-semantics" as const;
export const PRECOMPILED_STD_SNAPSHOT_VERSION = 1 as const;
export const PRECOMPILED_STD_COMPILER_BUILD_ID =
  `${VOYD_COMPILER_VERSION}:precompiled-std-abi-v1` as const;
export const PRECOMPILED_STD_TRANSPORT_ID =
  "voyd:reference-graph-json+brotli-v1" as const;
export const PRECOMPILED_STD_OPTIONS_ID =
  "includeTests=false;dependency=std" as const;
export const PRECOMPILED_STD_PATH_TOKEN = "$VOYD_STD_ROOT$";

type PersistentStdSnapshot = PersistentSemanticsMapSnapshot & {
  modules: readonly ModuleNode[];
};

type EncodedSyntax = {
  $voydSnapshotType: "syntax";
  syntaxClass: string;
  syntaxId: number;
  location?: unknown;
  attributes?: unknown;
  elements?: unknown;
  value?: string;
  quoted?: boolean;
  intType?: "i32" | "i64";
  floatType?: "f32" | "f64";
};

type EncodedMacroScope = {
  $voydSnapshotType: "macro-scope";
  snapshot?: unknown;
};

type EncodedMapWithProperties = {
  $voydSnapshotType: "map-with-properties";
  entries?: readonly (readonly [unknown, unknown])[];
  properties?: Record<string, unknown>;
};

export type EncodedPrecompiledStdSnapshot = unknown;

export type PrecompiledStdSourceManifestEntry = {
  path: string;
  sha256: string;
  bytes: number;
};

export type PrecompiledStdSnapshotHeader = {
  schema: typeof PRECOMPILED_STD_SNAPSHOT_SCHEMA;
  version: typeof PRECOMPILED_STD_SNAPSHOT_VERSION;
  compilerBuildId: typeof PRECOMPILED_STD_COMPILER_BUILD_ID;
  transportId: typeof PRECOMPILED_STD_TRANSPORT_ID;
  callableSummarySchema: string;
  callableSummaryVersion: number;
  stdContentSha256: string;
  optionsId: typeof PRECOMPILED_STD_OPTIONS_ID;
  sources: readonly PrecompiledStdSourceManifestEntry[];
};

export type PrecompiledStdSnapshotEnvelope = {
  header: PrecompiledStdSnapshotHeader;
  payloadSha256: string;
};

export type RestoredPrecompiledStdSnapshot = {
  modules: ReadonlyMap<string, ModuleNode>;
  dependencySnapshot: ReusableDependencySemanticsSnapshot;
  typingState: {
    arena: TypeArena;
    effectInterner: EffectInterner;
  };
};

export const encodePrecompiledStdSnapshot = ({
  graphModules,
  dependencySnapshot,
  stdRoot,
}: {
  graphModules: ReadonlyMap<string, ModuleNode>;
  dependencySnapshot: ReusableDependencySemanticsSnapshot;
  stdRoot: string;
}): EncodedPrecompiledStdSnapshot => {
  const moduleIds = dependencySnapshot.moduleIds.filter((moduleId) =>
    moduleId.startsWith("std::"),
  );
  if (moduleIds.length === 0) {
    throw new Error("cannot encode an empty std semantic snapshot");
  }

  const modules = moduleIds.map((moduleId) => {
    const module = graphModules.get(moduleId);
    if (!module || module.path.namespace !== "std") {
      throw new Error(`missing std module graph state for ${moduleId}`);
    }
    const { header: _header, surface: _surface, ...persistent } = module;
    return persistent as ModuleNode;
  });
  const selectedSemantics = new Map(
    moduleIds.map((moduleId) => {
      const entry = dependencySnapshot.semantics.get(moduleId);
      if (!entry) {
        throw new Error(`missing std semantic state for ${moduleId}`);
      }
      return [moduleId, entry] as const;
    }),
  );

  return encodeGraph(
    {
      modules,
      ...snapshotSemanticsMapForPersistence({
        semantics: selectedSemantics,
        arena: dependencySnapshot.arena,
        effectInterner: dependencySnapshot.effectInterner,
      }),
    } satisfies PersistentStdSnapshot,
    stdRoot,
  );
};

export const restorePrecompiledStdSnapshot = ({
  encoded,
  stdRoot,
}: {
  encoded: EncodedPrecompiledStdSnapshot;
  stdRoot: string;
}): RestoredPrecompiledStdSnapshot => {
  const persistent = decodeGraph(encoded, stdRoot) as PersistentStdSnapshot;
  validatePersistentSnapshot(persistent);
  const { semantics, arena, effectInterner } =
    restoreSemanticsMapFromPersistence({ snapshot: persistent });

  const modules = new Map(
    persistent.modules.map((module) => {
      module.header = createModuleHeaderView(module.ast);
      module.surface = createSurfaceModuleView(module.ast);
      if (module.surface.issues.length > 0) {
        throw new Error(
          `precompiled std module ${module.id} has an invalid expanded surface`,
        );
      }
      return [module.id, module] as const;
    }),
  );
  validateRestoredSnapshot({ modules, semantics, arena, effectInterner });

  return {
    modules,
    dependencySnapshot: {
      moduleIds: Array.from(semantics.keys()),
      semantics,
      arena: persistent.arena,
      effectInterner: persistent.effectInterner,
    },
    typingState: { arena, effectInterner },
  };
};

const validatePersistentSnapshot = (value: PersistentStdSnapshot): void => {
  if (
    !value ||
    !Array.isArray(value.modules) ||
    !Array.isArray(value.semantics) ||
    !value.arena ||
    !value.effectInterner
  ) {
    throw new Error("precompiled std snapshot payload is incomplete");
  }
  const moduleIds = new Set(value.modules.map((module) => module.id));
  const semanticModuleIds = new Set(
    value.semantics.map(([moduleId]) => moduleId),
  );
  if (
    moduleIds.size === 0 ||
    moduleIds.size !== value.modules.length ||
    semanticModuleIds.size !== value.semantics.length ||
    value.semantics.length !== moduleIds.size ||
    value.modules.some(
      (module) =>
        module.path.namespace !== "std" ||
        modulePathToString(module.path) !== module.id ||
        !(module.ast instanceof Form),
    ) ||
    value.semantics.some(
      ([moduleId, semantics]) =>
        !moduleIds.has(moduleId) ||
        semantics.moduleId !== moduleId ||
        semantics.binding.packageId !== "std",
    )
  ) {
    throw new Error("precompiled std snapshot module identities do not match");
  }
};

const validateRestoredSnapshot = ({
  modules,
  semantics,
  arena,
  effectInterner,
}: {
  modules: ReadonlyMap<string, ModuleNode>;
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
  arena: TypeArena;
  effectInterner: EffectInterner;
}): void => {
  if (modules.size !== semantics.size) {
    throw new Error("precompiled std graph and semantics sizes do not match");
  }
  modules.forEach((module, moduleId) => {
    if (
      moduleId !== module.id ||
      module.path.namespace !== "std" ||
      modulePathToString(module.path) !== moduleId
    ) {
      throw new Error(`invalid precompiled std module identity ${moduleId}`);
    }
    const entry = semantics.get(moduleId);
    if (
      !entry ||
      entry.typing.arena !== arena ||
      entry.typing.effects.internRow !== effectInterner.internRow
    ) {
      throw new Error(`invalid precompiled std semantic identity ${moduleId}`);
    }
  });
};

const encodeGraph = (
  rootValue: unknown,
  stdRoot: string,
): EncodedPrecompiledStdSnapshot => {
  const encoded = new Map<object, unknown>();
  const normalizedRoot = trimTrailingSeparators(stdRoot);

  const encode = (value: unknown): unknown => {
    if (
      value === undefined ||
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "string") {
      return canonicalizeStdPath(value, normalizedRoot);
    }
    if (typeof value !== "object") {
      throw new Error(`unsupported precompiled snapshot value ${typeof value}`);
    }

    const cached = encoded.get(value);
    if (cached !== undefined) {
      return cached;
    }

    if (value instanceof Syntax) {
      const result: EncodedSyntax = {
        $voydSnapshotType: "syntax",
        syntaxClass: value.constructor.name,
        syntaxId: value.syntaxId,
        ...(value instanceof IdentifierAtom ? { quoted: value.isQuoted } : {}),
        ...(value instanceof IntAtom ? { intType: value.intType } : {}),
        ...(value instanceof FloatAtom ? { floatType: value.floatType } : {}),
      };
      encoded.set(value, result);
      result.location = encode(value.location?.toJSON());
      result.attributes = encode(value.attributes);
      if (value instanceof Form) {
        result.elements = encode(value.toArray());
      } else if (value instanceof Atom) {
        result.value = value.value;
      }
      return result;
    }
    if (value instanceof MacroScope) {
      const result: EncodedMacroScope = {
        $voydSnapshotType: "macro-scope",
      };
      encoded.set(value, result);
      result.snapshot = encode(value.snapshot());
      return result;
    }
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      encoded.set(value, result);
      value.forEach((entry) => result.push(encode(entry)));
      return result;
    }
    if (value instanceof Map) {
      const ownKeys = Object.keys(value);
      if (ownKeys.length > 0) {
        const result: EncodedMapWithProperties = {
          $voydSnapshotType: "map-with-properties",
        };
        encoded.set(value, result);
        result.entries = Array.from(value, ([key, entry]) => [
          encode(key),
          encode(entry),
        ]);
        result.properties = Object.fromEntries(
          ownKeys
            .sort()
            .map((key) => [
              key,
              encode((value as unknown as Record<string, unknown>)[key]),
            ]),
        );
        return result;
      }
      const result = new Map<unknown, unknown>();
      encoded.set(value, result);
      value.forEach((entry, key) => result.set(encode(key), encode(entry)));
      return result;
    }
    if (value instanceof Set) {
      const result = new Set<unknown>();
      encoded.set(value, result);
      value.forEach((entry) => result.add(encode(entry)));
      return result;
    }
    if (value instanceof Uint8Array) {
      const result = Uint8Array.from(value);
      encoded.set(value, result);
      return result;
    }

    const result: Record<string, unknown> = {};
    encoded.set(value, result);
    Object.keys(value)
      .sort()
      .forEach((key) => {
        result[key] = encode((value as Record<string, unknown>)[key]);
      });
    return result;
  };

  return encode(rootValue);
};

const decodeGraph = (
  encoded: EncodedPrecompiledStdSnapshot,
  stdRoot: string,
): unknown => {
  const decoded = new Map<object, unknown>();
  const decode = (value: unknown): unknown => {
    if (
      value === undefined ||
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "string") {
      return restoreStdPath(value, stdRoot);
    }
    if (!value || typeof value !== "object") {
      throw new Error("invalid precompiled std snapshot value");
    }
    if (decoded.has(value)) {
      return decoded.get(value);
    }
    if (Array.isArray(value)) {
      decoded.set(value, value);
      value.forEach((entry, index) => {
        value[index] = decode(entry);
      });
      return value;
    }
    if (value instanceof Map) {
      decoded.set(value, value);
      const entries = Array.from(value);
      value.clear();
      entries.forEach(([key, entry]) => value.set(decode(key), decode(entry)));
      return value;
    }
    if (value instanceof Set) {
      decoded.set(value, value);
      const entries = Array.from(value);
      value.clear();
      entries.forEach((entry) => value.add(decode(entry)));
      return value;
    }
    if (value instanceof Uint8Array) {
      decoded.set(value, value);
      return value;
    }
    const tagged = value as {
      $voydSnapshotType?: "syntax" | "macro-scope" | "map-with-properties";
      snapshot?: unknown;
      entries?: readonly (readonly [unknown, unknown])[];
      properties?: Record<string, unknown>;
    };
    if (tagged.$voydSnapshotType === "map-with-properties") {
      const result = new Map<unknown, unknown>();
      decoded.set(value, result);
      tagged.entries?.forEach(([key, entry]) =>
        result.set(decode(key), decode(entry)),
      );
      Object.entries(tagged.properties ?? {}).forEach(([key, entry]) => {
        (result as unknown as Record<string, unknown>)[key] = decode(entry);
      });
      return result;
    }
    if (tagged.$voydSnapshotType === "macro-scope") {
      const result = new MacroScope();
      decoded.set(value, result);
      result.restore(decode(tagged.snapshot) as MacroScopeSnapshot);
      return result;
    }
    if (tagged.$voydSnapshotType === "syntax") {
      const syntax = restoreSyntaxShell(tagged as EncodedSyntax);
      decoded.set(value, syntax);
      restoreSyntaxContents({
        syntax,
        node: tagged as EncodedSyntax,
        decode,
      });
      return syntax;
    }
    const result = value as Record<string, unknown>;
    decoded.set(value, result);
    Object.keys(value)
      .sort()
      .forEach((key) => {
        result[key] = decode((value as Record<string, unknown>)[key]);
      });
    return result;
  };

  return decode(encoded);
};

const restoreSyntaxShell = (node: EncodedSyntax): Syntax => {
  switch (node.syntaxClass) {
    case "Form":
      return new Form();
    case "CallForm":
      return new CallForm();
    case "IdentifierAtom":
      return new IdentifierAtom();
    case "PossibleMissingCommaField":
      return new PossibleMissingCommaField();
    case "InternalIdentifierAtom":
      return new InternalIdentifierAtom("" as never);
    case "BoolAtom":
      return new BoolAtom();
    case "StringAtom":
      return new StringAtom();
    case "CommentAtom":
      return new CommentAtom();
    case "IntAtom":
      return new IntAtom();
    case "FloatAtom":
      return new FloatAtom();
    case "WhitespaceAtom":
      return new WhitespaceAtom();
    case "Atom":
      return new Atom();
    default:
      throw new Error(`unknown precompiled syntax class ${node.syntaxClass}`);
  }
};

const restoreSyntaxContents = ({
  syntax,
  node,
  decode,
}: {
  syntax: Syntax;
  node: EncodedSyntax;
  decode(value: unknown): unknown;
}): void => {
  const location = decode(node.location) as SourceLocationJSON | undefined;
  syntax.location = location ? new SourceLocation(location) : undefined;
  syntax.attributes = decode(node.attributes) as Attributes | undefined;
  if (syntax instanceof Form) {
    syntax.appendAll((decode(node.elements) ?? []) as never[]);
  }
  if (syntax instanceof Atom) {
    syntax.value = node.value ?? "";
  }
  if (syntax instanceof IdentifierAtom) {
    syntax.setIsQuoted(node.quoted === true);
  }
  if (syntax instanceof IntAtom) {
    syntax.setType(node.intType ?? "i64");
  }
  if (syntax instanceof FloatAtom) {
    syntax.setType(node.floatType ?? "f64");
  }
  Object.defineProperty(syntax, "syntaxId", {
    configurable: true,
    enumerable: true,
    value: node.syntaxId,
    writable: false,
  });
  reserveSyntaxIdsThrough(node.syntaxId);
};

const trimTrailingSeparators = (value: string): string =>
  value.replace(/[\\/]+$/, "");

const canonicalizeStdPath = (value: string, stdRoot: string): string => {
  if (value === stdRoot) {
    return PRECOMPILED_STD_PATH_TOKEN;
  }
  if (value.startsWith(`${stdRoot}/`) || value.startsWith(`${stdRoot}\\`)) {
    return `${PRECOMPILED_STD_PATH_TOKEN}${value.slice(stdRoot.length)}`;
  }
  return value;
};

const restoreStdPath = (value: string, stdRoot: string): string =>
  value === PRECOMPILED_STD_PATH_TOKEN
    ? trimTrailingSeparators(stdRoot)
    : value.startsWith(`${PRECOMPILED_STD_PATH_TOKEN}/`) ||
        value.startsWith(`${PRECOMPILED_STD_PATH_TOKEN}\\`)
      ? `${trimTrailingSeparators(stdRoot)}${normalizeRestoredPathSuffix({
          suffix: value.slice(PRECOMPILED_STD_PATH_TOKEN.length),
          stdRoot,
        })}`
      : value;

const normalizeRestoredPathSuffix = ({
  suffix,
  stdRoot,
}: {
  suffix: string;
  stdRoot: string;
}): string => {
  const separator =
    stdRoot.includes("\\") && !stdRoot.includes("/") ? "\\" : "/";
  return suffix.replaceAll(/[\\/]/g, separator);
};
