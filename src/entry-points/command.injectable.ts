import { getCommandInjectableBunch } from "@k8slens/command-palette-contracts";
import { activeTabClusterIdInjectionToken, activeTabClusterIdReactiveInjectionToken } from "@k8slens/main-view-contracts";
import { computed } from "mobx";
import { showAppGraphInjectable, showTrafficGraphInjectable } from "./app-graph-navigation.injectable";

export const openAppGraphCommandBunch = getCommandInjectableBunch({
  id: "app-graph.open",
  title: "App Graph: Open for this cluster",
  isActive: {
    consumptions: [activeTabClusterIdReactiveInjectionToken],
    instantiate: (di) => {
      const activeTabClusterId = di.inject(activeTabClusterIdReactiveInjectionToken)();

      return () => computed(() => activeTabClusterId.get() !== undefined);
    },
  },

  action: {
    consumptions: [activeTabClusterIdInjectionToken],
    instantiate: (di) => {
      const activeTabClusterId = di.inject(activeTabClusterIdInjectionToken)();
      const showAppGraph = di.inject(showAppGraphInjectable)();

      return () => async () => {
        const clusterId = await activeTabClusterId();

        if (clusterId) {
          await showAppGraph(clusterId);
        }
      };
    },
  },
});

export const openTrafficGraphCommandBunch = getCommandInjectableBunch({
  id: "app-graph.open-traffic",
  title: "Traffic Graph: Open for this cluster",
  isActive: {
    consumptions: [activeTabClusterIdReactiveInjectionToken],
    instantiate: (di) => {
      const activeTabClusterId = di.inject(activeTabClusterIdReactiveInjectionToken)();

      return () => computed(() => activeTabClusterId.get() !== undefined);
    },
  },

  action: {
    consumptions: [activeTabClusterIdInjectionToken],
    instantiate: (di) => {
      const activeTabClusterId = di.inject(activeTabClusterIdInjectionToken)();
      const showTrafficGraph = di.inject(showTrafficGraphInjectable)();

      return () => async () => {
        const clusterId = await activeTabClusterId();

        if (clusterId) {
          await showTrafficGraph(clusterId);
        }
      };
    },
  },
});
