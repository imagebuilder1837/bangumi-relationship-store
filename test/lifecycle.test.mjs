import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { createRelationshipStore } from "../src/index.mjs";
import { intercept } from "./support/storage.mjs";

const query = { relationships: [["alice", "friends"]] };

function delayedOpen(indexedDB) {
  let release;
  let ready;
  const waiting = new Promise((resolve) => {
    ready = resolve;
  });
  return {
    waiting,
    release: () => release(),
    indexedDB: {
      open(...args) {
        const request = indexedDB.open(...args);
        return new Proxy(request, {
          get(target, key) {
            return Reflect.get(target, key, target);
          },
          set(target, key, callback) {
            target[key] =
              key === "onsuccess"
                ? (event) => {
                    release = () => callback.call(target, event);
                    ready();
                  }
                : callback;
            return true;
          },
        });
      },
    },
  };
}

test("an existing incompatible store layout is reported as damaged rather than silently reused", async () => {
  const indexedDB = new IDBFactory();
  await new Promise((resolve) => {
    const request = indexedDB.open("bangumi-relationship-store", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("relationships", { keyPath: "id" });
      request.result.createObjectStore("users");
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
  const store = createRelationshipStore({ indexedDB });
  await assert.rejects(store.read(query), { code: "corrupt-data" });
  await assert.rejects(store.commit({}), { code: "corrupt-data" });
});

async function upgrade(indexedDB) {
  await new Promise((resolve, reject) => {
    const request = indexedDB.open("bangumi-relationship-store", 2);
    request.onblocked = () => reject(new Error("consumer leaked a connection"));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
}

test("cancelling while opening rejects promptly and closes the eventual connection", async () => {
  const indexedDB = new IDBFactory();
  const gate = delayedOpen(indexedDB);
  const controller = new AbortController();
  const pending = createRelationshipStore({ indexedDB: gate.indexedDB }).read(
    query,
    { signal: controller.signal },
  );
  const rejection = assert.rejects(pending, { name: "AbortError" });
  await gate.waiting;
  controller.abort();
  await rejection;
  gate.release();
  await upgrade(indexedDB);
});

test("a blocked opening reports its category and abandons the connection when it eventually opens", async () => {
  const indexedDB = new IDBFactory();
  await createRelationshipStore({ indexedDB }).read(query);
  const gate = delayedOpen(indexedDB);
  const proxy = {
    open(...args) {
      const request = gate.indexedDB.open(...args);
      queueMicrotask(() => request.onblocked());
      return request;
    },
  };
  await assert.rejects(
    createRelationshipStore({ indexedDB: proxy }).read(query),
    { code: "blocked" },
  );
  await gate.waiting;
  gate.release();
  await upgrade(indexedDB);
});

test("cancelling a pending readonly transaction rejects instead of returning a partial batch", async () => {
  const indexedDB = new IDBFactory();
  const controller = new AbortController();
  const proxy = intercept(indexedDB, (transaction, mode) => {
    if (mode !== "readonly") return;
    const getStore = transaction.objectStore.bind(transaction);
    transaction.objectStore = (...args) => {
      const store = getStore(...args);
      const get = store.get.bind(store);
      store.get = (...args) => {
        const request = get(...args);
        queueMicrotask(() => controller.abort());
        return request;
      };
      return store;
    };
  });
  await assert.rejects(
    createRelationshipStore({ indexedDB: proxy }).read(query, {
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  await upgrade(indexedDB);
});
