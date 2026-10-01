import { navigateToKubeResourceDetailsInjectionToken } from "@k8slens/details-panel-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import { getKubeResourceKind, getKubernetesApiVersion } from "@k8slens/kubernetes-contracts";
import { isNavigationSupersededError } from "@k8slens/navigation-contracts";
import { showErrorNotificationInjectionToken } from "@k8slens/notifications-contracts";
import { action, computed, type IObservableValue, observable, reaction, runInAction } from "mobx";
import { ALL_NAMESPACES, appGraphModelInjectable } from "../data/app-graph-model.injectable";
import { meshTelemetryInjectable } from "../data/mesh-telemetry.injectable";
import { type Layout, layoutGraph } from "../graph/layout";
import type { GroupKind } from "../graph/rules";
import { objectKey, type ObjectKey } from "../graph/types";
import { layoutTraffic } from "../graph/traffic";
import { appGraphNamespacesBunch, appGraphSettingsInjectable, type GraphMode } from "./settings.injectable";

export type Selection =
  | { readonly type: "node"; readonly id: ObjectKey }
  | { readonly type: "app"; readonly id: string }
  | { readonly type: "district"; readonly id: string };

/** A resource to bring into view, by what the rest of Lens knows it by. */
export interface FocusTarget {
  readonly group: string;
  readonly kind: string;
  readonly namespace?: string;
  readonly name: string;
}

export type Popover = "namespaces" | "display";

export interface FlyRequest {
  readonly target: Selection | "overview";
  readonly nonce: number;
}

export interface CameraMemory {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

const INITIAL_HOLD_MS = 4000;

const sameSelection = (a: Selection | undefined, b: Selection | undefined) => a?.type === b?.type && a?.id === b?.id;

/**
 * What one cluster's graph tab is showing and pointing at. Kept per cluster, outside React, so
 * it survives the tab being switched away (Lens only renders the selected tab).
 */
export const appGraphViewStateInjectable = getInjectable2({
  id: "app-graph-view-state",
  consumptions: [navigateToKubeResourceDetailsInjectionToken, showErrorNotificationInjectionToken],

  instantiate: (di) => {
    const modelFor = di.inject(appGraphModelInjectable);
    const meshTelemetryFor = di.inject(meshTelemetryInjectable);
    const settings = di.inject(appGraphSettingsInjectable)();
    const getPersistedNamespaces = di.inject(appGraphNamespacesBunch.persistable);
    const navigateToDetails = di.inject(navigateToKubeResourceDetailsInjectionToken)();
    const showError = di.inject(showErrorNotificationInjectionToken)();

    return (clusterId: string, mode: GraphMode) => {
      const selection = observable.box<Selection | undefined>(undefined, { deep: false });
      const hovered = observable.box<Selection | undefined>(undefined, { deep: false });
      const search = observable.box("");
      const namespaces = observable.box<readonly string[]>([], { deep: false });
      const flyRequest = observable.box<FlyRequest | undefined>(undefined, { deep: false });
      const pendingFocus = observable.box<ObjectKey | undefined>(undefined);
      const popover = observable.box<Popover | undefined>(undefined);
      let persistedNamespaces: IObservableValue<readonly string[]> | undefined;
      let nonce = 0;
      const camera: { memory?: CameraMemory } = {};

      void getPersistedNamespaces(clusterId, mode).then((box) => {
        persistedNamespaces = box;
        runInAction(() => namespaces.set(box.get()));
      });

      /** One namespace narrows the watches themselves; several are filtered after listing all. */
      const scope = computed(() => (namespaces.get().length === 1 ? namespaces.get()[0]! : ALL_NAMESPACES));
      const model = computed(() => modelFor(clusterId, scope.get()));
      /** What the cluster's service mesh saw; only the traffic graph asks. */
      const mesh = mode === "traffic" ? meshTelemetryFor(clusterId) : undefined;

      reaction(
        () => [model.get(), settings.get.get().showInfra] as const,
        ([current, showInfra]) => runInAction(() => current.includeInfra.set(showInfra)),
        { fireImmediately: true },
      );

      // The first picture waits for the first full listing (a few seconds at most), so the scene
      // does not reflow once per kind while they arrive.
      const settled = observable.box(false);

      reaction(
        () => {
          const current = model.get();
          const { settled: done, total } = current.progress.get();

          return current.snapshot.get() !== undefined && total > 0 && done >= total;
        },
        (ready) => ready && runInAction(() => settled.set(true)),
        { fireImmediately: true },
      );
      reaction(
        () => model.get().snapshot.get() !== undefined,
        (started) => started && setTimeout(() => runInAction(() => settled.set(true)), INITIAL_HOLD_MS),
        { fireImmediately: true },
      );

      const layout = computed((): Layout | undefined => {
        if (!settled.get()) {
          return undefined;
        }

        const snapshot = model.get().snapshot.get();
        const filter = namespaces.get();

        if (snapshot && mode === "traffic") {
          const telemetry = mesh?.telemetry.get();

          return layoutTraffic(snapshot, {
            namespaces: filter.length > 0 ? new Set(filter) : undefined,
            observed: telemetry?.status === "ready" ? telemetry.flows : undefined,
          });
        }

        const options = settings.get.get();

        return snapshot
          ? layoutGraph(snapshot, {
              namespaces: filter.length > 0 ? new Set(filter) : undefined,
              showReplicaSets: options.showReplicaSets,
              showShared: options.showShared,
              showUnattached: options.showUnattached,
              showInfra: options.showInfra,
              showHistory: options.showHistory,
            })
          : undefined;
      });

      const searchMatches = computed((): ReadonlySet<ObjectKey> | undefined => {
        const query = search.get().trim().toLowerCase();
        const current = layout.get();

        if (!query || !current) {
          return undefined;
        }

        const matches = new Set<ObjectKey>();

        for (const node of current.nodes.values()) {
          const { name, gk, appId } = node.node;

          if (name.toLowerCase().includes(query) || `${gk.kind}/${name}`.toLowerCase().includes(query) || appId?.toLowerCase().includes(query)) {
            matches.add(node.id);
          }
        }

        return matches;
      });

      const fly = action((target: Selection | "overview") => flyRequest.set({ target, nonce: ++nonce }));

      const select = action((next: Selection | undefined, options: { fly?: boolean } = {}) => {
        if (!sameSelection(selection.get(), next)) {
          selection.set(next);
        }

        if (next && options.fly) {
          fly(next);
        }
      });

      // A resource asked for from elsewhere in Lens is selected and flown to once it is laid out.
      reaction(
        () => {
          const id = pendingFocus.get();

          return id && layout.get()?.nodes.has(id) ? id : undefined;
        },
        (id) => {
          if (id) {
            runInAction(() => pendingFocus.set(undefined));
            select({ type: "node", id }, { fly: true });
          }
        },
      );

      const setNamespaces = action((next: readonly string[]) => {
        const sorted = [...new Set(next)].sort();

        namespaces.set(sorted);
        persistedNamespaces?.set(sorted);
      });

      return {
        clusterId,
        mode,
        selection,
        hovered,
        search,
        namespaces,
        scope,
        model,
        mesh,
        layout,
        searchMatches,
        flyRequest,
        camera,
        popover,

        togglePopover: action((which: Popover) => popover.set(popover.get() === which ? undefined : which)),
        closePopover: action(() => popover.set(undefined)),
        select,
        hover: action((next: Selection | undefined) => {
          if (!sameSelection(hovered.get(), next)) {
            hovered.set(next);
          }
        }),
        setSearch: action((query: string) => search.set(query)),
        setNamespaces,
        toggleNamespace: (namespace: string) => {
          const current = namespaces.get();

          setNamespaces(current.includes(namespace) ? current.filter((entry) => entry !== namespace) : [...current, namespace]);
        },
        fly,

        focusOn: action((target: FocusTarget) => {
          const gk: GroupKind = { group: target.group, kind: target.kind };
          const id = objectKey(gk, target.namespace ?? "", target.name);
          const filter = namespaces.get();

          if (target.namespace && filter.length > 0 && !filter.includes(target.namespace)) {
            setNamespaces([...filter, target.namespace]);
          }

          if (layout.get()?.nodes.has(id)) {
            select({ type: "node", id }, { fly: true });
          } else {
            pendingFocus.set(id);
          }
        }),

        /** Opens Lens's own details panel for a resource of the graph. */
        openDetails: async (id: ObjectKey) => {
          const node = layout.get()?.nodes.get(id)?.node;
          const object = node?.object;

          if (!node || !object) {
            return;
          }

          try {
            await navigateToDetails({
              clusterId,
              kind: getKubeResourceKind(object.kind),
              apiVersion: getKubernetesApiVersion(object.apiVersion),
              ref: node.namespace ? { name: node.name, namespace: node.namespace } : { name: node.name },
            });
          } catch (error) {
            if (!isNavigationSupersededError(error)) {
              showError(error as Error);
            }
          }
        },
      };
    };
  },
});

export type AppGraphViewState = ReturnType<ReturnType<typeof appGraphViewStateInjectable.instantiate>>;
