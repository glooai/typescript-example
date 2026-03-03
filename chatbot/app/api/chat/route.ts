import { streamText, convertToModelMessages, type JSONValue } from "ai";
import { gloo } from "@/lib/gloo-provider";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages, routingMode, modelFamily, tradition, model } =
    await req.json();

  const modelMessages = await convertToModelMessages(messages);

  // Build Gloo-specific body params based on routing mode
  const glooParams: Record<string, JSONValue> = {};

  switch (routingMode) {
    case "ai_core_select":
      // AI Core Select — specify provider family, Gloo picks the model
      glooParams.auto_routing = false;
      glooParams.model_family = modelFamily || "openai";
      break;
    case "ai_select":
      // AI Select — caller specifies exact model
      glooParams.auto_routing = false;
      break;
    default:
      // AI Core — auto-routing (recommended)
      glooParams.auto_routing = true;
      break;
  }

  if (tradition) {
    glooParams.tradition = tradition;
  }

  // For AI Select, use the caller's exact model; otherwise use a placeholder
  // (the provider's fetch wrapper strips `model` when auto_routing or
  // model_family is active, so the placeholder never reaches the API).
  const modelId = routingMode === "ai_select" && model ? model : "gloo-auto";

  const result = streamText({
    model: gloo.chatModel(modelId),
    messages: modelMessages,
    providerOptions: {
      gloo: glooParams,
    },
  });

  return result.toUIMessageStreamResponse();
}
