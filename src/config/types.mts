export type VoidConfig = {
  /** Specifies location to emit the parser ast */
  emitParserAst?: boolean;
  /** Specifies location to emit the syntax ast */
  emitSyntaxAst?: boolean;
  /** Specifies location to emit wasm bytecode */
  emitWasm?: boolean;
  /** Specifies location to emit wasm text */
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
