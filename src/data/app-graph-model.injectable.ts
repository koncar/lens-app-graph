import { connectClusterInjectionToken } from "@k8slens/cluster-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import {
  kubeResourceKindIsServedInjectionToken,
  type KubeResourceApiVersion,
  type KubeResourceKind,
  kubeResourcesInjectionToken,
  type KubernetesApiVersion,
} from "@k8slens/kubernetes-contracts";
import { action, computed, type IComputedValue, type IObservableValue, observable, reaction, runInAction } from "mobx";
import { buildSnapshot, type GraphSnapshot } from "../graph/snapshot";
import { GraphStore, type KindState } from "../graph/store";
import { groupKindKey, type KubeObject, sameGroupKind } from "../graph/types";
import { customKind, TRACKED_KINDS, type TrackedKind } from "./tracked-kinds";

/** The scope of a model: one namespace, or every namespace the connection can see. */
export const ALL_NAMESPACES = "*";

export interface LoadProgress {
  readonly total: number;
  readonly settled: number;
  readonly unavailable: ReadonlyArray<{ readonly kind: string; readonly reason: string }>;
}

export type Connection =
  | { readonly phase: "connecting" }
  | { readonly phase: "connected" }
  | { readonly phase: "failed"; readonly reason: string };

export interface AppGraphModel {
  readonly clusterId: string;
  readonly scope: string;
  /** Undefined until the model is started; then rebuilt, throttled, as the cluster changes. */
  readonly snapshot: IComputedValue<GraphSnapshot | undefined>;
  readonly connection: IComputedValue<Connection>;
  readonly progress: IComputedValue<LoadProgress>;
  /** Also list Nodes, classes and EndpointSlices. */
  readonly includeInfra: IObservableValue<boolean>;
  /** Starts listing and watching; the returned function stops it. Called by the live bunch only. */
  readonly start: () => () => void;
}

const SNAPSHOT_THROTTLE_MS = 700;
/** How many namespaces a kind forbidden cluster-wide is listed in, one watch each. */
const PER_NAMESPACE_LIMIT = 40;
/** How many kinds learnt of from ownerReferences are followed: operators' resources. */
const DISCOVERED_LIMIT = 24;
/** Looking for owners nothing tracks is a walk over every object: not on every change. */
const DISCOVERY_DELAY_MS = 3000;

const isTracked = (gk: { group: string; kind: string }) => TRACKED_KINDS.some((entry) => sameGroupKind(entry.gk, gk));

const describeFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);

  if (/forbidden|403/i.test(message)) {
    return "Forbidden";
  }

  if (/not (be )?served|not found|404|could not find/i.test(message)) {
    return "Not served";
  }

  return message.length > 80 ? `${message.slice(0, 77)}…` : message;
};

const isNotServed = (error: unknown) => describeFailure(error) === "Not served";

/**
 * The graph of one cluster (or one namespace of it), fed by Lens's own list-and-watch machinery:
 * one `kubeResources` subscription per tracked kind, shared with every other consumer of that
 * kind, diffed into an incremental {@link GraphStore}. Nothing here asks the API server per edge.
 */
export const appGraphModelInjectable = getInjectable2({
  id: "app-graph-model",
  consumptions: [kubeResourcesInjectionToken, kubeResourceKindIsServedInjectionToken, connectClusterInjectionToken],

  instantiate: (di) => {
    const connectCluster = di.inject(connectClusterInjectionToken);
    const kubeResources = di.inject(kubeResourcesInjectionToken)();
    const kubeResourceKindIsServed = di.inject(kubeResourceKindIsServedInjectionToken)();

    return (clusterId: string, scope: string): AppGraphModel => {
      const includeInfra = observable.box(false);
      const snapshot = observable.box<GraphSnapshot | undefined>(undefined, { deep: false });
      const version = observable.box(0);
      const connection = observable.box<Connection>({ phase: "connecting" }, { deep: false });
      let running = 0;

      const bump = action(() => version.set(version.get() + 1));

      const askServed = async (kind: KubeResourceKind, apiVersion: KubernetesApiVersion) => {
        const subscription = kubeResourceKindIsServed(kind, apiVersion as KubeResourceApiVersion<KubeResourceKind>, clusterId).subscribe();

        subscription.claim();

        try {
          return (await subscription.value).get();
        } catch {
          // Discovery could not answer: try the list itself, which says the same when it fails.
          return undefined;
        } finally {
          subscription.dispose();
        }
      };

      /**
       * One kind, listed namespace by namespace: every namespace the graph has seen, up to a
       * limit, each its own shared watch. The kind reads as listed only in the namespaces that
       * answered, so references elsewhere stay unknown rather than turning up missing.
       */
      const trackPerNamespace = (target: GraphStore, entry: TrackedKind, apiVersion: KubernetesApiVersion, setState: (state: KindState) => void) => {
        const lists = observable.map<string, IComputedValue<readonly unknown[]>>({}, { deep: false });
        const asked = new Map<string, () => void>();
        const refused = new Set<string>();
        let stopped = false;

        const settle = () => {
          if (lists.size > 0) {
            setState({ phase: "ready", namespaces: new Set(lists.keys()) });
          } else if (asked.size > 0 && refused.size === asked.size) {
            setState({ phase: "unavailable", reason: "Forbidden" });
          }
        };

        const ask = (namespace: string) => {
          const subscription = kubeResources(entry.kind, apiVersion as KubeResourceApiVersion<KubeResourceKind>, clusterId, namespace).subscribe();

          subscription.claim();
          asked.set(namespace, subscription.dispose);
          subscription.value.then(
            (list) => {
              if (!stopped) {
                runInAction(() => lists.set(namespace, list as IComputedValue<readonly unknown[]>));
                settle();
              }
            },
            () => {
              subscription.dispose();
              refused.add(namespace);

              if (!stopped) {
                settle();
              }
            },
          );
        };

        const stopAsking = reaction(
          () => {
            const current = snapshot.get();
            const withApps = new Set([...(current?.apps.values() ?? [])].map((app) => app.namespace));
            const namespaces = (current?.namespaces ?? []).filter((namespace) => namespace !== "");

            // Namespaces where apps live first: that is where references need resolving.
            return [...namespaces.filter((namespace) => withApps.has(namespace)), ...namespaces.filter((namespace) => !withApps.has(namespace))].slice(
              0,
              PER_NAMESPACE_LIMIT,
            );
          },
          (namespaces) => namespaces.filter((namespace) => !asked.has(namespace)).forEach(ask),
          { fireImmediately: true, equals: (a, b) => a.join() === b.join() },
        );

        const stopApplying = reaction(
          () => [...lists.values()].flatMap((list) => list.get()),
          (items) => {
            if (target.applyList(entry.gk, items as readonly KubeObject[])) {
              bump();
            }
          },
        );

        return () => {
          stopped = true;
          stopAsking();
          stopApplying();
          asked.forEach((dispose) => dispose());
        };
      };

      /** Lists and watches one kind into the store, trying its versions in order. */
      const track = (target: GraphStore, entry: TrackedKind) => {
        let stopped = false;
        const cleanups: Array<() => void> = [];

        const setState = (state: KindState) => {
          if (!stopped) {
            target.setKindState(entry.gk, state);
            bump();
          }
        };

        setState({ phase: "loading" });

        void (async () => {
          for (const [index, apiVersion] of entry.versions.entries()) {
            const isLast = index === entry.versions.length - 1;

            if (entry.custom || entry.versions.length > 1) {
              const served = await askServed(entry.kind, apiVersion);

              if (stopped) {
                return;
              }

              if (served === false) {
                continue;
              }
            }

            const subscription = kubeResources(
              entry.kind,
              apiVersion as KubeResourceApiVersion<KubeResourceKind>,
              clusterId,
              scope === ALL_NAMESPACES ? undefined : scope,
            ).subscribe();

            subscription.claim();

            try {
              const list = await subscription.value;

              if (stopped) {
                subscription.dispose();

                return;
              }

              cleanups.push(subscription.dispose);

              // Followed from an ownerReference, its scope was a guess: objects without a
              // namespace say it is cluster-scoped.
              const first = list.get()[0] as unknown as KubeObject | undefined;

              if (entry.custom && first && !first.metadata.namespace) {
                target.markClusterScoped(entry.gk);
              }

              setState(
                scope !== ALL_NAMESPACES && !target.isClusterScoped(entry.gk)
                  ? { phase: "ready", namespaces: new Set([scope]) }
                  : { phase: "ready" },
              );
              cleanups.push(
                reaction(
                  () => list.get(),
                  (items) => {
                    if (target.applyList(entry.gk, items as unknown as readonly KubeObject[])) {
                      bump();
                    }
                  },
                  { fireImmediately: true },
                ),
              );

              return;
            } catch (error) {
              subscription.dispose();

              if (stopped) {
                return;
              }

              if (isNotServed(error) && !isLast) {
                continue;
              }

              // Not allowed cluster-wide, as for most users of a shared cluster: list it in each
              // namespace instead, and keep the namespaces that answer.
              if (describeFailure(error) === "Forbidden" && scope === ALL_NAMESPACES && !target.isClusterScoped(entry.gk)) {
                cleanups.push(trackPerNamespace(target, entry, apiVersion, setState));

                return;
              }

              // A custom resource that is not installed is simply not part of this cluster.
              setState(entry.custom && isNotServed(error) ? { phase: "untracked" } : { phase: "unavailable", reason: describeFailure(error) });

              return;
            }
          }

          setState(entry.custom ? { phase: "untracked" } : { phase: "unavailable", reason: "Not served" });
        })();

        return () => {
          stopped = true;
          cleanups.splice(0).forEach((cleanup) => cleanup());
        };
      };

      /** Lists and watches every wanted kind into a fresh store; returns what stops it all. */
      const run = () => {
        const current = new GraphStore();
        const tracked = new Map<string, { readonly entry: TrackedKind; readonly stop: () => void }>();
        /** Owner kinds learnt of from the cluster, by group/kind. */
        const discovered = observable.map<string, TrackedKind>({}, { deep: false });
        const wanted = computed(() => [...TRACKED_KINDS.filter((entry) => !entry.infra || includeInfra.get()), ...discovered.values()]);

        const stopSyncingKinds = reaction(
          () => wanted.get(),
          (entries) => {
            const keys = new Set(entries.map((entry) => groupKindKey(entry.gk)));

            for (const [key, { entry, stop }] of tracked) {
              if (!keys.has(key)) {
                stop();
                tracked.delete(key);
                current.setKindState(entry.gk, { phase: "untracked" });
                bump();
              }
            }

            for (const entry of entries) {
              const key = groupKindKey(entry.gk);

              if (!tracked.has(key)) {
                tracked.set(key, { entry, stop: track(current, entry) });
              }
            }
          },
          { fireImmediately: true },
        );

        // An operator's resource owning pods is listed too, so it stands in the graph as itself:
        // its name, its health, its details. Asked about like any custom resource.
        const stopDiscovering = reaction(
          () => version.get(),
          () => {
            if (discovered.size >= DISCOVERED_LIMIT) {
              return;
            }

            const found = current
              .ownerKindsOutside((gk) => isTracked(gk) || discovered.has(groupKindKey(gk)))
              .slice(0, DISCOVERED_LIMIT - discovered.size);

            if (found.length > 0) {
              runInAction(() => {
                for (const { gk, apiVersion } of found) {
                  discovered.set(groupKindKey(gk), customKind(gk.group, gk.kind, [apiVersion.includes("/") ? apiVersion.split("/")[1]! : apiVersion]));
                }
              });
            }
          },
          { delay: DISCOVERY_DELAY_MS },
        );

        const stopSnapshotting = reaction(
          () => version.get(),
          () => snapshot.set(buildSnapshot(current)),
          { delay: SNAPSHOT_THROTTLE_MS, fireImmediately: true },
        );

        return () => {
          stopSyncingKinds();
          stopDiscovering();
          tracked.forEach(({ stop }) => stop());
          tracked.clear();
          stopSnapshotting();
        };
      };

      let stopRunning: (() => void) | undefined;

      const start = () => {
        running++;

        if (running === 1) {
          let cancelled = false;

          runInAction(() => connection.set({ phase: "connecting" }));

          // A tab restored after a restart may point at a cluster that is not connected yet.
          connectCluster(clusterId).then(
            () => {
              if (!cancelled) {
                runInAction(() => connection.set({ phase: "connected" }));
                stopRunning = run();
              }
            },
            (error: unknown) => {
              if (!cancelled) {
                runInAction(() => connection.set({ phase: "failed", reason: error instanceof Error ? error.message : String(error) }));
              }
            },
          );

          stopRunning = () => {
            cancelled = true;
          };
        }

        let stopped = false;

        return () => {
          if (stopped) {
            return;
          }

          stopped = true;
          running--;

          if (running === 0) {
            stopRunning?.();
            stopRunning = undefined;
            // Nothing is watching: let the objects go.
            runInAction(() => snapshot.set(undefined));
          }
        };
      };

      const progress = computed((): LoadProgress => {
        const kinds = snapshot.get()?.kinds;
        const entries = [...(kinds?.entries() ?? [])];
        const unavailable = entries
          .filter(([, state]) => state.phase === "unavailable")
          .map(([key, state]) => ({ kind: key.split("/")[1] ?? key, reason: (state as { reason: string }).reason }));

        return {
          total: entries.filter(([, state]) => state.phase !== "untracked").length,
          settled: entries.filter(([, state]) => state.phase === "ready" || state.phase === "unavailable").length,
          unavailable,
        };
      });

      return {
        clusterId,
        scope,
        snapshot: computed(() => snapshot.get()),
        connection: computed(() => connection.get()),
        progress,
        includeInfra,
        start,
      };
    };
  },
});
