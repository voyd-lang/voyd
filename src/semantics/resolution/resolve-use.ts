import { Identifier } from "../../syntax-objects/identifier.js";
import { List } from "../../syntax-objects/list.js";
import { NamedEntity } from "../../syntax-objects/named-entity.js";
import { Use } from "../../syntax-objects/use.js";
import { resolveModuleTypes } from "./resolve-types.js";

export const resolveUse = (use: Use) => {
  const path = use.path;

  const entities = resolveUsePath(path);
  if (entities instanceof Array) {
    entities.forEach((e) => use.parent?.registerEntity(e));
  } else {
    use.parent?.registerEntity(entities);
  }

  return use;
};

const resolveUsePath = (path: List): NamedEntity | NamedEntity[] => {
  if (!path.calls("::")) {
    throw new Error(`Invalid use statement ${path}`);
  }

  const [_, left, right] = path.toArray();
  const resolvedModule = left?.isList()
    ? resolveUsePath(left)
    : left?.isIdentifier()
    ? resolveUseIdentifier(left)
    : undefined;

  if (
    !resolvedModule ||
    resolvedModule instanceof Array ||
    !resolvedModule.isModule()
  ) {
    throw new Error(`Invalid use statement, not a module ${path}`);
  }

  const module =
    resolvedModule.phase < 3
      ? resolveModuleTypes(resolvedModule)
      : resolvedModule;

  if (!right?.isIdentifier()) {
    throw new Error(`Invalid use statement, expected identifier, got ${right}`);
  }

  if (right?.is("all")) {
    return module.getAllEntities().filter((e) => e.isExported);
  }

  const entity = module.resolveChildEntity(right);
  if (entity && !entity.isExported) {
    throw new Error(
      `Invalid use statement, entity ${right} not is not exported`
    );
  }

  if (entity) {
    return entity;
  }

  const fns = module.resolveChildFns(right).filter((f) => f.isExported);
  if (!fns.length) {
    throw new Error(`No exported entities with name ${right}`);
  }

  return fns;
};

const resolveUseIdentifier = (identifier: Identifier) => {
  if (identifier.is("super")) {
    return identifier.parentModule?.parentModule;
  }

  return identifier.resolve();
};
