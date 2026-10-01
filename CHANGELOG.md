# Changelog

What changed in each version of this extension, newest first.

## 0.1.0

- A 3D graph of the apps in a cluster: namespaces, apps and their resources, health and broken references, updating live.
- A Traffic Graph of every path a request takes: internet, ingresses and gateways, routes, Services, the workloads behind them, and the Services they call (inferred from Service DNS names in env, args and ConfigMaps).
- Istio Gateways and the VirtualServices bound to them are ways into the cluster in the Traffic Graph.
- With Istio or Linkerd and Prometheus, the Traffic Graph draws the traffic the mesh measured, coloured by error rate.
- Every resource is a Kubernetes-style token with its kind's icon, in 3D, in labels and in the side panel.
- Apps are recognised from Helm releases, Argo CD, Flux and `app.kubernetes.io/instance`, or from a workload on its own.
- A side panel explains every relationship down to the field it was found in.
- Open them from the navigator (App Graph under each cluster, Traffic Graph inside it), the menu of any resource, the command palette, or the new App Graph section of a resource's details.
- Search, namespace filters, and switches for labels, problems only, and hidden kinds.
- Kinds you cannot list cluster-wide are listed per namespace instead.
