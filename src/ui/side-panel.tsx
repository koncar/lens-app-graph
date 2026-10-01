import { Badge } from "@k8slens/badge";
import { Button, ClickableDiv, Div, Span } from "@k8slens/element-components";
import { CloseIcon } from "@k8slens/icon";
import { PlainButton, PrimaryButton } from "@k8slens/input-components";
import { observer } from "mobx-react";
import type React from "react";
import type { Health } from "../graph/health";
import type { LayoutEdge } from "../graph/layout";
import { BODY, EDGE_INVERSE_VERBS, EDGE_VERBS, HEALTH_COLORS } from "../graph/presentation";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../graph/snapshot";
import { INTERNET_ID } from "../graph/traffic";
import type { ObjectKey } from "../graph/types";
import styles from "./app-graph.module.scss";
import { KindBadge, KindIcon } from "./kind-icon";
import type { AppGraphViewState } from "./view-state.injectable";

const HEALTH_BADGE: Readonly<Record<Health, "success" | "warning" | "critical" | "grey40" | "grey60">> = {
  ok: "success",
  warn: "warning",
  error: "critical",
  idle: "grey40",
  neutral: "grey60",
  unknown: "grey60",
};

const HEALTH_WORD: Readonly<Record<Health, string>> = {
  ok: "Healthy",
  warn: "Degraded",
  error: "Broken",
  idle: "Idle",
  neutral: "",
  unknown: "Unknown",
};

const HealthBadge = ({ health, summary }: { health: Health; summary?: string }) => {
  const label = [HEALTH_WORD[health], summary].filter(Boolean).join(" · ");

  return label ? <Badge small label={label} $backgroundColor={HEALTH_BADGE[health]} $color="white" /> : null;
};

const Dot = ({ health }: { health: Health }) => <span className={styles.dot} style={{ background: HEALTH_COLORS[health] }} />;

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Div $flex={{ direction: "vertical", gap: "xxs" }}>
    <Span $font={{ size: "xs", bold: true, uppercase: true }} $color="textMuted">
      {title}
    </Span>
    {children}
  </Div>
);

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className={styles.row}>
    <span className={styles.rowLabel}>{label}</span>
    <span className={styles.rowValue}>{children}</span>
  </div>
);

/** A node of the graph, the internet included: the layout knows it, the snapshot may not. */
const nodeOf = (state: AppGraphViewState, snapshot: GraphSnapshot, id: ObjectKey): GraphNode | undefined =>
  state.layout.get()?.nodes.get(id)?.node ?? snapshot.nodes.get(id);

const Relation = observer(
  ({
    state,
    snapshot,
    other,
    verb,
    detail,
    edgeState,
  }: {
    state: AppGraphViewState;
    snapshot: GraphSnapshot;
    other: ObjectKey;
    verb: string;
    detail: string;
    edgeState: GraphEdge["state"];
  }) => {
    const node = nodeOf(state, snapshot, other);
    const shown = state.layout.get()?.nodes.has(other) ?? false;

    return (
      <ClickableDiv
        $flex={{ direction: "vertical", gap: "zero" }}
        $padding={{ vertical: "xxs", horizontal: "xs" }}
        $border={{ radius: "s" }}
        $backgroundColor={{ hover: "grey70" }}
        $onClick={shown ? () => state.select({ type: "node", id: other }, { fly: true }) : undefined}
        $cursor={shown ? "pointer" : "default"}
      >
        <Div $flex={{ gap: "xs", verticalAlign: "center" }}>
          {node && <Dot health={node.health} />}
          <Span $font={{ size: "s" }} $color="textMuted">
            {verb}
          </Span>
          {node && <KindIcon kind={node.gk.kind} />}
          <Span $font={{ size: "s", bold: true, textOverflow: "ellipsis", noWrap: true }}>{node?.name ?? other}</Span>
          {edgeState !== "resolved" && <Badge small label={edgeState} $backgroundColor={edgeState === "missing" ? "critical" : "grey60"} $color="white" />}
        </Div>
        <span className={styles.path}>{detail}</span>
      </ClickableDiv>
    );
  },
);

const Relations = observer(({ state, node, snapshot }: { state: AppGraphViewState; node: GraphNode; snapshot: GraphSnapshot }) => {
  if (state.mode === "traffic") {
    const edges = state.layout.get()?.edgesByNode.get(node.id) ?? [];
    const outgoing = edges.filter((edge) => edge.from === node.id);
    const incoming = edges.filter((edge) => edge.to === node.id);
    const row = (edge: LayoutEdge, other: ObjectKey, verb: string) => (
      <Relation key={edge.id} state={state} snapshot={snapshot} other={other} verb={verb} detail={edge.source.path} edgeState="resolved" />
    );

    return (
      <>
        {incoming.length > 0 && (
          <Section title={`Receives traffic from (${incoming.length})`}>
            {incoming.map((edge) => row(edge, edge.from, edge.type === "calls" ? "called by" : "from"))}
          </Section>
        )}
        {outgoing.length > 0 && (
          <Section title={`Sends traffic to (${outgoing.length})`}>{outgoing.map((edge) => row(edge, edge.to, edge.type === "calls" ? "calls" : "to"))}</Section>
        )}
      </>
    );
  }

  const outgoing = snapshot.outOf.get(node.id) ?? [];
  const incoming = snapshot.into.get(node.id) ?? [];

  return (
    <>
      {outgoing.length > 0 && (
        <Section title={`References (${outgoing.length})`}>
          {outgoing.map((edge) => (
            <Relation key={edge.id} state={state} snapshot={snapshot} other={edge.to} verb={EDGE_VERBS[edge.type]} detail={`${edge.ruleId} · ${edge.path}`} edgeState={edge.state} />
          ))}
        </Section>
      )}
      {incoming.length > 0 && (
        <Section title={`Referenced by (${incoming.length})`}>
          {incoming.map((edge) => (
            <Relation
              key={edge.id}
              state={state}
              snapshot={snapshot}
              other={edge.from}
              verb={EDGE_INVERSE_VERBS[edge.type]}
              detail={`${edge.ruleId} · ${edge.path}`}
              edgeState={edge.state}
            />
          ))}
        </Section>
      )}
    </>
  );
});

const Header = ({ node, eyebrow, children }: { node: GraphNode; eyebrow: string; children?: React.ReactNode }) => (
  <Div $flex={{ gap: "s", verticalAlign: "top" }}>
    <KindBadge kind={node.gk.kind} size={34} color={node.id === INTERNET_ID ? BODY.entry : undefined} />
    <Div $flex={{ direction: "vertical", gap: "xxs" }} $flexChild>
      <Span $font={{ size: "xs", uppercase: true }} $color="textMuted">
        {eyebrow}
      </Span>
      <Span $font={{ size: "l", bold: true, forceWrap: true }}>{node.name}</Span>
      {children}
    </Div>
  </Div>
);

const NodeDetails = observer(({ state, id, snapshot }: { state: AppGraphViewState; id: ObjectKey; snapshot: GraphSnapshot }) => {
  const node = nodeOf(state, snapshot, id);

  if (!node) {
    return <Span $color="textMuted">This resource is gone.</Span>;
  }

  if (node.id === INTERNET_ID) {
    return (
      <Div $flex={{ direction: "vertical", gap: "m" }}>
        <Header node={node} eyebrow="Outside the cluster">
          <Span $font={{ size: "s" }} $color="textMuted">
            Where requests come from: ingresses, gateways and Services of type LoadBalancer or NodePort.
          </Span>
        </Header>
        <Relations state={state} node={node} snapshot={snapshot} />
      </Div>
    );
  }

  const app = node.appId ? snapshot.apps.get(node.appId) : undefined;
  const role =
    node.role === "shared"
      ? `Shared by ${node.claimedBy.map((appId) => snapshot.apps.get(appId)?.name ?? appId).join(", ")}`
      : node.role === "hub"
        ? "Shared by many apps"
        : node.role === "unattached"
          ? "No app claims it"
          : undefined;

  return (
    <Div $flex={{ direction: "vertical", gap: "m" }}>
      <Header node={node} eyebrow={node.gk.group ? `${node.gk.kind} · ${node.gk.group}` : node.gk.kind}>
        <Div $flex={{ gap: "xs", wrap: true }}>
          <HealthBadge health={node.health} summary={node.summary} />
          {node.state !== "present" && (
            <Badge
              small
              label={node.state === "missing" ? "Missing" : `Unknown: ${node.unknownReason ?? ""}`}
              $backgroundColor={node.state === "missing" ? "critical" : "grey60"}
              $color="white"
            />
          )}
        </Div>
      </Header>

      <Section title="Where">
        {node.namespace && <Row label="Namespace">{node.namespace}</Row>}
        {app && (
          <Row label="App">
            <Button $onClick={() => state.select({ type: "app", id: app.id }, { fly: true })} $color="link" $font={{ size: "s" }}>
              {app.name}
            </Button>{" "}
            <Span $color="textMuted">({app.source})</Span>
          </Row>
        )}
        {role && <Row label="Role">{role}</Row>}
      </Section>

      <Div $flex={{ gap: "s", wrap: true }}>
        {node.state === "present" && <PrimaryButton onClick={() => void state.openDetails(node.id)}>Open details</PrimaryButton>}
        <PlainButton onClick={() => state.fly({ type: "node", id: node.id })}>Fly to</PlainButton>
      </Div>

      <Relations state={state} node={node} snapshot={snapshot} />
    </Div>
  );
});

const AppDetails = observer(({ state, id, snapshot }: { state: AppGraphViewState; id: string; snapshot: GraphSnapshot }) => {
  const app = snapshot.apps.get(id);

  if (!app) {
    return <Span $color="textMuted">This app is gone.</Span>;
  }

  const byKind = new Map<string, GraphNode[]>();

  for (const memberId of app.members) {
    const node = snapshot.nodes.get(memberId);

    if (node) {
      byKind.set(node.gk.kind, [...(byKind.get(node.gk.kind) ?? []), node]);
    }
  }

  return (
    <Div $flex={{ direction: "vertical", gap: "m" }}>
      <Div $flex={{ direction: "vertical", gap: "xxs" }}>
        <Span $font={{ size: "xs", uppercase: true }} $color="textMuted">
          App · {app.source}
        </Span>
        <Span $font={{ size: "l", bold: true, forceWrap: true }}>{app.name}</Span>
        <Div $flex={{ gap: "xs", wrap: true }}>
          <HealthBadge health={app.health} summary={app.pods > 0 ? `${app.readyPods}/${app.pods} pods ready` : undefined} />
          {app.missing > 0 && <Badge small label={`${app.missing} missing`} $backgroundColor="critical" $color="white" />}
        </Div>
      </Div>

      <Section title="Where">
        <Row label="Namespace">{app.namespace}</Row>
        {app.partOf && <Row label="Part of">{app.partOf}</Row>}
        <Row label="Resources">{app.members.length}</Row>
      </Section>

      <Div $flex={{ gap: "s" }}>
        <PlainButton onClick={() => state.fly({ type: "app", id: app.id })}>Fly to</PlainButton>
      </Div>

      {[...byKind.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([kind, nodes]) => (
          <Section key={kind} title={`${kind} (${nodes.length})`}>
            {nodes.slice(0, 40).map((node) => (
              <ClickableDiv
                key={node.id}
                $flex={{ gap: "xs", verticalAlign: "center" }}
                $padding={{ vertical: "xxs", horizontal: "xs" }}
                $border={{ radius: "s" }}
                $backgroundColor={{ hover: "grey70" }}
                $onClick={() => state.select({ type: "node", id: node.id }, { fly: true })}
                $cursor="pointer"
              >
                <Dot health={node.health} />
                <KindIcon kind={node.gk.kind} />
                <Span $font={{ size: "s", noWrap: true, textOverflow: "ellipsis" }}>{node.name}</Span>
                {node.summary && (
                  <Span $font={{ size: "xs", noWrap: true }} $color="textMuted">
                    {node.summary}
                  </Span>
                )}
              </ClickableDiv>
            ))}
            {nodes.length > 40 && (
              <Span $font={{ size: "xs" }} $color="textMuted">
                …and {nodes.length - 40} more
              </Span>
            )}
          </Section>
        ))}
    </Div>
  );
});

const DistrictDetails = observer(({ state, id, snapshot }: { state: AppGraphViewState; id: string; snapshot: GraphSnapshot }) => {
  const district = state.layout.get()?.districts.get(id);
  const apps = [...snapshot.apps.values()].filter((app) => app.namespace === id).sort((a, b) => (a.name < b.name ? -1 : 1));

  return (
    <Div $flex={{ direction: "vertical", gap: "m" }}>
      <Div $flex={{ direction: "vertical", gap: "xxs" }}>
        <Span $font={{ size: "xs", uppercase: true }} $color="textMuted">
          Namespace
        </Span>
        <Span $font={{ size: "l", bold: true }}>{district?.title ?? (id || "cluster-scoped")}</Span>
        {district && (
          <Span $font={{ size: "s" }} $color="textMuted">
            {district.caption ?? `${district.apps} apps · ${district.resources} resources shown`}
          </Span>
        )}
      </Div>
      <Div $flex={{ gap: "s" }}>
        <PlainButton onClick={() => state.fly({ type: "district", id })}>Fly to</PlainButton>
        {id && !id.startsWith("~") && <PlainButton onClick={() => state.setNamespaces([id])}>Only this namespace</PlainButton>}
      </Div>
      {state.mode === "apps" && (
        <Section title={`Apps (${apps.length})`}>
          {apps.map((app) => (
            <ClickableDiv
              key={app.id}
              $flex={{ gap: "xs", verticalAlign: "center" }}
              $padding={{ vertical: "xxs", horizontal: "xs" }}
              $border={{ radius: "s" }}
              $backgroundColor={{ hover: "grey70" }}
              $onClick={() => state.select({ type: "app", id: app.id }, { fly: true })}
              $cursor="pointer"
            >
              <Dot health={app.health} />
              <Span $font={{ size: "s" }}>{app.name}</Span>
              <Span $font={{ size: "xs" }} $color="textMuted">
                {app.members.length} resources
              </Span>
            </ClickableDiv>
          ))}
        </Section>
      )}
    </Div>
  );
});

export const SidePanel = observer(({ state }: { state: AppGraphViewState }) => {
  const selection = state.selection.get();
  const snapshot = state.model.get().snapshot.get();

  if (!selection || !snapshot) {
    return null;
  }

  return (
    <Div
      $className={[styles.overlay, styles.side, styles.glass]}
      $backgroundColor="backgroundPrimaryDimmed"
      $border={{ color: "borderPrimary", width: "xxs", radius: "m" }}
      $boxShadow
    >
      <Div $flex={{ horizontalAlign: "right" }} $padding={{ top: "xs", right: "xs" }}>
        <Button $onClick={() => state.select(undefined)} $tooltip="Close (Esc)" $interactive $padding="xxs" $border={{ radius: "m" }}>
          <CloseIcon $size="s" />
        </Button>
      </Div>
      <Div $overflow={{ y: "auto" }} $padding={{ horizontal: "m", bottom: "m" }} $flexChild>
        {selection.type === "node" && <NodeDetails state={state} id={selection.id} snapshot={snapshot} />}
        {selection.type === "app" && <AppDetails state={state} id={selection.id} snapshot={snapshot} />}
        {selection.type === "district" && <DistrictDetails state={state} id={selection.id} snapshot={snapshot} />}
      </Div>
    </Div>
  );
});
