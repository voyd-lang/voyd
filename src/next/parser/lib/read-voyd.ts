import { readFile } from "fs/promises";
import { read } from "../reader.js";
import { CharStream } from "../char-stream.js";

export const readVoyd = async (path: string) => {
  const file = await readFile(path, { encoding: "utf-8" });
  const chars = new CharStream(file, path);
  return read(chars);
};
