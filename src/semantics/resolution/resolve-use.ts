import { Call } from "../../syntax-objects/call.js";
import { Expr } from "../../syntax-objects/expr.js";
import { List } from "../../syntax-objects/list.js";
import { VoidModule } from "../../syntax-objects/module.js";
import { NamedEntity } from "../../syntax-objects/named-entity.js";
import { Use, UseEntities } from "../../syntax-objects/use.js";
import { resolveModule, resolveEntities } from "./resolve-entities.js";

export type ModulePass = (mod: VoidModule) => VoidModule;

export const resolveUse = (use: Use, runPass?: ModulePass) => {
  const path = use.path;

  const entities = resolveModulePath(path, runPass);
  entities.forEach((e) => use.parentModule?.registerEntity(e.e, e.alias));
  use.entities = entities;
  return use;
};

export const resolveModulePath = (
  path: Expr,
  runPass?: ModulePass
): { e: NamedEntity; alias?: string }[] => {
  if (path.isIdentifier()) {
    const e = path.resolve();
    return e ? [{ e }] : [];
  }

  if (!path.isCall() && !path.isList()) {
    throw new Error("Invalid path statement");
  }

  if (!path.calls("::")) {
    throw new Error(`Invalid use statement ${path}`);
  }

  const [left, right] = path.argsArray();

  const resolvedModule =
    left?.isList() || left?.isCall()
      ? resolveModulePath(left, runPass)[0]?.e
      : left?.isIdentifier()
      ? left.resolveModule(left)
      : undefined;

  if (
    !resolvedModule ||
    resolvedModule instanceof Array ||
    !resolvedModule.isModule()
  ) {
    throw new Error(
      `Invalid use statement, not a module ${JSON.stringify(
        path,
        null,
        2
      )} at ${path.location}`
    );
  }

  const module = runPass ? runPass(resolvedModule) : resolvedModule;

  if ((right.isCall() || right.isList()) && right.calls("object")) {
    return resolveObjectPath(right, module);
  }

  if (!right?.isIdentifier()) {
    if (resolvedModule.phase < 3) return []; // Ignore unresolved entities in macro phase
    throw new Error(`Invalid use statement, expected identifier, got ${right}`);
  }

  if (right?.is("all")) {
    return module.getAllExports().map((e) => ({ e }));
  }

  const entities = module.resolveExport(right);
  if (!entities.length) {
    if (resolvedModule.phase < 3) return []; // Ignore unresolved entities in macro phase
    throw new Error(
      `Invalid use statement, entity ${right} is not exported at ${right.location}`
    );
  }

  return entities.map((e) => ({ e }));
};

const resolveObjectPath = (path: Call | List, module: VoidModule) => {
  const entities: UseEntities = [];

  const imports = path.argsArray();
  for (const imp of imports) {
    if ((imp.isCall() || imp.isList()) && imp.calls("as")) {
      const args = imp.argsArray();
      const entityId = args.at(0);
      const alias = args.at(1);
      if (!entityId?.isIdentifier() || !alias?.isIdentifier()) {
        if (module.phase < 3) continue; // Ignore unresolved entities in macro phase
        throw new Error(
          `Invalid use statement, expected identifiers, got ${imp}`
        );
      }

      if (entityId.is("self")) {
        entities.push({ e: module, alias: alias?.value });
        continue;
      }

      const resolvedEntities = module.resolveExport(entityId);
      if (!resolvedEntities.length) {
        if (module.phase < 3) continue; // Ignore unresolved entities in macro phase
        throw new Error(
          `Invalid use statement, entity ${entityId} is not exported at ${entityId.location}`
        );
      }

      entities.push(
        ...resolvedEntities.map((e) => ({ e, alias: alias?.value }))
      );
      continue;
    }

    if (!imp.isIdentifier()) {
      throw new Error(`Invalid use statement, expected identifier, got ${imp}`);
    }

    if (imp.is("self")) {
      entities.push({ e: module });
      continue;
    }

    const resolvedEntities = module.resolveExport(imp);
    if (!resolvedEntities.length) {
      if (module.phase < 3) continue; // Ignore unresolved entities in macro phase
      throw new Error(
        `Invalid use statement, entity ${imp} is not exported at ${imp.location}`
      );
    }

    entities.push(...resolvedEntities.map((e) => ({ e })));
  }

  return entities;
};

export const resolveExport = (call: Call) => {
  const block = call.argAt(0);
  if (!block?.isBlock()) return call;

  const entities = block.body.map(resolveEntities);
  registerExports(call, entities, resolveModule);

  return call;
};

export const registerExports = (
  exportExpr: Expr,
  entities: (Expr | NamedEntity | { e: NamedEntity; alias?: string })[],
  pass?: ModulePass
) => {
  entities.forEach((e) => {
    if ("e" in e) {
      registerExport(exportExpr, e.e, e.alias);
      return;
    }

    if (e.isUse()) {
      e.entities.forEach((e) => registerExport(exportExpr, e.e, e.alias));
      return;
    }

    if ((e.isCall() || e.isList()) && e.calls("mod")) {
      registerExports(exportExpr, resolveModulePath(e.argsArray()[0], pass));
      return;
    }

    if (e instanceof NamedEntity) {
      registerExport(exportExpr, e);
      if (!e.parentImpl) e.parentModule?.registerEntity(e);
    }
  });
};

const registerExport = (
  exportExpr: Expr,
  entity: NamedEntity,
  alias?: string
) => {
  const parent = exportExpr.parent;
  if (!parent) return;

  if (parent.isModule()) {
    parent.registerExport(entity, alias);
    return;
  }

  if (exportExpr.parentImpl && entity.isFn()) {
    exportExpr.parentImpl.registerExport(entity);
    return;
  }
};
