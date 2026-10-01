import { getInjectable2 } from "@k8slens/injectable";
import { comparer, computed, observable, reaction, runInAction } from "mobx";
import { AppGraphScene } from "../scene/app-graph-scene";
import { appGraphSettingsInjectable, type BooleanSetting, type GraphMode } from "./settings.injectable";
import { appGraphViewStateInjectable, type Selection } from "./view-state.injectable";

const KEY_TOGGLES: Readonly<Record<string, BooleanSetting>> = {
  l: "labels",
  p: "problemsOnly",
};

/**
 * Binds one cluster's view state to a 3D scene. `attach` is a stable callback ref: Lens hands it
 * the element when the tab's viewport mounts and `null` when it goes, so the scene (and its GL
 * context) lives exactly as long as the viewport, with no effect in the component.
 */
export const appGraphSceneControllerInjectable = getInjectable2({
  id: "app-graph-scene-controller",

  instantiate: (di) => {
    const viewStateFor = di.inject(appGraphViewStateInjectable);
    const settings = di.inject(appGraphSettingsInjectable)();

    return (clusterId: string, mode: GraphMode) => {
      const state = viewStateFor(clusterId, mode);
      const failure = observable.box<string | undefined>(undefined);
      const legendOpen = observable.box(false);
      let flownNonce = 0;
      let teardown: (() => void) | undefined;

      const open = (target: Selection) => {
        if (target.type === "node") {
          state.select(target);
          void state.openDetails(target.id);
        } else {
          state.select(target, { fly: true });
        }
      };

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey || event.altKey) {
          return;
        }

        const key = event.key.toLowerCase();
        const toggle = KEY_TOGGLES[key];

        if (toggle) {
          settings.toggle(toggle);
        } else if (key === "r") {
          state.fly("overview");
        } else if (key === "f") {
          const selected = state.selection.get();

          state.fly(selected ?? "overview");
        } else if (key === "escape") {
          state.select(undefined);
        } else if (key === "?") {
          runInAction(() => legendOpen.set(!legendOpen.get()));
        } else {
          return;
        }

        event.preventDefault();
      };

      const attach = (element: HTMLElement | null) => {
        teardown?.();
        teardown = undefined;

        if (!element) {
          return;
        }

        let scene: AppGraphScene;

        try {
          scene = new AppGraphScene(element, {
            hover: (target) => state.hover(target),
            select: (target) => state.select(target),
            open,
          });
          runInAction(() => failure.set(undefined));
        } catch (error) {
          runInAction(() => failure.set(error instanceof Error ? error.message : String(error)));

          return;
        }

        let framed = false;

        const flyIfRequested = () => {
          const request = state.flyRequest.get();

          if (request && request.nonce > flownNonce) {
            flownNonce = request.nonce;
            scene.fly(request.target);
          }
        };

        const disposers = [
          reaction(
            () => state.layout.get(),
            (layout) => {
              scene.setLayout(layout);

              if (layout && layout.nodes.size > 0 && !framed) {
                framed = true;

                if (state.camera.memory) {
                  scene.restoreCamera(state.camera.memory);
                } else {
                  scene.fly("overview", true);
                }

                flyIfRequested();
              }
            },
            { fireImmediately: true },
          ),
          reaction(
            () => ({
              selected: state.selection.get(),
              hovered: state.hovered.get(),
              matches: state.searchMatches.get(),
              problemsOnly: settings.get.get().problemsOnly,
            }),
            (emphasis) => scene.setEmphasis(emphasis),
            { fireImmediately: true, equals: comparer.shallow },
          ),
          reaction(
            // Packets travel the traffic view; the app view stays still.
            () => ({ labels: settings.get.get().labels, traffic: mode === "traffic" }),
            (options) => scene.setOptions(options),
            { fireImmediately: true, equals: comparer.structural },
          ),
          reaction(
            () => state.flyRequest.get(),
            () => {
              if (framed) {
                flyIfRequested();
              }
            },
          ),
        ];

        element.addEventListener("keydown", onKeyDown);

        teardown = () => {
          element.removeEventListener("keydown", onKeyDown);
          state.camera.memory = scene.cameraMemory();
          disposers.forEach((dispose) => dispose());
          scene.dispose();
        };
      };

      return {
        attach,
        failure: computed(() => failure.get()),
        legendOpen: computed(() => legendOpen.get()),
        toggleLegend: () => runInAction(() => legendOpen.set(!legendOpen.get())),
      };
    };
  },
});
