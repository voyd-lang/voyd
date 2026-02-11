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
    | { kind: "missing-path-prefix"; path: readonly string[] }
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
  BD0005: { kind: "unsupported-mod-decl" };
  BD0006:
    | { kind: "duplicate-binding"; name: string }
    | { kind: "previous-binding" };
  CG0001: { kind: "codegen-error"; message: string };
  CG0002: {
    kind: "unsupported-effectful-export-return";
    exportName: string;
    returnType: string;
  };
  CG0003: {
    kind: "exported-generic-missing-instantiation";
    functionName: string;
  };
  CG0004: {
    kind: "missing-effect-id";
    effectName: string;
    fallbackId: string;
  };
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
  MD0003: {
    kind: "macro-expansion-failed";
    macro: string;
    errorMessage?: string;
  };
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
  TY0015: {
    kind: "tail-resume-count";
    operation: string;
    minCalls: number;
    maxCalls: number;
    escapes: boolean;
  };
  TY0016: {
    kind: "pkg-effect-annotation";
    functionName: string;
    effects: string;
  };
  TY0017: { kind: "effectful-main"; effects: string };
  TY0018: {
    kind: "effect-generic-mismatch";
    operation: string;
    message: string;
  };
  TY0019: {
    kind: "effect-handler-overload";
    operation: string;
    message: string;
  };
  TY0020: { kind: "ambiguous-nominal-match-pattern"; typeName: string };
  TY0021:
    | { kind: "call-missing-argument"; paramName: string }
    | { kind: "call-missing-labeled-argument"; label: string }
    | { kind: "call-extra-arguments"; extra: number };
  TY0022: { kind: "unknown-method"; name: string; receiver?: string };
  TY0023: { kind: "array-literal-empty" };
  TY0024: { kind: "array-literal-mixed-primitives" };
  TY0025: { kind: "array-literal-incompatible" };
  TY0026: { kind: "undefined-type"; name: string };
  TY0027: { kind: "type-mismatch"; expected: string; actual: string };
  TY0028: { kind: "intersection-nominal-conflict"; left: string; right: string };
  TY0029: {
    kind: "intersection-field-conflict";
    field: string;
    left: string;
    right: string;
  };
  TY0030: { kind: "undefined-identifier"; name: string };
  TY0031: { kind: "self-referential-initializer"; name: string };
  TY0032: { kind: "tuple-index-out-of-range"; index: number; length: number };
  TY0033: { kind: "unknown-field"; name: string; receiver?: string };
  TY0034: { kind: "return-type-inference-failed"; functionName: string };
  TY0035: {
    kind: "resume-call-count";
    operation: string;
    minCalls: number;
    maxCalls: number;
    escapes: boolean;
  };
  TY0036:
    | {
        kind: "duplicate-trait-implementation";
        traitName: string;
        targetName: string;
      }
    | {
        kind: "previous-trait-implementation";
        traitName: string;
        targetName: string;
      };
  TY0037: { kind: "missing-object-field"; field: string; receiver?: string };
  TY0038: {
    kind: "std-only-intrinsic-wrapper";
    intrinsicName: string;
  };
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
        case "missing-path-prefix":
          return `Use path ${params.path.join("::")} must start with one of: self::, super::, src::, std::, pkg::`;
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
  BD0005: {
    code: "BD0005",
    message: () =>
      "mod declarations without a body are no longer supported; use `use`, `pub use self::...`, or `pub self::...` instead",
    severity: "error",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["BD0005"]>,
  BD0006: {
    code: "BD0006",
    message: (params) => {
      switch (params.kind) {
        case "duplicate-binding":
          return `cannot redefine ${params.name} in the same scope`;
        case "previous-binding":
          return "previous binding declared here";
      }
      return exhaustive(params);
    },
    severity: "error",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["BD0006"]>,
  CG0001: {
    code: "CG0001",
    message: (params) => params.message,
    severity: "error",
    phase: "codegen",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["CG0001"]>,
  CG0002: {
    code: "CG0002",
    message: (params) =>
      `effectful export ${params.exportName} has unsupported return type ${params.returnType}`,
    severity: "error",
    phase: "codegen",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["CG0002"]>,
  CG0003: {
    code: "CG0003",
    message: (params) =>
      `requires concrete instantiation for exported generic function ${params.functionName}`,
    severity: "error",
    phase: "codegen",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["CG0003"]>,
  CG0004: {
    code: "CG0004",
    message: (params) =>
      `public effect ${params.effectName} is missing @effect(id: ...); using fallback id ${params.fallbackId}`,
    severity: "warning",
    phase: "codegen",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["CG0004"]>,
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
        ? (params.errorMessage ?? `Unable to load module ${params.requested}`)
        : `Requested by ${params.importer}`,
    severity: "error",
    phase: "module-graph",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["MD0002"]>,
  MD0003: {
    code: "MD0003",
    message: (params) =>
      `Macro expansion failed (${params.macro})${
        params.errorMessage ? `: ${params.errorMessage}` : ""
      }`,
    severity: "error",
    phase: "module-graph",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["MD0003"]>,
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
    message: (params) => `unhandled effect operations: ${params.operations}`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0013"]>,
  TY0014: {
    code: "TY0014",
    message: (params) => `effect annotation mismatch: ${params.message}`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0014"]>,
  TY0015: {
    code: "TY0015",
    message: (params) => {
      const min =
        params.minCalls === Number.POSITIVE_INFINITY ? "∞" : `${params.minCalls}`;
      const max =
        params.maxCalls === Number.POSITIVE_INFINITY ? "∞" : `${params.maxCalls}`;
      const range = min === max ? min : `${min}..${max}`;
      const suffix = params.escapes ? "; continuation escapes" : "";
      return `tail-resumptive operation ${params.operation} must call tail exactly once (observed ${range}${suffix})`;
    },
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0015"]>,
  TY0016: {
    code: "TY0016",
    message: (params) =>
      `exported function ${params.functionName} is missing an effect annotation; unhandled effects: ${params.effects}`,
    severity: "error",
    phase: "typing",
    hints: [
      {
        message:
          "Either annotate the remaining effects in the function signature, or handle them inside the function so it becomes pure (and then omit the annotation or use '()').",
      },
    ],
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0016"]>,
  TY0017: {
    code: "TY0017",
    message: (params) =>
      `pub fn main must be pure ('()'); found effects: ${params.effects}`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0017"]>,
  TY0018: {
    code: "TY0018",
    message: (params) =>
      `effect generic mismatch for ${params.operation}: ${params.message}`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0018"]>,
  TY0019: {
    code: "TY0019",
    message: (params) =>
      `effect handler for ${params.operation}: ${params.message}`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0019"]>,
  TY0020: {
    code: "TY0020",
    message: (params) =>
      `ambiguous match pattern '${params.typeName}': this union contains multiple instantiations of '${params.typeName}', so the pattern must specify type arguments`,
    severity: "error",
    phase: "typing",
    hints: [
      {
        message:
          "Specify type arguments in the pattern (for example: MyType<i32>).",
      },
    ],
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0020"]>,
  TY0021: {
    code: "TY0021",
    message: (params) => {
      switch (params.kind) {
        case "call-missing-argument":
          return `missing required call argument for ${params.paramName}`;
        case "call-missing-labeled-argument":
          return `missing required labeled call argument ${params.label}`;
        case "call-extra-arguments":
          return `call has ${params.extra} extra argument(s)`;
      }
      return exhaustive(params);
    },
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0021"]>,
  TY0022: {
    code: "TY0022",
    message: (params) =>
      params.receiver
        ? `method '${params.name}' is not defined on ${params.receiver}`
        : `method '${params.name}' is not defined`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0022"]>,
  TY0023: {
    code: "TY0023",
    message: () => "cannot infer element type for empty array literal",
    severity: "error",
    phase: "typing",
    hints: [
      {
        message:
          "Add at least one element, or use a helper that constructs an empty array with a known element type.",
      },
    ],
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0023"]>,
  TY0024: {
    code: "TY0024",
    message: () => "array literal elements must not mix primitive types",
    severity: "error",
    phase: "typing",
    hints: [
      { message: "Convert elements so they share a single primitive type." },
    ],
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0024"]>,
  TY0025: {
    code: "TY0025",
    message: () => "array literal elements must share a compatible type",
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0025"]>,
  TY0026: {
    code: "TY0026",
    message: (params) => `undefined type '${params.name}'`,
    severity: "error",
    phase: "typing",
    hints: [
      {
        message:
          "Check for typos and ensure the type is declared or imported into the current module.",
      },
    ],
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0026"]>,
  TY0027: {
    code: "TY0027",
    message: (params) =>
      `type mismatch: expected '${params.expected}', received '${params.actual}'`,
    severity: "error",
    phase: "typing",
    hints: [],
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0027"]>,
  TY0028: {
    code: "TY0028",
    message: (params) =>
      `intersection nominal conflict: '${params.left}' is incompatible with '${params.right}'`,
    severity: "error",
    phase: "typing",
    hints: [
      {
        message:
          "Intersections can only contain nominal objects that are in the same inheritance chain.",
      },
    ],
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0028"]>,
  TY0029: {
    code: "TY0029",
    message: (params) =>
      `intersection field '${params.field}' conflicts: '${params.left}' is incompatible with '${params.right}'`,
    severity: "error",
    phase: "typing",
    hints: [
      {
        message:
          "Rename one of the fields, or make sure both intersected types agree on the field type.",
      },
    ],
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0029"]>,
  TY0030: {
    code: "TY0030",
    message: (params) => `undefined identifier '${params.name}'`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0030"]>,
  TY0031: {
    code: "TY0031",
    message: (params) =>
      `cannot reference '${params.name}' in its own initializer`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0031"]>,
  TY0032: {
    code: "TY0032",
    message: (params) =>
      `tuple index ${params.index} is out of range (length ${params.length})`,
    severity: "error",
    phase: "typing",
    hints: [
      {
        message:
          "Tuple indices are 0-based; the last valid index is length - 1.",
      },
    ],
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0032"]>,
  TY0033: {
    code: "TY0033",
    message: (params) =>
      params.receiver
        ? `unknown field '${params.name}' on '${params.receiver}'`
        : `unknown field '${params.name}'`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0033"]>,
  TY0034: {
    code: "TY0034",
    message: (params) =>
      `could not infer return type for function '${params.functionName}'`,
    severity: "error",
    phase: "typing",
    hints: [{ message: "Add an explicit return type annotation." }],
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0034"]>,
  TY0035: {
    code: "TY0035",
    message: (params) => {
      const min =
        params.minCalls === Number.POSITIVE_INFINITY ? "∞" : `${params.minCalls}`;
      const max =
        params.maxCalls === Number.POSITIVE_INFINITY ? "∞" : `${params.maxCalls}`;
      const range = min === max ? min : `${min}..${max}`;
      const suffix = params.escapes ? "; continuation escapes" : "";
      return `resumptive operation ${params.operation} must call resume at most once (observed ${range}${suffix})`;
    },
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0035"]>,
  TY0036: {
    code: "TY0036",
    message: (params) =>
      params.kind === "duplicate-trait-implementation"
        ? `duplicate trait implementation: '${params.traitName}' is already implemented for '${params.targetName}'`
        : `previous implementation of trait '${params.traitName}' for '${params.targetName}' declared here`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0036"]>,
  TY0037: {
    code: "TY0037",
    message: (params) =>
      params.receiver
        ? `missing required field '${params.field}' when constructing '${params.receiver}'`
        : `missing required field '${params.field}'`,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0037"]>,
  TY0038: {
    code: "TY0038",
    message: (params) =>
      `intrinsic wrapper '${params.intrinsicName}' is reserved for std; use the std library API instead`,
    severity: "error",
    phase: "typing",
    hints: [
      {
        message:
          "Import and call std wrappers (for example std::fixed_array, std::array, std::memory) instead of declaring raw __* wrappers.",
      },
    ],
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY0038"]>,
  TY9999: {
    code: "TY9999",
    message: (params) => params.message,
    severity: "error",
    phase: "typing",
  } satisfies DiagnosticDefinition<DiagnosticParamsMap["TY9999"]>,
} as const;

export const formatDiagnosticMessage = <K extends DiagnosticCode>(
  code: K,
  params: DiagnosticParams<K>,
): string => diagnosticsRegistry[code].message(params);

export const getDiagnosticDefinition = <K extends DiagnosticCode>(code: K) =>
  diagnosticsRegistry[code];

export const diagnosticCodes = (): DiagnosticCode[] =>
  Object.keys(diagnosticsRegistry) as DiagnosticCode[];

const exhaustive = (_value: never): never => _value;
