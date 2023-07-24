export type VoidConfig = {
  /** Write raw parser AST to stdout */
  emitParserAst?: boolean;
  /** Write de-sugared AST to stdout */
  emitDeSugaredAst?: boolean;
  /** Write syntax SDT to stdout */
  emitSyntaxAst?: boolean;
  /** Write wasm bytecode to stdout */
  emitWasm?: boolean;
  /** Write wasm bytecode to stdout (binaryen flavor) */
  emitWasmText?: boolean;
  /** Have binaryen run an optimization pass */
  runBinaryenOptimizationPass?: boolean;
  /** Emit CLI usage to stdout */
  showHelp?: boolean;
  /** Emit void version to stdout */
  showVersion?: boolean;
  /** Run the compiled wasm code */
  run?: boolean;
  /** Specifies the entry void file */
  index: string;
};
