import { clusterNameReactiveInjectionToken } from "@k8slens/cluster-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import { computed, type IComputedValue, observable, runInAction } from "mobx";

/** What the user calls a cluster, following renames; the id until Lens has answered. */
export const clusterDisplayNameInjectable = getInjectable2({
  id: "app-graph-cluster-display-name",
  consumptions: [clusterNameReactiveInjectionToken],

  instantiate: (di) => {
    const clusterNameReactive = di.inject(clusterNameReactiveInjectionToken);

    return (clusterId: string) => {
      const name = observable.box<IComputedValue<string> | undefined>(undefined, { deep: false });

      void clusterNameReactive(clusterId).then((computedName) => runInAction(() => name.set(computedName)));

      return computed(() => name.get()?.get() ?? clusterId);
    };
  },
});
