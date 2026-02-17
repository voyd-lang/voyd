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
  /** Have binaryen run an optimization pass */
  runBinaryenOptimizationPass?: boolean;
  /** Run voyd from src/ or provided path */
  run?: boolean;
  /** Run emitted wasm directly */
  runWasm?: boolean;
  decodeMsgPackResponse?: boolean;
  /** Specifies the entry voyd file */
  index: string;
  /** Run the internal test script */
  internalTest?: boolean;
  /** Run voyd tests */
  test?: boolean;
  /** Select test reporter */
  testReporter?: string;
  /** Exit with status 1 if no tests are found */
  failOnEmptyTests?: boolean;
  /** Additional package search directories */
  pkgDirs?: string[];
  /** Generate HTML documentation */
  doc?: boolean;
  /** Documentation output path */
  docOut?: string;
};
