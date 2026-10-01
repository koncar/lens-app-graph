import { getInjectable2 } from "@k8slens/injectable";
import { prometheusIsConfiguredInjectionToken, queryPrometheusRangeInjectionToken } from "@k8slens/prometheus-contracts";
import { getSubscribableInjectableBunch } from "@k8slens/subscribable";
import { computed, type IComputedValue, observable, runInAction } from "mobx";
import { MESH_QUERIES, type MeshTelemetry, parseMeshSeries } from "../graph/mesh";

/** Mesh metrics move slowly (a five-minute rate): asking more often only costs Prometheus. */
const POLL_MS = 30_000;
/** A Prometheus that does not answer in this long is not going to. */
const TIMEOUT_MS = 20_000;

export interface MeshTelemetryModel {
  readonly telemetry: IComputedValue<MeshTelemetry>;
  /** Polls while started; returns the stop. Started by {@link meshTelemetryLiveBunch}. */
  readonly start: () => () => void;
}

const describeFailure = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What the service mesh of one cluster saw, polled from its Prometheus while the traffic graph
 * looks. A cluster without Prometheus says so and is not asked; a Prometheus without mesh
 * metrics is asked again only now and then.
 */
export const meshTelemetryInjectable = getInjectable2({
  id: "app-graph-mesh-telemetry",
  consumptions: [queryPrometheusRangeInjectionToken, prometheusIsConfiguredInjectionToken],

  instantiate: (di) => {
    const queryPrometheusRange = di.inject(queryPrometheusRangeInjectionToken)();
    const prometheusIsConfigured = di.inject(prometheusIsConfiguredInjectionToken)();

    return (clusterId: string): MeshTelemetryModel => {
      const telemetry = observable.box<MeshTelemetry>({ status: "idle" }, { deep: false });
      let running = 0;
      let stopRunning: (() => void) | undefined;

      const set = (next: MeshTelemetry) => runInAction(() => telemetry.set(next));

      const run = () => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let aborter: AbortController | undefined;
        const configured = prometheusIsConfigured(clusterId).subscribe();

        configured.claim();

        const poll = async () => {
          aborter = new AbortController();

          const { signal } = aborter;
          const timeout = setTimeout(() => aborter?.abort(), TIMEOUT_MS);
          const end = Math.floor(Date.now() / 1000);
          const range = { start: end - 60, end, step: 60 };

          try {
            const settled = await Promise.allSettled(
              MESH_QUERIES.map(async (query) => ({ query, series: await queryPrometheusRange(clusterId, query.query, range, signal) })),
            );

            if (stopped) {
              return;
            }

            const answers = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));

            if (answers.length === 0) {
              const reason = settled.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;

              set({ status: "failed", reason: describeFailure(reason) });
            } else {
              const { meshes, flows } = parseMeshSeries(answers);

              set(meshes.length === 0 ? { status: "no-mesh" } : { status: "ready", meshes, flows, at: Date.now() });
            }
          } finally {
            clearTimeout(timeout);
          }

          if (!stopped) {
            // Without a mesh there is little to wait for: look again now and then, in case one arrives.
            timer = setTimeout(() => void poll(), telemetry.get().status === "no-mesh" ? 4 * POLL_MS : POLL_MS);
          }
        };

        void configured.value.then(
          (isConfigured) => {
            if (stopped) {
              return;
            }

            if (!isConfigured.get()) {
              set({ status: "no-prometheus" });

              return;
            }

            set({ status: "loading" });
            void poll();
          },
          () => !stopped && set({ status: "no-prometheus" }),
        );

        return () => {
          stopped = true;
          clearTimeout(timer);
          aborter?.abort();
          configured.dispose();
          set({ status: "idle" });
        };
      };

      return {
        telemetry: computed(() => telemetry.get()),

        start: () => {
          running++;

          if (running === 1) {
            stopRunning = run();
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
            }
          };
        },
      };
    };
  },
});

/** Keeps a cluster's mesh telemetry polled for exactly as long as a traffic graph shows it. */
export const meshTelemetryLiveBunch = getSubscribableInjectableBunch<MeshTelemetry["status"], [clusterId: string]>()({
  id: "app-graph-mesh-telemetry-live",
  gracePeriodMs: 30_000,

  source: {
    instantiate: (di) => {
      const modelFor = di.inject(meshTelemetryInjectable);

      return () => (clusterId) => ({
        derive: () => {
          const model = modelFor(clusterId);
          const stop = model.start();

          return { value: computed(() => model.telemetry.get().status), ready: Promise.resolve(), stop };
        },
      });
    },
  },
});
