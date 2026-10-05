import { valuesAt } from "./paths";
import { type GroupKind, K } from "./rules";
import { asArray, asString, field, isRecord, type KubeObject } from "./types";

export interface ExtractedRef {
  readonly target: GroupKind;
  readonly namespace: string;
  readonly name: string;
  readonly path: string;
}

export type Extractor = (object: KubeObject) => readonly ExtractedRef[];

/** Generic ephemeral volumes get a PVC named `<pod>-<volume>`, created and owned by the pod. */
const ephemeralVolumePvcNames: Extractor = (pod) =>
  asArray(field(pod, "spec", "volumes")).flatMap((volume, index) => {
    const name = asString(field(volume, "name"));

    return name && isRecord(field(volume, "ephemeral"))
      ? [
          {
            target: K.PersistentVolumeClaim,
            namespace: pod.metadata.namespace ?? "",
            name: `${pod.metadata.name}-${name}`,
            path: `spec.volumes[${index}].ephemeral`,
          },
        ]
      : [];
  });

/** `spec.target.name` defaults to the ExternalSecret's own name. */
const externalSecretTargetName: Extractor = (externalSecret) => {
  const explicit = asString(field(externalSecret, "spec", "target", "name"));

  return [
    {
      target: K.Secret,
      namespace: externalSecret.metadata.namespace ?? "",
      name: explicit || externalSecret.metadata.name,
      path: explicit ? "spec.target.name" : "metadata.name",
    },
  ];
};

/**
 * Istio destinations name a host: `svc`, `svc.ns`, `svc.ns.svc` or `svc.ns.svc.cluster.local`.
 * Anything else is taken to be outside the cluster and yields nothing.
 */
const parseServiceHost = (host: string, namespace: string): { name: string; namespace: string } | undefined => {
  const parts = host.split(".");

  if (parts.length === 1) {
    return { name: parts[0]!, namespace };
  }

  if (parts.length === 2 || (parts.length >= 3 && parts[2] === "svc")) {
    return { name: parts[0]!, namespace: parts[1]! };
  }

  return undefined;
};

const istioDestinationHosts: Extractor = (virtualService) => {
  const namespace = virtualService.metadata.namespace ?? "";
  const refs: ExtractedRef[] = [];

  for (const protocol of ["http", "tcp", "tls"]) {
    asArray(field(virtualService, "spec", protocol)).forEach((route, routeIndex) => {
      asArray(field(route, "route")).forEach((destination, destinationIndex) => {
        const host = asString(field(destination, "destination", "host"));
        const parsed = host ? parseServiceHost(host, namespace) : undefined;

        if (parsed) {
          refs.push({
            target: K.Service,
            ...parsed,
            path: `spec.${protocol}[${routeIndex}].route[${destinationIndex}].destination.host`,
          });
        }
      });
    });
  }

  return refs;
};

/** The Istio Gateways a VirtualService is bound to: `ns/name`, or `name` beside it. */
const istioVirtualServiceGateways: Extractor = (virtualService) =>
  asArray(field(virtualService, "spec", "gateways")).flatMap((value, index) => {
    const reference = asString(value);

    if (!reference || reference === "mesh") {
      return [];
    }

    const [namespace, name] = reference.includes("/") ? reference.split("/", 2) : [virtualService.metadata.namespace ?? "", reference];

    return name ? [{ target: K.IstioGateway, namespace: namespace!, name, path: `spec.gateways[${index}]` }] : [];
  });

/** A DestinationRule's `spec.host`, read like a VirtualService's destinations. */
const istioDestinationRuleHost: Extractor = (destinationRule) => {
  const host = asString(field(destinationRule, "spec", "host"));
  const parsed = host ? parseServiceHost(host, destinationRule.metadata.namespace ?? "") : undefined;

  return parsed ? [{ target: K.Service, ...parsed, path: "spec.host" }] : [];
};

// --- what a GitOps tool applied --------------------------------------------------------------

/** Argo CD keeps every resource of an Application in `status.resources`: group (core left out), kind, namespace, name. */
const argoCdApplicationResources: Extractor = (application) =>
  asArray(field(application, "status", "resources")).flatMap((resource, index) => {
    const kind = asString(field(resource, "kind"));
    const name = asString(field(resource, "name"));

    return kind && name
      ? [
          {
            target: { group: asString(field(resource, "group")) ?? "", kind },
            namespace: asString(field(resource, "namespace")) ?? "",
            name,
            path: `status.resources[${index}]`,
          },
        ]
      : [];
  });

/** Flux keeps what it applied in `status.inventory.entries[].id`: "<namespace>_<name>_<group>_<kind>". */
const fluxInventory: Extractor = (holder) =>
  asArray(field(holder, "status", "inventory", "entries")).flatMap((entry, index) => {
    const parts = (asString(field(entry, "id")) ?? "").split("_");

    if (parts.length !== 4 || !parts[1] || !parts[3]) {
      return [];
    }

    const [namespace, name, group, kind] = parts as [string, string, string, string];

    return [{ target: { group, kind }, namespace, name, path: `status.inventory.entries[${index}]` }];
  });

// --- Service DNS names in free text ----------------------------------------------------------

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = `${LABEL}(?:\\.${LABEL})*`;
/** `scheme://host`, `host:port`, or anything ending in `.svc` / `.svc.cluster.local`. */
const HOST_PATTERN = new RegExp(`(?:[a-z][a-z0-9+.-]*://(${HOST}))|(?:\\b(${HOST}):\\d{2,5}\\b)|(?:\\b(${LABEL}\\.${LABEL}\\.svc(?:\\.cluster\\.local)?)\\b)`, "gi");
/** Settings whose whole value is a host, so a bare name counts: DB_HOST=postgres. */
const HOST_SETTING = /(host|hostname|addr|address|server|service|endpoint|url|uri)$/i;
const BARE_HOST = new RegExp(`^${HOST}$`, "i");
const SCAN_LIMIT = 64 * 1024;

/** `svc`, `svc.ns`, `svc.ns.svc`, `svc.ns.svc.cluster.local`; anything longer is outside the cluster. */
const serviceOfHost = (host: string, namespace: string): { name: string; namespace: string } | undefined => {
  const parts = host.toLowerCase().replace(/\.$/, "").split(".");

  if (parts.length === 1) {
    return { name: parts[0]!, namespace };
  }

  if (parts.length === 2 || (parts.length >= 3 && parts[2] === "svc")) {
    return { name: parts[0]!, namespace: parts[1]! };
  }

  return undefined;
};

const hostsIn = (text: string, settingName?: string): string[] => {
  const hosts: string[] = [];
  const value = text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text;

  for (const match of value.matchAll(HOST_PATTERN)) {
    const host = match[1] ?? match[2] ?? match[3];

    if (host) {
      hosts.push(host);
    }
  }

  if (hosts.length === 0 && settingName && HOST_SETTING.test(settingName) && BARE_HOST.test(value.trim())) {
    hosts.push(value.trim());
  }

  return hosts;
};

const serviceRefs = (texts: ReadonlyArray<{ text: string; path: string; setting?: string }>, namespace: string): ExtractedRef[] => {
  const seen = new Set<string>();
  const refs: ExtractedRef[] = [];

  for (const { text, path, setting } of texts) {
    for (const host of hostsIn(text, setting)) {
      const service = serviceOfHost(host, namespace);
      const key = service && `${service.namespace}/${service.name}`;

      if (service && key && !seen.has(key) && service.name !== "localhost") {
        seen.add(key);
        refs.push({ target: K.Service, ...service, path });
      }
    }
  }

  return refs;
};

/** Env values, args and commands of every container in a pod spec or template. */
const serviceHostsInPodSpec: Extractor = (holder) => {
  const texts: Array<{ text: string; path: string; setting?: string }> = [];
  const gk = { group: holder.apiVersion.includes("/") ? holder.apiVersion.split("/")[0]! : "", kind: holder.kind };

  for (const containers of ["$podSpec.containers[*]", "$podSpec.initContainers[*]"]) {
    for (const { value: container, path } of valuesAt(holder, containers, gk)) {
      asArray(field(container, "env")).forEach((variable, index) => {
        const text = asString(field(variable, "value"));

        if (text) {
          texts.push({ text, path: `${path}.env[${index}].value`, setting: asString(field(variable, "name")) });
        }
      });

      for (const list of ["args", "command"]) {
        asArray(field(container, list)).forEach((argument, index) => {
          const text = asString(argument);

          if (text) {
            texts.push({ text, path: `${path}.${list}[${index}]` });
          }
        });
      }
    }
  }

  return serviceRefs(texts, holder.metadata.namespace ?? "");
};

/** A Service of type ExternalName is a CNAME; when the name is a Service of this cluster, it aliases it. */
const externalNameService: Extractor = (service) => {
  const host = asString(field(service, "spec", "externalName"));

  if (asString(field(service, "spec", "type")) !== "ExternalName" || !host) {
    return [];
  }

  const target = serviceOfHost(host, service.metadata.namespace ?? "");

  return target && !(target.name === service.metadata.name && target.namespace === service.metadata.namespace)
    ? [{ target: K.Service, ...target, path: "spec.externalName" }]
    : [];
};

/** Every value of a ConfigMap: config files name the services they talk to. */
const serviceHostsInConfig: Extractor = (configMap) => {
  const data = field(configMap, "data");
  const texts = isRecord(data)
    ? Object.entries(data).flatMap(([key, value]) => (typeof value === "string" ? [{ text: value, path: `data["${key}"]`, setting: key }] : []))
    : [];

  return serviceRefs(texts, configMap.metadata.namespace ?? "");
};

export const EXTRACTORS: Readonly<Record<string, Extractor>> = {
  "argocd-application-resources": argoCdApplicationResources,
  "ephemeral-volume-pvc-names": ephemeralVolumePvcNames,
  "external-name-service": externalNameService,
  "external-secret-target-name": externalSecretTargetName,
  "flux-inventory": fluxInventory,
  "istio-destination-hosts": istioDestinationHosts,
  "istio-destinationrule-host": istioDestinationRuleHost,
  "istio-virtualservice-gateways": istioVirtualServiceGateways,
  "service-hosts-in-pod-spec": serviceHostsInPodSpec,
  "service-hosts-in-config": serviceHostsInConfig,
};

// --- names that follow a pattern ------------------------------------------------------------

/** One way a holder's targets are named, and the field that says so. */
export interface NamePattern {
  readonly pattern: RegExp;
  readonly path: string;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "<template>-<set>-<ordinal>", one pattern per volumeClaimTemplate. */
const statefulSetClaims = (statefulSet: KubeObject): readonly NamePattern[] =>
  asArray(field(statefulSet, "spec", "volumeClaimTemplates")).flatMap((template, index) => {
    const name = asString(field(template, "metadata", "name"));

    return name
      ? [{ pattern: new RegExp(`^${escape(name)}-${escape(statefulSet.metadata.name)}-\\d+$`), path: `spec.volumeClaimTemplates[${index}]` }]
      : [];
  });

export const NAME_PATTERNS: Readonly<Record<string, (holder: KubeObject) => readonly NamePattern[]>> = {
  "statefulset-claims": statefulSetClaims,
};
