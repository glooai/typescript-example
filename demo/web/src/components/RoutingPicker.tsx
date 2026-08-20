import type { ModelSummary, RoutingSelection } from "../types";
import { Select } from "./ui";

const FAMILIES = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
  { value: "open source", label: "Open Source" },
];

const TRADITIONS = [
  { value: "", label: "General" },
  { value: "evangelical", label: "Evangelical" },
  { value: "catholic", label: "Catholic" },
  { value: "mainline", label: "Mainline" },
];

const MODE_LABELS: Record<RoutingSelection["mode"], string> = {
  auto_routing: "AI Core (auto)",
  model_family: "AI Core Select (family)",
  model: "AI Select (exact model)",
};

/**
 * The three Completions V2 routing mechanisms, exposed as one control.
 * Only the field relevant to the chosen mechanism is rendered, which is
 * also how the request is built: exactly one routing key ever reaches the
 * API, as the contract requires.
 */
export function RoutingPicker({
  value,
  onChange,
  models,
  showTradition = true,
}: {
  value: RoutingSelection;
  onChange: (next: RoutingSelection) => void;
  models: ModelSummary[];
  showTradition?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3">
      <Select
        label="Routing"
        value={value.mode}
        onChange={(mode) =>
          onChange({
            ...value,
            mode: mode as RoutingSelection["mode"],
            modelFamily:
              mode === "model_family"
                ? (value.modelFamily ?? "anthropic")
                : undefined,
            model:
              mode === "model"
                ? (value.model ?? models[0]?.id ?? "gloo-openai-gpt-5-mini")
                : undefined,
          })
        }
      >
        {(Object.keys(MODE_LABELS) as RoutingSelection["mode"][]).map(
          (mode) => (
            <option key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </option>
          )
        )}
      </Select>

      {value.mode === "model_family" && (
        <Select
          label="Family"
          value={value.modelFamily ?? "anthropic"}
          onChange={(modelFamily) => onChange({ ...value, modelFamily })}
        >
          {FAMILIES.map((family) => (
            <option key={family.value} value={family.value}>
              {family.label}
            </option>
          ))}
        </Select>
      )}

      {value.mode === "model" && (
        <Select
          label="Model"
          value={value.model ?? ""}
          onChange={(model) => onChange({ ...value, model })}
        >
          {models.length === 0 && <option value="">loading</option>}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </Select>
      )}

      {showTradition && (
        <Select
          label="Tradition"
          value={value.tradition ?? ""}
          onChange={(tradition) =>
            onChange({ ...value, tradition: tradition || undefined })
          }
        >
          {TRADITIONS.map((tradition) => (
            <option key={tradition.value} value={tradition.value}>
              {tradition.label}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}
