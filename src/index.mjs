import {
  batchEntries,
  queryEntries,
  storedValue,
  RelationshipStoreError,
} from "./protocol.mjs";
export { RelationshipStoreError } from "./protocol.mjs";

const databaseName = "bangumi-relationship-store";
const stores = ["relationships", "users"];
const dictionary = () => Object.create(null);

function storageError(error) {
  if (error instanceof RelationshipStoreError) return error;
  const code =
    error?.name === "VersionError"
      ? "incompatible-version"
      : error?.name === "QuotaExceededError"
        ? "quota-exceeded"
        : ["SecurityError", "InvalidStateError", "NotAllowedError"].includes(
              error?.name,
            )
          ? "unavailable"
          : "storage-error";
  return new RelationshipStoreError(
    code,
    error?.message || "Relationship storage failed",
    error,
  );
}

function transact(indexedDB, mode, operation, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let opening;
    let abandoned = false;
    const openingAbort = () => {
      abandoned = true;
      signal?.removeEventListener("abort", openingAbort);
      reject(signal.reason);
    };
    const rejectOpening = (error) => {
      abandoned = true;
      signal?.removeEventListener("abort", openingAbort);
      reject(storageError(error));
    };
    try {
      if (typeof indexedDB?.open !== "function")
        throw new RelationshipStoreError(
          "unavailable",
          "IndexedDB is unavailable",
        );
      opening = indexedDB.open(databaseName, 1);
    } catch (error) {
      rejectOpening(error);
      return;
    }
    signal?.addEventListener("abort", openingAbort, { once: true });
    opening.onupgradeneeded = (event) => {
      if (abandoned || signal?.aborted || event.oldVersion !== 0) {
        opening.transaction.abort();
        return;
      }
      for (const name of stores) opening.result.createObjectStore(name);
    };
    opening.onblocked = () =>
      rejectOpening(
        new RelationshipStoreError(
          "blocked",
          "Database upgrade is blocked by another connection",
        ),
      );
    opening.onerror = () => rejectOpening(opening.error);
    opening.onsuccess = () => {
      signal?.removeEventListener("abort", openingAbort);
      const database = opening.result;
      database.onversionchange = () => database.close();
      if (abandoned || signal?.aborted) {
        database.close();
        if (signal?.aborted) reject(signal.reason);
        return;
      }
      let transaction;
      try {
        if (stores.some((name) => !database.objectStoreNames.contains(name)))
          throw new RelationshipStoreError(
            "corrupt-data",
            "Missing relationship object store",
          );
        transaction = database.transaction(stores, mode);
      } catch (error) {
        database.close();
        reject(storageError(error));
        return;
      }
      let result;
      let failure;
      let aborting = false;
      const fail = (error) => {
        if (aborting) return;
        aborting = true;
        failure = error;
        transaction.abort();
      };
      const abort = () => fail(signal.reason);
      const close = () => {
        signal?.removeEventListener("abort", abort);
        database.close();
      };
      transaction.oncomplete = () => {
        close();
        resolve(result);
      };
      transaction.onabort = () => {
        close();
        reject(
          signal?.aborted
            ? signal.reason
            : storageError(failure ?? transaction.error),
        );
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        signal?.throwIfAborted();
        for (const name of stores) {
          const store = transaction.objectStore(name);
          if (
            store.keyPath !== null ||
            store.autoIncrement ||
            store.indexNames.length
          )
            throw new RelationshipStoreError(
              "corrupt-data",
              "Unexpected relationship object store layout",
            );
        }
        result = operation(transaction, fail);
      } catch (error) {
        fail(error);
      }
    };
  });
}

/**
 * @typedef {"friends" | "rev_friends"} Direction
 * @typedef {{code: "missing-identifiers", count: number}} MissingIdentifiers
 * @typedef {{status: "available", members: string[], fetchedAt: number, issue?: MissingIdentifiers} |
 *   {status: "unavailable", fetchedAt: number, issue: {code: "deleted-display-name-page-unavailable"}}} Snapshot
 * @typedef {{name: string, avatar: string, fetchedAt: number}} User
 * @typedef {{relationships?: [string, Direction][], users?: string[]}} Query
 * @typedef {{relationships?: Record<string, Partial<Record<Direction, Snapshot>>>, users?: Record<string, User>}} Batch
 * @typedef {{relationships: Record<string, Partial<Record<Direction, Snapshot>>>, users: Record<string, User>}} ReadResult
 * @typedef {{signal?: AbortSignal}} Options
 */

/**
 * Create a same-origin store. Each call opens and closes its own connection.
 * @param {{indexedDB?: IDBFactory}} dependencies
 */
export function createRelationshipStore({ indexedDB }) {
  return {
    /**
     * Read only requested keys in one transaction; absent keys are omitted.
     * @param {Query} query
     * @param {Options} [options]
     * @returns {Promise<ReadResult>}
     */
    async read(query, { signal } = {}) {
      const entries = queryEntries(query);
      return transact(
        indexedDB,
        "readonly",
        (transaction, fail) => {
          const result = { relationships: dictionary(), users: dictionary() };
          for (const { name, key } of entries) {
            const request = transaction.objectStore(name).get(key);
            request.onsuccess = () => {
              try {
                const value = storedValue(request.result, name);
                if (value === undefined) return;
                if (name === "relationships") {
                  const [id, direction] = key;
                  result.relationships[id] ??= dictionary();
                  result.relationships[id][direction] = value;
                } else result.users[key] = value;
              } catch (error) {
                fail(error);
              }
            };
          }
          return result;
        },
        signal,
      );
    },
    /**
     * Validate and detach input, then atomically merge by observation time.
     * Resolve only on transaction completion; reject with the signal reason
     * on cancellation, otherwise a RelationshipStoreError with a stable code.
     * @param {Batch} batch
     * @param {Options} [options]
     * @returns {Promise<void>}
     */
    async commit(batch, { signal } = {}) {
      const entries = batchEntries(batch);
      return transact(
        indexedDB,
        "readwrite",
        (transaction, fail) => {
          const merge = (name, key, value) => {
            const store = transaction.objectStore(name);
            const request = store.get(key);
            request.onsuccess = () => {
              try {
                const previous = storedValue(request.result, name);
                if (!previous || value.fetchedAt >= previous.fetchedAt)
                  store.put({ version: 1, value }, key);
              } catch (error) {
                fail(error);
              }
            };
          };
          for (const { name, key, value } of entries) merge(name, key, value);
        },
        signal,
      );
    },
  };
}
