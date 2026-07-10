export { parse } from "@voyd-lang/compiler/parser/parser.js";
export { isForm } from "@voyd-lang/compiler/parser/index.js";
export type { Form } from "@voyd-lang/compiler/parser/index.js";
export type { TestAttribute } from "@voyd-lang/compiler/parser/attributes.js";
export {
  analyzeModules,
  emitProgram,
  loadModuleGraph,
} from "@voyd-lang/compiler/pipeline.js";
export type { TestCase } from "@voyd-lang/compiler/pipeline-shared.js";
export type {
  Diagnostic,
  DiagnosticSeverity,
  SourceSpan,
} from "@voyd-lang/compiler/diagnostics/index.js";
export { DiagnosticError } from "@voyd-lang/compiler/diagnostics/index.js";
export {
  BOUNDARY_MSGPACK_CONTRACT_PROVIDER_MODULES,
  /** @deprecated Use BOUNDARY_MSGPACK_CONTRACT_PROVIDER_MODULES. */
  BOUNDARY_MSGPACK_CONTRACT_PROVIDER_MODULES as EFFECTS_HOST_BOUNDARY_STD_DEPS,
} from "@voyd-lang/compiler/compiler-contracts/index.js";
export {
  modulePathFromFile,
  modulePathToString,
} from "@voyd-lang/compiler/modules/path.js";
export { createFsModuleHost } from "@voyd-lang/compiler/modules/fs-host.js";
export type {
  ModulePathAdapter,
  ModuleRoots,
} from "@voyd-lang/compiler/modules/types.js";
export type { HirGraph } from "@voyd-lang/compiler/semantics/hir/index.js";
export type { OptimizationLevel } from "@voyd-lang/compiler/optimization-policy.js";
export { BENCH_FILE } from "@voyd-lang/compiler/parser/benchmark.js";
