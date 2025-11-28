import type {
  MacroDefinition,
  MacroEvalResult,
  MacroVariableBinding,
} from "./types.js";

export class MacroScope {
  #parent?: MacroScope;
  #macros = new Map<string, MacroDefinition>();
  #variables = new Map<string, MacroVariableBinding>();

  constructor(parent?: MacroScope) {
    this.#parent = parent;
  }

  child(): MacroScope {
    return new MacroScope(this);
  }

  defineMacro(definition: MacroDefinition) {
    this.#macros.set(definition.name.value, definition);
  }

  getMacro(name: string): MacroDefinition | undefined {
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
