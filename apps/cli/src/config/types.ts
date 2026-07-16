import type { OptimizationLevel } from "@voyd-lang/sdk";

export type DocumentationFormat = "html" | "json";
export type BootstrapTemplate = "vx-spa" | "web-ssr";

export type VoydConfig = {
  /** Write raw parser AST to stdout */
  emitParserAst?: boolean;
  /** Write desurfaced AST to stdout */
  emitCoreAst?: boolean;
  /** Emit ast ir expanded (post semantic phases) */
  emitIrAst?: boolean;
  /** Write wasm bytecode to stdout */
  emitWasm?: boolean;
  /** Write wasm bytecode to stdout (binaryen flavor) */
  emitWasmText?: boolean;
  /** Select the compiler optimization policy. */
  optimizationLevel?: OptimizationLevel;
  /** Run voyd from src/ or provided path */
  run?: boolean;
  /** Run emitted wasm directly */
  runWasm?: boolean;
  /** Entry function to run. Defaults to main */
  entry?: string;
  /** Specifies the entry voyd file */
  index: string;
  /** Run voyd tests */
  test?: boolean;
  /** Select test reporter */
  testReporter?: string;
  /** Exit with status 1 if no tests are found */
  failOnEmptyTests?: boolean;
  /** Additional package search directories */
  pkgDirs?: string[];
  /** Generate documentation output */
  doc?: boolean;
  /** Documentation output path */
  docOut?: string;
  /** Documentation output format */
  docFormat?: DocumentationFormat;
  /** Scaffold a new Voyd project */
  bootstrap?: boolean;
  /** Bootstrap target directory */
  bootstrapDir?: string;
  /** Bootstrap starter template */
  bootstrapTemplate?: BootstrapTemplate;
  /** Print bootstrap actions without writing files */
  bootstrapDryRun?: boolean;
  /** Allow bootstrap to write into a non-empty directory */
  bootstrapForce?: boolean;
  /** Use published Voyd dependencies instead of a detected local checkout */
  bootstrapUsePublished?: boolean;
  /** Generate package-adapter bindings. */
  generateAdapter?: boolean;
  /** Generate an application adapter registry. */
  generateAdapterRegistry?: boolean;
  /** Generated adapter output directory. */
  generateOut?: string;
};
