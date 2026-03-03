> ## Documentation Index
> Fetch the complete documentation index at: https://docs.gloo.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Completions

> Chat Completions V2. Values Aligned. Smart Routing. Better Results. Lower Costs.

The Gloo Completions V2 API is built on a layered, production-ready AI architecture that embeds values, safety, and care directly into today’s best models before, during, and after use.

## **System Capabilities**

* Curated Foundational Models: Access the best foundational models available without decision fatigue or unsafe defaults.
* Safe & Values-Aligned: Values alignment and AI safety is evaluted at every layer of the input and output, considering six dimensions of AI safety (Physical, Ethical, Emotional, Factual, Theological, and Security)
* Intelligent Routing: Optional automatic model routing optimizes your outputs for quality, cost, and intent.

## **Why Completions V2?**

Completions V2 builds on the standard chat completions format you already know, but adds three powerful routing mechanisms to help you get the best performance for every query.

### Choose your Routing Strategy

| Routing Mode   | Best For                                           | How It Works                                                                                                     |
| -------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| AI Core        | General chat, customer support, content generation | Analyzes each query and automatically selects the optimal model tier (speed vs. capability)                      |
| AI Core Select | Provider preference, testing across model families | Specify a provider (OpenAI. Anthropic, Gemini, Open Source) and let Gloo AI pick the best model from that family |
| AI Select      | Full control, benchmarking, specialized tasks      | Explicitly choose a specific model such as `gloo-openai-gpt-5-mini` or `gloo-anthropic-claude-haiku-4.5`         |

### 1. AI Core (Auto-Routing) \[Recommended]

Let Gloo AI analyze your query and choose the best model automatically:

```
{
	"messages": [
	 { "role": "user", "content": "How does the Old Testament connect to the New Testament?" }
	],
	"auto_routing": true,
	"stream": false
}
```

This is ideal when you want Gloo’s optimized choice across speed, utility, and reasoning without manual comparison.

### 2. AI Core Select (Model Provider Selection)

Specify a model provider (`model_family`):

```
{
  "messages": [
    { "role": "user", "content": "Draft a sermon" }
  ],
  "model_family": "anthropic",
  "auto_routing": false
}
```

This is ideal if you prefer a specific provider but want Gloo AI to optimize your output by choosing the model from within that group.

### 3. AI Select (Direct Model Choice)

Specify the exact model for your output:

```
{
  "messages": [
    { "role": "user", "content": "Summarize this article" }
  ],
  "model": "gloo-google-gemini-2.5-pro",
  "auto_routing": false
}
```

Choose a specific model directly for benchmarking, specialized workflows, or strict reproducibility.

You can view supported model ids for this endpoint on the [Supported Models](/api-guides/supported-models) page.

## Additional Features

Completions V2 isn’t just about routing—it’s designed to support the broader goal of **values-aligned AI** that is **safe, intelligent, and production-ready**.

### Tradition-Aware

Customize responses based on theological perspectives:

```
{
  "messages": [
    { "role": "user", "content": "Who is the Holy Spirit?" }
  ],
  "auto_routing": true,
  "tradition": "evangelical"
}
```

Supported: `"evangelical"`, `"catholic"`, `"mainline"`, or omit for a general Christian perspective

### Streaming Support

Get real-time responses for better UX:

```
{
  "messages": [...],
  "auto_routing": true,
  "stream": true
}
```

### Tool Calling

Function calling works seamlessly with all routing modes. You can define tools in your request and the selected model will invoke them as needed:

```json  theme={null}
{
  "messages": [
    { "role": "user", "content": "What's the weather in Shanghai?" }
  ],
  "auto_routing": true,  // or use model/model_family
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather for a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": { "type": "string" },
            "unit": { "type": "string", "enum": ["celsius", "fahrenheit"] }
          },
          "required": ["location"]
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

For comprehensive tool calling documentation including:

* Multiple SDK examples (Python, TypeScript, AgentKit)
* Model compatibility and streaming support
* Multi-step tool workflows
* Best practices and patterns

See our **[Tool Use Guide](/api-guides/tool-use)**.

## Prerequisites

Before starting, ensure you have:

* A Gloo AI Studio account
* Your Client ID and Client Secret from the [API Credentials page](/studio/manage-api-credentials)
* **Authentication setup** - Complete the [Authentication Tutorial](/tutorials/authentication) first

**URL:** `https://platform.ai.gloo.com/ai/v2/chat/completions`

**Operation:** `POST`

#### Example CURL Request:

```bash  theme={null}
curl -X 'POST' \
  'https://platform.ai.gloo.com/ai/v2/chat/completions' \
  -H 'accept: application/json' \
  -H 'Authorization: Bearer ${ACCESS_TOKEN}' \
  -H 'Content-Type: application/json' \
  -d '{
  "messages": [
    {
      "role": "user",
      "content": "How does the Hebrew term 'ruach' in Genesis 1:2 affect translation?"
    }
  ],
  "tradition": "evangelical",
  "auto_routing": true
}'
```

## Request Parameters

| Parameter      | Type    | Required?   | Description                                                      |
| :------------- | :------ | :---------- | :--------------------------------------------------------------- |
| `messages`     | array   | Yes         | Chat message history                                             |
| `auto_routing` | boolean | Conditional | Enable smart routing                                             |
| `model`        | string  | Conditional | Gloo model id                                                    |
| `model_family` | string  | Conditional | Provider family (`openai`, `anthropic`, `google`, `open source`) |
| `tradition`    | string  | No          | Theological Perspective                                          |
| `stream`       | boolean | No          | Enable streaming (default: `false`)                              |
| `temperature`  | float   | No          | Sampling temperature (0.0-2.0)                                   |
| `max_tokens`   | integer | No          | Maximum response length                                          |
| `tools`        | array   | No          | Function calling definitions                                     |

Exactly one routing mechanism must be specified: `auto_routing`, `model`, or `model_family`

### Response Metadata

The response includes routing metadata that varies based on your model selection mode.

**Common fields (all modes):**

| Field               | Description                                                                          |
| ------------------- | ------------------------------------------------------------------------------------ |
| `model`             | The Gloo model ID that handled the request                                           |
| `provider`          | Always `"Gloo AI"`                                                                   |
| `model_family`      | The provider family (`OpenAI`, `Anthropic`, `Google`, `Open Source`)                 |
| `auto_routing`      | Whether auto-routing was enabled                                                     |
| `routing_mechanism` | The selection mode used: `auto_routing`, `model_family`, or `direct_model_selection` |

**Additional fields for auto-routing and model family modes:**

| Field                | Description                                        |
| -------------------- | -------------------------------------------------- |
| `routing_tier`       | The model tier selected (e.g., `tier_2`, `tier_4`) |
| `routing_confidence` | Confidence score for the routing decision (0-1)    |

**Optional fields (included if specified in request):**

| Field       | Description                                                                    |
| ----------- | ------------------------------------------------------------------------------ |
| `tradition` | The theological perspective used (e.g., `evangelical`, `catholic`, `mainline`) |

#### Example: Auto-Routing Response

```json  theme={null}
{
  "id": "gen-1768500882-56HaBYeuAb4pLpv8PXqh",
  "object": "chat.completion",
  "created": 1768500882,
  "model": "gloo-openai-gpt-5.2",
  "provider": "Gloo AI",
  "model_family": "OpenAI",
  "auto_routing": true,
  "routing_mechanism": "auto_routing",
  "routing_tier": "tier_2",
  "routing_confidence": 0.557,
  "choices": [...],
  "usage": {...}
}
```

#### Example: Model Family Response

```json  theme={null}
{
  "id": "gen-1768501093-eWeO7cEfSgTPxxUmEgCI",
  "object": "chat.completion",
  "created": 1768501093,
  "model": "gloo-openai-gpt-oss-120b",
  "provider": "Gloo AI",
  "model_family": "Open Source",
  "auto_routing": false,
  "routing_mechanism": "model_family",
  "routing_tier": "tier_2",
  "routing_confidence": 0.555,
  "choices": [...],
  "usage": {...}
}
```

#### Example: Direct Model Selection Response

```json  theme={null}
{
  "id": "gen-1768498306-NYVIJq1ygiReBbX1AKwP",
  "object": "chat.completion",
  "created": 1768498306,
  "model": "gloo-deepseek-v3.2",
  "provider": "Gloo AI",
  "model_family": "Open Source",
  "auto_routing": false,
  "routing_mechanism": "direct_model_selection",
  "choices": [...],
  "usage": {...}
}
```

<Note>
  `routing_tier` and `routing_confidence` are not included when using direct model selection since no routing decision is made.
</Note>

## Migrating from Completions V1

If you're currently using the V1 completions endpoint (`/ai/v1/chat/completions`), here's what you need to know to migrate to V2.

### Endpoint Change

| Version | Endpoint                                              |
| ------- | ----------------------------------------------------- |
| V1      | `https://platform.ai.gloo.com/ai/v1/chat/completions` |
| V2      | `https://platform.ai.gloo.com/ai/v2/chat/completions` |

### Request Parameter Changes

The main difference is how you specify model selection:

| V1                                               | V2                                                     |
| ------------------------------------------------ | ------------------------------------------------------ |
| `model` optional (uses fixed default if omitted) | Choose one: `auto_routing`, `model`, or `model_family` |

**If you're not specifying a model in V1**, the simplest migration path is to use V2's auto-routing, which intelligently selects the best model for each request:

```json  theme={null}
{
  "auto_routing": true,
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}
```

**If you're specifying a model in V1**, you can continue using the `model` parameter in V2:

**V1 Request:**

```json  theme={null}
{
  "model": "gloo-anthropic-claude-haiku-4.5",
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}
```

**V2 Request (equivalent):**

```json  theme={null}
{
  "model": "gloo-anthropic-claude-haiku-4.5",
  "auto_routing": false,
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}
```

### New V2-Only Parameters

| Parameter      | Type    | Description                                                         |
| -------------- | ------- | ------------------------------------------------------------------- |
| `auto_routing` | boolean | Enable intelligent model selection                                  |
| `model_family` | string  | Select by provider (`openai`, `anthropic`, `google`, `open source`) |
| `tradition`    | string  | Theological perspective (`evangelical`, `catholic`, `mainline`)     |

### Response Changes

V2 responses include additional routing metadata. The exact fields vary by routing mode—see [Response Metadata](#response-metadata) for full details.

Example (auto-routing with tradition):

```json  theme={null}
{
  "model": "gloo-openai-gpt-5.2",
  "provider": "Gloo AI",
  "model_family": "OpenAI",
  "auto_routing": true,
  "routing_mechanism": "auto_routing",
  "routing_tier": "tier_2",
  "routing_confidence": 0.557,
  "tradition": "evangelical",
  ...
}
```

<Note>
  `routing_tier` and `routing_confidence` are only included for auto-routing and model family modes. The `tradition` field is only included if specified in the request.
</Note>

### Migration Checklist

1. Update the endpoint URL from `/ai/v1/` to `/ai/v2/`
2. Add a routing mechanism to your request:
   * Set `auto_routing: true` to use smart routing (recommended)
   * Or keep using `model` with `auto_routing: false` for direct model selection
   * Or use `model_family` to let Gloo select the best model from a provider
3. Update model IDs to [V2-supported models](/api-guides/supported-models)
4. (Optional) Add `tradition` parameter for theology-aware responses
5. Update response handling to accommodate new metadata fields
