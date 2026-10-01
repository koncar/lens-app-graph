import { asArray, asString, isRecord, type Json, stringMap } from "./types";

export interface LabelSelectorRequirement {
  readonly key: string;
  readonly operator: "In" | "NotIn" | "Exists" | "DoesNotExist";
  readonly values: readonly string[];
}

export interface CompiledSelector {
  readonly matchLabels: Readonly<Record<string, string>>;
  readonly matchExpressions: readonly LabelSelectorRequirement[];
  /** Selects nothing: a missing selector, or an empty one where the rule says empty means none. */
  readonly matchesNothing: boolean;
}

const isOperator = (value: string | undefined): value is LabelSelectorRequirement["operator"] =>
  value === "In" || value === "NotIn" || value === "Exists" || value === "DoesNotExist";

/**
 * Compiles a selector with Kubernetes semantics. `form: "map"` is a plain map of labels (a
 * Service's `spec.selector`); `"labelSelector"` is `matchLabels` plus `matchExpressions`.
 * A missing selector always matches nothing; `empty` says what `{}` means.
 */
export const compileSelector = (selector: Json, form: "map" | "labelSelector", empty: "all" | "none"): CompiledSelector => {
  if (!isRecord(selector)) {
    return { matchLabels: {}, matchExpressions: [], matchesNothing: true };
  }

  const matchLabels = form === "map" ? stringMap(selector) : stringMap(selector.matchLabels);
  const matchExpressions: LabelSelectorRequirement[] = [];

  if (form === "labelSelector") {
    for (const expression of asArray(selector.matchExpressions)) {
      const key = asString(isRecord(expression) ? expression.key : undefined);
      const operator = asString(isRecord(expression) ? expression.operator : undefined);

      if (!key || !isOperator(operator)) {
        // An expression we cannot evaluate must not widen the selector: select nothing.
        return { matchLabels, matchExpressions, matchesNothing: true };
      }

      const values = asArray(isRecord(expression) ? expression.values : undefined).filter(
        (value): value is string => typeof value === "string",
      );

      matchExpressions.push({ key, operator, values });
    }
  }

  const isEmpty = Object.keys(matchLabels).length === 0 && matchExpressions.length === 0;

  return { matchLabels, matchExpressions, matchesNothing: isEmpty && empty === "none" };
};

export const selectorMatches = (selector: CompiledSelector, labels: Readonly<Record<string, string>> | undefined) => {
  if (selector.matchesNothing) {
    return false;
  }

  const actual = labels ?? {};

  for (const [key, value] of Object.entries(selector.matchLabels)) {
    if (actual[key] !== value) {
      return false;
    }
  }

  for (const { key, operator, values } of selector.matchExpressions) {
    const has = Object.prototype.hasOwnProperty.call(actual, key);

    switch (operator) {
      case "In":
        if (!has || !values.includes(actual[key]!)) {
          return false;
        }
        break;
      case "NotIn":
        if (has && values.includes(actual[key]!)) {
          return false;
        }
        break;
      case "Exists":
        if (!has) {
          return false;
        }
        break;
      case "DoesNotExist":
        if (has) {
          return false;
        }
        break;
    }
  }

  return true;
};
