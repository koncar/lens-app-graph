import { Div, Span } from "@k8slens/element-components";
import { mainViewTabHostKind } from "@k8slens/main-view-contracts";
import { getTabKind, getTabKindInjectableBunch, type TabProps } from "@k8slens/tab-contracts";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { AppGraphView } from "./app-graph-view";
import { clusterDisplayNameInjectable } from "./cluster-name.injectable";
import { AppGraphIcon, TrafficGraphIcon } from "./graph-icons";

/** One tab per cluster and view: the tab id is the cluster id, so nothing else needs keeping. */
export const appGraphTabKind = getTabKind()("app-graph");
export const trafficGraphTabKind = getTabKind()("traffic-graph");

const AppGraphTitle = observer(({ tabId }: TabProps<typeof mainViewTabHostKind>) => {
  const name = useInject(clusterDisplayNameInjectable)(tabId);

  return (
    <Div $flex={{ gap: "xs", verticalAlign: "center" }}>
      <AppGraphIcon $size="s" />
      <Span $font={{ noWrap: true }}>App Graph · {name.get()}</Span>
    </Div>
  );
});

const TrafficGraphTitle = observer(({ tabId }: TabProps<typeof mainViewTabHostKind>) => {
  const name = useInject(clusterDisplayNameInjectable)(tabId);

  return (
    <Div $flex={{ gap: "xs", verticalAlign: "center" }}>
      <TrafficGraphIcon $size="s" />
      <Span $font={{ noWrap: true }}>Traffic Graph · {name.get()}</Span>
    </Div>
  );
});

const AppGraphTab = ({ tabId }: TabProps<typeof mainViewTabHostKind>) => <AppGraphView clusterId={tabId} mode="apps" />;
const TrafficGraphTab = ({ tabId }: TabProps<typeof mainViewTabHostKind>) => <AppGraphView clusterId={tabId} mode="traffic" />;

export const appGraphTabBunch = getTabKindInjectableBunch({
  tabHostKind: mainViewTabHostKind,
  kind: appGraphTabKind,
  Component: AppGraphTab,
  Title: AppGraphTitle,
});

export const trafficGraphTabBunch = getTabKindInjectableBunch({
  tabHostKind: mainViewTabHostKind,
  kind: trafficGraphTabKind,
  Component: TrafficGraphTab,
  Title: TrafficGraphTitle,
});
