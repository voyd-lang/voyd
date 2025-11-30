import type {
  DiagnosticHint,
  DiagnosticPhase,
  DiagnosticSeverity,
} from "./types.js";

type DiagnosticMessage<P> = (params: P) => string;

export type DiagnosticDefinition<P> = {
  code: string;
  message: DiagnosticMessage<P>;
  severity?: DiagnosticSeverity;
  phase?: DiagnosticPhase;
  hints?: readonly DiagnosticHint[];
};

type DefinitionParams<T> = T extends DiagnosticDefinition<infer P> ? P : never;

const mutableBindingHint: DiagnosticHint = {
  message: "Use the '~' prefix to create a mutable binding (~my_var).",
};

export const diagnosticsRegistry = {
  BD0001: {
    code: "BD0001",
    message: (params) => {
      switch (params.kind) {
        case "unresolved-use-path":
          return `Unable to resolve module for use path ${params.path.join("::")}`;
        case "module-unavailable":
          return `Module ${params.moduleId} is not available for import`;
        case "missing-target":
          return "use entry missing target name";
        case "missing-export":
          return `Module ${params.moduleId} does not export ${params.target}`;
        case "missing-module-identifier":
          return "missing module identifier for import";
      }
      return exhaustive(params);
    },
  } satisfies DiagnosticDefinition<
    | { kind: "unresolved-use-path"; path: readonly string[] }
    | { kind: "module-unavailable"; moduleId: string }
    | { kind: "missing-target" }
    | { kind: "missing-export"; moduleId: string; target: string }
    | { kind: "missing-module-identifier" }
  >,
  BD0002: {
    code: "BD0002",
    message: (params) =>
      params.kind === "duplicate-overload"
        ? `function ${params.functionName} already defines overload ${params.signature}`
        : "previous overload declared here",
    severity: "error",
  } satisfies DiagnosticDefinition<
    | {
        kind: "duplicate-overload";
        functionName: string;
        signature: string;
      }
    | { kind: "previous-overload" }
  >,
  BD0003: {
    code: "BD0003",
    message: (params) => {
      switch (params.kind) {
        case "non-function-conflict":
          return `cannot overload ${params.name}; ${params.conflictKind} with the same name already exists`;
        case "overload-name-collision":
          return `cannot declare ${params.name}; overloads with this name already exist in the current scope`;
        case "conflicting-declaration":
          return "conflicting declaration here";
      }
      return exhaustive(params);
    },
    severity: "error",
  } satisfies DiagnosticDefinition<
    | {
        kind: "non-function-conflict";
        name: string;
        conflictKind: string;
      }
    | { kind: "overload-name-collision"; name: string }
    | { kind: "conflicting-declaration" }
  >,
  BD0004: {
    code: "BD0004",
    message: (params) =>
      params.kind === "missing-annotation"
        ? `parameter ${params.parameter} in overloaded function ${params.functionName} must declare a type`
        : "conflicting overload declared here",
    severity: "error",
  } satisfies DiagnosticDefinition<
    | {
        kind: "missing-annotation";
        functionName: string;
        parameter: string;
      }
    | { kind: "conflicting-overload" }
  >,
  CG0001: {
    code: "CG0001",
    message: (params) => params.message,
    severity: "error",
    phase: "codegen",
  } satisfies DiagnosticDefinition<{ kind: "codegen-error"; message: string }>,
  MD0001: {
    code: "MD0001",
    message: (params) =>
      params.kind === "missing"
        ? `Unable to resolve module ${params.requested}`
        : `Referenced from ${params.importer}`,
    severity: "error",
    phase: "module-graph",
  } satisfies DiagnosticDefinition<
    | { kind: "missing"; requested: string }
    | { kind: "referenced-from"; importer: string }
  >,
  MD0002: {
    code: "MD0002",
    message: (params) =>
      params.kind === "load-failed"
        ? params.errorMessage ?? `Unable to load module ${params.requested}`
        : `Requested by ${params.importer}`,
    severity: "error",
    phase: "module-graph",
  } satisfies DiagnosticDefinition<
    | {
        kind: "load-failed";
        requested: string;
        errorMessage?: string;
      }
    | { kind: "requested-from"; importer: string }
  >,
  TY0001: {
    code: "TY0001",
    message: (params) =>
      params.kind === "immutable-assignment"
        ? `cannot assign to immutable binding '${params.name}'`
        : `binding '${params.name}' declared here`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<
    | { kind: "immutable-assignment"; name: string }
    | { kind: "binding-declaration"; name: string }
  >,
  TY0002: {
    code: "TY0002",
    message: (params) =>
      params.kind === "pattern-mismatch"
        ? `pattern '${params.patternLabel}' does not match discriminant in ${params.reason}`
        : "discriminant expression",
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<
    | { kind: "pattern-mismatch"; patternLabel: string; reason: string }
    | { kind: "discriminant-note" }
  >,
  TY0003: {
    code: "TY0003",
    message: (_params) => "non-exhaustive match",
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<{ kind: "non-exhaustive-match" }>,
  TY0004: {
    code: "TY0004",
    message: (params) => {
      switch (params.kind) {
        case "argument-must-be-mutable":
          return `${params.paramName} requires a mutable object reference.`;
        case "immutable-object":
          return `${params.reason}: object '${params.binding}' is immutable.`;
        case "binding-declaration":
          return `binding '${params.binding}' declared here.`;
      }
      return exhaustive(params);
    },
    severity: "error",
    phase: "typing",
    hints: [mutableBindingHint],
  } satisfies DiagnosticDefinition<
    | { kind: "argument-must-be-mutable"; paramName: string }
    | { kind: "immutable-object"; binding: string; reason: string }
    | { kind: "binding-declaration"; binding: string }
  >,
  TY0005: {
    code: "TY0005",
    message: (_params) => "cannot call a non-function value",
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<{ kind: "not-callable" }>,
  TY0006: {
    code: "TY0006",
    message: (params) => `function '${params.name}' is not defined`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<{ kind: "unknown-function"; name: string }>,
  TY9999: {
    code: "TY9999",
    message: (params) => params.message,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<{ kind: "unexpected-error"; message: string }>,
} as const;

export type DiagnosticCode = keyof typeof diagnosticsRegistry;

export type DiagnosticParams<K extends DiagnosticCode> = DefinitionParams<
  (typeof diagnosticsRegistry)[K]
>;

export const formatDiagnosticMessage = <K extends DiagnosticCode>(
  code: K,
  params: DiagnosticParams<K>
): string => diagnosticsRegistry[code].message(params);

export const getDiagnosticDefinition = <K extends DiagnosticCode>(code: K) =>
  diagnosticsRegistry[code];

export const diagnosticCodes = (): DiagnosticCode[] =>
  Object.keys(diagnosticsRegistry) as DiagnosticCode[];

const exhaustive = (_value: never): never => _value;
