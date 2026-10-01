import { getInjectable2 } from "@k8slens/injectable";
import { getPersistableValueInjectableBunch } from "@k8slens/persistable-contracts";
import { action, computed, type IObservableValue, observable, runInAction } from "mobx";

/** Two views of one cluster: its apps and what they are made of, or the traffic between them. */
export type GraphMode = "apps" | "traffic";

export interface AppGraphSettings {
  /** Names over apps and the resources near the camera. */
  readonly labels: boolean;
  /** Dim everything that is healthy. */
  readonly problemsOnly: boolean;
  readonly showReplicaSets: boolean;
  readonly showShared: boolean;
  readonly showUnattached: boolean;
  readonly showInfra: boolean;
  readonly showHistory: boolean;
}

export const defaultSettings = (): AppGraphSettings => ({
  labels: true,
  problemsOnly: false,
  showReplicaSets: false,
  showShared: false,
  showUnattached: false,
  showInfra: false,
  showHistory: false,
});

export const appGraphSettingsBunch = getPersistableValueInjectableBunch<Partial<AppGraphSettings>>()({
  id: "settings",
  defaultValue: { instantiate: () => async () => ({}) },
});

export type BooleanSetting = { [K in keyof AppGraphSettings]: AppGraphSettings[K] extends boolean ? K : never }[keyof AppGraphSettings];

/** The user's display choices, the same for every cluster, remembered across restarts. */
export const appGraphSettingsInjectable = getInjectable2({
  id: "app-graph-settings",

  instantiate: (di) => {
    const getPersisted = di.inject(appGraphSettingsBunch.persistable);

    return () => {
      const current = observable.box<AppGraphSettings>(defaultSettings(), { deep: false });
      let persisted: IObservableValue<Partial<AppGraphSettings>> | undefined;

      void getPersisted().then((box) => {
        persisted = box;
        runInAction(() => current.set({ ...defaultSettings(), ...box.get() }));
      });

      const update = action((change: Partial<AppGraphSettings>) => {
        const next = { ...current.get(), ...change };

        current.set(next);
        persisted?.set(next);
      });

      return {
        get: computed(() => current.get()),
        update,
        toggle: (setting: BooleanSetting) => update({ [setting]: !current.get()[setting] }),
      };
    };
  },
});

export const appGraphNamespacesBunch = getPersistableValueInjectableBunch<readonly string[], [clusterId: string, mode: GraphMode]>()({
  id: "namespaces",
  defaultValue: { instantiate: () => async () => [] },
});
