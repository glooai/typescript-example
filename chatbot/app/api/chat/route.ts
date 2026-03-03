import { streamText, convertToModelMessages } from "ai";
import { gloo } from "@/lib/gloo-provider";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages, routingMode, modelFamily, tradition, model } =
    await req.json();

  const modelMessages = await convertToModelMessages(messages);

  // Build Gloo-specific body params based on routing mode
  const glooParams: Record<string, unknown> = {};

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

  // For AI Select, use the specific model; otherwise use a placeholder
  // that the provider sends as `model` in the body (Gloo ignores it
  // when auto_routing is true or model_family is set).
  const modelId = routingMode === "ai_select" && model ? model : "gloo-auto";

  const result = streamText({
    model: gloo.chatModel(modelId),
    messages: modelMessages,
    ...glooParams,
  });

  return result.toUIMessageStreamResponse();
}
