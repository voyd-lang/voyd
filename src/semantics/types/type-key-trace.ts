import { VoydModule } from "../../syntax-objects/module.js";
import { Type, TypeAlias, UnionType } from "../../syntax-objects/types.js";

export type TypeKeyTraceEntry = {
  type: Type;
  fingerprint: string;
  kind: "alias" | "union" | "type";
  name: string;
  modulePath?: string;
  qualifiedName: string;
  depth: number;
  stack: string[];
};

type TraceConfig = {
  enabled: true;
  names: Set<string>;
  log: (entry: TypeKeyTraceEntry) => void;
};

type MutableTraceConfig = TraceConfig | { enabled: false } | undefined;

const DEFAULT_TRACE_NAMES = ["RecType", "MsgPack", "Optional"];

const defaultLogger = ({
  kind,
  qualifiedName,
  fingerprint,
  depth,
  stack,
}: TypeKeyTraceEntry) => {
  const stackLabel = stack.length ? ` stack=${stack.join(" > ")}` : "";
  console.log(
    `[typeKey] ${kind} ${qualifiedName} -> ${fingerprint} depth=${depth}${stackLabel}`
  );
};

const createTraceConfig = (
  names: string[],
  log: (entry: TypeKeyTraceEntry) => void = defaultLogger
): TraceConfig => ({
  enabled: true,
  names: new Set(names),
  log,
});

const envTraceConfig = (() => {
  const env =
    (globalThis as any)?.process?.env?.VOYD_TYPE_KEY_TRACE ?? undefined;
  if (!env) return undefined;

  const normalized = env.trim().toLowerCase();
  if (!normalized || normalized === "0" || normalized === "false") {
    return undefined;
  }

  const names =
    normalized === "1" || normalized === "true"
      ? DEFAULT_TRACE_NAMES
      : env
          .split(",")
          .map((part: string) => part.trim())
          .filter(Boolean);

  return createTraceConfig(names);
})();

let runtimeTraceConfig: MutableTraceConfig | undefined;

export const configureTypeKeyTrace = (opts?: {
  names?: string[];
  log?: (entry: TypeKeyTraceEntry) => void;
}) => {
  if (!opts) {
    runtimeTraceConfig = undefined;
    return;
  }

  const names =
    opts.names && opts.names.length ? opts.names : DEFAULT_TRACE_NAMES;

  runtimeTraceConfig = createTraceConfig(names, opts.log ?? defaultLogger);
};

export const getActiveTypeKeyTraceConfig = (): TraceConfig | undefined => {
  if (runtimeTraceConfig?.enabled === false) return undefined;
  if (runtimeTraceConfig?.enabled) return runtimeTraceConfig;
  if (envTraceConfig?.enabled) return envTraceConfig;
  return undefined;
};

export const shouldTraceTypeKey = (
  label: TraceLabel,
  config = getActiveTypeKeyTraceConfig()
): boolean => {
  if (!config?.enabled) return false;
  const { names } = config;
  return (
    names.has(label.name) ||
    names.has(label.qualifiedName) ||
    (label.modulePath ? names.has(label.modulePath) : false)
  );
};

export const emitTypeKeyTrace = (entry: TypeKeyTraceEntry): void => {
  const config = getActiveTypeKeyTraceConfig();
  if (!config?.enabled) return;
  config.log(entry);
};

export type TraceLabel = {
  name: string;
  qualifiedName: string;
  modulePath?: string;
  kind: "alias" | "union" | "type";
};

export const getTraceLabel = (type: Type): TraceLabel | undefined => {
  if ((type as TypeAlias).isTypeAlias?.()) {
    const alias = type as TypeAlias;
    const modulePath = modulePathFor(alias.parentModule);
    const name = alias.name.toString();
    return {
      name,
      qualifiedName: qualifyName(name, modulePath),
      modulePath,
      kind: "alias",
    };
  }

  if ((type as UnionType).isUnionType?.()) {
    const union = type as UnionType;
    const modulePath = modulePathFor(union.parentModule);

    const name = union.name?.toString?.() ?? `${union.syntaxId}`;
    return {
      name,
      qualifiedName: qualifyName(name, modulePath),
      modulePath,
      kind: "union",
    };
  }

  const modulePath = modulePathFor(type.parentModule);
  const name =
    (type as any).name?.toString?.() ??
    (type as any).name?.value ??
    `${type.kindOfType ?? "type"}#${type.idNum ?? type.id ?? "anon"}`;

  return {
    name,
    qualifiedName: qualifyName(name, modulePath),
    modulePath,
    kind: "type",
  };
};

const qualifyName = (name: string, modulePath?: string) =>
  modulePath ? `${modulePath}::${name}` : name;

const modulePathFor = (module?: VoydModule): string | undefined => {
  if (!module) return undefined;
  const path = module.getPath();
  if (!path.length) return undefined;

  // Strip the leading "root" segment when present to keep output concise
  const filtered = module.isRoot ? path.slice(1) : path;
  return filtered.length ? filtered.join("::") : undefined;
};
