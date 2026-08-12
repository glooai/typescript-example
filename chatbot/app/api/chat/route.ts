import {
  streamText,
  convertToModelMessages,
  type JSONValue,
  type UIMessage,
} from "ai";
import { gloo } from "@/lib/gloo-provider";
import type { ChatSettings } from "@/components/settings-bar";

export const maxDuration = 60;

type ChatRequest = Partial<ChatSettings> & { messages: UIMessage[] };

export async function POST(req: Request) {
  const { messages, routingMode, modelFamily, tradition, model } =
    (await req.json()) as ChatRequest;

  const modelMessages = await convertToModelMessages(messages);

  const glooParams: Record<string, JSONValue> = {};

  switch (routingMode) {
    case "ai_core_select":
      // Caller picks the provider family, Gloo picks the model within it.
      glooParams.auto_routing = false;
      glooParams.model_family = modelFamily || "openai";
      break;
    case "ai_select":
      // Caller picks the exact model.
      glooParams.auto_routing = false;
      break;
    default:
      // AI Core: Gloo routes on its own.
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
