import fs from "node:fs";
import { parse } from "../parser.js";
import { List } from "../../syntax-objects/list.js";

export const parseFile = async (path: string): Promise<List> => {
  const file = fs.readFileSync(path, { encoding: "utf8" });
  return parse(file, path);
};
