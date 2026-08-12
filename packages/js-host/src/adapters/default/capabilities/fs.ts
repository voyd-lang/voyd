import {
  globalRecord,
  isRecord,
  isNodeCompatibleRuntime,
  joinListDirChildPath,
  readField,
  toNumberOrUndefined,
  toPath,
  toStringOrUndefined,
} from "../helpers.js";
import { maybeNodeFs } from "../runtime-imports.js";
import {
  opEntries,
  registerMissingOpHandlers,
  registerOpHandler,
  registerUnsupportedHandlers,
} from "../registration.js";
import { FS_EFFECT_ID, type CapabilityDefinition } from "../types.js";

type FsErrorKind =
  | "not-found"
  | "already-exists"
  | "permission-denied"
  | "conflict"
  | "other";

type FsWriteContent = string | Uint8Array;

const ATOMIC_WRITE_ATTEMPTS = 16;
let atomicWriteSequence = 0;

const fsErrorCode = (error: unknown): number => {
  const errno = isRecord(error) ? readField(error, "errno") : undefined;
  const parsed = toNumberOrUndefined(errno);
  return parsed === undefined ? 1 : parsed;
};

const fsErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const fsErrorKind = (error: unknown): FsErrorKind => {
  const code = isRecord(error)
    ? toStringOrUndefined(readField(error, "code"))
    : undefined;
  const name = isRecord(error)
    ? toStringOrUndefined(readField(error, "name"))
    : undefined;
  const identifier = code ?? name;

  if (identifier === "ENOENT" || identifier === "NotFound") {
    return "not-found";
  }
  if (identifier === "EEXIST" || identifier === "AlreadyExists") {
    return "already-exists";
  }
  if (
    identifier === "EACCES" ||
    identifier === "EPERM" ||
    identifier === "PermissionDenied"
  ) {
    return "permission-denied";
  }
  if (
    identifier === "EBUSY" ||
    identifier === "ETXTBSY" ||
    identifier === "ENOTEMPTY" ||
    identifier === "Busy"
  ) {
    return "conflict";
  }
  return "other";
};

const fsSuccess = <T>(value: T): Record<string, unknown> => ({
  ok: true,
  value,
  error_kind: "other",
  error_code: 0,
  error_message: "",
});

const fsHostError = <T>(
  error: unknown,
  value: T,
): Record<string, unknown> => ({
  ok: false,
  value,
  error_kind: fsErrorKind(error),
  error_code: fsErrorCode(error),
  error_message: fsErrorMessage(error),
});

const UNIT_VALUE = Object.freeze({});

const bytesFromPayload = (payload: unknown): Uint8Array => {
  const value = readField(payload, "bytes");
  if (!(value instanceof Uint8Array)) {
    throw new Error("expected filesystem bytes payload to be Uint8Array");
  }
  return value;
};

const stringFromPayload = (payload: unknown): string =>
  toStringOrUndefined(readField(payload, "value")) ?? "";

const writeContentFromPayload = (payload: unknown): FsWriteContent => {
  const kind = toStringOrUndefined(readField(payload, "kind"));
  if (kind === "bytes") {
    return bytesFromPayload(payload);
  }
  if (kind === "string") {
    return stringFromPayload(payload);
  }
  throw new Error("expected filesystem write payload kind to be string or bytes");
};

const runtimeProcessId = (): number => {
  const processValue = readField(globalRecord, "process");
  const nodePid = toNumberOrUndefined(readField(processValue, "pid"));
  if (nodePid !== undefined) {
    return nodePid;
  }
  const denoValue = readField(globalRecord, "Deno");
  return toNumberOrUndefined(readField(denoValue, "pid")) ?? 0;
};

const nextAtomicTemporaryPath = (destination: string): string => {
  atomicWriteSequence += 1;
  return `${destination}.voyd-tmp-${runtimeProcessId()}-${Date.now().toString(36)}-${atomicWriteSequence.toString(36)}`;
};

export const fsCapabilityDefinition: CapabilityDefinition = {
  capability: "fs",
  effectId: FS_EFFECT_ID,
  register: async ({ host, runtime, diagnostics, effectBufferSize }) => {
    const entries = opEntries({ host, effectId: FS_EFFECT_ID });
    if (entries.length === 0) {
      return 0;
    }

    const nodeFs = isNodeCompatibleRuntime(runtime)
      ? await maybeNodeFs()
      : undefined;
    const deno =
      runtime === "deno"
        ? (globalRecord.Deno as Record<string, unknown>)
        : undefined;
    const denoReadFile = deno?.readFile as
      | ((path: string) => Promise<Uint8Array>)
      | undefined;
    const denoReadTextFile = deno?.readTextFile as
      | ((path: string) => Promise<string>)
      | undefined;
    const denoWriteFile = deno?.writeFile as
      | ((
          path: string,
          data: Uint8Array,
          options?: { createNew?: boolean }
        ) => Promise<void>)
      | undefined;
    const denoWriteTextFile = deno?.writeTextFile as
      | ((
          path: string,
          data: string,
          options?: { createNew?: boolean }
        ) => Promise<void>)
      | undefined;
    const denoStat = deno?.stat as
      | ((path: string) => Promise<unknown>)
      | undefined;
    const denoRemove = deno?.remove as
      | ((path: string) => Promise<void>)
      | undefined;
    const denoMkdir = deno?.mkdir as
      | ((path: string, options: { recursive: boolean }) => Promise<void>)
      | undefined;
    const denoRename = deno?.rename as
      | ((oldPath: string, newPath: string) => Promise<void>)
      | undefined;
    const denoReadDir = deno?.readDir as
      | ((path: string) => AsyncIterable<{ name: string }>)
      | undefined;

    const hasNodeFs = !!nodeFs;
    const hasDenoFs =
      !!denoReadFile &&
      !!denoReadTextFile &&
      !!denoWriteFile &&
      !!denoWriteTextFile &&
      !!denoStat &&
      !!denoRemove &&
      !!denoMkdir &&
      !!denoRename &&
      !!denoReadDir;

    if (!hasNodeFs && !hasDenoFs) {
      return registerUnsupportedHandlers({
        host,
        effectId: FS_EFFECT_ID,
        capability: "fs",
        runtime,
        reason: "filesystem APIs are not available",
        diagnostics,
      });
    }

    const implementedOps = new Set<string>();
    let registered = 0;
    const writeExclusive = async (
      path: string,
      content: FsWriteContent
    ): Promise<void> => {
      if (hasNodeFs) {
        await nodeFs!.writeFile(path, content, { flag: "wx" });
        return;
      }
      if (typeof content === "string") {
        await denoWriteTextFile!(path, content, { createNew: true });
        return;
      }
      await denoWriteFile!(path, content, { createNew: true });
    };

    const removeTemporary = async (path: string): Promise<void> => {
      try {
        if (hasNodeFs) {
          await nodeFs!.unlink(path);
        } else {
          await denoRemove!(path);
        }
      } catch {
        // Cleanup is best effort; the original write/rename error is retained.
      }
    };

    const writeAtomic = async (
      destination: string,
      content: FsWriteContent
    ): Promise<void> => {
      let lastCollision: unknown;
      for (let attempt = 0; attempt < ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
        const temporary = nextAtomicTemporaryPath(destination);
        try {
          await writeExclusive(temporary, content);
        } catch (error) {
          if (fsErrorKind(error) === "already-exists") {
            lastCollision = error;
            continue;
          }
          await removeTemporary(temporary);
          throw error;
        }

        try {
          if (hasNodeFs) {
            await nodeFs!.rename(temporary, destination);
          } else {
            await denoRename!(temporary, destination);
          }
          return;
        } catch (error) {
          await removeTemporary(temporary);
          throw error;
        }
      }
      throw (
        lastCollision ??
        Object.assign(
          new Error("could not allocate an atomic write temporary file"),
          {
            code: "EEXIST",
            errno: 17,
          }
        )
      );
    };

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "read_bytes",
      handler: async ({ tail }, path) => {
        try {
          const resolvedPath = toPath(path);
          const bytes = hasNodeFs
            ? await nodeFs!.readFile(resolvedPath)
            : await denoReadFile!(resolvedPath);
          if (bytes.byteLength > effectBufferSize) {
            return tail(
              fsHostError(
                new Error(
                  `Default fs adapter read_bytes response exceeds effect transport buffer (${effectBufferSize} bytes). Increase createVoydHost({ bufferSize }) or read a smaller payload.`
                ),
                new Uint8Array(),
              )
            );
          }
          return tail(fsSuccess(Uint8Array.from(bytes)));
        } catch (error) {
          return tail(fsHostError(error, new Uint8Array()));
        }
      },
    });
    implementedOps.add("read_bytes");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "read_string",
      handler: async ({ tail }, path) => {
        try {
          const resolvedPath = toPath(path);
          const value = hasNodeFs
            ? new TextDecoder().decode(await nodeFs!.readFile(resolvedPath))
            : await denoReadTextFile!(resolvedPath);
          if (new TextEncoder().encode(value).byteLength > effectBufferSize) {
            return tail(
              fsHostError(
                new Error(
                  `Default fs adapter read_string response exceeds effect transport buffer (${effectBufferSize} bytes). Increase createVoydHost({ bufferSize }) or read a smaller payload.`
                ),
                "",
              ),
            );
          }
          return tail(fsSuccess(value));
        } catch (error) {
          return tail(fsHostError(error, ""));
        }
      },
    });
    implementedOps.add("read_string");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "write_bytes",
      handler: async ({ tail }, payload) => {
        try {
          const pathValue = toPath(readField(payload, "path"));
          const bytes = bytesFromPayload(payload);
          if (hasNodeFs) {
            await nodeFs!.writeFile(pathValue, bytes);
          } else {
            await denoWriteFile!(pathValue, bytes);
          }
          return tail(fsSuccess(UNIT_VALUE));
        } catch (error) {
          return tail(fsHostError(error, UNIT_VALUE));
        }
      },
    });
    implementedOps.add("write_bytes");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "write_string",
      handler: async ({ tail }, payload) => {
        try {
          const pathValue = toPath(readField(payload, "path"));
          const value = toStringOrUndefined(readField(payload, "value")) ?? "";
          if (hasNodeFs) {
            await nodeFs!.writeFile(pathValue, value);
          } else {
            await denoWriteTextFile!(pathValue, value);
          }
          return tail(fsSuccess(UNIT_VALUE));
        } catch (error) {
          return tail(fsHostError(error, UNIT_VALUE));
        }
      },
    });
    implementedOps.add("write_string");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "exists",
      handler: async ({ tail }, path) => {
        try {
          const resolvedPath = toPath(path);
          if (hasNodeFs) {
            await nodeFs!.access(resolvedPath);
          } else {
            await denoStat!(resolvedPath);
          }
          return tail(true);
        } catch {
          return tail(false);
        }
      },
    });
    implementedOps.add("exists");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "remove",
      handler: async ({ tail }, path) => {
        try {
          const resolvedPath = toPath(path);
          if (hasNodeFs) {
            const metadata = await nodeFs!.lstat(resolvedPath);
            if (metadata.isDirectory()) {
              await nodeFs!.rmdir(resolvedPath);
            } else {
              await nodeFs!.unlink(resolvedPath);
            }
          } else {
            await denoRemove!(resolvedPath);
          }
          return tail(fsSuccess(UNIT_VALUE));
        } catch (error) {
          return tail(fsHostError(error, UNIT_VALUE));
        }
      },
    });
    implementedOps.add("remove");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "list_dir",
      handler: async ({ tail }, path) => {
        try {
          const resolvedPath = toPath(path);
          let names: string[];
          if (hasNodeFs) {
            names = await nodeFs!.readdir(resolvedPath);
          } else {
            names = [];
            for await (const entry of denoReadDir!(resolvedPath)) {
              names.push(entry.name);
            }
          }
          const value = names.map((name) =>
            joinListDirChildPath({
              directoryPath: resolvedPath,
              childName: name,
            }),
          );
          const encodedBytes = value.reduce(
            (total, child) => total + new TextEncoder().encode(child).byteLength,
            0,
          );
          if (encodedBytes > effectBufferSize) {
            return tail(
              fsHostError(
                new Error(
                  `Default fs adapter list_dir response exceeds effect transport buffer (${effectBufferSize} bytes). Increase createVoydHost({ bufferSize }) or list a smaller directory.`,
                ),
                [],
              ),
            );
          }
          return tail(fsSuccess(value));
        } catch (error) {
          return tail(fsHostError(error, []));
        }
      },
    });
    implementedOps.add("list_dir");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "create_dir_all",
      handler: async ({ tail }, path) => {
        try {
          const resolvedPath = toPath(path);
          if (hasNodeFs) {
            await nodeFs!.mkdir(resolvedPath, { recursive: true });
          } else {
            await denoMkdir!(resolvedPath, { recursive: true });
          }
          return tail(fsSuccess(UNIT_VALUE));
        } catch (error) {
          return tail(fsHostError(error, UNIT_VALUE));
        }
      },
    });
    implementedOps.add("create_dir_all");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "rename",
      handler: async ({ tail }, payload) => {
        try {
          const fromPath = toPath(readField(payload, "from"));
          const toPathValue = toPath(readField(payload, "to"));
          if (hasNodeFs) {
            await nodeFs!.rename(fromPath, toPathValue);
          } else {
            await denoRename!(fromPath, toPathValue);
          }
          return tail(fsSuccess(UNIT_VALUE));
        } catch (error) {
          return tail(fsHostError(error, UNIT_VALUE));
        }
      },
    });
    implementedOps.add("rename");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "write_atomic",
      handler: async ({ tail }, payload) => {
        try {
          const destination = toPath(readField(payload, "path"));
          await writeAtomic(destination, writeContentFromPayload(payload));
          return tail(fsSuccess(UNIT_VALUE));
        } catch (error) {
          return tail(fsHostError(error, UNIT_VALUE));
        }
      },
    });
    implementedOps.add("write_atomic");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "create_exclusive",
      handler: async ({ tail }, payload) => {
        try {
          const destination = toPath(readField(payload, "path"));
          await writeExclusive(destination, writeContentFromPayload(payload));
          return tail(fsSuccess(UNIT_VALUE));
        } catch (error) {
          return tail(fsHostError(error, UNIT_VALUE));
        }
      },
    });
    implementedOps.add("create_exclusive");

    return (
      registered +
      registerMissingOpHandlers({
        host,
        effectId: FS_EFFECT_ID,
        implementedOps,
        diagnostics,
      })
    );
  },
};
