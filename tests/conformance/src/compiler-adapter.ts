export type ConformanceDiagnostic = {
  code: string;
  message: string;
  phase?: string;
  span?: {
    file: string;
    start: number;
    end: number;
  };
};

export type ConformanceCompileRequest = {
  entryPath: string;
  optimize?: boolean;
};

export type ConformanceEffectResponse = {
  action: "resume" | "end";
  value?: unknown;
};

export type ConformanceHostScenario = {
  effects: Record<string, ConformanceEffectResponse>;
};

export type ConformanceHostInteraction = {
  kind: "effect";
  label: string;
  args: unknown[];
};

export type ConformanceRunResult =
  | {
      success: true;
      value: unknown;
      interactions: ConformanceHostInteraction[];
    }
  | {
      success: false;
      trap: { name: string; message: string };
      interactions: ConformanceHostInteraction[];
    };

export type ConformanceCompiledProgram = {
  run(options: {
    entryName: string;
    host?: ConformanceHostScenario;
  }): Promise<ConformanceRunResult>;
};

export type ConformanceCompileResult =
  | {
      success: true;
      wasm: Uint8Array;
      program: ConformanceCompiledProgram;
    }
  | {
      success: false;
      diagnostics: ConformanceDiagnostic[];
    };

/**
 * The only compiler-specific seam used by the portable conformance corpus.
 * A future compiler can run the same manifest by implementing this adapter.
 */
export interface ConformanceCompilerAdapter {
  compile(
    request: ConformanceCompileRequest,
  ): Promise<ConformanceCompileResult>;
}
