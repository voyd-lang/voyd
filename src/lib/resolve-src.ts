import { stat } from "node:fs/promises";
import path from "node:path";

export type SrcInfo = {
  indexPath: string;
  srcRootPath?: string;
};

/**
 * Resolves src code location information.
 *
 * Assumes either a single file to compile or a directory with an index file.
 * I.E. Single File === `src/test.void` or Directory === `src`.
 *
 * Will return only the index file path if a single file is provided.
 * Will return the srcRootPath and index file path as srcRootPath + index.void if a directory is provided.
 */
export async function resolveSrc(index: string): Promise<SrcInfo> {
  const indexPath = path.resolve(index);
  const parsedIndexPath = path.parse(indexPath);
  const indexStats = await stat(indexPath);

  if (!indexStats.isDirectory() && parsedIndexPath.ext !== ".void") {
    throw new Error(`Invalid file extension ${parsedIndexPath.ext}`);
  }

  if (indexStats.isDirectory()) {
    return {
      indexPath: path.join(indexPath, "index.void"),
      srcRootPath: indexPath,
    };
  }

  return { indexPath };
}
