import { VoydModule } from "../../syntax-objects/module.js";
import { List } from "../../syntax-objects/list.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { checkTypes } from "./check-types.js";

export const checkModuleTypes = (mod: VoydModule): VoydModule => {
  mod.each(checkTypes);
  return mod;
};

const resolveExports = ({
  exports,
  body,
}: {
  exports: List;
  body: List;
}): void => {
  body.each((expr) => {
    if (!expr.isList()) return;
    if (expr.calls("export")) {
      exports.push(expr.at(1) as Identifier);
      return;
    }
    return resolveExports({ exports, body: expr });
  });
};

