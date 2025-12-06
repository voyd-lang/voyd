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

const mutableBindingHint: DiagnosticHint = {
  message: "Use the '~' prefix to create a mutable binding (~my_var).",
};

type DiagnosticParamsMap = {
  BD0001:
    | { kind: "unresolved-use-path"; path: readonly string[] }
    | { kind: "module-unavailable"; moduleId: string }
    | { kind: "missing-target" }
    | { kind: "missing-export"; moduleId: string; target: string }
    | { kind: "missing-module-identifier" }
    | {
        kind: "out-of-scope-export";
        moduleId: string;
        target: string;
        visibility: string;
      }
    | {
        kind: "instance-member-import";
        moduleId: string;
        target: string;
        owner?: string;
      };
  BD0002:
    | {
        kind: "duplicate-overload";
        functionName: string;
        signature: string;
      }
    | { kind: "previous-overload" };
  BD0003:
    | { kind: "non-function-conflict"; name: string; conflictKind: string }
    | { kind: "overload-name-collision"; name: string }
    | { kind: "conflicting-declaration" };
  BD0004:
    | { kind: "missing-annotation"; functionName: string; parameter: string }
    | { kind: "conflicting-overload" };
  CG0001: { kind: "codegen-error"; message: string };
  MD0001:
    | { kind: "missing"; requested: string }
    | { kind: "referenced-from"; importer: string };
  MD0002:
    | {
        kind: "load-failed";
        requested: string;
        errorMessage?: string;
      }
    | { kind: "requested-from"; importer: string };
  TY0001:
    | { kind: "immutable-assignment"; name: string }
    | { kind: "binding-declaration"; name: string };
  TY0002:
    | { kind: "pattern-mismatch"; patternLabel: string; reason: string }
    | { kind: "discriminant-note" };
  TY0003: { kind: "non-exhaustive-match" };
  TY0004:
    | { kind: "argument-must-be-mutable"; paramName: string }
    | { kind: "immutable-object"; binding: string; reason: string }
    | { kind: "binding-declaration"; binding: string };
  TY0005: { kind: "not-callable" };
  TY0006: { kind: "unknown-function"; name: string };
  TY0007: { kind: "ambiguous-overload"; name: string };
  TY0008: { kind: "no-overload"; name: string };
  TY0009: {
    kind: "member-access";
    memberKind: "field" | "method";
    name: string;
    visibility: string;
    context?: string;
  };
  TY0010: {
    kind: "inaccessible-construction";
    typeName: string;
    member: string;
    visibility: string;
  };
  TY0011: { kind: "return-type-mismatch"; functionName?: string };
  TY0012: { kind: "branch-type-mismatch"; context?: string };
  TY0013: { kind: "unhandled-effects"; operations: string };
  TY0014: { kind: "effect-annotation-mismatch"; message: string };
  TY0015: { kind: "tail-resume-count"; operation: string; count: number };
  TY9999: { kind: "unexpected-error"; message: string };
};

export type DiagnosticCode = keyof DiagnosticParamsMap;

export type DiagnosticParams<K extends DiagnosticCode> = DiagnosticParamsMap[K];

export const diagnosticsRegistry: {
  [K in DiagnosticCode]: DiagnosticDefinition<DiagnosticParamsMap[K]>;
} = {
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
        case "out-of-scope-export":
          return `Module ${params.moduleId} export ${params.target} is not visible here (visibility: ${params.visibility})`;
        case "instance-member-import": {
          const ownerPrefix = params.owner ? `${params.owner}::` : "";
          return `Cannot import ${params.target} from ${params.moduleId}; ${ownerPrefix}${params.target} is an instance member and must be accessed through its type`;
        }
      }
      return exhaustive(params);
    },
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["BD0001"]>,
  BD0002: {
    code: "BD0002",
    message: (params) =>
      params.kind === "duplicate-overload"
        ? `function ${params.functionName} already defines overload ${params.signature}`
        : "previous overload declared here",
    severity: "error",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["BD0002"]>,
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
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["BD0003"]>,
  BD0004: {
    code: "BD0004",
    message: (params) =>
      params.kind === "missing-annotation"
        ? `parameter ${params.parameter} in overloaded function ${params.functionName} must declare a type`
        : "conflicting overload declared here",
    severity: "error",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["BD0004"]>,
  CG0001: {
    code: "CG0001",
    message: (params) => params.message,
    severity: "error",
    phase: "codegen",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["CG0001"]>,
  MD0001: {
    code: "MD0001",
    message: (params) =>
      params.kind === "missing"
        ? `Unable to resolve module ${params.requested}`
        : `Referenced from ${params.importer}`,
    severity: "error",
    phase: "module-graph",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["MD0001"]>,
  MD0002: {
    code: "MD0002",
    message: (params) =>
      params.kind === "load-failed"
        ? params.errorMessage ?? `Unable to load module ${params.requested}`
        : `Requested by ${params.importer}`,
    severity: "error",
    phase: "module-graph",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["MD0002"]>,
  TY0001: {
    code: "TY0001",
    message: (params) =>
      params.kind === "immutable-assignment"
        ? `cannot assign to immutable binding '${params.name}'`
        : `binding '${params.name}' declared here`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0001"]>,
  TY0002: {
    code: "TY0002",
    message: (params) =>
      params.kind === "pattern-mismatch"
        ? `pattern '${params.patternLabel}' does not match discriminant in ${params.reason}`
        : "discriminant expression",
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0002"]>,
  TY0003: {
    code: "TY0003",
    message: (_params) => "non-exhaustive match",
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0003"]>,
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
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0004"]>,
  TY0005: {
    code: "TY0005",
    message: (_params) => "cannot call a non-function value",
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0005"]>,
  TY0006: {
    code: "TY0006",
    message: (params) => `function '${params.name}' is not defined`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0006"]>,
  TY0007: {
    code: "TY0007",
    message: (params) => `ambiguous overload for ${params.name}`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0007"]>,
  TY0008: {
    code: "TY0008",
    message: (params) => `no overload of ${params.name} matches argument types`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0008"]>,
  TY0009: {
    code: "TY0009",
    message: (params) => {
      const context = params.context ? ` when ${params.context}` : "";
      return `${params.memberKind} '${params.name}' is not accessible${context} (visibility: ${params.visibility})`;
    },
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0009"]>,
  TY0010: {
    code: "TY0010",
    message: (params) =>
      `cannot construct ${params.typeName}; field '${params.member}' is not accessible (visibility: ${params.visibility})`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0010"]>,
  TY0011: {
    code: "TY0011",
    message: (params) =>
      params.functionName
        ? `return value does not match declared return type of ${params.functionName}`
        : "return value does not match declared return type",
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0011"]>,
  TY0012: {
    code: "TY0012",
    message: (params) =>
      params.context
        ? `branch type mismatch in ${params.context}`
        : "branch type mismatch",
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0012"]>,
  TY0013: {
    code: "TY0013",
    message: (params) =>
      `unhandled effect operations: ${params.operations}`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0013"]>,
  TY0014: {
    code: "TY0014",
    message: (params) =>
      `effect annotation mismatch: ${params.message}`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0014"]>,
  TY0015: {
    code: "TY0015",
    message: (params) =>
      `tail-resumptive operation ${params.operation} must call tail exactly once (found ${params.count})`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0015"]>,
  TY9999: {
    code: "TY9999",
    message: (params) => params.message,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY9999"]>,
} as const;

export const formatDiagnosticMessage = <K extends DiagnosticCode>(
  code: K,
  params: DiagnosticParams<K>
): string => diagnosticsRegistry[code].message(params);

export const getDiagnosticDefinition = <K extends DiagnosticCode>(code: K) =>
  diagnosticsRegistry[code];

export const diagnosticCodes = (): DiagnosticCode[] =>
  Object.keys(diagnosticsRegistry) as DiagnosticCode[];

const exhaustive = (_value: never): never => _value;
