import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { createRelationshipStore } from "../src/index.mjs";
import { seed, intercept } from "./support/storage.mjs";

const available = (members, fetchedAt = 1, issue) => ({
  status: "available",
  members,
  fetchedAt,
  ...(issue ? { issue } : {}),
});
const batch = (snapshot) => ({
  relationships: { alice: { friends: snapshot } },
  users: { alice: { name: "Alice", avatar: "", fetchedAt: 1 } },
});
const query = {
  relationships: [
    ["alice", "friends"],
    ["alice", "rev_friends"],
  ],
  users: ["alice", "unknown"],
};

test("independent consumers share observations, distinguish unknown from empty, and cannot mutate stored results", async () => {
  const indexedDB = new IDBFactory();
  const writer = createRelationshipStore({ indexedDB });
  await writer.commit(batch(available([])));
  const reader = createRelationshipStore({ indexedDB });
  const first = await reader.read(query);
  assert.deepEqual(first.relationships.alice.friends, available([]));
  assert.equal(first.relationships.alice.rev_friends, undefined);
  assert.equal(first.users.alice.name, "Alice");
  assert.equal(first.users.unknown, undefined);
  first.relationships.alice.friends.members.push("changed");
  first.users.alice.name = "Changed";
  const second = await reader.read(query);
  assert.deepEqual(second.relationships.alice.friends.members, []);
  assert.equal(second.users.alice.name, "Alice");
});

test("only protocol observations are accepted and an invalid batch changes nothing", async () => {
  const store = createRelationshipStore({ indexedDB: new IDBFactory() });
  await store.commit(batch(available(["old"])));
  for (const invalid of [
    available(["bad"], -1),
    { status: "available", fetchedAt: 2 },
    available([], 2, { code: "missing-identifiers", count: 0 }),
    {
      status: "unavailable",
      fetchedAt: 2,
      members: [],
      issue: { code: "deleted-display-name-page-unavailable" },
    },
    { status: "unavailable", fetchedAt: 2, issue: { code: "network-error" } },
    { ...available([], 2), surprise: true },
  ]) {
    await assert.rejects(
      store.commit({
        relationships: {
          alice: { friends: available(["new"], 3), rev_friends: invalid },
        },
      }),
      { code: "invalid-input" },
    );
    assert.deepEqual(
      (await store.read(query)).relationships.alice.friends.members,
      ["old"],
    );
  }
  await assert.rejects(
    store.commit({ relationships: { alice: { followers: available([]) } } }),
    { code: "invalid-input" },
  );
  await assert.rejects(
    store.read({ relationships: [["alice", "followers"]] }),
    { code: "invalid-input" },
  );
});

test("damaged and newer records cannot be mistaken for unknown or overwritten", async () => {
  for (const [value, code] of [
    [
      { version: 1, value: { status: "available", fetchedAt: 1 } },
      "corrupt-data",
    ],
    [{ version: 2, value: available([]) }, "incompatible-version"],
  ]) {
    const indexedDB = new IDBFactory();
    await seed(indexedDB, { value });
    const store = createRelationshipStore({ indexedDB });
    await assert.rejects(store.read(query), { code });
    await assert.rejects(store.commit(batch(available(["replacement"], 2))), {
      code,
    });
    await store.commit({ relationships: { bob: { friends: available([]) } } });
    assert.deepEqual(
      (await store.read({ relationships: [["bob", "friends"]] })).relationships
        .bob.friends.members,
      [],
    );
    await assert.rejects(store.read(query), { code });
  }
});

test("a newer database and unavailable storage report stable errors without reinitializing data", async () => {
  const indexedDB = new IDBFactory();
  await seed(indexedDB, {
    version: 2,
    value: { version: 2, value: available(["future"]) },
  });
  const store = createRelationshipStore({ indexedDB });
  await assert.rejects(store.read(query), { code: "incompatible-version" });
  await assert.rejects(store.commit(batch(available([]))), {
    code: "incompatible-version",
  });
  await assert.rejects(createRelationshipStore({}).read(query), {
    code: "unavailable",
  });
  const denied = {
    open() {
      throw new DOMException("denied", "SecurityError");
    },
  };
  await assert.rejects(
    createRelationshipStore({ indexedDB: denied }).commit(batch(available([]))),
    { code: "unavailable" },
  );
});

test("write failures and cancellation roll back the entire batch after writes were queued", async () => {
  for (const cancellation of [false, true]) {
    const indexedDB = new IDBFactory();
    const store = createRelationshipStore({ indexedDB });
    await store.commit(batch(available(["old"])));
    const controller = new AbortController();
    const faulty = createRelationshipStore({
      indexedDB: intercept(indexedDB, (transaction, mode) => {
        if (mode !== "readwrite") return;
        const objectStore = transaction.objectStore.bind(transaction);
        transaction.objectStore = (...args) => {
          const target = objectStore(...args);
          const put = target.put.bind(target);
          target.put = (...args) => {
            put(...args);
            if (cancellation) controller.abort();
            else throw new DOMException("full", "QuotaExceededError");
          };
          return target;
        };
      }),
    });
    await assert.rejects(
      faulty.commit(
        {
          relationships: {
            alice: { friends: available(["new"], 2) },
            bob: { friends: available([]) },
          },
          users: { alice: { name: "Changed", avatar: "", fetchedAt: 2 } },
        },
        { signal: controller.signal },
      ),
      cancellation ? { name: "AbortError" } : { code: "quota-exceeded" },
    );
    const result = await store.read({
      relationships: [...query.relationships, ["bob", "friends"]],
      users: ["alice"],
    });
    assert.deepEqual(result.relationships.alice.friends.members, ["old"]);
    assert.equal(result.relationships.bob, undefined);
    assert.equal(result.users.alice.name, "Alice");
  }
});

test("an already cancelled operation neither reads nor commits", async () => {
  const store = createRelationshipStore({ indexedDB: new IDBFactory() });
  const controller = new AbortController();
  controller.abort(new Error("cancelled by caller"));
  await assert.rejects(
    store.read(query, { signal: controller.signal }),
    /cancelled by caller/,
  );
  await assert.rejects(
    store.commit(batch(available([])), { signal: controller.signal }),
    /cancelled by caller/,
  );
  assert.equal((await store.read(query)).relationships.alice, undefined);
});

test("problem observations retain known members and replace earlier states without inventing reverse lists", async () => {
  const store = createRelationshipStore({ indexedDB: new IDBFactory() });
  const partial = available(["bob", "bob"], 2, {
    code: "missing-identifiers",
    count: 3,
  });
  await store.commit(batch(partial));
  let result = await store.read(query);
  assert.deepEqual(
    result.relationships.alice.friends,
    available(["bob"], 2, { code: "missing-identifiers", count: 3 }),
  );
  assert.equal(
    (await store.read({ relationships: [["bob", "rev_friends"]] }))
      .relationships.bob,
    undefined,
  );
  const unavailable = {
    status: "unavailable",
    fetchedAt: 3,
    issue: { code: "deleted-display-name-page-unavailable" },
  };
  await store.commit(batch(unavailable));
  assert.deepEqual(
    (await store.read(query)).relationships.alice.friends,
    unavailable,
  );
  await store.commit(batch(available([], 4)));
  assert.deepEqual(
    (await store.read(query)).relationships.alice.friends,
    available([], 4),
  );
});

test("invalid profiles and query shapes reject before any valid observations are committed", async () => {
  const store = createRelationshipStore({ indexedDB: new IDBFactory() });
  for (const invalid of [
    null,
    { relationships: [] },
    { relationships: new Map() },
    { users: { alice: { name: "A", avatar: "https://", fetchedAt: 1 } } },
    { users: [] },
    { users: { alice: { name: "A", avatar: "javascript:bad", fetchedAt: 1 } } },
    { users: { alice: { name: "A", avatar: "", fetchedAt: Infinity } } },
  ]) {
    await assert.rejects(store.commit(invalid), { code: "invalid-input" });
  }
  for (const invalid of [
    null,
    { relationships: "alice" },
    { relationships: [["alice"]] },
    { users: [""] },
    { extra: true },
  ])
    await assert.rejects(store.read(invalid), { code: "invalid-input" });
  await store.commit({});
  assert.equal((await store.read(query)).relationships.alice, undefined);
});

test("property-like usernames and duplicate members remain safe across consumers", async () => {
  const store = createRelationshipStore({ indexedDB: new IDBFactory() });
  await store.commit({
    relationships: JSON.parse(
      '{"__proto__":{"friends":{"status":"available","members":["constructor","constructor"],"fetchedAt":1}}}',
    ),
    users: { constructor: { name: "Constructor", avatar: "", fetchedAt: 1 } },
  });
  const result = await store.read({
    relationships: [["__proto__", "friends"]],
    users: ["constructor"],
  });
  assert.deepEqual(result.relationships.__proto__.friends.members, [
    "constructor",
  ]);
  assert.equal(result.users.constructor.name, "Constructor");
});

test("profile observation time is independent and queued input is detached from caller mutation", async () => {
  const indexedDB = new IDBFactory();
  const store = createRelationshipStore({ indexedDB });
  await store.commit({
    users: { alice: { name: "Fresh", avatar: "", fetchedAt: 5 } },
  });
  const input = batch(available(["bob"], 2));
  const pending = store.commit(input);
  input.relationships.alice.friends.members.push("mutated");
  input.users.alice.name = "Mutated";
  await pending;
  const result = await store.read(query);
  assert.deepEqual(result.relationships.alice.friends.members, ["bob"]);
  assert.equal(result.users.alice.name, "Fresh");
});

test("concurrent batches merge independent directions and replace rather than union by observation time", async () => {
  const indexedDB = new IDBFactory();
  const first = createRelationshipStore({ indexedDB });
  const second = createRelationshipStore({ indexedDB });
  await Promise.all([
    first.commit(batch(available(["bob", "carol"], 3))),
    second.commit({
      relationships: { alice: { rev_friends: available(["dana"], 2) } },
    }),
  ]);
  await second.commit(batch(available(["stale"], 1)));
  assert.deepEqual(
    (await first.read(query)).relationships.alice.friends.members,
    ["bob", "carol"],
  );
  await second.commit(batch(available(["bob"], 3)));
  const result = await first.read(query);
  assert.deepEqual(result.relationships.alice.friends.members, ["bob"]);
  assert.deepEqual(result.relationships.alice.rev_friends.members, ["dana"]);
});
