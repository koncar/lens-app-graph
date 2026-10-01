import { Button, Div, Span } from "@k8slens/element-components";
import { CloseIcon, FilterListIcon, HelpOutlineIcon, HomeIcon, LabelIcon, LayersIcon, SearchIcon, WarningIcon } from "@k8slens/icon";
import { MultiSelect, type SelectOption, TextInput } from "@k8slens/input-components";
import { useSubscribable } from "@k8slens/subscribable-react";
import { useInject, useSyncInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import type React from "react";
import { appGraphLiveBunch } from "../data/app-graph-live.injectable";
import { meshTelemetryLiveBunch } from "../data/mesh-telemetry.injectable";
import { MESH_TITLES, MESH_WINDOW } from "../graph/mesh";
import { BODY, HEALTH_COLORS, PALETTE } from "../graph/presentation";
import styles from "./app-graph.module.scss";
import { KindBadge } from "./kind-icon";
import { appGraphSceneControllerInjectable } from "./scene-controller.injectable";
import { appGraphSettingsInjectable, type BooleanSetting, type GraphMode } from "./settings.injectable";
import { SidePanel } from "./side-panel";
import { type AppGraphViewState, appGraphViewStateInjectable } from "./view-state.injectable";

type IconComponent = React.ComponentType<{ $size?: "s" | "m" | "l" }>;

interface ToolButtonProps {
  readonly Icon: IconComponent;
  readonly tooltip: string;
  readonly active?: boolean;
  readonly onClick: () => void;
}

const ToolButton = ({ Icon, tooltip, active, onClick }: ToolButtonProps) => (
  <Button
    $interactive={{ active: Boolean(active) }}
    $tooltip={tooltip}
    $onClick={onClick}
    $padding="xs"
    $border={{ radius: "m" }}
    $color={active ? "primary" : "textDefault"}
    aria-pressed={active}
  >
    <Icon $size="m" />
  </Button>
);

const Panel = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <Div
    $className={[styles.glass, className]}
    $backgroundColor="backgroundPrimaryDimmed"
    $border={{ color: "borderPrimary", width: "xxs", radius: "m" }}
    $boxShadow
  >
    {children}
  </Div>
);

const useController = (state: AppGraphViewState) => useInject(appGraphSceneControllerInjectable)(state.clusterId, state.mode);

// --- toolbar -------------------------------------------------------------------------------------

const DISPLAY_OPTIONS: readonly SelectOption<BooleanSetting>[] = [
  { id: "showReplicaSets", label: "ReplicaSets" },
  { id: "showHistory", label: "History (old ReplicaSets, finished Jobs)" },
  { id: "showShared", label: "Shared resources (default ServiceAccount, ClusterRoles…)" },
  { id: "showUnattached", label: "Resources no app claims" },
  { id: "showInfra", label: "Infrastructure (Nodes, classes, EndpointSlices)" },
];

const NamespacePicker = observer(({ state }: { state: AppGraphViewState }) => {
  const snapshot = state.model.get().snapshot.get();
  const selected = state.namespaces.get();
  const options = (snapshot?.namespaces ?? selected).map((namespace): SelectOption<string> => ({ id: namespace, label: namespace }));

  return (
    <>
      <Div $flex={{ gap: "s", verticalAlign: "center", horizontalAlign: "space-between" }} $padding={{ horizontal: "s", top: "s" }}>
        <Span $font={{ size: "s", bold: true }}>Namespaces</Span>
        <Button $onClick={() => state.setNamespaces([])} $color="link" $font={{ size: "s" }} $enabled={selected.length > 0}>
          Show all
        </Button>
      </Div>
      <div className={styles.popoverList}>
        <MultiSelect options={options} selected={selected} onToggle={state.toggleNamespace} />
      </div>
      <Span $font={{ size: "xs" }} $color="textMuted" $padding={{ horizontal: "s", bottom: "s" }}>
        {selected.length === 1 ? "Watching this namespace only." : "One namespace narrows what is watched, too."}
      </Span>
    </>
  );
});

const DisplayPicker = observer(() => {
  const settings = useInject(appGraphSettingsInjectable)();
  const current = settings.get.get();

  return (
    <>
      <Span $font={{ size: "s", bold: true }} $padding={{ horizontal: "s", top: "s" }}>
        Show
      </Span>
      <div className={styles.popoverList}>
        <MultiSelect options={DISPLAY_OPTIONS} selected={DISPLAY_OPTIONS.filter((option) => current[option.id]).map((option) => option.id)} onToggle={settings.toggle} />
      </div>
    </>
  );
});

const Popover = ({ state, children }: { state: AppGraphViewState; children: React.ReactNode }) => (
  <Div
    $anchoredAt="bottom span-right"
    $onOutsideClick={state.closePopover}
    $backgroundColor="backgroundPrimary"
    $border={{ color: "borderPrimary", width: "xxs", radius: "m" }}
    $boxShadow
    $className={styles.popover}
  >
    {children}
  </Div>
);

const Toolbar = observer(({ state }: { state: AppGraphViewState }) => {
  const settings = useInject(appGraphSettingsInjectable)();
  const controller = useController(state);
  const current = settings.get.get();
  const popover = state.popover.get();
  const namespaces = state.namespaces.get();
  const matches = state.searchMatches.get();

  return (
    <>
      <Div $className={[styles.overlay, styles.topLeft]} $flex={{ gap: "s", verticalAlign: "center", wrap: true }}>
        <Panel>
          <Div $flex={{ gap: "xs", verticalAlign: "center" }} $padding={{ horizontal: "s", vertical: "xxs" }}>
            <SearchIcon $size="m" />
            <Div $className={styles.search}>
              <TextInput
                type="search"
                placeholder={state.mode === "traffic" ? "Find a service or workload…" : "Find a resource or app…"}
                value={state.search.get()}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => state.setSearch(event.target.value)}
              />
            </Div>
            {matches && (
              <Span $font={{ size: "s" }} $color="textMuted">
                {matches.size} found
              </Span>
            )}
          </Div>
        </Panel>

        <Panel>
          <Div $anchor $flex={{ verticalAlign: "center" }}>
            <Button $onClick={() => state.togglePopover("namespaces")} $padding={{ horizontal: "s", vertical: "xs" }} $flex={{ gap: "xs", verticalAlign: "center" }}>
              <LayersIcon $size="m" />
              <Span $font={{ size: "s" }}>{namespaces.length === 0 ? "All namespaces" : namespaces.length === 1 ? namespaces[0] : `${namespaces.length} namespaces`}</Span>
            </Button>
            {popover === "namespaces" && (
              <Popover state={state}>
                <NamespacePicker state={state} />
              </Popover>
            )}
          </Div>
        </Panel>

        {state.mode === "apps" && (
          <Panel>
            <Div $anchor $flex={{ verticalAlign: "center" }}>
              <ToolButton Icon={FilterListIcon} tooltip="What to show" active={popover === "display"} onClick={() => state.togglePopover("display")} />
              {popover === "display" && (
                <Popover state={state}>
                  <DisplayPicker />
                </Popover>
              )}
            </Div>
          </Panel>
        )}
      </Div>

      <Div $className={[styles.overlay, styles.topRight]}>
        <Panel>
          <Div $flex={{ gap: "xxs", verticalAlign: "center" }} $padding="xxs">
            <ToolButton Icon={LabelIcon} tooltip="Labels (L)" active={current.labels} onClick={() => settings.toggle("labels")} />
            <ToolButton Icon={WarningIcon} tooltip="Problems only (P)" active={current.problemsOnly} onClick={() => settings.toggle("problemsOnly")} />
            <ToolButton Icon={HomeIcon} tooltip="Whole cluster (R)" onClick={() => state.fly("overview")} />
            <ToolButton Icon={HelpOutlineIcon} tooltip="Legend and keys (?)" active={controller.legendOpen.get()} onClick={controller.toggleLegend} />
          </Div>
        </Panel>
      </Div>
    </>
  );
});

// --- status, legend, empty states ----------------------------------------------------------------

const Dot = ({ color }: { color: string }) => <span className={styles.dot} style={{ background: color }} />;

const StatusLine = observer(({ state }: { state: AppGraphViewState }) => {
  const model = state.model.get();
  const layout = state.layout.get();
  const progress = model.progress.get();
  const snapshot = model.snapshot.get();

  if (!layout || !snapshot) {
    return null;
  }

  const loading = progress.settled < progress.total;
  let summary: React.ReactNode;

  if (state.mode === "traffic") {
    const services = [...layout.nodes.values()].filter((node) => node.node.gk.kind === "Service").length;
    const calls = layout.edges.filter((edge) => edge.type === "calls" && !edge.observed).length;

    summary = (
      <>
        <Span $font={{ size: "s", bold: true }}>
          {services} service{services === 1 ? "" : "s"} · {layout.edges.length} connections
        </Span>
        <MeshStatus state={state} />
        {calls > 0 && (
          <Span $font={{ size: "s" }} $color="textMuted" $tooltip="A workload, or a ConfigMap it uses, names the Service's DNS name">
            {calls} inferred call{calls === 1 ? "" : "s"}
          </Span>
        )}
      </>
    );
  } else {
    const apps = layout.apps.size;
    const problems = [...layout.apps.values()].filter((app) => app.app.health === "error" || app.app.health === "warn").length;
    const missing = [...layout.nodes.values()].filter((node) => node.node.state === "missing").length;
    const hidden = layout.hidden.shared + layout.hidden.unattached + layout.hidden.history + layout.hidden.infra;

    summary = (
      <>
        <Span $font={{ size: "s", bold: true }}>
          {apps} app{apps === 1 ? "" : "s"} · {layout.nodes.size} resources
        </Span>
        {problems > 0 && (
          <Span $font={{ size: "s" }} $flex={{ gap: "xxs", verticalAlign: "center" }}>
            <Dot color={HEALTH_COLORS.error} />
            {problems} app{problems === 1 ? "" : "s"} with problems
          </Span>
        )}
        {missing > 0 && (
          <Span $font={{ size: "s" }} $color="critical">
            {missing} broken reference{missing === 1 ? "" : "s"}
          </Span>
        )}
        {hidden > 0 && (
          <Span $font={{ size: "s" }} $color="textMuted" $tooltip="Use the filter button to show them">
            {hidden} hidden
          </Span>
        )}
      </>
    );
  }

  return (
    <Div $className={[styles.overlay, styles.bottomLeft]}>
      <Panel>
        <Div $flex={{ direction: "vertical", gap: "xxs" }} $padding={{ horizontal: "s", vertical: "xs" }}>
          <Div $flex={{ gap: "m", verticalAlign: "center", wrap: true }}>
            {summary}
            {loading && (
              <Span $font={{ size: "s" }} $color="textMuted">
                Loading {progress.settled}/{progress.total} kinds…
              </Span>
            )}
          </Div>
          {progress.unavailable.length > 0 && (
            <Span $font={{ size: "xs" }} $color="textMuted" $tooltip={progress.unavailable.map(({ kind, reason }) => `${kind}: ${reason}`).join("\n")}>
              Can't list {progress.unavailable.map(({ kind }) => kind).join(", ")}: their references show as unknown.
            </Span>
          )}
        </Div>
      </Panel>
    </Div>
  );
});

const MeshStatus = observer(({ state }: { state: AppGraphViewState }) => {
  const telemetry = state.mesh?.telemetry.get();
  const layout = state.layout.get();

  switch (telemetry?.status) {
    case "ready": {
      const observed = layout?.edges.filter((edge) => edge.observed).length ?? 0;
      const failing = layout?.edges.filter((edge) => edge.observed && edge.color === PALETTE.red).length ?? 0;

      return (
        <Span
          $font={{ size: "s" }}
          $flex={{ gap: "xxs", verticalAlign: "center" }}
          $tooltip={`Requests over the last ${MESH_WINDOW}, from the cluster's Prometheus, every 30 seconds`}
        >
          <Dot color={failing > 0 ? HEALTH_COLORS.error : HEALTH_COLORS.ok} />
          {telemetry.meshes.map((mesh) => MESH_TITLES[mesh]).join(" and ")}: {observed > 0 ? `${observed} measured` : "nothing measured here"}
          {failing > 0 && `, ${failing} failing`}
        </Span>
      );
    }
    case "loading":
      return (
        <Span $font={{ size: "s" }} $color="textMuted">
          Reading mesh traffic…
        </Span>
      );
    case "no-prometheus":
      return (
        <Span $font={{ size: "s" }} $color="textMuted" $tooltip="With Prometheus set up for this cluster, the traffic Istio or Linkerd measures is drawn too">
          No Prometheus: no measured traffic
        </Span>
      );
    case "no-mesh": {
      // Istio installs its kinds; a mesh with nothing to report is still a mesh.
      const istio = state.model.get().snapshot.get()?.kinds.get("networking.istio.io/VirtualService")?.phase === "ready";

      return (
        <Span $font={{ size: "s" }} $color="textMuted" $tooltip={`Prometheus has no Istio or Linkerd requests from the last ${MESH_WINDOW}`}>
          {istio ? `Istio: no requests in the last ${MESH_WINDOW}` : "No mesh traffic"}
        </Span>
      );
    }
    case "failed":
      return (
        <Span $font={{ size: "s" }} $color="textMuted" $tooltip={telemetry.reason}>
          Mesh traffic unavailable
        </Span>
      );
    default:
      return null;
  }
});

const APP_LEGEND: ReadonlyArray<readonly [string, string]> = [
  ["Ingress", "Ingress, Gateway, route"],
  ["Service", "Service"],
  ["Deployment", "Deployment, StatefulSet, DaemonSet, CronJob"],
  ["Pod", "Pod, coloured by health"],
  ["ConfigMap", "ConfigMap"],
  ["Secret", "Secret"],
  ["PersistentVolumeClaim", "Volume claim, volume"],
  ["ServiceAccount", "ServiceAccount, RBAC"],
  ["HorizontalPodAutoscaler", "Autoscaler, budget, policy (floating above)"],
];

const TRAFFIC_LEGEND: ReadonlyArray<readonly [string, string]> = [
  ["Internet", "Outside the cluster"],
  ["Ingress", "Ingress, Gateway, Istio Gateway"],
  ["HTTPRoute", "Route, VirtualService"],
  ["Service", "Service"],
  ["Deployment", "The workload behind a Service"],
];

const KEYS: ReadonlyArray<readonly [string, string]> = [
  ["Click", "select"],
  ["Double-click", "open details / fly in"],
  ["Drag · right-drag · scroll", "orbit · pan · zoom"],
  ["L · P", "labels · problems only"],
  ["R · F · Esc", "overview · focus · clear"],
];

const TRAFFIC_COLORS: ReadonlyArray<readonly [string, string]> = [
  [PALETTE.cyan, "Into the cluster, and on to a Service"],
  [PALETTE.teal, "From a Service to the workload behind it"],
  [PALETTE.violet, "A call: the workload names the Service's DNS name"],
  [PALETTE.green, "Measured by Istio or Linkerd: succeeding"],
  [PALETTE.gold, "Measured: 1% or more failing"],
  [PALETTE.red, "Measured: 5% or more failing"],
];

const Legend = observer(({ state }: { state: AppGraphViewState }) => {
  const controller = useController(state);

  if (!controller.legendOpen.get()) {
    return null;
  }

  const entries = state.mode === "traffic" ? TRAFFIC_LEGEND : APP_LEGEND;

  return (
    <Div $className={[styles.overlay, styles.center]}>
      <Panel>
        <Div $flex={{ direction: "vertical", gap: "s" }} $padding="m">
          <Div $flex={{ horizontalAlign: "space-between", verticalAlign: "center" }}>
            <Span $font={{ size: "m", bold: true }}>{state.mode === "traffic" ? "Traffic Graph" : "App Graph"}</Span>
            <ToolButton Icon={CloseIcon} tooltip="Close" onClick={controller.toggleLegend} />
          </Div>
          <Div $flex={{ gap: "xl" }}>
            <Div $flex={{ direction: "vertical", gap: "xs" }}>
              {entries.map(([kind, text]) => (
                <Div key={kind} $flex={{ gap: "s", verticalAlign: "center" }}>
                  <KindBadge kind={kind} color={kind === "Internet" ? BODY.entry : undefined} />
                  <Span $font={{ size: "s" }}>{text}</Span>
                </Div>
              ))}
              {state.mode === "traffic" ? (
                <Div $flex={{ direction: "vertical", gap: "xxs" }}>
                  {TRAFFIC_COLORS.map(([color, text]) => (
                    <Span key={text} $flex={{ gap: "xs", verticalAlign: "center" }} $font={{ size: "s" }}>
                      <span className={styles.swatch} style={{ background: color }} />
                      {text}
                    </Span>
                  ))}
                </Div>
              ) : (
                <Div $flex={{ gap: "s", verticalAlign: "center" }}>
                  {(["ok", "warn", "error", "idle"] as const).map((health) => (
                    <Span key={health} $flex={{ gap: "xxs", verticalAlign: "center" }} $font={{ size: "s" }}>
                      <Dot color={HEALTH_COLORS[health]} />
                      {health}
                    </Span>
                  ))}
                </Div>
              )}
            </Div>
            <Div $flex={{ direction: "vertical", gap: "xxs" }}>
              {KEYS.map(([keys, text]) => (
                <Div key={keys} $flex={{ gap: "s", verticalAlign: "center" }}>
                  <span className={styles.kbd}>{keys}</span>
                  <Span $font={{ size: "s" }}>{text}</Span>
                </Div>
              ))}
              <Span $font={{ size: "xs" }} $color="textMuted" $className={styles.note}>
                {state.mode === "traffic"
                  ? "One lane per namespace; traffic flows left to right. With Istio or Linkerd and Prometheus, calls are measured, and packets run as dense as the requests. Without, they are inferred from Service DNS names in env, args and ConfigMaps."
                  : "Glass modules are apps: a Helm release, an Argo CD or Flux app, an app.kubernetes.io/instance, or a lone workload. Wireframes are missing (red) or unknown (grey)."}
              </Span>
            </Div>
          </Div>
        </Div>
      </Panel>
    </Div>
  );
});

const Notice = ({ title, children }: { title: string; children?: React.ReactNode }) => (
  <Div $className={[styles.overlay, styles.center]}>
    <Panel>
      <Div $flex={{ direction: "vertical", gap: "s", horizontalAlign: "center" }} $padding="l">
        <Span $font={{ size: "l", bold: true }}>{title}</Span>
        {children}
      </Div>
    </Panel>
  </Div>
);

const Status = observer(({ state }: { state: AppGraphViewState }) => {
  const controller = useController(state);
  const model = state.model.get();
  const connection = model.connection.get();
  const layout = state.layout.get();
  const progress = model.progress.get();
  const failure = controller.failure.get();

  if (failure) {
    return (
      <Notice title="3D is not available">
        <Span $color="textMuted">{failure}</Span>
      </Notice>
    );
  }

  if (connection.phase === "failed") {
    return (
      <Notice title="Could not connect to the cluster">
        <Span $color="textMuted">{connection.reason}</Span>
      </Notice>
    );
  }

  const loading = progress.settled < progress.total;

  if (connection.phase === "connecting" || !layout || (layout.nodes.size === 0 && loading)) {
    return (
      <Notice title={connection.phase === "connecting" ? "Connecting…" : "Reading the cluster…"}>
        <div className={styles.progress}>
          <div style={{ width: `${progress.total ? (progress.settled / progress.total) * 100 : 5}%` }} />
        </div>
      </Notice>
    );
  }

  if (layout.nodes.size === 0) {
    return (
      <Notice title="Nothing to show here">
        <Span $color="textMuted">
          {state.mode === "traffic"
            ? "No traffic paths: no ingresses, gateways or Services with workloads behind them."
            : `No apps in ${state.namespaces.get().length > 0 ? "these namespaces" : "this cluster"} yet. The filter button shows resources no app claims.`}
        </Span>
      </Notice>
    );
  }

  return null;
});

// --- the tab -------------------------------------------------------------------------------------

const Viewport = observer(({ state }: { state: AppGraphViewState }) => {
  const controller = useController(state);

  return (
    <Div
      $ref={controller.attach}
      $className={styles.viewport}
      $backgroundColor="backgroundSecondary"
      tabIndex={0}
      aria-label={state.mode === "traffic" ? "3D traffic graph" : "3D app graph"}
    />
  );
});

/** Keeps the cluster's watches alive while mounted; renders nothing. */
const KeepLive = observer(({ state }: { state: AppGraphViewState }) => {
  useSubscribable(useSyncInject(appGraphLiveBunch.subscribable, state.clusterId, state.scope.get()));

  return null;
});

/** Mesh traffic is polled from Prometheus, so only while a traffic graph is on screen. */
const KeepMeshLive = ({ clusterId }: { clusterId: string }) => {
  useSubscribable(useSyncInject(meshTelemetryLiveBunch.subscribable, clusterId));

  return null;
};

export const AppGraphView = observer(({ clusterId, mode }: { clusterId: string; mode: GraphMode }) => {
  const state = useInject(appGraphViewStateInjectable)(clusterId, mode);

  return (
    <Div $className={styles.root} $backgroundColor="backgroundSecondary">
      <KeepLive state={state} />
      {mode === "traffic" && <KeepMeshLive clusterId={clusterId} />}
      <Viewport state={state} />
      <Toolbar state={state} />
      <StatusLine state={state} />
      <SidePanel state={state} />
      <Status state={state} />
      <Legend state={state} />
    </Div>
  );
});
