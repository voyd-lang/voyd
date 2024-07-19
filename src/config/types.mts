export type VoidConfig = {
  /** Write raw parser AST to stdout */
  emitParserAst?: boolean;
  /** Write desurfaced AST to stdout */
  emitCoreAst?: boolean;
  /** Emit full AST with all resolved file modules */
  emitModuleAst?: boolean;
  /** Emit ast with regular macros expanded */
  emitMacroAst?: boolean;
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
  /** Run the internal test script */
  internalTest?: boolean;
};
