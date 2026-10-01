import { connectClusterInjectionToken } from "@k8slens/cluster-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import { mainViewTabHostKind } from "@k8slens/main-view-contracts";
import {
  getNavigationTargetInjectableBunch,
  getNavigationTargetKind,
  isNavigationSupersededError,
  navigateToInjectionToken,
  type NavigationTargetKind,
} from "@k8slens/navigation-contracts";
import { showErrorNotificationInjectionToken } from "@k8slens/notifications-contracts";
import { focusTabInjectionToken, openTabInjectionToken, type TabKind, tabIsOpenInjectionToken } from "@k8slens/tab-contracts";
import { appGraphTabKind, trafficGraphTabKind } from "../ui/app-graph-tab.injectable";
import type { GraphMode } from "../ui/settings.injectable";
import { appGraphViewStateInjectable, type FocusTarget } from "../ui/view-state.injectable";

export interface AppGraphNavigationParams {
  readonly clusterId: string;
  /** A resource to select and fly to once the graph has it. */
  readonly focus?: FocusTarget;
}

export const appGraphNavigationTargetKind = getNavigationTargetKind<AppGraphNavigationParams>()("app-graph-extension-graph");
export const trafficGraphNavigationTargetKind = getNavigationTargetKind<AppGraphNavigationParams>()("app-graph-extension-traffic");

/** A graph of a cluster as a place: connected first, remembered by back and forward. */
const navigationTargetFor = (
  kind: NavigationTargetKind<AppGraphNavigationParams>,
  tabKind: TabKind,
  mode: GraphMode,
  title: string,
) =>
  getNavigationTargetInjectableBunch({
    kind,

    preconditions: [
      {
        consumptions: [connectClusterInjectionToken],
        instantiate: (di) => {
          const connectCluster = di.inject(connectClusterInjectionToken);

          return () => ({ clusterId }) => connectCluster(clusterId);
        },
      },
    ],

    navigate: {
      consumptions: [openTabInjectionToken, tabIsOpenInjectionToken, focusTabInjectionToken],
      instantiate: (di) => {
        const openTab = di.inject(openTabInjectionToken.for(mainViewTabHostKind).for(tabKind).for(di.scopeIds))();
        const isOpen = di.inject(tabIsOpenInjectionToken.for(mainViewTabHostKind).for(tabKind).for(di.scopeIds))();
        const focusTab = di.inject(focusTabInjectionToken.for(mainViewTabHostKind).for(tabKind).for(di.scopeIds))();
        const viewStateFor = di.inject(appGraphViewStateInjectable);

        return () => async ({ clusterId, focus }, signal) => {
          if (await isOpen({ tabId: clusterId })) {
            await focusTab({ tabId: clusterId });
          } else {
            await openTab({ tabId: clusterId });
          }

          if (focus && !signal.aborted) {
            viewStateFor(clusterId, mode).focusOn(focus);
          }
        };
      },
    },

    describe: ({ focus }) => (focus ? `${title}: ${focus.kind} ${focus.name}` : title),
  });

export const appGraphNavigationTargetBunch = navigationTargetFor(appGraphNavigationTargetKind, appGraphTabKind, "apps", "App Graph");
export const trafficGraphNavigationTargetBunch = navigationTargetFor(trafficGraphNavigationTargetKind, trafficGraphTabKind, "traffic", "Traffic Graph");

const showFor = (id: string, kind: NavigationTargetKind<AppGraphNavigationParams>) =>
  getInjectable2({
    id,
    consumptions: [navigateToInjectionToken, showErrorNotificationInjectionToken],

    instantiate: (di) => {
      const navigate = di.inject(navigateToInjectionToken.for(kind))();
      const showError = di.inject(showErrorNotificationInjectionToken)();

      return () => async (clusterId: string, focus?: FocusTarget) => {
        try {
          await navigate({ clusterId, focus });
        } catch (error) {
          if (!isNavigationSupersededError(error)) {
            showError(error as Error);
          }
        }
      };
    },
  });

/** Opens the app graph of a cluster, optionally on one resource, from anywhere in the extension. */
export const showAppGraphInjectable = showFor("app-graph-show", appGraphNavigationTargetKind);

/** Opens the traffic graph of a cluster, optionally on one resource. */
export const showTrafficGraphInjectable = showFor("app-graph-show-traffic", trafficGraphNavigationTargetKind);
