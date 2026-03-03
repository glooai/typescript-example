"use client";

export type RoutingMode = "ai_core" | "ai_core_select" | "ai_select";

export type ChatSettings = {
  routingMode: RoutingMode;
  modelFamily: string;
  tradition: string;
  model: string;
};

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

export function SettingsBar({
  settings,
  onChange,
}: {
  settings: ChatSettings;
  onChange: (settings: ChatSettings) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-2.5 shadow-sm text-sm">
      <label className="flex items-center gap-1.5">
        <span className="font-medium text-gray-600">Routing</span>
        <select
          value={settings.routingMode}
          onChange={(e) =>
            onChange({
              ...settings,
              routingMode: e.target.value as RoutingMode,
            })
          }
          className="rounded-lg border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-sm"
        >
          <option value="ai_core">AI Core (Auto)</option>
          <option value="ai_core_select">AI Core Select</option>
          <option value="ai_select">AI Select</option>
        </select>
      </label>

      {settings.routingMode === "ai_core_select" && (
        <label className="flex items-center gap-1.5">
          <span className="font-medium text-gray-600">Provider</span>
          <select
            value={settings.modelFamily}
            onChange={(e) =>
              onChange({ ...settings, modelFamily: e.target.value })
            }
            className="rounded-lg border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-sm"
          >
            {MODEL_FAMILIES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {settings.routingMode === "ai_select" && (
        <label className="flex items-center gap-1.5">
          <span className="font-medium text-gray-600">Model</span>
          <select
            value={settings.model}
            onChange={(e) => onChange({ ...settings, model: e.target.value })}
            className="rounded-lg border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-sm"
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="flex items-center gap-1.5">
        <span className="font-medium text-gray-600">Tradition</span>
        <select
          value={settings.tradition}
          onChange={(e) => onChange({ ...settings, tradition: e.target.value })}
          className="rounded-lg border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-sm"
        >
          {TRADITIONS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
