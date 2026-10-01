import { getFeature, registerInjectablesFromModules } from "@k8slens/feature-core";
import modulesWithInjectables from "./**/*.injectable.(ts|tsx)";
import stylesheets from "./**/!(_*).(scss|css)";

export const appGraphFeature = getFeature({
  id: "app-graph",
  register: (di) => {
    // Every `*.injectable.(ts|tsx)` under src registers itself, and so does every stylesheet.
    registerInjectablesFromModules(di, [...modulesWithInjectables, ...stylesheets]);
  },
});
