import type {
  MacroDefinition,
  MacroEvalResult,
  MacroVariableBinding,
} from "./types.js";

type HygieneState = {
  rootId: string;
  nextExpansionOrdinal: number;
};

type ExpansionAllocation = {
  id: string;
  nextFreshOrdinal: number;
};

export class MacroScope {
  #parent?: MacroScope;
  #macros = new Map<string, MacroDefinition>();
  #ambiguousMacros = new Set<string>();
  #variables = new Map<string, MacroVariableBinding>();
  #hygieneState: HygieneState;
  #expansionAllocation?: ExpansionAllocation;

  constructor(
    parent?: MacroScope,
    options: {
      hygieneRootId?: string;
      hygieneState?: HygieneState;
      expansionAllocation?: ExpansionAllocation;
    } = {},
  ) {
    this.#parent = parent;
    this.#hygieneState =
      options.hygieneState ??
      (parent ? parent.#hygieneState : undefined) ?? {
        rootId: options.hygieneRootId ?? "<macro-expansion>",
        nextExpansionOrdinal: 0,
      };
    this.#expansionAllocation =
      options.expansionAllocation ??
      (parent ? parent.#expansionAllocation : undefined);
  }

  child(): MacroScope {
    return new MacroScope(this);
  }

  invocationScope({
    definitionScope,
    macroKey,
  }: {
    definitionScope: MacroScope;
    macroKey: string;
  }): MacroScope {
    const ordinal = this.#hygieneState.nextExpansionOrdinal++;
    return new MacroScope(definitionScope, {
      hygieneState: this.#hygieneState,
      expansionAllocation: {
        id: `${this.#hygieneState.rootId}:${ordinal}:${macroKey}`,
        nextFreshOrdinal: 0,
      },
    });
  }

  currentExpansionId(): string {
    if (!this.#expansionAllocation) {
      throw new Error("fresh identifiers require an active macro expansion");
    }
    return this.#expansionAllocation.id;
  }

  allocateFreshOrdinal(): number {
    if (!this.#expansionAllocation) {
      throw new Error("fresh identifiers require an active macro expansion");
    }
    const ordinal = this.#expansionAllocation.nextFreshOrdinal;
    this.#expansionAllocation.nextFreshOrdinal += 1;
    return ordinal;
  }

  hygieneRootId(): string {
    return this.#hygieneState.rootId;
  }

  checkpoint(): () => void {
    const macros = new Map(this.#macros);
    const ambiguousMacros = new Set(this.#ambiguousMacros);
    const variables = new Map(
      Array.from(this.#variables, ([name, binding]) => [name, { ...binding }]),
    );
    return () => {
      this.#macros = macros;
      this.#ambiguousMacros = ambiguousMacros;
      this.#variables = variables;
    };
  }

  defineMacro(definition: MacroDefinition) {
    this.#ambiguousMacros.delete(definition.name.value);
    this.#macros.set(definition.name.value, definition);
  }

  defineAmbiguousMacro(name: string) {
    this.#macros.delete(name);
    this.#ambiguousMacros.add(name);
  }

  getMacro(name: string): MacroDefinition | undefined {
    if (this.#ambiguousMacros.has(name)) {
      throw new Error(
        `Macro '${name}' is ambiguous; import it with an explicit alias`,
      );
    }
    return this.#macros.get(name) ?? this.#parent?.getMacro(name);
  }

  defineVariable(binding: MacroVariableBinding) {
    this.#variables.set(binding.name.value, binding);
  }

  getVariable(name: string): MacroVariableBinding | undefined {
    return this.#variables.get(name) ?? this.#parent?.getVariable(name);
  }

  assignVariable(name: string, value: MacroEvalResult): MacroVariableBinding {
    const binding = this.#variables.get(name);
    if (binding) {
      if (!binding.mutable) {
        throw new Error(`Variable ${name} is not mutable`);
      }
      binding.value = value;
      return binding;
    }

    const parent = this.#parent;
    if (parent) return parent.assignVariable(name, value);

    throw new Error(`Identifier ${name} is not defined`);
  }
}
