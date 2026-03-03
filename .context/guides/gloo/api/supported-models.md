> ## Documentation Index
>
> Fetch the complete documentation index at: https://docs.gloo.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Supported Models

> A full list of Gloo AI API models and their capabilities.

The Gloo AI platform provides access to a wide range of leading models from various providers. Visit the **[Model Explorer in Gloo Studio](https://studio.ai.gloo.com/models)** to compare pricing, context windows, speed, and reasoning capabilities.

This page lists the **Model IDs** you'll need for API requests to the [Completions V2 endpoint](/api-reference/completions/v2).

<Info>
  All Completions V2 models support tool use and streaming.
</Info>

## Anthropic

| Model ID                           | Model Name        | Description                                                    |
| :--------------------------------- | :---------------- | :------------------------------------------------------------- |
| `gloo-anthropic-claude-haiku-4.5`  | Claude Haiku 4.5  | High-speed model with improved reasoning and concise outputs   |
| `gloo-anthropic-claude-sonnet-4.5` | Claude Sonnet 4.5 | Powerful reasoning model blending speed, depth, and creativity |
| `gloo-anthropic-claude-opus-4.5`   | Claude Opus 4.5   | Top-tier intelligence for complex reasoning and analysis       |

## Google

| Model ID                            | Model Name            | Description                                                       |
| :---------------------------------- | :-------------------- | :---------------------------------------------------------------- |
| `gloo-google-gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite | Light, speed-optimized model for quick lookups and simple tasks   |
| `gloo-google-gemini-2.5-flash`      | Gemini 2.5 Flash      | High-throughput model for rapid responses and low-cost deployment |
| `gloo-google-gemini-2.5-pro`        | Gemini 2.5 Pro        | Advanced multimodal model with strong reasoning                   |
| `gloo-google-gemini-3-pro-preview`  | Gemini 3 Pro Preview  | Next-generation model offering strong reasoning and creativity    |

## OpenAI

| Model ID                 | Model Name | Description                                                |
| :----------------------- | :--------- | :--------------------------------------------------------- |
| `gloo-openai-gpt-5-nano` | GPT-5 Nano | Small, responsive model offering reliable reasoning        |
| `gloo-openai-gpt-5-mini` | GPT-5 Mini | Balanced small model with strong reasoning at minimal cost |
| `gloo-openai-gpt-5-pro`  | GPT-5 Pro  | Premium high-capability model for expert reasoning         |
| `gloo-openai-gpt-5.2`    | GPT-5.2    | Flagship model with leading reasoning and versatility      |

## Open Source

| Model ID                          | Model Name            | Description                                                        |
| :-------------------------------- | :-------------------- | :----------------------------------------------------------------- |
| `gloo-meta-llama-3.1-8b-instruct` | Llama 3.1 8B Instruct | Mid-size open model with robust reasoning for dialogue             |
| `gloo-deepseek-chat-v3.1`         | DeepSeek Chat V3.1    | High-efficiency model with strong reasoning and compute efficiency |
| `gloo-deepseek-v3.2`              | DeepSeek V3.2         | Balanced efficiency with strong reasoning and agentic tool use     |
| `gloo-openai-gpt-oss-120b`        | GPT OSS 120B          | Large open-source model with near frontier-level reasoning         |
