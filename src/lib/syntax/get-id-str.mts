import { Id } from "./identifier.mjs";

export const getIdStr = (id: Id) => {
  if (!id) {
    throw new Error("no id");
  }
  return typeof id === "string" ? id : id.value;
};
