import { Badge } from "@k8slens/badge";
import { DrawerItem } from "@k8slens/details-panel-components";
import { buildDetailsPanelSectionBunch } from "@k8slens/details-panel-contracts";
import { Div, Span } from "@k8slens/element-components";
import { getInjectable2 } from "@k8slens/injectable";
import { PlainButton } from "@k8slens/input-components";
import {
  appsV1,
  batchV1,
  configMapKind,
  coreV1,
  cronJobKind,
  daemonSetKind,
  deploymentKind,
  ingressKind,
  jobKind,
  networkingV1,
  persistentVolumeClaimKind,
  podKind,
  secretKind,
  serviceAccountKind,
  serviceKind,
  statefulSetKind,
} from "@k8slens/kubernetes-contracts";
import { useSubscribable } from "@k8slens/subscribable-react";
import { useInject, useSyncInject } from "@k8slens/use-inject";
import { computed } from "mobx";
import { observer } from "mobx-react";
import { appGraphLiveBunch } from "../data/app-graph-live.injectable";
import { ALL_NAMESPACES, appGraphModelInjectable } from "../data/app-graph-model.injectable";
import { groupOfApiVersion, objectKey, parseObjectKey } from "../graph/types";
import { AppGraphIcon } from "../ui/graph-icons";
import { showAppGraphInjectable } from "./app-graph-navigation.injectable";

/** What the graph knows about one resource, from the model of its namespace. */
const resourceGraphSummaryInjectable = getInjectable2({
  id: "app-graph-resource-summary",

  instantiate: (di) => {
    const modelFor = di.inject(appGraphModelInjectable);

    return (clusterId: string, scope: string, id: string) =>
      computed(() => {
        const model = modelFor(clusterId, scope);
        const snapshot = model.snapshot.get();
        const progress = model.progress.get();

        if (!snapshot || progress.settled < progress.total) {
          return { loading: true as const };
        }

        const node = snapshot.nodes.get(id);
        const app = node?.appId ? snapshot.apps.get(node.appId) : undefined;
        const broken = (snapshot.outOf.get(id) ?? []).filter((edge) => edge.state === "missing");

        return {
          loading: false as const,
          node,
          app,
          broken,
          references: snapshot.outOf.get(id)?.length ?? 0,
          referencedBy: snapshot.into.get(id)?.length ?? 0,
          sharedBy: node?.claimedBy.map((appId) => snapshot.apps.get(appId)?.name ?? appId) ?? [],
        };
      });
  },
});

interface SectionProps {
  readonly resource: { readonly apiVersion: string; readonly kind: string; readonly metadata: { readonly name: string; readonly namespace?: string } };
  readonly clusterId: string;
}

const AppGraphSection = observer(({ resource, clusterId }: SectionProps) => {
  const { name, namespace } = resource.metadata;
  const scope = namespace ?? ALL_NAMESPACES;
  const group = groupOfApiVersion(resource.apiVersion);
  const id = objectKey({ group, kind: resource.kind }, namespace ?? "", name);

  useSubscribable(useSyncInject(appGraphLiveBunch.subscribable, clusterId, scope));

  const summary = useInject(resourceGraphSummaryInjectable)(clusterId, scope, id).get();
  const showAppGraph = useInject(showAppGraphInjectable)();
  const open = () => void showAppGraph(clusterId, { group, kind: resource.kind, namespace, name });

  if (summary.loading) {
    return <DrawerItem name="App">Reading relationships…</DrawerItem>;
  }

  const { app, node, broken, references, referencedBy, sharedBy } = summary;

  return (
    <>
      <DrawerItem name="App">
        {app ? (
          <Span>
            {app.name} <Span $color="textMuted">({app.source})</Span>
          </Span>
        ) : node?.role === "shared" ? (
          `Shared by ${sharedBy.join(", ")}`
        ) : node?.role === "hub" ? (
          "Shared by many apps"
        ) : (
          "Not part of an app"
        )}
      </DrawerItem>
      {app && (
        <DrawerItem name="App resources">
          {app.members.length}
          {app.pods > 0 ? `, ${app.readyPods}/${app.pods} pods ready` : ""}
          {app.problems > 0 ? `, ${app.problems} with problems` : ""}
        </DrawerItem>
      )}
      <DrawerItem name="Relationships">
        {references} out, {referencedBy} in
      </DrawerItem>
      {broken.length > 0 && (
        <DrawerItem name="Broken references">
          <Div $flex={{ direction: "vertical", gap: "xxs" }}>
            {broken.map((edge) => (
              <Div key={edge.id} $flex={{ gap: "xs", verticalAlign: "center", wrap: true }}>
                <Badge small label="missing" $backgroundColor="critical" $color="white" />
                <Span>
                  {edge.toGroupKind.kind} {parseObjectKey(edge.to).name}
                </Span>
                <Span $font={{ size: "xs" }} $color="textMuted">
                  {edge.path}
                </Span>
              </Div>
            ))}
          </Div>
        </DrawerItem>
      )}
      <DrawerItem name="">
        <PlainButton Icon={AppGraphIcon} onClick={open}>
          Show in App Graph
        </PlainButton>
      </DrawerItem>
    </>
  );
});

const section = (id: string) => ({ id: `app-graph-${id}`, title: "App Graph", orderNumber: 35, Component: AppGraphSection });

export const deploymentSection = buildDetailsPanelSectionBunch({ ...section("deployment"), kind: deploymentKind, apiVersion: appsV1 });
export const statefulSetSection = buildDetailsPanelSectionBunch({ ...section("stateful-set"), kind: statefulSetKind, apiVersion: appsV1 });
export const daemonSetSection = buildDetailsPanelSectionBunch({ ...section("daemon-set"), kind: daemonSetKind, apiVersion: appsV1 });
export const cronJobSection = buildDetailsPanelSectionBunch({ ...section("cron-job"), kind: cronJobKind, apiVersion: batchV1 });
export const jobSection = buildDetailsPanelSectionBunch({ ...section("job"), kind: jobKind, apiVersion: batchV1 });
export const podSection = buildDetailsPanelSectionBunch({ ...section("pod"), kind: podKind, apiVersion: coreV1 });
export const serviceSection = buildDetailsPanelSectionBunch({ ...section("service"), kind: serviceKind, apiVersion: coreV1 });
export const ingressSection = buildDetailsPanelSectionBunch({ ...section("ingress"), kind: ingressKind, apiVersion: networkingV1 });
export const configMapSection = buildDetailsPanelSectionBunch({ ...section("config-map"), kind: configMapKind, apiVersion: coreV1 });
export const secretSection = buildDetailsPanelSectionBunch({ ...section("secret"), kind: secretKind, apiVersion: coreV1 });
export const pvcSection = buildDetailsPanelSectionBunch({ ...section("pvc"), kind: persistentVolumeClaimKind, apiVersion: coreV1 });
export const serviceAccountSection = buildDetailsPanelSectionBunch({ ...section("service-account"), kind: serviceAccountKind, apiVersion: coreV1 });
