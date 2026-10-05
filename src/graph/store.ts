import { EXTRACTORS, type ExtractedRef, NAME_PATTERNS } from "./extractors";
import { valuesAt } from "./paths";
import { CLUSTER_SCOPED, type GroupKind, type Match, type Rule, RULES } from "./rules";
import { type CompiledSelector, compileSelector, selectorMatches } from "./selectors";
import {
  asArray,
  asRecord,
  asString,
  type Edge,
  groupKindKey,
  type GroupKindKey,
  groupKindOf,
  groupOfApiVersion,
  isRecord,
  type Json,
  type KubeObject,
  matchesGroupKind,
  objectKey,
  type ObjectKey,
  parseObjectKey,
  sameGroupKind,
} from "./types";

export interface StoredObject {
  readonly key: ObjectKey;
  readonly gk: GroupKind;
  readonly namespace: string;
  readonly object: KubeObject;
}

/**
 * Whether the graph can see a kind:
 * - loading: asked for, no list yet
 * - ready: listed and watched
 * - unavailable: asked for, and the cluster refused (RBAC) or does not serve it
 * - untracked: never asked for (not in scope, or its rules are off)
 */
export type KindState =
  | { readonly phase: "loading" }
  /** `namespaces`: the only namespaces it could be listed in, when not all of them. */
  | { readonly phase: "ready"; readonly namespaces?: ReadonlySet<string> }
  | { readonly phase: "unavailable"; readonly reason: string }
  | { readonly phase: "untracked" };

const UNTRACKED: KindState = { phase: "untracked" };

/** Fields the graph never needs and must never hold: secret values, config payloads, bulk. */
const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

export const sanitize = (object: KubeObject): KubeObject => {
  const { data: _data, stringData: _stringData, binaryData: _binaryData, ...rest } = object as KubeObject & {
    data?: Json;
    stringData?: Json;
    binaryData?: Json;
  };
  const { managedFields: _managedFields, annotations, ...metadata } = object.metadata as KubeObject["metadata"] & {
    managedFields?: Json;
  };
  let cleanAnnotations = annotations;

  if (annotations && LAST_APPLIED in annotations) {
    const { [LAST_APPLIED]: _lastApplied, ...others } = annotations;

    cleanAnnotations = others;
  }

  return { ...rest, metadata: { ...metadata, ...(cleanAnnotations ? { annotations: cleanAnnotations } : {}) } };
};

const addTo = <K, V>(map: Map<K, Set<V>>, key: K, value: V) => {
  let set = map.get(key);

  if (!set) {
    set = new Set();
    map.set(key, set);
  }

  set.add(value);
};

const removeFrom = <K, V>(map: Map<K, Set<V>>, key: K, value: V) => {
  const set = map.get(key);

  if (set) {
    set.delete(value);

    if (set.size === 0) {
      map.delete(key);
    }
  }
};

const namespaceKindKey = (namespace: string, gk: GroupKind) => `${namespace}|${groupKindKey(gk)}`;

/** Matches that pick their targets from what exists in the namespace, kept from both sides. */
type TwoSidedMatch = Extract<Match, { type: "selector" } | { type: "namePattern" }>;

const isTwoSided = (match: Match): match is TwoSidedMatch => match.type === "selector" || match.type === "namePattern";

/** A two-sided match, compiled for one holder: the path an edge to `target` is found at, if it is one. */
interface TargetMatcher {
  readonly matchesNothing: boolean;
  readonly pathTo: (target: StoredObject) => string | undefined;
}

const NOTHING: TargetMatcher = { matchesNothing: true, pathTo: () => undefined };

/**
 * The objects of a cluster and the edges between them, kept incrementally.
 *
 * Every rule is evaluated from the object that holds the reference. Out-edges are owned by
 * their holder and re-extracted whenever it changes; in-edges are an index over them, so
 * reverse lookups are free. Selector edges are maintained from both ends: a Service changing
 * its selector re-evaluates its pods, and a pod changing its labels re-evaluates the selectors
 * of its namespace. Nothing here calls the API server: lists come in, edges come out.
 */
export class GraphStore {
  private readonly rules: readonly Rule[];
  private readonly clusterScoped: Set<GroupKindKey>;
  private readonly objects = new Map<ObjectKey, StoredObject>();
  private readonly keysByKind = new Map<GroupKindKey, Set<ObjectKey>>();
  private readonly keysByNamespaceKind = new Map<string, Set<ObjectKey>>();
  private readonly outEdges = new Map<ObjectKey, Map<string, Edge>>();
  private readonly inEdges = new Map<ObjectKey, Map<string, Edge>>();
  /** Per holder, per rule id. */
  private readonly compiledSelectors = new Map<ObjectKey, Map<string, TargetMatcher>>();
  private readonly kindStates = new Map<GroupKindKey, KindState>();
  private readonly holderRulesCache = new Map<GroupKindKey, readonly Rule[]>();
  private readonly selectorRulesTargetingCache = new Map<GroupKindKey, readonly Rule[]>();
  private changeCount = 0;

  constructor({ rules = RULES, clusterScoped = CLUSTER_SCOPED }: { rules?: readonly Rule[]; clusterScoped?: readonly GroupKind[] } = {}) {
    this.rules = rules;
    this.clusterScoped = new Set(clusterScoped.map(groupKindKey));
  }

  /** Bumped on every change; what a reactive wrapper watches. */
  get version() {
    return this.changeCount;
  }

  isClusterScoped(gk: GroupKind) {
    return this.clusterScoped.has(groupKindKey(gk));
  }

  /**
   * A kind found to be cluster-scoped only once listed (an operator's resource, followed from
   * an ownerReference). References to it were keyed in their holder's namespace: re-key them.
   */
  markClusterScoped(gk: GroupKind) {
    if (this.isClusterScoped(gk)) {
      return;
    }

    this.clusterScoped.add(groupKindKey(gk));

    for (const edges of [...this.outEdges.values()]) {
      for (const edge of [...edges.values()]) {
        const rule = this.ruleById(edge.ruleId);

        if (rule && !edge.bySelector && sameGroupKind(edge.toGroupKind, gk)) {
          this.deleteEdge(edge);
          this.addEdge(this.edge(rule, edge.from, gk, "", parseObjectKey(edge.to).name, edge.path));
        }
      }
    }

    this.changeCount++;
  }

  // --- kinds ---------------------------------------------------------------------------------

  setKindState(gk: GroupKind, state: KindState) {
    const key = groupKindKey(gk);
    const previous = this.kindStates.get(key);
    const namespacesOf = (value: KindState | undefined) => (value?.phase === "ready" ? [...(value.namespaces ?? [])].sort().join(",") : "");

    if (
      previous?.phase === state.phase &&
      (previous as { reason?: string }).reason === (state as { reason?: string }).reason &&
      namespacesOf(previous) === namespacesOf(state)
    ) {
      return;
    }

    this.kindStates.set(key, state);

    if (state.phase === "unavailable" || state.phase === "untracked") {
      this.applyList(gk, []);
    }

    this.changeCount++;
  }

  kindState(gk: GroupKind): KindState {
    return this.kindStates.get(groupKindKey(gk)) ?? UNTRACKED;
  }

  kinds(): ReadonlyMap<GroupKindKey, KindState> {
    return this.kindStates;
  }

  /**
   * Kinds that own something here but that nothing tracks, with the API version the owner
   * reference names them by: an operator's resources (a database cluster owning StatefulSets),
   * worth listing so they stand in the graph as themselves rather than as unknowns.
   */
  ownerKindsOutside(isKnown: (gk: GroupKind) => boolean): ReadonlyArray<{ readonly gk: GroupKind; readonly apiVersion: string }> {
    const found = new Map<GroupKindKey, { gk: GroupKind; apiVersion: string }>();

    for (const { object } of this.objects.values()) {
      for (const ref of asArray(object.metadata.ownerReferences as Json)) {
        const apiVersion = asString(isRecord(ref) ? ref.apiVersion : undefined);
        const kind = asString(isRecord(ref) ? ref.kind : undefined);

        if (!apiVersion || !kind) {
          continue;
        }

        const gk = { group: groupOfApiVersion(apiVersion), kind };
        const key = groupKindKey(gk);

        if (!found.has(key) && !isKnown(gk)) {
          found.set(key, { gk, apiVersion });
        }
      }
    }

    return [...found.values()];
  }

  // --- objects -------------------------------------------------------------------------------

  /** Replaces every object of a kind with `objects`: what a list-and-watch emits. */
  applyList(gk: GroupKind, objects: readonly KubeObject[]): boolean {
    const before = this.changeCount;
    const previousKeys = new Set(this.keysByKind.get(groupKindKey(gk)) ?? []);

    for (const object of objects) {
      const key = this.keyOf(object);

      previousKeys.delete(key);
      this.upsert(object);
    }

    for (const key of previousKeys) {
      this.remove(key);
    }

    return this.changeCount !== before;
  }

  upsert(raw: KubeObject) {
    const gk = groupKindOf(raw);
    const key = this.keyOf(raw);
    const existing = this.objects.get(key);

    if (
      existing &&
      existing.object.metadata.uid === raw.metadata.uid &&
      raw.metadata.resourceVersion !== undefined &&
      existing.object.metadata.resourceVersion === raw.metadata.resourceVersion
    ) {
      return;
    }

    const namespace = this.isClusterScoped(gk) ? "" : (raw.metadata.namespace ?? "");
    const stored: StoredObject = { key, gk, namespace, object: sanitize(raw) };

    if (existing) {
      this.dropOutEdges(key);
      this.dropSelectorInEdges(key);
    } else {
      addTo(this.keysByKind, groupKindKey(gk), key);
      addTo(this.keysByNamespaceKind, namespaceKindKey(namespace, gk), key);
    }

    this.objects.set(key, stored);
    // Extracted from what arrived, before sanitising dropped it: config files name services.
    this.extractOutEdges(stored, raw);
    this.evaluateSelectorsTargeting(stored);
    this.changeCount++;
  }

  remove(key: ObjectKey) {
    const stored = this.objects.get(key);

    if (!stored) {
      return;
    }

    this.dropOutEdges(key);
    this.dropSelectorInEdges(key);
    this.objects.delete(key);
    removeFrom(this.keysByKind, groupKindKey(stored.gk), key);
    removeFrom(this.keysByNamespaceKind, namespaceKindKey(stored.namespace, stored.gk), key);
    this.changeCount++;
  }

  // --- reads ---------------------------------------------------------------------------------

  get(key: ObjectKey): StoredObject | undefined {
    return this.objects.get(key);
  }

  get size() {
    return this.objects.size;
  }

  all(): IterableIterator<StoredObject> {
    return this.objects.values();
  }

  outOf(key: ObjectKey): Iterable<Edge> {
    return this.outEdges.get(key)?.values() ?? [];
  }

  into(key: ObjectKey): Iterable<Edge> {
    return this.inEdges.get(key)?.values() ?? [];
  }

  *edges(): IterableIterator<Edge> {
    for (const edges of this.outEdges.values()) {
      yield* edges.values();
    }
  }

  ruleById(id: string): Rule | undefined {
    return this.rules.find((rule) => rule.id === id);
  }

  // --- internals -----------------------------------------------------------------------------

  private keyOf(object: KubeObject): ObjectKey {
    const gk = groupKindOf(object);

    return objectKey(gk, this.isClusterScoped(gk) ? "" : (object.metadata.namespace ?? ""), object.metadata.name);
  }

  private rulesForHolder(gk: GroupKind): readonly Rule[] {
    const cacheKey = groupKindKey(gk);
    let rules = this.holderRulesCache.get(cacheKey);

    if (!rules) {
      rules = this.rules.filter((rule) => rule.holders.some((holder) => matchesGroupKind(holder, gk)));
      this.holderRulesCache.set(cacheKey, rules);
    }

    return rules;
  }

  private selectorRulesTargeting(gk: GroupKind): readonly Rule[] {
    const cacheKey = groupKindKey(gk);
    let rules = this.selectorRulesTargetingCache.get(cacheKey);

    if (!rules) {
      rules = this.rules.filter((rule) => isTwoSided(rule.match) && sameGroupKind(rule.match.target, gk));
      this.selectorRulesTargetingCache.set(cacheKey, rules);
    }

    return rules;
  }

  private addEdge(edge: Edge) {
    let out = this.outEdges.get(edge.from);

    if (!out) {
      out = new Map();
      this.outEdges.set(edge.from, out);
    }

    out.set(edge.id, edge);

    let into = this.inEdges.get(edge.to);

    if (!into) {
      into = new Map();
      this.inEdges.set(edge.to, into);
    }

    into.set(edge.id, edge);
  }

  private deleteEdge(edge: Edge) {
    const out = this.outEdges.get(edge.from);

    out?.delete(edge.id);

    if (out?.size === 0) {
      this.outEdges.delete(edge.from);
    }

    const into = this.inEdges.get(edge.to);

    into?.delete(edge.id);

    if (into?.size === 0) {
      this.inEdges.delete(edge.to);
    }
  }

  private dropOutEdges(key: ObjectKey) {
    for (const edge of [...(this.outEdges.get(key)?.values() ?? [])]) {
      this.deleteEdge(edge);
    }

    this.compiledSelectors.delete(key);
  }

  /** Selector edges exist only between objects that both exist: a pod gone is simply unselected. */
  private dropSelectorInEdges(key: ObjectKey) {
    for (const edge of [...(this.inEdges.get(key)?.values() ?? [])]) {
      if (edge.bySelector) {
        this.deleteEdge(edge);
      }
    }
  }

  private edge(rule: Rule, from: ObjectKey, target: GroupKind, namespace: string, name: string, path: string, bySelector = false): Edge {
    const to = objectKey(target, this.isClusterScoped(target) ? "" : namespace, name);

    return { id: `${rule.id}|${from}|${to}|${path}`, ruleId: rule.id, type: rule.edge, from, to, toGroupKind: target, path, bySelector };
  }

  private extractOutEdges(stored: StoredObject, raw: KubeObject) {
    for (const rule of this.rulesForHolder(stored.gk)) {
      if (isTwoSided(rule.match)) {
        this.evaluateSelectorOf(rule, rule.match, stored);
        continue;
      }

      for (const ref of this.refsOf(rule.match, { ...stored, object: raw })) {
        this.addEdge(this.edge(rule, stored.key, ref.target, ref.namespace, ref.name, ref.path));
      }
    }
  }

  private refsOf(match: Exclude<Match, TwoSidedMatch>, { object, gk, namespace }: StoredObject): readonly ExtractedRef[] {
    switch (match.type) {
      case "ownerReferences":
        return asArray(object.metadata.ownerReferences as Json).flatMap((ref, index) => {
          const kind = asString(isRecord(ref) ? ref.kind : undefined);
          const name = asString(isRecord(ref) ? ref.name : undefined);

          return kind && name
            ? [
                {
                  target: { group: groupOfApiVersion(asString(asRecord(ref).apiVersion)), kind },
                  namespace,
                  name,
                  path: `metadata.ownerReferences[${index}]`,
                },
              ]
            : [];
        });

      case "name": {
        const targetNamespace = match.namespace === "cluster" ? "" : namespace;
        const refs = match.paths.flatMap((path) =>
          valuesAt(object, path, gk).flatMap(({ value, path: at }) =>
            typeof value === "string" && value !== "" ? [{ target: match.target, namespace: targetNamespace, name: value, path: at }] : [],
          ),
        );

        // A default applies to what is there but left the field out, never to a holder that has
        // no pod spec at all.
        const defaultApplies =
          match.defaultName !== undefined &&
          match.paths.every((path) => !path.startsWith("$podSpec") || valuesAt(object, "$podSpec", gk).length > 0);

        if (refs.length === 0 && match.defaultName && defaultApplies) {
          return [
            {
              target: match.target,
              namespace: targetNamespace,
              name: match.defaultName,
              path: `${match.paths[0]?.replace("$podSpec", "spec") ?? ""} (default)`,
            },
          ];
        }

        return refs;
      }

      case "objectRef":
        return match.paths.flatMap((path) =>
          valuesAt(object, path, gk).flatMap(({ value, path: at }) => {
            if (!isRecord(value)) {
              return [];
            }

            const group =
              typeof value.group === "string"
                ? value.group
                : typeof value.apiGroup === "string"
                  ? value.apiGroup
                  : typeof value.apiVersion === "string"
                    ? groupOfApiVersion(value.apiVersion)
                    : match.defaults.group;
            const kind = asString(value.kind) || match.defaults.kind;
            const name = asString(value[match.nameField ?? "name"]);

            if (group === undefined || !kind || !name) {
              return [];
            }

            const target = { group, kind };

            if (match.allowedTargets && !match.allowedTargets.some((allowed) => sameGroupKind(allowed, target))) {
              return [];
            }

            return [{ target, namespace: asString(value.namespace) || namespace, name, path: at }];
          }),
        );

      case "labelValue": {
        const name = object.metadata.labels?.[match.label];

        return name ? [{ target: match.target, namespace, name, path: `metadata.labels["${match.label}"]` }] : [];
      }

      case "annotationValue": {
        const name = object.metadata.annotations?.[match.annotation];

        return name
          ? [
              {
                target: match.target,
                namespace: match.namespace === "cluster" ? "" : namespace,
                name,
                path: `metadata.annotations["${match.annotation}"]`,
              },
            ]
          : [];
      }

      case "custom":
        return EXTRACTORS[match.extractorId]?.(object) ?? [];
    }
  }

  private compiledSelectorOf(rule: Rule, match: TwoSidedMatch, holder: StoredObject): TargetMatcher {
    let ofHolder = this.compiledSelectors.get(holder.key);

    if (!ofHolder) {
      ofHolder = new Map();
      this.compiledSelectors.set(holder.key, ofHolder);
    }

    let compiled = ofHolder.get(rule.id);

    if (!compiled) {
      compiled = this.compileMatcher(match, holder);
      ofHolder.set(rule.id, compiled);
    }

    return compiled;
  }

  private compileMatcher(match: TwoSidedMatch, holder: StoredObject): TargetMatcher {
    if (match.type === "namePattern") {
      const patterns = NAME_PATTERNS[match.patternId]?.(holder.object) ?? [];

      return patterns.length === 0
        ? NOTHING
        : { matchesNothing: false, pathTo: (target) => patterns.find(({ pattern }) => pattern.test(target.object.metadata.name))?.path };
    }

    const selector: CompiledSelector = compileSelector(valuesAt(holder.object, match.path, holder.gk)[0]?.value, match.form, match.empty);

    return selector.matchesNothing
      ? NOTHING
      : { matchesNothing: false, pathTo: (target) => (selectorMatches(selector, target.object.metadata.labels) ? match.path : undefined) };
  }

  /** Holder side: a Service (say) was added or changed; find the pods it selects. */
  private evaluateSelectorOf(rule: Rule, match: TwoSidedMatch, holder: StoredObject) {
    const matcher = this.compiledSelectorOf(rule, match, holder);

    if (matcher.matchesNothing) {
      return;
    }

    for (const targetKey of this.keysByNamespaceKind.get(namespaceKindKey(holder.namespace, match.target)) ?? []) {
      const target = this.objects.get(targetKey);
      const path = target && matcher.pathTo(target);

      if (target && path !== undefined) {
        this.addEdge(this.edge(rule, holder.key, match.target, holder.namespace, target.object.metadata.name, path, true));
      }
    }
  }

  /** Target side: a pod (say) was added or changed; find the selectors of its namespace that select it. */
  private evaluateSelectorsTargeting(target: StoredObject) {
    for (const rule of this.selectorRulesTargeting(target.gk)) {
      const match = rule.match as TwoSidedMatch;

      for (const holderKind of rule.holders) {
        for (const holderKey of this.keysByNamespaceKind.get(namespaceKindKey(target.namespace, holderKind)) ?? []) {
          const holder = this.objects.get(holderKey);

          if (!holder || holder.key === target.key) {
            continue;
          }

          const path = this.compiledSelectorOf(rule, match, holder).pathTo(target);

          if (path !== undefined) {
            this.addEdge(this.edge(rule, holder.key, match.target, holder.namespace, target.object.metadata.name, path, true));
          }
        }
      }
    }
  }
}
