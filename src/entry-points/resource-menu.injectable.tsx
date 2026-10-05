import { DropDownMenuItemRow } from "@k8slens/drop-down-menu-items";
import {
  getKubeResourceMenuItemInjectableBunch,
  type KubeResourceMenuTarget,
  kubeResourceMenuOrderNumbers,
} from "@k8slens/kube-resource-menu-contracts";
import { useInject } from "@k8slens/use-inject";
import { trackedKindOf } from "../data/tracked-kinds";
import { groupOfApiVersion } from "../graph/types";
import { AppGraphIcon, TrafficGraphIcon } from "../ui/graph-icons";
import { showAppGraphInjectable, showTrafficGraphInjectable } from "./app-graph-navigation.injectable";

const ShowInAppGraph = ({ data }: { data: KubeResourceMenuTarget }) => {
  const showAppGraph = useInject(showAppGraphInjectable)();

  return (
    <DropDownMenuItemRow
      Icon={AppGraphIcon}
      $onClick={() =>
        void showAppGraph(data.clusterId, {
          group: groupOfApiVersion(data.apiVersion),
          kind: data.kind,
          namespace: data.namespace,
          name: data.name,
        })
      }
    >
      Show in App Graph
    </DropDownMenuItemRow>
  );
};

/** "Show in App Graph" in the menu of every resource the graph draws. */
export const showInAppGraphMenuItemBunch = getKubeResourceMenuItemInjectableBunch({
  id: "app-graph-show-in-graph",
  orderNumber: kubeResourceMenuOrderNumbers.sectionEnd + 100,
  isVisible: (target) => {
    const tracked = trackedKindOf({ group: groupOfApiVersion(target.apiVersion), kind: target.kind });

    return tracked !== undefined && !tracked.infra && target.kind !== "Namespace";
  },
  Component: ShowInAppGraph,
});

/** The kinds the traffic view draws: the path a request takes. */
const IN_TRAFFIC = new Set(["Service", "Ingress", "Gateway", "HTTPRoute", "GRPCRoute", "VirtualService", "ServiceEntry", "Deployment", "StatefulSet", "DaemonSet", "Rollout"]);

const ShowInTrafficGraph = ({ data }: { data: KubeResourceMenuTarget }) => {
  const showTrafficGraph = useInject(showTrafficGraphInjectable)();

  return (
    <DropDownMenuItemRow
      Icon={TrafficGraphIcon}
      $onClick={() =>
        void showTrafficGraph(data.clusterId, {
          group: groupOfApiVersion(data.apiVersion),
          kind: data.kind,
          namespace: data.namespace,
          name: data.name,
        })
      }
    >
      Show in Traffic Graph
    </DropDownMenuItemRow>
  );
};

/** "Show in Traffic Graph" in the menu of Services, ingresses, routes and workloads. */
export const showInTrafficGraphMenuItemBunch = getKubeResourceMenuItemInjectableBunch({
  id: "app-graph-show-in-traffic-graph",
  orderNumber: kubeResourceMenuOrderNumbers.sectionEnd + 101,
  isVisible: (target) => IN_TRAFFIC.has(target.kind),
  Component: ShowInTrafficGraph,
});
