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
  /** Run the compiled wasm code */
  run?: boolean;
  decodeMsgPackResponse?: boolean;
  /** Specifies the entry voyd file */
  index: string;
  /** Run the internal test script */
  internalTest?: boolean;
};
