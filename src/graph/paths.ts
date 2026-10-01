import { type GroupKind, POD_SPEC_LOCATIONS, type Path } from "./rules";
import { isRecord, type Json, sameGroupKind } from "./types";

export interface PathValue {
  readonly value: Json;
  /** Where the value was found, with array indexes filled in: `spec.volumes[2].secret.secretName`. */
  readonly path: string;
}

interface Segment {
  readonly key: string;
  readonly iterate: boolean;
}

const parsedPaths = new Map<string, readonly Segment[]>();

const parse = (path: string): readonly Segment[] => {
  let segments = parsedPaths.get(path);

  if (!segments) {
    segments = path
      .split(".")
      .filter((part) => part !== "")
      .map((part) => (part.endsWith("[*]") ? { key: part.slice(0, -3), iterate: true } : { key: part, iterate: false }));
    parsedPaths.set(path, segments);
  }

  return segments;
};

const join = (prefix: string, key: string) => (prefix === "" ? key : `${prefix}.${key}`);

const walk = (root: Json, path: string): PathValue[] => {
  let current: PathValue[] = [{ value: root, path: "" }];

  for (const { key, iterate } of parse(path)) {
    const next: PathValue[] = [];

    for (const { value, path: at } of current) {
      if (!isRecord(value) || !(key in value)) {
        continue;
      }

      const child = value[key];
      const childPath = join(at, key);

      if (!iterate) {
        if (child !== undefined && child !== null) {
          next.push({ value: child, path: childPath });
        }
        continue;
      }

      if (Array.isArray(child)) {
        child.forEach((element, index) => {
          if (element !== undefined && element !== null) {
            next.push({ value: element, path: `${childPath}[${index}]` });
          }
        });
      }
    }

    current = next;

    if (current.length === 0) {
      break;
    }
  }

  return current;
};

/**
 * Every value at `path` in `root`. `[*]` iterates an array and each element yields its own
 * value; a missing path yields nothing. A path starting with `$podSpec` expands to wherever the
 * holder keeps its pod spec, and yields nothing for a holder that has none.
 */
export const valuesAt = (root: Json, path: Path, holder: GroupKind): PathValue[] => {
  if (!path.startsWith("$podSpec")) {
    return walk(root, path);
  }

  const location = POD_SPEC_LOCATIONS.find(([kind]) => sameGroupKind(kind, holder))?.[1];

  if (location === undefined) {
    return [];
  }

  return walk(root, location + path.slice("$podSpec".length));
};
