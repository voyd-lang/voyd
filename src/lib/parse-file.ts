import fs from "node:fs";
import { parse } from "../parser/parser.js";
import { List } from "../syntax-objects/list.js";
import { File } from "./file.js";

export const parseFile = async (path: string): Promise<List> => {
  const file = fs.readFileSync(path, { encoding: "utf8" });
  return parse(new File(file, path));
};
