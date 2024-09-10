import { Call } from "../../syntax-objects/call.js";
import { Expr } from "../../syntax-objects/expr.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { List } from "../../syntax-objects/list.js";
import { VoidModule } from "../../syntax-objects/module.js";
import { NamedEntity } from "../../syntax-objects/named-entity.js";
import { Use } from "../../syntax-objects/use.js";
import { resolveModuleTypes, resolveTypes } from "./resolve-types.js";

export type ModulePass = (mod: VoidModule) => VoidModule;

export const resolveUse = (use: Use, runPass?: ModulePass) => {
  const path = use.path;

  const entities = resolveModulePath(path, runPass);
  entities.forEach((e) => use.parentModule?.registerEntity(e));
  use.entities = [...use.entities, ...entities];
  return use;
};

export const resolveModulePath = (
  path: Expr,
  runPass?: ModulePass
): NamedEntity[] => {
  if (path.isIdentifier()) {
    const entity = path.resolve();
    return entity ? [entity] : [];
  }

  if (!path.isCall() && !path.isList()) {
    throw new Error("Invalid path statement");
  }

  if (path.calls("object")) {
    const imports = path.argsArray();
  }

  if (!path.calls("::")) {
    throw new Error(`Invalid use statement ${path}`);
  }

  const [_, left, right] = path.isCall()
    ? [undefined, path.argAt(0), path.argAt(1)]
    : path.toArray();

  const [resolvedModule] = left?.isList()
    ? resolveModulePath(left, runPass)
    : left?.isIdentifier()
    ? [resolveUseIdentifier(left)]
    : [];

  if (
    !resolvedModule ||
    resolvedModule instanceof Array ||
    !resolvedModule.isModule()
  ) {
    throw new Error(`Invalid use statement, not a module ${path.toJSON()}`);
  }

  const module = runPass ? runPass(resolvedModule) : resolvedModule;

  if (!right?.isIdentifier()) {
    throw new Error(`Invalid use statement, expected identifier, got ${right}`);
  }

  if (right?.is("all")) {
    return module.getAllExports();
  }

  const entity = module.resolveExport(right);
  if (!entity.length) {
    throw new Error(
      `Invalid use statement, entity ${right} is not exported at ${right.location}`
    );
  }

  return entity;
};

const resolveUseIdentifier = (identifier: Identifier) => {
  if (identifier.is("dir")) {
    return identifier.parentModule?.parentModule;
  }

  return identifier.resolve();
};

export const resolveExport = (call: Call) => {
  const block = call.argAt(0);
  if (!block?.isBlock()) return call;

  const entities = block.body.toArray().map(resolveTypes);
  registerExports(call, entities);

  return call;
};

export const registerExports = (
  exportExpr: Expr,
  entities: (Expr | NamedEntity)[],
  pass = resolveModuleTypes
) => {
  entities.forEach((e) => {
    if (e.isUse()) {
      e.entities.forEach((e) => registerExport(exportExpr, e));
      return;
    }

    if (e.isCall() && e.calls("mod")) {
      registerExports(exportExpr, resolveModulePath(e.exprArgAt(0), pass));
      return;
    }

    if (e instanceof NamedEntity) {
      registerExport(exportExpr, e);
      e.parentModule?.registerEntity(e);
    }
  });
};

const registerExport = (exportExpr: Expr, entity: NamedEntity) => {
  exportExpr.parentModule?.registerExport(entity);
};
