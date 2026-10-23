// Fault injection is confined to the browser database boundary.
export function intercept(indexedDB, callback) {
  return {
    open(...args) {
      const opening = indexedDB.open(...args);
      opening.addEventListener("success", () => {
        const database = opening.result;
        const transaction = database.transaction.bind(database);
        database.transaction = (...args) => {
          const result = transaction(...args);
          callback(result, args[1]);
          return result;
        };
      });
      return opening;
    },
  };
}

// Seed an external producer's damaged/newer on-disk protocol, then observe
// consumer behavior only through the public store interface.
export async function seed(
  indexedDB,
  {
    version = 1,
    store = "relationships",
    key = ["alice", "friends"],
    value,
  } = {},
) {
  await new Promise((resolve, reject) => {
    const opening = indexedDB.open("bangumi-relationship-store", version);
    opening.onupgradeneeded = () => {
      for (const name of ["relationships", "users"])
        if (!opening.result.objectStoreNames.contains(name))
          opening.result.createObjectStore(name);
    };
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      const transaction = database.transaction(store, "readwrite");
      transaction.objectStore(store).put(value, key);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error);
      };
    };
  });
}
