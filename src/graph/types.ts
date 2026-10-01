import type { EdgeType, GroupKind } from "./rules";

/** Plain JSON as the API server sends it. Read through the helpers below, never trusted. */
export type Json = unknown;

export interface OwnerReference {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly uid?: string;
  readonly controller?: boolean;
}

export interface KubeObjectMetadata {
  readonly name: string;
  readonly namespace?: string;
  readonly uid: string;
  readonly resourceVersion?: string;
  readonly creationTimestamp?: string;
  readonly deletionTimestamp?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly annotations?: Readonly<Record<string, string>>;
  readonly ownerReferences?: readonly OwnerReference[];
}

/** The shape every served resource has; everything below `metadata` is read defensively. */
export interface KubeObject {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: KubeObjectMetadata;
  readonly [field: string]: Json;
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

/** "apps/Deployment", "/Pod" for the core group. */
export type GroupKindKey = string;
/** "apps/Deployment/shop/web", "/PersistentVolume//pv-1" for a cluster-scoped kind. */
export type ObjectKey = string;

export const groupKindKey = ({ group, kind }: GroupKind): GroupKindKey => `${group}/${kind}`;

export const objectKey = (gk: GroupKind, namespace: string, name: string): ObjectKey =>
  `${gk.group}/${gk.kind}/${namespace}/${name}`;

export const parseObjectKey = (key: ObjectKey) => {
  const [group = "", kind = "", namespace = "", ...rest] = key.split("/");

  return { gk: { group, kind }, namespace, name: rest.join("/") };
};

export const groupOfApiVersion = (apiVersion: string | undefined): string => {
  if (!apiVersion) {
    return "";
  }

  const slash = apiVersion.indexOf("/");

  return slash === -1 ? "" : apiVersion.slice(0, slash);
};

export const sameGroupKind = (a: GroupKind, b: GroupKind) => a.group === b.group && a.kind === b.kind;

export const matchesGroupKind = (pattern: GroupKind, gk: GroupKind) =>
  (pattern.group === "*" || pattern.group === gk.group) && (pattern.kind === "*" || pattern.kind === gk.kind);

export const groupKindOf = (object: KubeObject): GroupKind => ({
  group: groupOfApiVersion(object.apiVersion),
  kind: object.kind,
});

// ---------------------------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------------------------

/**
 * - resolved: the target exists.
 * - missing: the target's kind is listed and the object is not there — a broken reference.
 * - unknown: the target's kind cannot be listed (RBAC, not served) or is not tracked at all.
 * - pending: the target's kind is still loading; not drawn yet.
 */
export type EdgeState = "resolved" | "missing" | "unknown" | "pending";

export interface Edge {
  /** `${ruleId}|${from}|${to}|${path}`: stable, and unique per concrete reference. */
  readonly id: string;
  readonly ruleId: string;
  readonly type: EdgeType;
  readonly from: ObjectKey;
  readonly to: ObjectKey;
  readonly toGroupKind: GroupKind;
  /** The concrete field the reference was found in, e.g. `spec.template.spec.volumes[2].secret.secretName`. */
  readonly path: string;
  /** Edges from selector rules are maintained from both ends. */
  readonly bySelector: boolean;
}

// ---------------------------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------------------------

export const isRecord = (value: Json): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asRecord = (value: Json): Record<string, Json> => (isRecord(value) ? value : {});

export const asArray = (value: Json): readonly Json[] => (Array.isArray(value) ? value : []);

export const asString = (value: Json): string | undefined => (typeof value === "string" ? value : undefined);

export const asNumber = (value: Json): number | undefined => (typeof value === "number" ? value : undefined);

export const field = (value: Json, ...path: string[]): Json => {
  let current = value;

  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current;
};

export const stringMap = (value: Json): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {};

  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }

  return result;
};
