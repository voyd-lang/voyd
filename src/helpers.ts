import fs from "fs";
import path from "path";

export function isInTuple<T>(item: any, tuple: readonly T[]): item is T {
    return tuple.includes(item);
}

// https://stackoverflow.com/a/57103940/2483955
export type DistributiveOmit<T, K extends keyof any> = T extends any
    ? Omit<T, K>
    : never;

export interface FSItem {
    /** Item is directory or file */
    type: "dir" | "file";
    /** Filename without extension */
    name: string;
    /** File extension */
    extension: string;
    /** Absolute path of item */
    path: string;
    /** Filename with extension */
    filename: string;
    /** If the item is a directory contents holds more FSItems */
    contents: FSItem[];
}

export async function walkDir(dir: string): Promise<FSItem[]> {
    const fsItems: FSItem[] = [];
    const dirContents = await fs.promises.readdir(dir);

    for (const item of dirContents) {
        const location = `${dir}/${item}`;
        const stats = await fs.promises.lstat(location);
        if (stats.isFile()) {
            const parsedPath = path.parse(item);
            fsItems.push({
                type: "file",
                filename: item,
                name: parsedPath.name,
                extension: parsedPath.ext,
                path: path.resolve(location),
                contents: []
            });
            continue;
        }

        if (stats.isDirectory()) {
            const parsedPath = path.parse(item);
            fsItems.push({
                type: "dir",
                filename: item,
                name: parsedPath.name,
                extension: parsedPath.ext,
                path: path.resolve(location),
                contents: await walkDir(location)
            });
        }
    }

    return fsItems;
}
