import type { Expr, Form, Syntax } from "../parser/index.js";
import type { HirVisibility } from "./hir/index.js";
import type {
  FunctionDeclId,
  OverloadSetId,
  ParameterDeclId,
  ScopeId,
  SymbolId,
  TypeAliasDeclId,
  ObjectDeclId,
  ImplDeclId,
} from "./ids.js";

export interface ParameterDecl {
  id: ParameterDeclId;
  name: string;
  label?: string;
  symbol: SymbolId;
  ast?: Syntax;
  typeExpr?: Expr;
}

export type ParameterDeclInput = Omit<ParameterDecl, "id"> & {
  id?: ParameterDeclId;
};

export interface TypeParameterDecl {
  name: string;
  symbol: SymbolId;
  ast?: Syntax;
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
  body: Expr;
  overloadSetId?: OverloadSetId;
  moduleIndex: number;
  implId?: ImplDeclId;
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
}

export type TypeAliasDeclInput = Omit<TypeAliasDecl, "id"> & {
  id?: TypeAliasDeclId;
};

export interface ObjectFieldDecl {
  name: string;
  symbol: SymbolId;
  ast?: Syntax;
  typeExpr: Expr;
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
}

export type ObjectDeclInput = Omit<ObjectDecl, "id"> & { id?: ObjectDeclId };

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
}

export type ImplDeclInput = Omit<ImplDecl, "id" | "methods"> & {
  id?: ImplDeclId;
  methods?: FunctionDecl[];
};

export class DeclTable {
  functions: FunctionDecl[] = [];
  typeAliases: TypeAliasDecl[] = [];
  objects: ObjectDecl[] = [];
  impls: ImplDecl[] = [];

  private nextFunctionId: FunctionDeclId = 0;
  private nextParamId: ParameterDeclId = 0;
  private nextAliasId: TypeAliasDeclId = 0;
  private nextObjectId: ObjectDeclId = 0;
  private nextImplId: ImplDeclId = 0;

  private functionsBySymbol = new Map<SymbolId, FunctionDecl>();
  private functionsById = new Map<FunctionDeclId, FunctionDecl>();
  private parametersBySymbol = new Map<SymbolId, ParameterDecl>();
  private parametersById = new Map<ParameterDeclId, ParameterDecl>();
  private typeAliasesBySymbol = new Map<SymbolId, TypeAliasDecl>();
  private typeAliasesById = new Map<TypeAliasDeclId, TypeAliasDecl>();
  private objectsBySymbol = new Map<SymbolId, ObjectDecl>();
  private objectsById = new Map<ObjectDeclId, ObjectDecl>();
  private implsBySymbol = new Map<SymbolId, ImplDecl>();
  private implsById = new Map<ImplDeclId, ImplDecl>();

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

  getImpl(symbol: SymbolId): ImplDecl | undefined {
    return this.implsBySymbol.get(symbol);
  }

  getImplById(id: ImplDeclId): ImplDecl | undefined {
    return this.implsById.get(id);
  }
}
