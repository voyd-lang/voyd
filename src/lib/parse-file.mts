import fs from "node:fs";
import { parse } from "../parser.mjs";
import { List } from "../syntax-objects/list.mjs";
import { File } from "./file.mjs";

export const parseFile = async (path: string): Promise<List> => {
  const file = fs.readFileSync(path, { encoding: "utf8" });
  return parse(new File(file, path));
};
