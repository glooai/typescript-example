> ## Documentation Index
> Fetch the complete documentation index at: https://docs.gloo.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Using the Completions API

> Learn how to integrate with the Completions V2 API featuring auto-routing and intelligent model selection.

This guide provides a practical, step-by-step tutorial for using the Gloo AI Completions V2 API with its powerful routing features.

<Info>
  **Why V2?** Completions V2 offers auto-routing for optimal model selection, model family preferences, and tradition-aware responses—all while maintaining compatibility with the standard chat completions format.
</Info>

## Prerequisites

Before starting, ensure you have:

* A Gloo AI Studio account
* Your Client ID and Client Secret from the [API Credentials page](/studio/manage-api-credentials)
* **Authentication setup** - Complete the [Authentication Tutorial](/tutorials/authentication) first

***

## Choose Your Routing Strategy

Completions V2 offers three routing modes:

| Mode                      | Use Case                                          | Parameter                           |
| ------------------------- | ------------------------------------------------- | ----------------------------------- |
| **AI Core** (Recommended) | Let Gloo AI automatically select the best model   | `"auto_routing": true`              |
| **AI Core Select**        | Choose a provider family, let Gloo pick the model | `"model_family": "anthropic"`       |
| **AI Select**             | Specify an exact model                            | `"model": "gloo-openai-gpt-5-mini"` |

***

## Example 1: Auto-Routing (Recommended)

Let Gloo AI analyze your query and automatically select the optimal model:

<CodeGroup>
  ```python Python theme={null}
  import requests

  def make_v2_completion_auto(token_info):
      """Makes a V2 completion request with auto-routing."""

      api_url = "https://platform.ai.gloo.com/ai/v2/chat/completions"
      headers = {
          "Authorization": f"Bearer {token_info['access_token']}",
          "Content-Type": "application/json"
      }

      payload = {
          "messages": [
              {"role": "user", "content": "How does the Old Testament connect to the New Testament?"}
          ],
          "auto_routing": True,
          "tradition": "evangelical"  # Optional: evangelical, catholic, or mainline
      }

      response = requests.post(api_url, headers=headers, json=payload)
      response.raise_for_status()
      return response.json()
  ```

  ```javascript JavaScript theme={null}
  async function makeV2CompletionAuto(tokenInfo) {
    const apiUrl = "https://platform.ai.gloo.com/ai/v2/chat/completions";

    const payload = {
      messages: [
        { role: "user", content: "How does the Old Testament connect to the New Testament?" }
      ],
      auto_routing: true,
      tradition: "evangelical"  // Optional: evangelical, catholic, or mainline
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenInfo.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    return response.json();
  }
  ```

  ```typescript TypeScript theme={null}
  interface TokenInfo {
    access_token: string;
    expires_at: number;
  }

  async function makeV2CompletionAuto(tokenInfo: TokenInfo): Promise<any> {
    const apiUrl = "https://platform.ai.gloo.com/ai/v2/chat/completions";

    const payload = {
      messages: [
        { role: "user", content: "How does the Old Testament connect to the New Testament?" }
      ],
      auto_routing: true,
      tradition: "evangelical"  // Optional: evangelical, catholic, or mainline
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenInfo.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    return response.json();
  }
  ```

  ```php PHP theme={null}
  <?php
  function makeV2CompletionAuto($tokenInfo) {
      $apiUrl = 'https://platform.ai.gloo.com/ai/v2/chat/completions';

      $payload = json_encode([
          'messages' => [
              ['role' => 'user', 'content' => 'How does the Old Testament connect to the New Testament?']
          ],
          'auto_routing' => true,
          'tradition' => 'evangelical'  // Optional: evangelical, catholic, or mainline
      ]);

      $ch = curl_init();
      curl_setopt($ch, CURLOPT_URL, $apiUrl);
      curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
      curl_setopt($ch, CURLOPT_POST, 1);
      curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
      curl_setopt($ch, CURLOPT_HTTPHEADER, [
          'Content-Type: application/json',
          'Authorization: Bearer ' . $tokenInfo['access_token'],
      ]);

      $result = curl_exec($ch);
      if (curl_errno($ch)) {
          throw new Exception(curl_error($ch));
      }
      curl_close($ch);

      return json_decode($result, true);
  }
  ?>
  ```

  ```go Go theme={null}
  func makeV2CompletionAuto(tokenInfo *TokenInfo) (map[string]interface{}, error) {
  	apiUrl := "https://platform.ai.gloo.com/ai/v2/chat/completions"

  	payload := map[string]interface{}{
  		"messages": []map[string]string{
  			{"role": "user", "content": "How does the Old Testament connect to the New Testament?"},
  		},
  		"auto_routing": true,
  		"tradition":    "evangelical", // Optional: evangelical, catholic, or mainline
  	}
  	jsonPayload, _ := json.Marshal(payload)

  	req, err := http.NewRequest("POST", apiUrl, bytes.NewBuffer(jsonPayload))
  	if err != nil {
  		return nil, err
  	}

  	req.Header.Add("Authorization", "Bearer "+tokenInfo.AccessToken)
  	req.Header.Add("Content-Type", "application/json")

  	client := &http.Client{}
  	resp, err := client.Do(req)
  	if err != nil {
  		return nil, err
  	}
  	defer resp.Body.Close()

  	body, _ := ioutil.ReadAll(resp.Body)
  	var result map[string]interface{}
  	json.Unmarshal(body, &result)

  	return result, nil
  }
  ```

  ```java Java theme={null}
  public String makeV2CompletionAuto(TokenInfo tokenInfo) throws IOException, InterruptedException {
      String apiUrl = "https://platform.ai.gloo.com/ai/v2/chat/completions";

      String payload = """
          {
              "messages": [
                  {"role": "user", "content": "How does the Old Testament connect to the New Testament?"}
              ],
              "auto_routing": true,
              "tradition": "evangelical"
          }
          """;

      HttpClient client = HttpClient.newHttpClient();
      HttpRequest request = HttpRequest.newBuilder()
              .uri(URI.create(apiUrl))
              .header("Content-Type", "application/json")
              .header("Authorization", "Bearer " + tokenInfo.access_token)
              .POST(HttpRequest.BodyPublishers.ofString(payload))
              .build();

      HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
      return response.body();
  }
  ```
</CodeGroup>

***

## Example 2: Model Family Selection

Specify a provider family and let Gloo AI pick the best model within that family:

<CodeGroup>
  ```python Python theme={null}
  def make_v2_completion_family(token_info):
      """Makes a V2 completion request with model family selection."""

      api_url = "https://platform.ai.gloo.com/ai/v2/chat/completions"
      headers = {
          "Authorization": f"Bearer {token_info['access_token']}",
          "Content-Type": "application/json"
      }

      payload = {
          "messages": [
              {"role": "user", "content": "Draft a short sermon outline on forgiveness."}
          ],
          "model_family": "anthropic",  # Options: openai, anthropic, google, open source
          "stream": False
      }

      response = requests.post(api_url, headers=headers, json=payload)
      response.raise_for_status()
      return response.json()
  ```

  ```javascript JavaScript theme={null}
  async function makeV2CompletionFamily(tokenInfo) {
    const apiUrl = "https://platform.ai.gloo.com/ai/v2/chat/completions";

    const payload = {
      messages: [
        { role: "user", content: "Draft a short sermon outline on forgiveness." }
      ],
      model_family: "anthropic",  // Options: openai, anthropic, google, open source
      stream: false
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenInfo.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    return response.json();
  }
  ```

  ```typescript TypeScript theme={null}
  async function makeV2CompletionFamily(tokenInfo: TokenInfo): Promise<any> {
    const apiUrl = "https://platform.ai.gloo.com/ai/v2/chat/completions";

    const payload = {
      messages: [
        { role: "user", content: "Draft a short sermon outline on forgiveness." }
      ],
      model_family: "anthropic",  // Options: openai, anthropic, google, open source
      stream: false
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenInfo.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    return response.json();
  }
  ```

  ```php PHP theme={null}
  <?php
  function makeV2CompletionFamily($tokenInfo) {
      $apiUrl = 'https://platform.ai.gloo.com/ai/v2/chat/completions';

      $payload = json_encode([
          'messages' => [
              ['role' => 'user', 'content' => 'Draft a short sermon outline on forgiveness.']
          ],
          'model_family' => 'anthropic',  // Options: openai, anthropic, google, open source
          'stream' => false
      ]);

      $ch = curl_init();
      curl_setopt($ch, CURLOPT_URL, $apiUrl);
      curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
      curl_setopt($ch, CURLOPT_POST, 1);
      curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
      curl_setopt($ch, CURLOPT_HTTPHEADER, [
          'Content-Type: application/json',
          'Authorization: Bearer ' . $tokenInfo['access_token'],
      ]);

      $result = curl_exec($ch);
      if (curl_errno($ch)) {
          throw new Exception(curl_error($ch));
      }
      curl_close($ch);

      return json_decode($result, true);
  }
  ?>
  ```

  ```go Go theme={null}
  func makeV2CompletionFamily(tokenInfo *TokenInfo) (map[string]interface{}, error) {
  	apiUrl := "https://platform.ai.gloo.com/ai/v2/chat/completions"

  	payload := map[string]interface{}{
  		"messages": []map[string]string{
  			{"role": "user", "content": "Draft a short sermon outline on forgiveness."},
  		},
  		"model_family": "anthropic", // Options: openai, anthropic, google, open source
  		"stream":       false,
  	}
  	jsonPayload, _ := json.Marshal(payload)

  	req, err := http.NewRequest("POST", apiUrl, bytes.NewBuffer(jsonPayload))
  	if err != nil {
  		return nil, err
  	}

  	req.Header.Add("Authorization", "Bearer "+tokenInfo.AccessToken)
  	req.Header.Add("Content-Type", "application/json")

  	client := &http.Client{}
  	resp, err := client.Do(req)
  	if err != nil {
  		return nil, err
  	}
  	defer resp.Body.Close()

  	body, _ := ioutil.ReadAll(resp.Body)
  	var result map[string]interface{}
  	json.Unmarshal(body, &result)

  	return result, nil
  }
  ```

  ```java Java theme={null}
  public String makeV2CompletionFamily(TokenInfo tokenInfo) throws IOException, InterruptedException {
      String apiUrl = "https://platform.ai.gloo.com/ai/v2/chat/completions";

      String payload = """
          {
              "messages": [
                  {"role": "user", "content": "Draft a short sermon outline on forgiveness."}
              ],
              "model_family": "anthropic",
              "stream": false
          }
          """;

      HttpClient client = HttpClient.newHttpClient();
      HttpRequest request = HttpRequest.newBuilder()
              .uri(URI.create(apiUrl))
              .header("Content-Type", "application/json")
              .header("Authorization", "Bearer " + tokenInfo.access_token)
              .POST(HttpRequest.BodyPublishers.ofString(payload))
              .build();

      HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
      return response.body();
  }
  ```
</CodeGroup>

Available model families: `openai`, `anthropic`, `google`, `open source`

***

## Example 3: Direct Model Selection

Choose a specific model for full control:

<CodeGroup>
  ```python Python theme={null}
  def make_v2_completion_direct(token_info):
      """Makes a V2 completion request with direct model selection."""

      api_url = "https://platform.ai.gloo.com/ai/v2/chat/completions"
      headers = {
          "Authorization": f"Bearer {token_info['access_token']}",
          "Content-Type": "application/json"
      }

      payload = {
          "messages": [
              {"role": "user", "content": "Summarize the book of Romans in 3 sentences."}
          ],
          "model": "gloo-anthropic-claude-sonnet-4.5",
          "temperature": 0.7,
          "max_tokens": 500
      }

      response = requests.post(api_url, headers=headers, json=payload)
      response.raise_for_status()
      return response.json()
  ```

  ```javascript JavaScript theme={null}
  async function makeV2CompletionDirect(tokenInfo) {
    const apiUrl = "https://platform.ai.gloo.com/ai/v2/chat/completions";

    const payload = {
      messages: [
        { role: "user", content: "Summarize the book of Romans in 3 sentences." }
      ],
      model: "gloo-anthropic-claude-sonnet-4.5",
      temperature: 0.7,
      max_tokens: 500
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenInfo.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    return response.json();
  }
  ```

  ```typescript TypeScript theme={null}
  async function makeV2CompletionDirect(tokenInfo: TokenInfo): Promise<any> {
    const apiUrl = "https://platform.ai.gloo.com/ai/v2/chat/completions";

    const payload = {
      messages: [
        { role: "user", content: "Summarize the book of Romans in 3 sentences." }
      ],
      model: "gloo-anthropic-claude-sonnet-4.5",
      temperature: 0.7,
      max_tokens: 500
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenInfo.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    return response.json();
  }
  ```

  ```php PHP theme={null}
  <?php
  function makeV2CompletionDirect($tokenInfo) {
      $apiUrl = 'https://platform.ai.gloo.com/ai/v2/chat/completions';

      $payload = json_encode([
          'messages' => [
              ['role' => 'user', 'content' => 'Summarize the book of Romans in 3 sentences.']
          ],
          'model' => 'gloo-anthropic-claude-sonnet-4.5',
          'temperature' => 0.7,
          'max_tokens' => 500
      ]);

      $ch = curl_init();
      curl_setopt($ch, CURLOPT_URL, $apiUrl);
      curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
      curl_setopt($ch, CURLOPT_POST, 1);
      curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
      curl_setopt($ch, CURLOPT_HTTPHEADER, [
          'Content-Type: application/json',
          'Authorization: Bearer ' . $tokenInfo['access_token'],
      ]);

      $result = curl_exec($ch);
      if (curl_errno($ch)) {
          throw new Exception(curl_error($ch));
      }
      curl_close($ch);

      return json_decode($result, true);
  }
  ?>
  ```

  ```go Go theme={null}
  func makeV2CompletionDirect(tokenInfo *TokenInfo) (map[string]interface{}, error) {
  	apiUrl := "https://platform.ai.gloo.com/ai/v2/chat/completions"

  	payload := map[string]interface{}{
  		"messages": []map[string]string{
  			{"role": "user", "content": "Summarize the book of Romans in 3 sentences."},
  		},
  		"model":       "gloo-anthropic-claude-sonnet-4.5",
  		"temperature": 0.7,
  		"max_tokens":  500,
  	}
  	jsonPayload, _ := json.Marshal(payload)

  	req, err := http.NewRequest("POST", apiUrl, bytes.NewBuffer(jsonPayload))
  	if err != nil {
  		return nil, err
  	}

  	req.Header.Add("Authorization", "Bearer "+tokenInfo.AccessToken)
  	req.Header.Add("Content-Type", "application/json")

  	client := &http.Client{}
  	resp, err := client.Do(req)
  	if err != nil {
  		return nil, err
  	}
  	defer resp.Body.Close()

  	body, _ := ioutil.ReadAll(resp.Body)
  	var result map[string]interface{}
  	json.Unmarshal(body, &result)

  	return result, nil
  }
  ```

  ```java Java theme={null}
  public String makeV2CompletionDirect(TokenInfo tokenInfo) throws IOException, InterruptedException {
      String apiUrl = "https://platform.ai.gloo.com/ai/v2/chat/completions";

      String payload = """
          {
              "messages": [
                  {"role": "user", "content": "Summarize the book of Romans in 3 sentences."}
              ],
              "model": "gloo-anthropic-claude-sonnet-4.5",
              "temperature": 0.7,
              "max_tokens": 500
          }
          """;

      HttpClient client = HttpClient.newHttpClient();
      HttpRequest request = HttpRequest.newBuilder()
              .uri(URI.create(apiUrl))
              .header("Content-Type", "application/json")
              .header("Authorization", "Bearer " + tokenInfo.access_token)
              .POST(HttpRequest.BodyPublishers.ofString(payload))
              .build();

      HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
      return response.body();
  }
  ```
</CodeGroup>

See the [Supported Model IDs](/api-guides/supported-models) page for all available models.

***

## Understanding the Response

V2 responses include additional routing metadata:

```json  theme={null}
{
  "id": "chatcmpl-xyz",
  "object": "chat.completion",
  "created": 1733184562,
  "model": "gloo-anthropic-claude-sonnet-4.5",
  "routing_mechanism": "auto_routing",
  "routing_tier": "tier_2",
  "routing_confidence": 0.87,
  "tradition": "evangelical",
  "provider": "Anthropic",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The response content..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 125,
    "completion_tokens": 78,
    "total_tokens": 203
  }
}
```

Key metadata fields:

* `routing_mechanism`: How the model was selected (`auto_routing`, `model_family`, or `direct_model_selection`)
* `routing_tier`: The complexity tier determined by auto-routing (`tier_1`, `tier_2`, `tier_3`)
* `routing_confidence`: Confidence score for the routing decision (0.0-1.0)
* `tradition`: The theological perspective applied (if specified)

***

## Streaming Responses

Enable streaming for real-time responses:

<CodeGroup>
  ```python Python theme={null}
  import requests

  def make_v2_completion_streaming(token_info):
      """Makes a streaming V2 completion request."""

      api_url = "https://platform.ai.gloo.com/ai/v2/chat/completions"
      headers = {
          "Authorization": f"Bearer {token_info['access_token']}",
          "Content-Type": "application/json"
      }

      payload = {
          "messages": [
              {"role": "user", "content": "Explain the significance of the resurrection."}
          ],
          "auto_routing": True,
          "stream": True
      }

      with requests.post(api_url, headers=headers, json=payload, stream=True) as response:
          response.raise_for_status()
          for line in response.iter_lines():
              if line:
                  print(line.decode('utf-8'))
  ```

  ```javascript JavaScript theme={null}
  async function makeV2CompletionStreaming(tokenInfo) {
    const apiUrl = "https://platform.ai.gloo.com/ai/v2/chat/completions";

    const payload = {
      messages: [
        { role: "user", content: "Explain the significance of the resurrection." }
      ],
      auto_routing: true,
      stream: true
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenInfo.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      console.log(decoder.decode(value));
    }
  }
  ```

  ```typescript TypeScript theme={null}
  async function makeV2CompletionStreaming(tokenInfo: TokenInfo): Promise<void> {
    const apiUrl = "https://platform.ai.gloo.com/ai/v2/chat/completions";

    const payload = {
      messages: [
        { role: "user", content: "Explain the significance of the resurrection." }
      ],
      auto_routing: true,
      stream: true
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenInfo.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No reader available');

    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      console.log(decoder.decode(value));
    }
  }
  ```

  ```php PHP theme={null}
  <?php
  function makeV2CompletionStreaming($tokenInfo) {
      $apiUrl = 'https://platform.ai.gloo.com/ai/v2/chat/completions';

      $payload = json_encode([
          'messages' => [
              ['role' => 'user', 'content' => 'Explain the significance of the resurrection.']
          ],
          'auto_routing' => true,
          'stream' => true
      ]);

      $ch = curl_init();
      curl_setopt($ch, CURLOPT_URL, $apiUrl);
      curl_setopt($ch, CURLOPT_POST, 1);
      curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
      curl_setopt($ch, CURLOPT_HTTPHEADER, [
          'Content-Type: application/json',
          'Authorization: Bearer ' . $tokenInfo['access_token'],
      ]);

      // Stream the response
      curl_setopt($ch, CURLOPT_WRITEFUNCTION, function($ch, $data) {
          echo $data;
          return strlen($data);
      });

      curl_exec($ch);
      if (curl_errno($ch)) {
          throw new Exception(curl_error($ch));
      }
      curl_close($ch);
  }
  ?>
  ```

  ```go Go theme={null}
  func makeV2CompletionStreaming(tokenInfo *TokenInfo) error {
  	apiUrl := "https://platform.ai.gloo.com/ai/v2/chat/completions"

  	payload := map[string]interface{}{
  		"messages": []map[string]string{
  			{"role": "user", "content": "Explain the significance of the resurrection."},
  		},
  		"auto_routing": true,
  		"stream":       true,
  	}
  	jsonPayload, _ := json.Marshal(payload)

  	req, err := http.NewRequest("POST", apiUrl, bytes.NewBuffer(jsonPayload))
  	if err != nil {
  		return err
  	}

  	req.Header.Add("Authorization", "Bearer "+tokenInfo.AccessToken)
  	req.Header.Add("Content-Type", "application/json")

  	client := &http.Client{}
  	resp, err := client.Do(req)
  	if err != nil {
  		return err
  	}
  	defer resp.Body.Close()

  	reader := bufio.NewReader(resp.Body)
  	for {
  		line, err := reader.ReadBytes('\n')
  		if err != nil {
  			break
  		}
  		fmt.Print(string(line))
  	}

  	return nil
  }
  ```

  ```java Java theme={null}
  public void makeV2CompletionStreaming(TokenInfo tokenInfo) throws IOException, InterruptedException {
      String apiUrl = "https://platform.ai.gloo.com/ai/v2/chat/completions";

      String payload = """
          {
              "messages": [
                  {"role": "user", "content": "Explain the significance of the resurrection."}
              ],
              "auto_routing": true,
              "stream": true
          }
          """;

      HttpClient client = HttpClient.newHttpClient();
      HttpRequest request = HttpRequest.newBuilder()
              .uri(URI.create(apiUrl))
              .header("Content-Type", "application/json")
              .header("Authorization", "Bearer " + tokenInfo.access_token)
              .POST(HttpRequest.BodyPublishers.ofString(payload))
              .build();

      HttpResponse<Stream<String>> response = client.send(
          request,
          HttpResponse.BodyHandlers.ofLines()
      );

      response.body().forEach(System.out::println);
  }
  ```
</CodeGroup>

***

## Complete Examples

The following examples combine token retrieval, expiration checking, and all three routing strategies into a single, runnable script for each language. Each example demonstrates auto-routing, model family selection, and direct model selection.

You'll want to first set up your environment variables in either an `.env` file:

```
GLOO_CLIENT_ID=YOUR_CLIENT_ID
GLOO_CLIENT_SECRET=YOUR_CLIENT_SECRET
```

Or export them in your shell for Go and Java:

```bash  theme={null}
export GLOO_CLIENT_ID="your_actual_client_id_here"
export GLOO_CLIENT_SECRET="your_actual_client_secret_here"
```

<CodeGroup>
  ```python Python theme={null}
  import requests
  import time
  import os
  from dotenv import load_dotenv

  # Load environment variables from .env file
  load_dotenv()

  # --- Configuration ---
  CLIENT_ID = os.getenv("GLOO_CLIENT_ID", "YOUR_CLIENT_ID")
  CLIENT_SECRET = os.getenv("GLOO_CLIENT_SECRET", "YOUR_CLIENT_SECRET")
  TOKEN_URL = "https://platform.ai.gloo.com/oauth2/token"
  API_URL = "https://platform.ai.gloo.com/ai/v2/chat/completions"

  # --- State Management ---
  access_token_info = {}

  # --- Token Management ---
  def get_access_token():
      """Retrieves a new access token."""
      headers = {"Content-Type": "application/x-www-form-urlencoded"}
      data = {"grant_type": "client_credentials", "scope": "api/access"}
      response = requests.post(TOKEN_URL, headers=headers, data=data, auth=(CLIENT_ID, CLIENT_SECRET))
      response.raise_for_status()
      token_data = response.json()
      token_data['expires_at'] = int(time.time()) + token_data['expires_in']
      return token_data

  def is_token_expired(token_info):
      """Checks if the token is expired or close to expiring."""
      if not token_info or 'expires_at' not in token_info:
          return True
      return time.time() > (token_info['expires_at'] - 60)

  def ensure_valid_token():
      """Ensures we have a valid token, refreshing if needed."""
      global access_token_info
      if is_token_expired(access_token_info):
          print("Token is expired or missing. Fetching a new one...")
          access_token_info = get_access_token()
      return access_token_info

  # --- V2 Completion Functions ---
  def make_v2_auto_routing(message, tradition="evangelical"):
      """Example 1: Auto-routing - Let Gloo AI select the optimal model."""
      token = ensure_valid_token()
      headers = {
          "Authorization": f"Bearer {token['access_token']}",
          "Content-Type": "application/json"
      }
      payload = {
          "messages": [{"role": "user", "content": message}],
          "auto_routing": True,
          "tradition": tradition
      }
      response = requests.post(API_URL, headers=headers, json=payload)
      response.raise_for_status()
      return response.json()

  def make_v2_model_family(message, model_family="anthropic"):
      """Example 2: Model family selection - Choose a provider family."""
      token = ensure_valid_token()
      headers = {
          "Authorization": f"Bearer {token['access_token']}",
          "Content-Type": "application/json"
      }
      payload = {
          "messages": [{"role": "user", "content": message}],
          "model_family": model_family
      }
      response = requests.post(API_URL, headers=headers, json=payload)
      response.raise_for_status()
      return response.json()

  def make_v2_direct_model(message, model="gloo-anthropic-claude-sonnet-4.5"):
      """Example 3: Direct model selection - Specify an exact model."""
      token = ensure_valid_token()
      headers = {
          "Authorization": f"Bearer {token['access_token']}",
          "Content-Type": "application/json"
      }
      payload = {
          "messages": [{"role": "user", "content": message}],
          "model": model,
          "temperature": 0.7,
          "max_tokens": 500
      }
      response = requests.post(API_URL, headers=headers, json=payload)
      response.raise_for_status()
      return response.json()

  # --- Main Execution ---
  if __name__ == "__main__":
      try:
          # Example 1: Auto-routing
          print("=== Example 1: Auto-Routing ===")
          result1 = make_v2_auto_routing("How does the Old Testament connect to the New Testament?")
          print(f"Model used: {result1.get('model')}")
          print(f"Routing: {result1.get('routing_mechanism')}")
          print(f"Response: {result1['choices'][0]['message']['content'][:200]}...")

          # Example 2: Model family selection
          print("\n=== Example 2: Model Family Selection ===")
          result2 = make_v2_model_family("Draft a short sermon outline on forgiveness.", "anthropic")
          print(f"Model used: {result2.get('model')}")
          print(f"Response: {result2['choices'][0]['message']['content'][:200]}...")

          # Example 3: Direct model selection
          print("\n=== Example 3: Direct Model Selection ===")
          result3 = make_v2_direct_model("Summarize the book of Romans in 3 sentences.")
          print(f"Model used: {result3.get('model')}")
          print(f"Response: {result3['choices'][0]['message']['content'][:200]}...")

      except requests.exceptions.HTTPError as err:
          print(f"An HTTP error occurred: {err}")
      except Exception as err:
          print(f"An error occurred: {err}")
  ```

  ```javascript JavaScript theme={null}
  // Load environment variables from .env file
  require('dotenv').config();

  const axios = require('axios');

  // --- Configuration ---
  const CLIENT_ID = process.env.GLOO_CLIENT_ID || "YOUR_CLIENT_ID";
  const CLIENT_SECRET = process.env.GLOO_CLIENT_SECRET || "YOUR_CLIENT_SECRET";
  const TOKEN_URL = "https://platform.ai.gloo.com/oauth2/token";
  const API_URL = "https://platform.ai.gloo.com/ai/v2/chat/completions";

  // --- State Management ---
  let tokenInfo = {};

  // --- Token Management ---
  async function getAccessToken() {
      const body = 'grant_type=client_credentials&scope=api/access';
      const response = await axios.post(TOKEN_URL, body, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          auth: { username: CLIENT_ID, password: CLIENT_SECRET }
      });
      const tokenData = response.data;
      tokenData.expires_at = Math.floor(Date.now() / 1000) + tokenData.expires_in;
      return tokenData;
  }

  function isTokenExpired(token) {
      if (!token || !token.expires_at) return true;
      return (Date.now() / 1000) > (token.expires_at - 60);
  }

  async function ensureValidToken() {
      if (isTokenExpired(tokenInfo)) {
          console.log("Token is expired or missing. Fetching a new one...");
          tokenInfo = await getAccessToken();
      }
      return tokenInfo;
  }

  // --- V2 Completion Functions ---
  async function makeV2AutoRouting(message, tradition = "evangelical") {
      // Example 1: Auto-routing - Let Gloo AI select the optimal model
      const token = await ensureValidToken();
      const payload = {
          messages: [{ role: "user", content: message }],
          auto_routing: true,
          tradition: tradition
      };
      const response = await axios.post(API_URL, payload, {
          headers: {
              'Authorization': `Bearer ${token.access_token}`,
              'Content-Type': 'application/json',
          },
      });
      return response.data;
  }

  async function makeV2ModelFamily(message, modelFamily = "anthropic") {
      // Example 2: Model family selection - Choose a provider family
      const token = await ensureValidToken();
      const payload = {
          messages: [{ role: "user", content: message }],
          model_family: modelFamily
      };
      const response = await axios.post(API_URL, payload, {
          headers: {
              'Authorization': `Bearer ${token.access_token}`,
              'Content-Type': 'application/json',
          },
      });
      return response.data;
  }

  async function makeV2DirectModel(message, model = "gloo-anthropic-claude-sonnet-4.5") {
      // Example 3: Direct model selection - Specify an exact model
      const token = await ensureValidToken();
      const payload = {
          messages: [{ role: "user", content: message }],
          model: model,
          temperature: 0.7,
          max_tokens: 500
      };
      const response = await axios.post(API_URL, payload, {
          headers: {
              'Authorization': `Bearer ${token.access_token}`,
              'Content-Type': 'application/json',
          },
      });
      return response.data;
  }

  // --- Main Execution ---
  async function main() {
      try {
          // Example 1: Auto-routing
          console.log("=== Example 1: Auto-Routing ===");
          const result1 = await makeV2AutoRouting("How does the Old Testament connect to the New Testament?");
          console.log(`Model used: ${result1.model}`);
          console.log(`Routing: ${result1.routing_mechanism}`);
          console.log(`Response: ${result1.choices[0].message.content.substring(0, 200)}...`);

          // Example 2: Model family selection
          console.log("\n=== Example 2: Model Family Selection ===");
          const result2 = await makeV2ModelFamily("Draft a short sermon outline on forgiveness.", "anthropic");
          console.log(`Model used: ${result2.model}`);
          console.log(`Response: ${result2.choices[0].message.content.substring(0, 200)}...`);

          // Example 3: Direct model selection
          console.log("\n=== Example 3: Direct Model Selection ===");
          const result3 = await makeV2DirectModel("Summarize the book of Romans in 3 sentences.");
          console.log(`Model used: ${result3.model}`);
          console.log(`Response: ${result3.choices[0].message.content.substring(0, 200)}...`);

      } catch (error) {
          console.error("An error occurred:", error.response ? error.response.data : error.message);
      }
  }

  main();
  ```

  ```typescript TypeScript theme={null}
  import axios from 'axios';
  import * as dotenv from 'dotenv';

  // Load environment variables from .env file
  dotenv.config();

  // --- Type Definitions ---
  interface TokenInfo {
      access_token: string;
      expires_in: number;
      expires_at: number;
      token_type: string;
  }

  interface V2CompletionResponse {
      model: string;
      routing_mechanism?: string;
      routing_tier?: string;
      routing_confidence?: number;
      tradition?: string;
      choices: Array<{
          message: {
              role: string;
              content: string;
          };
      }>;
  }

  // --- Configuration ---
  const CLIENT_ID = process.env.GLOO_CLIENT_ID || "YOUR_CLIENT_ID";
  const CLIENT_SECRET = process.env.GLOO_CLIENT_SECRET || "YOUR_CLIENT_SECRET";
  const TOKEN_URL = "https://platform.ai.gloo.com/oauth2/token";
  const API_URL = "https://platform.ai.gloo.com/ai/v2/chat/completions";

  // --- State Management ---
  let tokenInfo: TokenInfo | null = null;

  // --- Token Management ---
  async function getAccessToken(): Promise<TokenInfo> {
      const body = 'grant_type=client_credentials&scope=api/access';
      const response = await axios.post<TokenInfo>(TOKEN_URL, body, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          auth: { username: CLIENT_ID, password: CLIENT_SECRET }
      });
      const tokenData = response.data;
      (tokenData as any).expires_at = Math.floor(Date.now() / 1000) + tokenData.expires_in;
      return tokenData;
  }

  function isTokenExpired(token: TokenInfo | null): boolean {
      if (!token || !(token as any).expires_at) return true;
      return (Date.now() / 1000) > ((token as any).expires_at - 60);
  }

  async function ensureValidToken(): Promise<TokenInfo> {
      if (isTokenExpired(tokenInfo)) {
          console.log("Token is expired or missing. Fetching a new one...");
          tokenInfo = await getAccessToken();
      }
      return tokenInfo!;
  }

  // --- V2 Completion Functions ---
  async function makeV2AutoRouting(message: string, tradition: string = "evangelical"): Promise<V2CompletionResponse> {
      // Example 1: Auto-routing - Let Gloo AI select the optimal model
      const token = await ensureValidToken();
      const payload = {
          messages: [{ role: "user", content: message }],
          auto_routing: true,
          tradition: tradition
      };
      const response = await axios.post<V2CompletionResponse>(API_URL, payload, {
          headers: {
              'Authorization': `Bearer ${token.access_token}`,
              'Content-Type': 'application/json',
          },
      });
      return response.data;
  }

  async function makeV2ModelFamily(message: string, modelFamily: string = "anthropic"): Promise<V2CompletionResponse> {
      // Example 2: Model family selection - Choose a provider family
      const token = await ensureValidToken();
      const payload = {
          messages: [{ role: "user", content: message }],
          model_family: modelFamily
      };
      const response = await axios.post<V2CompletionResponse>(API_URL, payload, {
          headers: {
              'Authorization': `Bearer ${token.access_token}`,
              'Content-Type': 'application/json',
          },
      });
      return response.data;
  }

  async function makeV2DirectModel(message: string, model: string = "gloo-anthropic-claude-sonnet-4.5"): Promise<V2CompletionResponse> {
      // Example 3: Direct model selection - Specify an exact model
      const token = await ensureValidToken();
      const payload = {
          messages: [{ role: "user", content: message }],
          model: model,
          temperature: 0.7,
          max_tokens: 500
      };
      const response = await axios.post<V2CompletionResponse>(API_URL, payload, {
          headers: {
              'Authorization': `Bearer ${token.access_token}`,
              'Content-Type': 'application/json',
          },
      });
      return response.data;
  }

  // --- Main Execution ---
  async function main(): Promise<void> {
      try {
          // Example 1: Auto-routing
          console.log("=== Example 1: Auto-Routing ===");
          const result1 = await makeV2AutoRouting("How does the Old Testament connect to the New Testament?");
          console.log(`Model used: ${result1.model}`);
          console.log(`Routing: ${result1.routing_mechanism}`);
          console.log(`Response: ${result1.choices[0].message.content.substring(0, 200)}...`);

          // Example 2: Model family selection
          console.log("\n=== Example 2: Model Family Selection ===");
          const result2 = await makeV2ModelFamily("Draft a short sermon outline on forgiveness.", "anthropic");
          console.log(`Model used: ${result2.model}`);
          console.log(`Response: ${result2.choices[0].message.content.substring(0, 200)}...`);

          // Example 3: Direct model selection
          console.log("\n=== Example 3: Direct Model Selection ===");
          const result3 = await makeV2DirectModel("Summarize the book of Romans in 3 sentences.");
          console.log(`Model used: ${result3.model}`);
          console.log(`Response: ${result3.choices[0].message.content.substring(0, 200)}...`);

      } catch (error: any) {
          console.error("An error occurred:", error.response ? error.response.data : error.message);
      }
  }

  main();
  ```

  ```php PHP theme={null}
  <?php
  require_once 'vendor/autoload.php';

  // Load .env file
  $dotenv = Dotenv\Dotenv::createImmutable(__DIR__);
  $dotenv->load();

  // --- Configuration ---
  $CLIENT_ID = $_ENV['GLOO_CLIENT_ID'] ?? getenv('GLOO_CLIENT_ID') ?: 'YOUR_CLIENT_ID';
  $CLIENT_SECRET = $_ENV['GLOO_CLIENT_SECRET'] ?? getenv('GLOO_CLIENT_SECRET') ?: 'YOUR_CLIENT_SECRET';
  $TOKEN_URL = 'https://platform.ai.gloo.com/oauth2/token';
  $API_URL = 'https://platform.ai.gloo.com/ai/v2/chat/completions';

  // --- State Management ---
  $tokenInfo = [];

  // --- Token Management ---
  function getAccessToken($clientId, $clientSecret, $tokenUrl) {
      $postData = 'grant_type=client_credentials&scope=api/access';
      $ch = curl_init();
      curl_setopt($ch, CURLOPT_URL, $tokenUrl);
      curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
      curl_setopt($ch, CURLOPT_POST, 1);
      curl_setopt($ch, CURLOPT_POSTFIELDS, $postData);
      curl_setopt($ch, CURLOPT_USERPWD, $clientId . ':' . $clientSecret);
      curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/x-www-form-urlencoded']);
      $result = curl_exec($ch);
      if (curl_errno($ch)) throw new Exception(curl_error($ch));
      curl_close($ch);
      $tokenData = json_decode($result, true);
      $tokenData['expires_at'] = time() + $tokenData['expires_in'];
      return $tokenData;
  }

  function isTokenExpired($token) {
      if (empty($token) || !isset($token['expires_at'])) return true;
      return time() > ($token['expires_at'] - 60);
  }

  function ensureValidToken(&$tokenInfo, $clientId, $clientSecret, $tokenUrl) {
      if (isTokenExpired($tokenInfo)) {
          echo "Token is expired or missing. Fetching a new one...\n";
          $tokenInfo = getAccessToken($clientId, $clientSecret, $tokenUrl);
      }
      return $tokenInfo;
  }

  // --- V2 Completion Functions ---
  function makeV2AutoRouting($message, $tradition, $apiUrl, &$tokenInfo, $clientId, $clientSecret, $tokenUrl) {
      // Example 1: Auto-routing - Let Gloo AI select the optimal model
      $token = ensureValidToken($tokenInfo, $clientId, $clientSecret, $tokenUrl);
      $payload = json_encode([
          'messages' => [['role' => 'user', 'content' => $message]],
          'auto_routing' => true,
          'tradition' => $tradition
      ]);
      return makeRequest($apiUrl, $payload, $token);
  }

  function makeV2ModelFamily($message, $modelFamily, $apiUrl, &$tokenInfo, $clientId, $clientSecret, $tokenUrl) {
      // Example 2: Model family selection - Choose a provider family
      $token = ensureValidToken($tokenInfo, $clientId, $clientSecret, $tokenUrl);
      $payload = json_encode([
          'messages' => [['role' => 'user', 'content' => $message]],
          'model_family' => $modelFamily
      ]);
      return makeRequest($apiUrl, $payload, $token);
  }

  function makeV2DirectModel($message, $model, $apiUrl, &$tokenInfo, $clientId, $clientSecret, $tokenUrl) {
      // Example 3: Direct model selection - Specify an exact model
      $token = ensureValidToken($tokenInfo, $clientId, $clientSecret, $tokenUrl);
      $payload = json_encode([
          'messages' => [['role' => 'user', 'content' => $message]],
          'model' => $model,
          'temperature' => 0.7,
          'max_tokens' => 500
      ]);
      return makeRequest($apiUrl, $payload, $token);
  }

  function makeRequest($apiUrl, $payload, $token) {
      $ch = curl_init();
      curl_setopt($ch, CURLOPT_URL, $apiUrl);
      curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
      curl_setopt($ch, CURLOPT_POST, 1);
      curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
      curl_setopt($ch, CURLOPT_HTTPHEADER, [
          'Content-Type: application/json',
          'Authorization: Bearer ' . $token['access_token'],
      ]);
      $result = curl_exec($ch);
      if (curl_errno($ch)) throw new Exception(curl_error($ch));
      curl_close($ch);
      return json_decode($result, true);
  }

  // --- Main Execution ---
  try {
      // Example 1: Auto-routing
      echo "=== Example 1: Auto-Routing ===\n";
      $result1 = makeV2AutoRouting(
          "How does the Old Testament connect to the New Testament?",
          "evangelical",
          $API_URL, $tokenInfo, $CLIENT_ID, $CLIENT_SECRET, $TOKEN_URL
      );
      echo "Model used: " . $result1['model'] . "\n";
      echo "Routing: " . $result1['routing_mechanism'] . "\n";
      echo "Response: " . substr($result1['choices'][0]['message']['content'], 0, 200) . "...\n";

      // Example 2: Model family selection
      echo "\n=== Example 2: Model Family Selection ===\n";
      $result2 = makeV2ModelFamily(
          "Draft a short sermon outline on forgiveness.",
          "anthropic",
          $API_URL, $tokenInfo, $CLIENT_ID, $CLIENT_SECRET, $TOKEN_URL
      );
      echo "Model used: " . $result2['model'] . "\n";
      echo "Response: " . substr($result2['choices'][0]['message']['content'], 0, 200) . "...\n";

      // Example 3: Direct model selection
      echo "\n=== Example 3: Direct Model Selection ===\n";
      $result3 = makeV2DirectModel(
          "Summarize the book of Romans in 3 sentences.",
          "gloo-anthropic-claude-sonnet-4.5",
          $API_URL, $tokenInfo, $CLIENT_ID, $CLIENT_SECRET, $TOKEN_URL
      );
      echo "Model used: " . $result3['model'] . "\n";
      echo "Response: " . substr($result3['choices'][0]['message']['content'], 0, 200) . "...\n";

  } catch (Exception $e) {
      echo 'Error: ' . $e->getMessage();
  }
  ?>
  ```

  ```go Go theme={null}
  package main

  import (
  	"bytes"
  	"encoding/json"
  	"fmt"
  	"io/ioutil"
  	"net/http"
  	"os"
  	"strings"
  	"time"
  )

  // --- Configuration ---
  var (
  	clientID     = getEnv("GLOO_CLIENT_ID", "YOUR_CLIENT_ID")
  	clientSecret = getEnv("GLOO_CLIENT_SECRET", "YOUR_CLIENT_SECRET")
  	tokenURL     = "https://platform.ai.gloo.com/oauth2/token"
  	apiURL       = "https://platform.ai.gloo.com/ai/v2/chat/completions"
  )

  // --- Data Structures ---
  type TokenInfo struct {
  	AccessToken string `json:"access_token"`
  	ExpiresIn   int    `json:"expires_in"`
  	ExpiresAt   int64  `json:"expires_at"`
  	TokenType   string `json:"token_type"`
  }

  var tokenInfo *TokenInfo

  // --- Token Management ---
  func getAccessToken() (*TokenInfo, error) {
  	data := strings.NewReader("grant_type=client_credentials&scope=api/access")
  	req, err := http.NewRequest("POST", tokenURL, data)
  	if err != nil {
  		return nil, err
  	}

  	req.SetBasicAuth(clientID, clientSecret)
  	req.Header.Add("Content-Type", "application/x-www-form-urlencoded")

  	client := &http.Client{}
  	resp, err := client.Do(req)
  	if err != nil {
  		return nil, err
  	}
  	defer resp.Body.Close()

  	if resp.StatusCode != http.StatusOK {
  		bodyBytes, _ := ioutil.ReadAll(resp.Body)
  		return nil, fmt.Errorf("failed to get token: %s - %s", resp.Status, string(bodyBytes))
  	}

  	body, err := ioutil.ReadAll(resp.Body)
  	if err != nil {
  		return nil, err
  	}

  	var token TokenInfo
  	if err := json.Unmarshal(body, &token); err != nil {
  		return nil, err
  	}

  	token.ExpiresAt = time.Now().Unix() + int64(token.ExpiresIn)
  	return &token, nil
  }

  func isTokenExpired(token *TokenInfo) bool {
  	if token == nil || token.ExpiresAt == 0 {
  		return true
  	}
  	return time.Now().Unix() > (token.ExpiresAt - 60)
  }

  func ensureValidToken() (*TokenInfo, error) {
  	if isTokenExpired(tokenInfo) {
  		fmt.Println("Token is expired or missing. Fetching a new one...")
  		var err error
  		tokenInfo, err = getAccessToken()
  		if err != nil {
  			return nil, err
  		}
  	}
  	return tokenInfo, nil
  }

  // --- V2 Completion Functions ---
  func makeV2AutoRouting(message, tradition string) (map[string]interface{}, error) {
  	// Example 1: Auto-routing - Let Gloo AI select the optimal model
  	token, err := ensureValidToken()
  	if err != nil {
  		return nil, err
  	}

  	payload := map[string]interface{}{
  		"messages":     []map[string]string{{"role": "user", "content": message}},
  		"auto_routing": true,
  		"tradition":    tradition,
  	}
  	return makeRequest(payload, token)
  }

  func makeV2ModelFamily(message, modelFamily string) (map[string]interface{}, error) {
  	// Example 2: Model family selection - Choose a provider family
  	token, err := ensureValidToken()
  	if err != nil {
  		return nil, err
  	}

  	payload := map[string]interface{}{
  		"messages":     []map[string]string{{"role": "user", "content": message}},
  		"model_family": modelFamily,
  	}
  	return makeRequest(payload, token)
  }

  func makeV2DirectModel(message, model string) (map[string]interface{}, error) {
  	// Example 3: Direct model selection - Specify an exact model
  	token, err := ensureValidToken()
  	if err != nil {
  		return nil, err
  	}

  	payload := map[string]interface{}{
  		"messages":    []map[string]string{{"role": "user", "content": message}},
  		"model":       model,
  		"temperature": 0.7,
  		"max_tokens":  500,
  	}
  	return makeRequest(payload, token)
  }

  func makeRequest(payload map[string]interface{}, token *TokenInfo) (map[string]interface{}, error) {
  	jsonPayload, _ := json.Marshal(payload)

  	req, err := http.NewRequest("POST", apiURL, bytes.NewBuffer(jsonPayload))
  	if err != nil {
  		return nil, err
  	}

  	req.Header.Add("Authorization", "Bearer "+token.AccessToken)
  	req.Header.Add("Content-Type", "application/json")

  	client := &http.Client{}
  	resp, err := client.Do(req)
  	if err != nil {
  		return nil, err
  	}
  	defer resp.Body.Close()

  	body, _ := ioutil.ReadAll(resp.Body)

  	if resp.StatusCode != http.StatusOK {
  		return nil, fmt.Errorf("API call failed: %s - %s", resp.Status, string(body))
  	}

  	var result map[string]interface{}
  	json.Unmarshal(body, &result)

  	return result, nil
  }

  func getEnv(key, fallback string) string {
  	if value, ok := os.LookupEnv(key); ok {
  		return value
  	}
  	return fallback
  }

  func getResponseContent(result map[string]interface{}) string {
  	if choices, ok := result["choices"].([]interface{}); ok && len(choices) > 0 {
  		if choice, ok := choices[0].(map[string]interface{}); ok {
  			if message, ok := choice["message"].(map[string]interface{}); ok {
  				if content, ok := message["content"].(string); ok {
  					if len(content) > 200 {
  						return content[:200] + "..."
  					}
  					return content
  				}
  			}
  		}
  	}
  	return ""
  }

  // --- Main Execution ---
  func main() {
  	// Example 1: Auto-routing
  	fmt.Println("=== Example 1: Auto-Routing ===")
  	result1, err := makeV2AutoRouting("How does the Old Testament connect to the New Testament?", "evangelical")
  	if err != nil {
  		fmt.Println("Error:", err)
  		return
  	}
  	fmt.Printf("Model used: %v\n", result1["model"])
  	fmt.Printf("Routing: %v\n", result1["routing_mechanism"])
  	fmt.Printf("Response: %s\n", getResponseContent(result1))

  	// Example 2: Model family selection
  	fmt.Println("\n=== Example 2: Model Family Selection ===")
  	result2, err := makeV2ModelFamily("Draft a short sermon outline on forgiveness.", "anthropic")
  	if err != nil {
  		fmt.Println("Error:", err)
  		return
  	}
  	fmt.Printf("Model used: %v\n", result2["model"])
  	fmt.Printf("Response: %s\n", getResponseContent(result2))

  	// Example 3: Direct model selection
  	fmt.Println("\n=== Example 3: Direct Model Selection ===")
  	result3, err := makeV2DirectModel("Summarize the book of Romans in 3 sentences.", "gloo-anthropic-claude-sonnet-4.5")
  	if err != nil {
  		fmt.Println("Error:", err)
  		return
  	}
  	fmt.Printf("Model used: %v\n", result3["model"])
  	fmt.Printf("Response: %s\n", getResponseContent(result3))
  }
  ```

  ```java Java theme={null}
  import com.google.gson.Gson;
  import java.io.IOException;
  import java.net.URI;
  import java.net.http.HttpClient;
  import java.net.http.HttpRequest;
  import java.net.http.HttpResponse;
  import java.time.Instant;
  import java.util.Base64;
  import java.util.HashMap;
  import java.util.List;
  import java.util.Map;

  public class GlooV2Example {

      // --- Configuration ---
      private static final String CLIENT_ID = System.getenv().getOrDefault("GLOO_CLIENT_ID", "YOUR_CLIENT_ID");
      private static final String CLIENT_SECRET = System.getenv().getOrDefault("GLOO_CLIENT_SECRET", "YOUR_CLIENT_SECRET");
      private static final String TOKEN_URL = "https://platform.ai.gloo.com/oauth2/token";
      private static final String API_URL = "https://platform.ai.gloo.com/ai/v2/chat/completions";

      private TokenInfo tokenInfo;
      private final HttpClient httpClient = HttpClient.newHttpClient();
      private final Gson gson = new Gson();

      // --- Token Management ---
      private static class TokenInfo {
          String access_token;
          int expires_in;
          long expires_at;
      }

      private void fetchAccessToken() throws IOException, InterruptedException {
          String auth = CLIENT_ID + ":" + CLIENT_SECRET;
          String encodedAuth = Base64.getEncoder().encodeToString(auth.getBytes());
          String requestBody = "grant_type=client_credentials&scope=api/access";

          HttpRequest request = HttpRequest.newBuilder()
                  .uri(URI.create(TOKEN_URL))
                  .header("Content-Type", "application/x-www-form-urlencoded")
                  .header("Authorization", "Basic " + encodedAuth)
                  .POST(HttpRequest.BodyPublishers.ofString(requestBody))
                  .build();

          HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
          if (response.statusCode() != 200) throw new IOException("Failed to get token: " + response.body());

          this.tokenInfo = gson.fromJson(response.body(), TokenInfo.class);
          this.tokenInfo.expires_at = Instant.now().getEpochSecond() + this.tokenInfo.expires_in;
      }

      private boolean isTokenExpired() {
          if (this.tokenInfo == null || this.tokenInfo.expires_at == 0) return true;
          return Instant.now().getEpochSecond() > (this.tokenInfo.expires_at - 60);
      }

      private void ensureValidToken() throws IOException, InterruptedException {
          if (isTokenExpired()) {
              System.out.println("Token is expired or missing. Fetching a new one...");
              fetchAccessToken();
          }
      }

      // --- V2 Completion Functions ---
      public Map<String, Object> makeV2AutoRouting(String message, String tradition) throws IOException, InterruptedException {
          // Example 1: Auto-routing - Let Gloo AI select the optimal model
          ensureValidToken();
          Map<String, Object> payload = new HashMap<>();
          Map<String, String> messageEntry = new HashMap<>();
          messageEntry.put("role", "user");
          messageEntry.put("content", message);
          payload.put("messages", List.of(messageEntry));
          payload.put("auto_routing", true);
          payload.put("tradition", tradition);
          return makeRequest(gson.toJson(payload));
      }

      public Map<String, Object> makeV2ModelFamily(String message, String modelFamily) throws IOException, InterruptedException {
          // Example 2: Model family selection - Choose a provider family
          ensureValidToken();
          Map<String, Object> payload = new HashMap<>();
          Map<String, String> messageEntry = new HashMap<>();
          messageEntry.put("role", "user");
          messageEntry.put("content", message);
          payload.put("messages", List.of(messageEntry));
          payload.put("model_family", modelFamily);
          return makeRequest(gson.toJson(payload));
      }

      public Map<String, Object> makeV2DirectModel(String message, String model) throws IOException, InterruptedException {
          // Example 3: Direct model selection - Specify an exact model
          ensureValidToken();
          Map<String, Object> payload = new HashMap<>();
          Map<String, String> messageEntry = new HashMap<>();
          messageEntry.put("role", "user");
          messageEntry.put("content", message);
          payload.put("messages", List.of(messageEntry));
          payload.put("model", model);
          payload.put("temperature", 0.7);
          payload.put("max_tokens", 500);
          return makeRequest(gson.toJson(payload));
      }

      private Map<String, Object> makeRequest(String payload) throws IOException, InterruptedException {
          HttpRequest request = HttpRequest.newBuilder()
                  .uri(URI.create(API_URL))
                  .header("Content-Type", "application/json")
                  .header("Authorization", "Bearer " + this.tokenInfo.access_token)
                  .POST(HttpRequest.BodyPublishers.ofString(payload))
                  .build();

          HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
          if (response.statusCode() != 200) throw new IOException("API call failed: " + response.body());

          return gson.fromJson(response.body(), Map.class);
      }

      private String getResponseContent(Map<String, Object> result) {
          List<Map<String, Object>> choices = (List<Map<String, Object>>) result.get("choices");
          Map<String, Object> message = (Map<String, Object>) choices.get(0).get("message");
          String content = (String) message.get("content");
          return content.length() > 200 ? content.substring(0, 200) + "..." : content;
      }

      // --- Main Execution ---
      public static void main(String[] args) {
          GlooV2Example client = new GlooV2Example();
          try {
              // Example 1: Auto-routing
              System.out.println("=== Example 1: Auto-Routing ===");
              Map<String, Object> result1 = client.makeV2AutoRouting(
                  "How does the Old Testament connect to the New Testament?", "evangelical");
              System.out.println("Model used: " + result1.get("model"));
              System.out.println("Routing: " + result1.get("routing_mechanism"));
              System.out.println("Response: " + client.getResponseContent(result1));

              // Example 2: Model family selection
              System.out.println("\n=== Example 2: Model Family Selection ===");
              Map<String, Object> result2 = client.makeV2ModelFamily(
                  "Draft a short sermon outline on forgiveness.", "anthropic");
              System.out.println("Model used: " + result2.get("model"));
              System.out.println("Response: " + client.getResponseContent(result2));

              // Example 3: Direct model selection
              System.out.println("\n=== Example 3: Direct Model Selection ===");
              Map<String, Object> result3 = client.makeV2DirectModel(
                  "Summarize the book of Romans in 3 sentences.", "gloo-anthropic-claude-sonnet-4.5");
              System.out.println("Model used: " + result3.get("model"));
              System.out.println("Response: " + client.getResponseContent(result3));

          } catch (Exception e) {
              e.printStackTrace();
          }
      }
  }
  ```
</CodeGroup>

***

## Working Code Sample

<Card title="View Complete Code" icon="github" href="https://github.com/GlooDeveloper/gloo-ai-docs-cookbook/tree/main/completions-v2-tutorial">
  Clone or browse the complete working examples for all 6 languages (JavaScript, TypeScript, Python, PHP, Go, Java) with setup instructions.
</Card>

## Next Steps

Now that you understand the Completions V2 API, explore:

1. **[Completions V2 Guide](/api-guides/completions-v2)** - Full API documentation
2. **[Supported Model IDs](/api-guides/supported-models)** - All available models
3. **[Tool Use](/api-guides/tool-use)** - Function calling with completions
4. **[Chat Tutorial](/tutorials/chat)** - Stateful chat interactions
