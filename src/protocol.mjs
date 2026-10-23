export class RelationshipStoreError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = cause?.name || "RelationshipStoreError";
    this.code = code;
  }
}

const record = (value) =>
  Object.prototype.toString.call(value) === "[object Object]";
export const identifier = (value) =>
  typeof value === "string" && value.length > 0;
export const direction = (value) => ["friends", "rev_friends"].includes(value);
const timestamp = (value) =>
  Number.isFinite(value) && value >= 0 && value <= 8640000000000000;
const fields = (value, allowed) =>
  record(value) && Object.keys(value).every((key) => allowed.includes(key));
const missingIssue = (issue) =>
  fields(issue, ["code", "count"]) &&
  issue.code === "missing-identifiers" &&
  Number.isSafeInteger(issue.count) &&
  issue.count > 0;
const unavailableIssue = (issue) =>
  fields(issue, ["code"]) &&
  issue.code === "deleted-display-name-page-unavailable";

function arrayOf(value, accepts) {
  if (!Array.isArray(value)) return false;
  // Iteration visits empty slots as undefined; Array#every skips them.
  for (const item of value) if (!accepts(item)) return false;
  return true;
}

export function snapshot(value) {
  if (
    !fields(value, ["status", "members", "fetchedAt", "issue"]) ||
    !timestamp(value.fetchedAt)
  )
    return false;
  if (value.status === "available")
    return (
      arrayOf(value.members, identifier) &&
      (value.issue === undefined || missingIssue(value.issue))
    );
  return (
    value.status === "unavailable" &&
    value.members === undefined &&
    unavailableIssue(value.issue)
  );
}

function avatar(value) {
  if (value === "") return true;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

export function user(value) {
  return (
    fields(value, ["name", "avatar", "fetchedAt"]) &&
    typeof value.name === "string" &&
    typeof value.avatar === "string" &&
    avatar(value.avatar) &&
    timestamp(value.fetchedAt)
  );
}

export function storedValue(entry, name) {
  if (!record(entry) || !Number.isSafeInteger(entry.version))
    throw new RelationshipStoreError(
      "corrupt-data",
      "Damaged relationship store record",
    );
  if (entry.version !== 1)
    throw new RelationshipStoreError(
      "incompatible-version",
      "Unsupported relationship record version",
    );
  if (
    !fields(entry, ["version", "value"]) ||
    !(name === "relationships" ? snapshot(entry.value) : user(entry.value))
  )
    throw new RelationshipStoreError(
      "corrupt-data",
      "Damaged relationship store record",
    );
  return entry.value;
}

function requireInput(condition) {
  if (!condition)
    throw new RelationshipStoreError(
      "invalid-input",
      "Invalid relationship store input",
    );
}

export function queryEntries(query) {
  requireInput(fields(query, ["relationships", "users"]));
  const { relationships = [], users = [] } = query;
  requireInput(
    arrayOf(
      relationships,
      (key) =>
        Array.isArray(key) &&
        key.length === 2 &&
        identifier(key[0]) &&
        direction(key[1]),
    ) && arrayOf(users, identifier),
  );
  return [
    ...relationships.map(([id, kind]) => ({
      name: "relationships",
      key: [id, kind],
    })),
    ...users.map((id) => ({ name: "users", key: id })),
  ];
}

export function batchEntries(batch) {
  requireInput(fields(batch, ["relationships", "users"]));
  const { relationships = {}, users = {} } = batch;
  requireInput(record(relationships) && record(users));
  const entries = [];
  for (const [id, directions] of Object.entries(relationships)) {
    requireInput(identifier(id) && record(directions));
    for (const [kind, value] of Object.entries(directions)) {
      requireInput(direction(kind) && snapshot(value));
      entries.push({
        name: "relationships",
        key: [id, kind],
        value: {
          ...value,
          ...(value.members ? { members: [...new Set(value.members)] } : {}),
          ...(value.issue ? { issue: { ...value.issue } } : {}),
        },
      });
    }
  }
  for (const [id, value] of Object.entries(users)) {
    requireInput(identifier(id) && user(value));
    entries.push({ name: "users", key: id, value: { ...value } });
  }
  return entries;
}
