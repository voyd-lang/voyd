import type { Expr, Form, Syntax } from "../parser/index.js";
import type { HirBindingKind, HirVisibility } from "./hir/index.js";
import type {
  FunctionDeclId,
  OverloadSetId,
  ParameterDeclId,
  ScopeId,
  SymbolId,
  TypeAliasDeclId,
  ObjectDeclId,
  TraitDeclId,
  ImplDeclId,
  EffectDeclId,
} from "./ids.js";
import type { IdentifierAtom } from "../parser/ast/atom.js";
import type { IntrinsicAttribute } from "../parser/attributes.js";

export interface ParameterDecl {
  id: ParameterDeclId;
  name: string;
  label?: string;
  labelAst?: Syntax;
  optional?: boolean;
  symbol: SymbolId;
  ast?: Syntax;
  typeExpr?: Expr;
  bindingKind?: HirBindingKind;
  documentation?: string;
}

export type ParameterDeclInput = Omit<ParameterDecl, "id"> & {
  id?: ParameterDeclId;
};

export interface TypeParameterDecl {
  name: string;
  symbol: SymbolId;
  ast?: Syntax;
  constraint?: Expr;
}

export type TypeParameterDeclInput = TypeParameterDecl;

export interface FunctionDecl {
  id: FunctionDeclId;
  name: string;
  form?: Form;
  visibility: HirVisibility;
  symbol: SymbolId;
  scope: ScopeId;
  params: ParameterDecl[];
  typeParameters?: TypeParameterDecl[];
  returnTypeExpr?: Expr;
  effectTypeExpr?: Expr;
  body: Expr;
  memberVisibility?: HirVisibility;
  overloadSetId?: OverloadSetId;
  moduleIndex: number;
  implId?: ImplDeclId;
  intrinsic?: IntrinsicAttribute;
  documentation?: string;
}

export type FunctionDeclInput = Omit<FunctionDecl, "id" | "params"> & {
  id?: FunctionDeclId;
  params: ParameterDeclInput[];
};

export interface TypeAliasDecl {
  id: TypeAliasDeclId;
  name: string;
  form?: Form;
  visibility: HirVisibility;
  symbol: SymbolId;
  target: Expr;
  typeParameters?: TypeParameterDecl[];
  moduleIndex: number;
  documentation?: string;
}

export type TypeAliasDeclInput = Omit<TypeAliasDecl, "id"> & {
  id?: TypeAliasDeclId;
};

export interface ObjectFieldDecl {
  name: string;
  symbol: SymbolId;
  ast?: Syntax;
  visibility: HirVisibility;
  typeExpr: Expr;
  optional?: boolean;
  documentation?: string;
}

export interface ObjectDecl {
  id: ObjectDeclId;
  name: string;
  form?: Form;
  visibility: HirVisibility;
  symbol: SymbolId;
  baseTypeExpr?: Expr;
  fields: ObjectFieldDecl[];
  typeParameters?: TypeParameterDecl[];
  moduleIndex: number;
  documentation?: string;
}

export type ObjectDeclInput = Omit<ObjectDecl, "id"> & { id?: ObjectDeclId };

export interface TraitMethodDecl {
  name: string;
  form?: Form;
  symbol: SymbolId;
  scope: ScopeId;
  nameAst?: IdentifierAtom;
  params: ParameterDecl[];
  typeParameters?: TypeParameterDecl[];
  returnTypeExpr?: Expr;
  effectTypeExpr?: Expr;
  defaultBody?: Expr;
  intrinsic?: IntrinsicAttribute;
  documentation?: string;
}

export type TraitMethodDeclInput = Omit<TraitMethodDecl, "params"> & {
  params: ParameterDeclInput[];
};

export interface TraitDecl {
  id: TraitDeclId;
  name: string;
  form?: Form;
  visibility: HirVisibility;
  symbol: SymbolId;
  typeParameters?: TypeParameterDecl[];
  methods: TraitMethodDecl[];
  scope: ScopeId;
  moduleIndex: number;
  documentation?: string;
}

export type TraitDeclInput = Omit<TraitDecl, "id" | "methods"> & {
  id?: TraitDeclId;
  methods?: TraitMethodDeclInput[];
};

export interface ImplDecl {
  id: ImplDeclId;
  form?: Form;
  visibility: HirVisibility;
  symbol: SymbolId;
  target: Expr;
  trait?: Expr;
  typeParameters?: TypeParameterDecl[];
  methods: FunctionDecl[];
  scope: ScopeId;
  moduleIndex: number;
  documentation?: string;
}

export type ImplDeclInput = Omit<ImplDecl, "id" | "methods"> & {
  id?: ImplDeclId;
  methods?: FunctionDecl[];
};

export interface EffectOperationDecl {
  name: string;
  symbol: SymbolId;
  ast?: Syntax;
  parameters: readonly ParameterDecl[];
  resumable: "resume" | "tail";
  returnTypeExpr?: Expr;
  documentation?: string;
}

export interface EffectOperationDeclInput {
  name: string;
  symbol: SymbolId;
  ast?: Syntax;
  parameters: readonly ParameterDeclInput[];
  resumable: "resume" | "tail";
  returnTypeExpr?: Expr;
}

export interface EffectDecl {
  id: EffectDeclId;
  name: string;
  form?: Form;
  visibility: HirVisibility;
  symbol: SymbolId;
  scope: ScopeId;
  effectId?: string;
  typeParameters?: TypeParameterDecl[];
  operations: readonly EffectOperationDecl[];
  moduleIndex: number;
}

export type EffectDeclInput = Omit<EffectDecl, "id" | "operations"> & {
  id?: EffectDeclId;
  operations: readonly EffectOperationDeclInput[];
};


export class DeclTable {
  functions: FunctionDecl[] = [];
  typeAliases: TypeAliasDecl[] = [];
  objects: ObjectDecl[] = [];
  traits: TraitDecl[] = [];
  impls: ImplDecl[] = [];
  effects: EffectDecl[] = [];

  private nextFunctionId: FunctionDeclId = 0;
  private nextParamId: ParameterDeclId = 0;
  private nextAliasId: TypeAliasDeclId = 0;
  private nextObjectId: ObjectDeclId = 0;
  private nextTraitId: TraitDeclId = 0;
  private nextImplId: ImplDeclId = 0;
  private nextEffectId: EffectDeclId = 0;

  private functionsBySymbol = new Map<SymbolId, FunctionDecl>();
  private functionsById = new Map<FunctionDeclId, FunctionDecl>();
  private parametersBySymbol = new Map<SymbolId, ParameterDecl>();
  private parametersById = new Map<ParameterDeclId, ParameterDecl>();
  private typeAliasesBySymbol = new Map<SymbolId, TypeAliasDecl>();
  private typeAliasesById = new Map<TypeAliasDeclId, TypeAliasDecl>();
  private objectsBySymbol = new Map<SymbolId, ObjectDecl>();
  private objectsById = new Map<ObjectDeclId, ObjectDecl>();
  private traitsBySymbol = new Map<SymbolId, TraitDecl>();
  private traitsById = new Map<TraitDeclId, TraitDecl>();
  private implsBySymbol = new Map<SymbolId, ImplDecl>();
  private implsById = new Map<ImplDeclId, ImplDecl>();
  private effectsBySymbol = new Map<SymbolId, EffectDecl>();
  private effectsById = new Map<EffectDeclId, EffectDecl>();
  private effectOperationsBySymbol = new Map<
    SymbolId,
    { effect: EffectDecl; operation: EffectOperationDecl }
  >();

  private bumpId(next: number, used: number): number {
    return Math.max(next, used + 1);
  }

  registerFunction(fn: FunctionDeclInput): FunctionDecl {
    const typeParameters = fn.typeParameters?.map((param) => ({ ...param }));
    const params: ParameterDecl[] = fn.params.map((param) => {
      const withId: ParameterDecl = {
        ...param,
        id: param.id ?? this.nextParamId++,
      };
      this.nextParamId = this.bumpId(this.nextParamId, withId.id);
      this.parametersBySymbol.set(withId.symbol, withId);
      this.parametersById.set(withId.id, withId);
      return withId;
    });

    const withIds: FunctionDecl = {
      ...fn,
      id: fn.id ?? this.nextFunctionId++,
      typeParameters,
      params,
    };
    this.nextFunctionId = this.bumpId(this.nextFunctionId, withIds.id);

    this.functions.push(withIds);
    this.functionsBySymbol.set(withIds.symbol, withIds);
    this.functionsById.set(withIds.id, withIds);
    return withIds;
  }

  registerTypeAlias(alias: TypeAliasDeclInput): TypeAliasDecl {
    const withId: TypeAliasDecl = {
      ...alias,
      id: alias.id ?? this.nextAliasId++,
    };
    this.nextAliasId = this.bumpId(this.nextAliasId, withId.id);
    this.typeAliases.push(withId);
    this.typeAliasesBySymbol.set(withId.symbol, withId);
    this.typeAliasesById.set(withId.id, withId);
    return withId;
  }

  registerObject(object: ObjectDeclInput): ObjectDecl {
    const withId: ObjectDecl = {
      ...object,
      id: object.id ?? this.nextObjectId++,
    };
    this.nextObjectId = this.bumpId(this.nextObjectId, withId.id);
    this.objects.push(withId);
    this.objectsBySymbol.set(withId.symbol, withId);
    this.objectsById.set(withId.id, withId);
    return withId;
  }

  registerTrait(trait: TraitDeclInput): TraitDecl {
    const typeParameters = trait.typeParameters?.map((param) => ({ ...param }));
    const methods =
      trait.methods?.map((method) => {
        const methodTypeParameters = method.typeParameters?.map((param) => ({
          ...param,
        }));
        const params: ParameterDecl[] = method.params.map((param) => {
          const withId: ParameterDecl = {
            ...param,
            id: param.id ?? this.nextParamId++,
          };
          this.nextParamId = this.bumpId(this.nextParamId, withId.id);
          this.parametersBySymbol.set(withId.symbol, withId);
          this.parametersById.set(withId.id, withId);
          return withId;
        });

        return { ...method, params, typeParameters: methodTypeParameters };
      }) ?? [];

    const withId: TraitDecl = {
      ...trait,
      typeParameters,
      methods,
      id: trait.id ?? this.nextTraitId++,
    };
    this.nextTraitId = this.bumpId(this.nextTraitId, withId.id);
    this.traits.push(withId);
    this.traitsBySymbol.set(withId.symbol, withId);
    this.traitsById.set(withId.id, withId);
    return withId;
  }

  registerImpl(impl: ImplDeclInput): ImplDecl {
    const methods = impl.methods ? [...impl.methods] : [];
    const withId: ImplDecl = {
      ...impl,
      methods,
      id: impl.id ?? this.nextImplId++,
    };
    this.nextImplId = this.bumpId(this.nextImplId, withId.id);
    this.impls.push(withId);
    this.implsBySymbol.set(withId.symbol, withId);
    this.implsById.set(withId.id, withId);
    return withId;
  }

  registerEffect(effect: EffectDeclInput): EffectDecl {
    const operations = effect.operations.map((op) => ({
      ...op,
      parameters: op.parameters.map((param) => {
        const withId: ParameterDecl = {
          ...param,
          id: param.id ?? this.nextParamId++,
        };
        this.nextParamId = this.bumpId(this.nextParamId, withId.id);
        this.parametersBySymbol.set(withId.symbol, withId);
        this.parametersById.set(withId.id, withId);
        return withId;
      }),
    }));

    const typeParameters = effect.typeParameters?.map((param) => ({ ...param }));
    const withId: EffectDecl = {
      ...effect,
      typeParameters,
      operations,
      id: effect.id ?? this.nextEffectId++,
    };
    this.nextEffectId = this.bumpId(this.nextEffectId, withId.id);
    this.effects.push(withId);
    this.effectsBySymbol.set(withId.symbol, withId);
    this.effectsById.set(withId.id, withId);
    withId.operations.forEach((operation) => {
      this.effectOperationsBySymbol.set(operation.symbol, {
        effect: withId,
        operation,
      });
    });
    return withId;
  }

  getFunction(symbol: SymbolId): FunctionDecl | undefined {
    return this.functionsBySymbol.get(symbol);
  }

  getFunctionById(id: FunctionDeclId): FunctionDecl | undefined {
    return this.functionsById.get(id);
  }

  getParameter(symbol: SymbolId): ParameterDecl | undefined {
    return this.parametersBySymbol.get(symbol);
  }

  getParameterById(id: ParameterDeclId): ParameterDecl | undefined {
    return this.parametersById.get(id);
  }

  getTypeAlias(symbol: SymbolId): TypeAliasDecl | undefined {
    return this.typeAliasesBySymbol.get(symbol);
  }

  getTypeAliasById(id: TypeAliasDeclId): TypeAliasDecl | undefined {
    return this.typeAliasesById.get(id);
  }

  getObject(symbol: SymbolId): ObjectDecl | undefined {
    return this.objectsBySymbol.get(symbol);
  }

  getObjectById(id: ObjectDeclId): ObjectDecl | undefined {
    return this.objectsById.get(id);
  }

  getTrait(symbol: SymbolId): TraitDecl | undefined {
    return this.traitsBySymbol.get(symbol);
  }

  getTraitById(id: TraitDeclId): TraitDecl | undefined {
    return this.traitsById.get(id);
  }

  getImpl(symbol: SymbolId): ImplDecl | undefined {
    return this.implsBySymbol.get(symbol);
  }

  getImplById(id: ImplDeclId): ImplDecl | undefined {
    return this.implsById.get(id);
  }

  getEffect(symbol: SymbolId): EffectDecl | undefined {
    return this.effectsBySymbol.get(symbol);
  }

  getEffectById(id: EffectDeclId): EffectDecl | undefined {
    return this.effectsById.get(id);
  }

  getEffectOperation(
    symbol: SymbolId
  ):
    | { effect: EffectDecl; operation: EffectOperationDecl }
    | undefined {
    return this.effectOperationsBySymbol.get(symbol);
  }
}
