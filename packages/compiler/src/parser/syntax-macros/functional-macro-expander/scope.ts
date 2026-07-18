import type {
  MacroDefinition,
  MacroEvalResult,
  MacroVariableBinding,
} from "./types.js";

export class MacroScope {
  #parent?: MacroScope;
  #macros = new Map<string, MacroDefinition>();
  #ambiguousMacros = new Set<string>();
  #variables = new Map<string, MacroVariableBinding>();

  constructor(parent?: MacroScope) {
    this.#parent = parent;
  }

  child(): MacroScope {
    return new MacroScope(this);
  }

  checkpoint(): () => void {
    const macros = new Map(this.#macros);
    const ambiguousMacros = new Set(this.#ambiguousMacros);
    const variables = new Map(
      Array.from(this.#variables, ([name, binding]) => [
        name,
        { ...binding },
      ]),
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
