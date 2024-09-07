import { Call } from "../../syntax-objects/call.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { List } from "../../syntax-objects/list.js";
import { VoidModule } from "../../syntax-objects/module.js";
import { NamedEntity } from "../../syntax-objects/named-entity.js";
import { Use } from "../../syntax-objects/use.js";

export type ModulePass = (mod: VoidModule) => VoidModule;

export const resolveUse = (use: Use, runPass?: ModulePass) => {
  const path = use.path;

  const entities = resolveModulePath(path, runPass);
  entities.forEach((e) => use.parent?.registerEntity(e));
  return use;
};

export const resolveModulePath = (
  path: List | Call,
  runPass?: ModulePass
): NamedEntity[] => {
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
    throw new Error(`Invalid use statement, not a module ${path}`);
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
      `Invalid use statement, entity ${right} not is not exported`
    );
  }

  return entity;
};

const resolveUseIdentifier = (identifier: Identifier) => {
  if (identifier.is("super")) {
    return identifier.parentModule?.parentModule;
  }

  return identifier.resolve();
};
