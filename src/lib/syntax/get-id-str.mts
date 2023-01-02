import { Id } from "./identifier.mjs";

export const getIdStr = (id: Id) => (typeof id === "string" ? id : id.value);
