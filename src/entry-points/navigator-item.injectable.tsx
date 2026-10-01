import { clusterNavigatorItemKind } from "@k8slens/cluster-contracts";
import { NavigatorBranchIndicator, NavigatorItemIcon, NavigatorItemLabel, NavigatorLeafIndicator } from "@k8slens/navigator-components";
import {
  getNavigatorItemKind,
  getNavigatorItemKindInjectableBunch,
  type NavigatorItemProps,
  useItemHasChildren,
  useItemIsOpen,
} from "@k8slens/navigator-contracts";
import { useInject } from "@k8slens/use-inject";
import { computed } from "mobx";
import { AppGraphIcon, TrafficGraphIcon } from "../ui/graph-icons";
import { showAppGraphInjectable, showTrafficGraphInjectable } from "./app-graph-navigation.injectable";

interface GraphNavigatorItem {
  readonly id: string;
  readonly name: string;
  readonly orderNumber: number;
}

export const appGraphNavigatorItemKind = getNavigatorItemKind<GraphNavigatorItem, [clusterId: string]>()("app-graph");
/** Under App Graph, so its ancestry is the cluster's id and then App Graph's. */
export const trafficGraphNavigatorItemKind = getNavigatorItemKind<GraphNavigatorItem, [clusterId: string, appGraphId: string]>()("traffic-graph");

// Lens's own rows draw their icon to the slot, 16px; a glyph left to its default is 20.
const AppGraphRow = ({ kind, ids, item, parentItem }: NavigatorItemProps<GraphNavigatorItem, typeof clusterNavigatorItemKind>) => {
  const showAppGraph = useInject(showAppGraphInjectable)();
  const isOpen = useItemIsOpen(kind, ...ids);
  const hasChildren = useItemHasChildren(kind, ...ids);

  return (
    <>
      {hasChildren ? <NavigatorBranchIndicator isOpen={isOpen} /> : <NavigatorLeafIndicator />}
      <NavigatorItemIcon>
        <AppGraphIcon $size="m" />
      </NavigatorItemIcon>
      <NavigatorItemLabel onClick={() => void showAppGraph(parentItem.id)}>{item.name}</NavigatorItemLabel>
    </>
  );
};

const TrafficGraphRow = ({ ids, item }: NavigatorItemProps<GraphNavigatorItem, typeof appGraphNavigatorItemKind>) => {
  const showTrafficGraph = useInject(showTrafficGraphInjectable)();
  const [clusterId] = ids;

  return (
    <>
      <NavigatorLeafIndicator />
      <NavigatorItemIcon>
        <TrafficGraphIcon $size="m" />
      </NavigatorItemIcon>
      <NavigatorItemLabel onClick={() => void showTrafficGraph(clusterId)}>{item.name}</NavigatorItemLabel>
    </>
  );
};

const appGraphItems = [{ id: "app-graph", name: "App Graph", orderNumber: 950 }];
const trafficGraphItems = [{ id: "traffic-graph", name: "Traffic Graph", orderNumber: 1 }];

/** "App Graph" under every cluster in the navigator. */
export const appGraphNavigatorItemBunch = getNavigatorItemKindInjectableBunch({
  kind: appGraphNavigatorItemKind,
  parentKind: clusterNavigatorItemKind,
  description: "Opens the 3D graph of the apps in the cluster.",
  items: {
    instantiate: () => async () => computed(() => appGraphItems),
  },
  Component: AppGraphRow,
});

/** "Traffic Graph" under each cluster's App Graph in the navigator. */
export const trafficGraphNavigatorItemBunch = getNavigatorItemKindInjectableBunch({
  kind: trafficGraphNavigatorItemKind,
  parentKind: appGraphNavigatorItemKind,
  description: "Opens the 3D graph of the traffic between the cluster's services.",
  items: {
    instantiate: () => async () => computed(() => trafficGraphItems),
  },
  Component: TrafficGraphRow,
});
