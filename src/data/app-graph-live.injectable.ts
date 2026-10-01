import { getSubscribableInjectableBunch } from "@k8slens/subscribable";
import { computed } from "mobx";
import { appGraphModelInjectable } from "./app-graph-model.injectable";

/**
 * Keeps a model's watches running for exactly as long as something looks at it. Components hold
 * it with `useSubscribable` and read the model itself; the grace period keeps a tab flipped away
 * and back, or a details panel reopened, from listing everything again.
 */
export const appGraphLiveBunch = getSubscribableInjectableBunch<number, [clusterId: string, scope: string]>()({
  id: "app-graph-live",
  gracePeriodMs: 30_000,

  source: {
    instantiate: (di) => {
      const modelFor = di.inject(appGraphModelInjectable);

      return () => (clusterId, scope) => ({
        derive: () => {
          const model = modelFor(clusterId, scope);
          const stop = model.start();

          return { value: computed(() => model.snapshot.get()?.version ?? 0), ready: Promise.resolve(), stop };
        },
      });
    },
  },
});
