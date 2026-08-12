"use client";

export type RoutingMode = "ai_core" | "ai_core_select" | "ai_select";

export type ChatSettings = {
  routingMode: RoutingMode;
  modelFamily: string;
  tradition: string;
  model: string;
};

type Option = { value: string; label: string };

const ROUTING_MODES: Option[] = [
  { value: "ai_core", label: "AI Core (Auto)" },
  { value: "ai_core_select", label: "AI Core Select" },
  { value: "ai_select", label: "AI Select" },
];

const MODEL_FAMILIES = [
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

const MODELS = [
  { value: "gloo-openai-gpt-5-mini", label: "GPT-5 Mini" },
  { value: "gloo-anthropic-claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { value: "gloo-google-gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { value: "gloo-deepseek-v3.2", label: "DeepSeek V3.2" },
];

function SettingSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="font-medium text-gray-600">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-sm"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SettingsBar({
  settings,
  onChange,
}: {
  settings: ChatSettings;
  onChange: (settings: ChatSettings) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-2.5 shadow-sm text-sm">
      <SettingSelect
        label="Routing"
        value={settings.routingMode}
        options={ROUTING_MODES}
        onChange={(routingMode) =>
          onChange({ ...settings, routingMode: routingMode as RoutingMode })
        }
      />

      {settings.routingMode === "ai_core_select" && (
        <SettingSelect
          label="Provider"
          value={settings.modelFamily}
          options={MODEL_FAMILIES}
          onChange={(modelFamily) => onChange({ ...settings, modelFamily })}
        />
      )}

      {settings.routingMode === "ai_select" && (
        <SettingSelect
          label="Model"
          value={settings.model}
          options={MODELS}
          onChange={(model) => onChange({ ...settings, model })}
        />
      )}

      <SettingSelect
        label="Tradition"
        value={settings.tradition}
        options={TRADITIONS}
        onChange={(tradition) => onChange({ ...settings, tradition })}
      />
    </div>
  );
}
