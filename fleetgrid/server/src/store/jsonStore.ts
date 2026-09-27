import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Minimal interface every business service depends on.
 *
 * IMPORTANT: services must never import `node:fs`. Swapping this interface for a
 * PostgreSQL adapter (one method set, same signatures) is the only change required
 * to move off JSON files.
 */
export interface Store<T extends { id: string }> {
  /** Every record, in insertion order. */
  get(): Promise<T[]>;
  /** All records matching a predicate. */
  find(predicate: (row: T) => boolean): Promise<T[]>;
  /** One record by primary key, or undefined. */
  findById(id: string): Promise<T | undefined>;
  /** Insert a record. */
  create(row: T): Promise<T>;
  /** Shallow-merge a patch into an existing record. Returns undefined if not found. */
  update(id: string, patch: Partial<Omit<T, 'id'>>): Promise<T | undefined>;
  /** Remove a record. Returns true when a record was removed. */
  delete(id: string): Promise<boolean>;
  /** Remove every record (used by demo reset). */
  clear(): Promise<void>;
  /** Replace the whole collection (used by demo seed/reset). */
  replaceAll(rows: T[]): Promise<T[]>;
}

export interface JsonStoreOptions {
  /** Absolute path of the .json file backing this collection. */
  filePath: string;
  /** In-memory cache keeps reads synchronous-fast; writes are flushed through. */
  name: string;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * JSON-file-backed collection store with an in-memory write-through cache.
 *
 * Design notes:
 * - Reads are served from memory (fast) and hydrated once at boot.
 * - Mutations are serialised per collection through `mutationChain`, so the
 *   read-modify-write cycle in create/update/delete cannot interleave. Serialising only
 *   the file write is not enough: five parallel creates would each read the same base
 *   array and the last one would win, silently dropping the other four rows.
 * - Files are written to a temp path then renamed, so a crash mid-write cannot
 *   leave a truncated JSON file behind.
 */
export function createJsonStore<T extends { id: string }>(options: JsonStoreOptions): Store<T> {
  const { filePath, name } = options;
  let cache: T[] | null = null;
  let writeChain: Promise<unknown> = Promise.resolve();
  let mutationChain: Promise<unknown> = Promise.resolve();

  /**
   * Run a read-modify-write cycle with exclusive access to the collection.
   *
   * `load()` inside the callback always sees the result of the previous mutation, which
   * is what makes concurrent `Promise.all` writes accumulate instead of clobbering.
   */
  function enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const run = mutationChain.then(fn, fn);
    // Keep the chain alive even if this mutation throws, so one failure cannot wedge
    // every later write to this collection.
    mutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function load(): Promise<T[]> {
    if (cache) return cache;
    if (!existsSync(filePath)) {
      cache = [];
      return cache;
    }
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed: unknown = raw.trim().length === 0 ? [] : JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error(`Expected ${filePath} to contain a JSON array`);
      }
      cache = parsed as T[];
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        cache = [];
      } else {
        // Corrupt file: keep a .corrupt copy and start clean rather than crash-looping the demo.
        const backup = `${filePath}.corrupt`;
        console.error(
          `[store:${name}] could not read ${filePath}: ${(err as Error).message}. Backing up to ${backup} and starting empty.`,
        );
        try {
          await rename(filePath, backup);
        } catch {
          /* best effort */
        }
        cache = [];
      }
    }
    return cache;
  }

  async function flush(next: T[]): Promise<void> {
    const serialised = `${JSON.stringify(next, null, 2)}\n`;
    writeChain = writeChain.then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      await writeFile(tmp, serialised, 'utf8');
      await rename(tmp, filePath);
    });
    await writeChain;
  }

  return {
    async get() {
      return [...(await load())];
    },
    async find(predicate) {
      return (await load()).filter(predicate);
    },
    async findById(id) {
      return (await load()).find((row) => row.id === id);
    },
    async create(row) {
      return enqueue(async () => {
        const rows = await load();
        if (rows.some((r) => r.id === row.id)) {
          throw new Error(`[store:${name}] duplicate id ${row.id}`);
        }
        const next = [...rows, row];
        cache = next;
        await flush(next);
        return row;
      });
    },
    async update(id, patch) {
      return enqueue(async () => {
        const rows = await load();
        const index = rows.findIndex((row) => row.id === id);
        if (index === -1) return undefined;
        const current = rows[index] as T;
        const updated = { ...current, ...patch, id: current.id } as T;
        const next = [...rows];
        next[index] = updated;
        cache = next;
        await flush(next);
        return updated;
      });
    },
    async delete(id) {
      return enqueue(async () => {
        const rows = await load();
        const next = rows.filter((row) => row.id !== id);
        if (next.length === rows.length) return false;
        cache = next;
        await flush(next);
        return true;
      });
    },
    async clear() {
      return enqueue(async () => {
        cache = [];
        await flush(cache);
      });
    },
    async replaceAll(rows) {
      return enqueue(async () => {
        cache = [...rows];
        await flush(cache);
        return [...cache];
      });
    },
  };
}

/** Absolute path helper so every collection lands in one directory. */
export function dataFile(dataDir: string, fileName: string): string {
  return join(dataDir, fileName);
}
