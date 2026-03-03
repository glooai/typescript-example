> ## Documentation Index
> Fetch the complete documentation index at: https://docs.gloo.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Authentication with Gloo AI

> Learn how to authenticate with the Gloo AI API using OAuth2 client credentials flow.

This tutorial covers how to authenticate with the Gloo AI API using OAuth2 client credentials flow. Authentication is required for all API endpoints and involves exchanging your Client ID and Client Secret for a temporary access token.

## Overview

The Gloo AI API uses OAuth2 client credentials flow for authentication. This process involves:

1. **Get Client Credentials** - Obtain your Client ID and Client Secret from the Gloo AI Studio
2. **Exchange for Access Token** - Use your credentials to get a temporary bearer token
3. **Use Token in API Calls** - Include the bearer token in all API requests
4. **Handle Token Expiration** - Refresh tokens when they expire

## Prerequisites

Before starting, ensure you have:

* A Gloo AI Studio account
* Your Client ID and Client Secret from the [API Credentials page](/studio/manage-api-credentials)

## Step 1: Environment Setup

First, set up your environment variables to securely store your credentials:

### Environment Variables

Create a `.env` file in your project root:

```bash  theme={null}
GLOO_CLIENT_ID=your_actual_client_id_here
GLOO_CLIENT_SECRET=your_actual_client_secret_here
```

For Go and Java, you can also export them directly:

```bash  theme={null}
export GLOO_CLIENT_ID="your_actual_client_id_here"
export GLOO_CLIENT_SECRET="your_actual_client_secret_here"
```

## Step 2: Token Exchange

Exchange your Client ID and Client Secret for an access token by calling the OAuth2 token endpoint:

<CodeGroup>
  ```python Python theme={null}
  import requests
  import time
  import os
  from dotenv import load_dotenv

  load_dotenv()

  CLIENT_ID = os.getenv("GLOO_CLIENT_ID", "YOUR_CLIENT_ID")
  CLIENT_SECRET = os.getenv("GLOO_CLIENT_SECRET", "YOUR_CLIENT_SECRET")
  TOKEN_URL = "https://platform.ai.gloo.com/oauth2/token"

  def get_access_token():
      """Retrieve a new access token from the Gloo AI API."""
      headers = {"Content-Type": "application/x-www-form-urlencoded"}
      data = {"grant_type": "client_credentials", "scope": "api/access"}

      response = requests.post(TOKEN_URL, headers=headers, data=data, auth=(CLIENT_ID, CLIENT_SECRET))
      response.raise_for_status()

      token_data = response.json()
      token_data['expires_at'] = int(time.time()) + token_data['expires_in']

      return token_data

  # Example usage
  token_info = get_access_token()
  print(f"Access token: {token_info['access_token']}")
  print(f"Expires in: {token_info['expires_in']} seconds")
  ```

  ```javascript JavaScript theme={null}
  const axios = require('axios');
  require('dotenv').config();

  const CLIENT_ID = process.env.GLOO_CLIENT_ID || "YOUR_CLIENT_ID";
  const CLIENT_SECRET = process.env.GLOO_CLIENT_SECRET || "YOUR_CLIENT_SECRET";
  const TOKEN_URL = "https://platform.ai.gloo.com/oauth2/token";

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

  // Example usage
  getAccessToken().then(tokenInfo => {
      console.log(`Access token: ${tokenInfo.access_token}`);
      console.log(`Expires in: ${tokenInfo.expires_in} seconds`);
  });
  ```

  ```typescript TypeScript theme={null}
  import axios from 'axios';
  import * as dotenv from 'dotenv';

  dotenv.config();

  const CLIENT_ID = process.env.GLOO_CLIENT_ID || "YOUR_CLIENT_ID";
  const CLIENT_SECRET = process.env.GLOO_CLIENT_SECRET || "YOUR_CLIENT_SECRET";
  const TOKEN_URL = "https://platform.ai.gloo.com/oauth2/token";

  interface TokenInfo {
      access_token: string;
      expires_in: number;
      expires_at: number;
      token_type: string;
  }

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

  // Example usage
  getAccessToken().then(tokenInfo => {
      console.log(`Access token: ${tokenInfo.access_token}`);
      console.log(`Expires in: ${tokenInfo.expires_in} seconds`);
  });
  ```

  ```php PHP theme={null}
  <?php
  require_once 'vendor/autoload.php';

  $dotenv = Dotenv\Dotenv::createImmutable(__DIR__);
  $dotenv->load();

  $CLIENT_ID = getenv('GLOO_CLIENT_ID') ?: 'YOUR_CLIENT_ID';
  $CLIENT_SECRET = getenv('GLOO_CLIENT_SECRET') ?: 'YOUR_CLIENT_SECRET';
  $TOKEN_URL = 'https://platform.ai.gloo.com/oauth2/token';

  function getAccessToken($client_id, $client_secret, $token_url) {
      $post_data = 'grant_type=client_credentials&scope=api/access';
      $ch = curl_init();

      curl_setopt($ch, CURLOPT_URL, $token_url);
      curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
      curl_setopt($ch, CURLOPT_POST, 1);
      curl_setopt($ch, CURLOPT_POSTFIELDS, $post_data);
      curl_setopt($ch, CURLOPT_USERPWD, $client_id . ':' . $client_secret);
      curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/x-www-form-urlencoded']);

      $result = curl_exec($ch);
      if (curl_errno($ch)) {
          throw new Exception(curl_error($ch));
      }
      curl_close($ch);

      $token_data = json_decode($result, true);
      $token_data['expires_at'] = time() + $token_data['expires_in'];

      return $token_data;
  }

  // Example usage
  $token_info = getAccessToken($CLIENT_ID, $CLIENT_SECRET, $TOKEN_URL);
  echo "Access token: " . $token_info['access_token'] . "\n";
  echo "Expires in: " . $token_info['expires_in'] . " seconds\n";
  ?>
  ```

  ```go Go theme={null}
  package main

  import (
  	"encoding/json"
  	"fmt"
  	"io/ioutil"
  	"net/http"
  	"os"
  	"strings"
  	"time"
  )

  var (
  	clientID     = getEnv("GLOO_CLIENT_ID", "YOUR_CLIENT_ID")
  	clientSecret = getEnv("GLOO_CLIENT_SECRET", "YOUR_CLIENT_SECRET")
  	tokenURL     = "https://platform.ai.gloo.com/oauth2/token"
  )

  type TokenInfo struct {
  	AccessToken string `json:"access_token"`
  	ExpiresIn   int    `json:"expires_in"`
  	ExpiresAt   int64  `json:"expires_at"`
  	TokenType   string `json:"token_type"`
  }

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

  func getEnv(key, fallback string) string {
  	if value, ok := os.LookupEnv(key); ok {
  		return value
  	}
  	return fallback
  }

  // Example usage
  func main() {
  	tokenInfo, err := getAccessToken()
  	if err != nil {
  		fmt.Printf("Error: %v\n", err)
  		return
  	}

  	fmt.Printf("Access token: %s\n", tokenInfo.AccessToken)
  	fmt.Printf("Expires in: %d seconds\n", tokenInfo.ExpiresIn)
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

  public class AuthManager {
      private static final String CLIENT_ID = System.getenv().getOrDefault("GLOO_CLIENT_ID", "YOUR_CLIENT_ID");
      private static final String CLIENT_SECRET = System.getenv().getOrDefault("GLOO_CLIENT_SECRET", "YOUR_CLIENT_SECRET");
      private static final String TOKEN_URL = "https://platform.ai.gloo.com/oauth2/token";

      private static final HttpClient httpClient = HttpClient.newHttpClient();
      private static final Gson gson = new Gson();

      public static class TokenInfo {
          public String access_token;
          public int expires_in;
          public long expires_at;
          public String token_type;
      }

      public static TokenInfo getAccessToken() throws IOException, InterruptedException {
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

          if (response.statusCode() != 200) {
              throw new IOException("Failed to get access token: " + response.body());
          }

          TokenInfo token = gson.fromJson(response.body(), TokenInfo.class);
          token.expires_at = Instant.now().getEpochSecond() + token.expires_in;

          return token;
      }

      // Example usage
      public static void main(String[] args) {
          try {
              TokenInfo tokenInfo = getAccessToken();
              System.out.println("Access token: " + tokenInfo.access_token);
              System.out.println("Expires in: " + tokenInfo.expires_in + " seconds");
          } catch (Exception e) {
              e.printStackTrace();
          }
      }
  }
  ```
</CodeGroup>

## Step 3: Token Management

Access tokens are temporary and expire after a certain period. Implement token management to handle expiration:

<CodeGroup>
  ```python Python theme={null}
  # Global token storage
  access_token_info = {}

  def is_token_expired(token_info):
      """Check if the token is expired or close to expiring."""
      if not token_info or 'expires_at' not in token_info:
          return True
      return time.time() > (token_info['expires_at'] - 60)

  def ensure_valid_token():
      """Ensure we have a valid access token."""
      global access_token_info
      if is_token_expired(access_token_info):
          print("Getting new access token...")
          access_token_info = get_access_token()
      return access_token_info['access_token']

  # Usage in API calls
  def make_api_call():
      token = ensure_valid_token()
      headers = {"Authorization": f"Bearer {token}"}
      # Make your API call here
  ```

  ```javascript JavaScript theme={null}
  // Global token storage
  let tokenInfo = {};

  function isTokenExpired(token) {
      if (!token || !token.expires_at) return true;
      return (Date.now() / 1000) > (token.expires_at - 60);
  }

  async function ensureValidToken() {
      if (isTokenExpired(tokenInfo)) {
          console.log("Getting new access token...");
          tokenInfo = await getAccessToken();
      }
      return tokenInfo.access_token;
  }

  // Usage in API calls
  async function makeApiCall() {
      const token = await ensureValidToken();
      const headers = { 'Authorization': `Bearer ${token}` };
      // Make your API call here
  }
  ```

  ```typescript TypeScript theme={null}
  // Global token storage
  let tokenInfo: TokenInfo | null = null;

  function isTokenExpired(token: TokenInfo | null): boolean {
      if (!token || !(token as any).expires_at) return true;
      return (Date.now() / 1000) > ((token as any).expires_at - 60);
  }

  async function ensureValidToken(): Promise<string> {
      if (isTokenExpired(tokenInfo)) {
          console.log("Getting new access token...");
          tokenInfo = await getAccessToken();
      }
      return tokenInfo!.access_token;
  }

  // Usage in API calls
  async function makeApiCall(): Promise<void> {
      const token = await ensureValidToken();
      const headers = { 'Authorization': `Bearer ${token}` };
      // Make your API call here
  }
  ```

  ```php PHP theme={null}
  // Global token storage
  $token_info = [];

  function isTokenExpired($token) {
      if (empty($token) || !isset($token['expires_at'])) {
          return true;
      }
      return time() > ($token['expires_at'] - 60);
  }

  function ensureValidToken() {
      global $token_info, $CLIENT_ID, $CLIENT_SECRET, $TOKEN_URL;

      if (isTokenExpired($token_info)) {
          echo "Getting new access token...\n";
          $token_info = getAccessToken($CLIENT_ID, $CLIENT_SECRET, $TOKEN_URL);
      }

      return $token_info['access_token'];
  }

  // Usage in API calls
  function makeApiCall() {
      $token = ensureValidToken();
      $headers = ['Authorization: Bearer ' . $token];
      // Make your API call here
  }
  ```

  ```go Go theme={null}
  var tokenInfo *TokenInfo

  func isTokenExpired(token *TokenInfo) bool {
  	if token == nil || token.ExpiresAt == 0 {
  		return true
  	}
  	return time.Now().Unix() > (token.ExpiresAt - 60)
  }

  func ensureValidToken() (string, error) {
  	if isTokenExpired(tokenInfo) {
  		fmt.Println("Getting new access token...")
  		var err error
  		tokenInfo, err = getAccessToken()
  		if err != nil {
  			return "", err
  		}
  	}
  	return tokenInfo.AccessToken, nil
  }

  // Usage in API calls
  func makeApiCall() error {
  	token, err := ensureValidToken()
  	if err != nil {
  		return err
  	}
  	// Use token in Authorization header
  	// Make your API call here
  	return nil
  }
  ```

  ```java Java theme={null}
  private static TokenInfo tokenInfo;

  public static boolean isTokenExpired(TokenInfo token) {
      if (token == null || token.expires_at == 0) {
          return true;
      }
      return Instant.now().getEpochSecond() > (token.expires_at - 60);
  }

  public static String ensureValidToken() throws IOException, InterruptedException {
      if (isTokenExpired(tokenInfo)) {
          System.out.println("Getting new access token...");
          tokenInfo = getAccessToken();
      }
      return tokenInfo.access_token;
  }

  // Usage in API calls
  public static void makeApiCall() throws IOException, InterruptedException {
      String token = ensureValidToken();
      // Use token in Authorization header
      // Make your API call here
  }
  ```
</CodeGroup>

## Step 4: Using Tokens in API Calls

Once you have a valid access token, include it in the Authorization header of your API requests:

```http  theme={null}
Authorization: Bearer YOUR_ACCESS_TOKEN
```

### Example API Request

<CodeGroup>
  ```python Python theme={null}
  import requests

  def make_authenticated_request(endpoint, payload=None):
      """Make an authenticated API request."""
      token = ensure_valid_token()

      headers = {
          "Authorization": f"Bearer {token}",
          "Content-Type": "application/json"
      }

      if payload:
          response = requests.post(endpoint, headers=headers, json=payload)
      else:
          response = requests.get(endpoint, headers=headers)

      response.raise_for_status()
      return response.json()

  # Example usage
  result = make_authenticated_request(
      "https://platform.ai.gloo.com/ai/v1/chat/completions",
      {
          "model": "us.anthropic.claude-sonnet-4-20250514-v1:0",
          "messages": [{"role": "user", "content": "Hello!"}]
      }
  )
  ```

  ```javascript JavaScript theme={null}
  async function makeAuthenticatedRequest(endpoint, payload = null) {
      const token = await ensureValidToken();

      const config = {
          headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
          }
      };

      if (payload) {
          const response = await axios.post(endpoint, payload, config);
          return response.data;
      } else {
          const response = await axios.get(endpoint, config);
          return response.data;
      }
  }

  // Example usage
  const result = await makeAuthenticatedRequest(
      "https://platform.ai.gloo.com/ai/v1/chat/completions",
      {
          model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
          messages: [{ role: "user", content: "Hello!" }]
      }
  );
  ```

  ```typescript TypeScript theme={null}
  async function makeAuthenticatedRequest(endpoint: string, payload?: any): Promise<any> {
      const token = await ensureValidToken();

      const config = {
          headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
          }
      };

      if (payload) {
          const response = await axios.post(endpoint, payload, config);
          return response.data;
      } else {
          const response = await axios.get(endpoint, config);
          return response.data;
      }
  }

  // Example usage
  const result = await makeAuthenticatedRequest(
      "https://platform.ai.gloo.com/ai/v1/chat/completions",
      {
          model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
          messages: [{ role: "user", content: "Hello!" }]
      }
  );
  ```

  ```php PHP theme={null}
  function makeAuthenticatedRequest($endpoint, $payload = null) {
      $token = ensureValidToken();

      $headers = [
          'Authorization: Bearer ' . $token,
          'Content-Type: application/json'
      ];

      $ch = curl_init();
      curl_setopt($ch, CURLOPT_URL, $endpoint);
      curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
      curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);

      if ($payload) {
          curl_setopt($ch, CURLOPT_POST, 1);
          curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
      }

      $result = curl_exec($ch);
      if (curl_errno($ch)) {
          throw new Exception(curl_error($ch));
      }
      curl_close($ch);

      return json_decode($result, true);
  }

  // Example usage
  $result = makeAuthenticatedRequest(
      "https://platform.ai.gloo.com/ai/v1/chat/completions",
      [
          'model' => 'us.anthropic.claude-sonnet-4-20250514-v1:0',
          'messages' => [['role' => 'user', 'content' => 'Hello!']]
      ]
  );
  ```

  ```go Go theme={null}
  func makeAuthenticatedRequest(endpoint string, payload []byte) ([]byte, error) {
  	token, err := ensureValidToken()
  	if err != nil {
  		return nil, err
  	}

  	var req *http.Request
  	if payload != nil {
  		req, err = http.NewRequest("POST", endpoint, bytes.NewBuffer(payload))
  	} else {
  		req, err = http.NewRequest("GET", endpoint, nil)
  	}

  	if err != nil {
  		return nil, err
  	}

  	req.Header.Add("Authorization", "Bearer "+token)
  	req.Header.Add("Content-Type", "application/json")

  	client := &http.Client{}
  	resp, err := client.Do(req)
  	if err != nil {
  		return nil, err
  	}
  	defer resp.Body.Close()

  	return ioutil.ReadAll(resp.Body)
  }

  // Example usage
  payload := []byte(`{
  	"model": "us.anthropic.claude-sonnet-4-20250514-v1:0",
  	"messages": [{"role": "user", "content": "Hello!"}]
  }`)

  result, err := makeAuthenticatedRequest(
  	"https://platform.ai.gloo.com/ai/v1/chat/completions",
  	payload,
  )
  ```

  ```java Java theme={null}
  public static String makeAuthenticatedRequest(String endpoint, String payload) throws IOException, InterruptedException {
      String token = ensureValidToken();

      HttpRequest.Builder requestBuilder = HttpRequest.newBuilder()
              .uri(URI.create(endpoint))
              .header("Authorization", "Bearer " + token)
              .header("Content-Type", "application/json");

      if (payload != null) {
          requestBuilder.POST(HttpRequest.BodyPublishers.ofString(payload));
      } else {
          requestBuilder.GET();
      }

      HttpRequest request = requestBuilder.build();
      HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

      if (response.statusCode() != 200) {
          throw new IOException("API call failed: " + response.body());
      }

      return response.body();
  }

  // Example usage
  String payload = """
  {
      "model": "us.anthropic.claude-sonnet-4-20250514-v1:0",
      "messages": [{"role": "user", "content": "Hello!"}]
  }
  """;

  String result = makeAuthenticatedRequest(
      "https://platform.ai.gloo.com/ai/v1/chat/completions",
      payload
  );
  ```
</CodeGroup>

## Security Best Practices

### 1. Environment Variables

* Never hardcode credentials in your source code
* Use environment variables or secure credential storage
* Add `.env` files to your `.gitignore`

### 2. Token Storage

* Store tokens securely in memory
* Don't persist tokens to disk in production
* Implement proper token rotation

### 3. Network Security

* Always use HTTPS for API calls
* Implement proper error handling
* Use secure HTTP client configurations

### 4. Error Handling

* Handle authentication failures gracefully
* Implement retry logic for transient failures
* Log authentication events securely

## Common Issues and Solutions

### Issue: 401 Unauthorized

**Cause**: Token expired or invalid credentials
**Solution**: Implement token refresh logic and verify credentials

### Issue: 403 Forbidden

**Cause**: Insufficient permissions
**Solution**: Check your API access levels in the Studio

### Issue: Token Expired

**Cause**: Access token has exceeded its lifetime
**Solution**: Implement automatic token refresh before expiration

## Testing Your Implementation

Create a simple test to verify your authentication setup:

<CodeGroup>
  ```python Python theme={null}
  def test_authentication():
      """Test authentication flow."""
      try:
          # Test token retrieval
          token_info = get_access_token()
          print(f"✓ Token retrieved successfully")
          print(f"  Token type: {token_info.get('token_type')}")
          print(f"  Expires in: {token_info.get('expires_in')} seconds")

          # Test token validation
          token = ensure_valid_token()
          print(f"✓ Token validation successful")

          return True
      except Exception as e:
          print(f"✗ Authentication failed: {e}")
          return False

  if __name__ == "__main__":
      test_authentication()
  ```

  ```javascript JavaScript theme={null}
  async function testAuthentication() {
      try {
          // Test token retrieval
          const tokenInfo = await getAccessToken();
          console.log("✓ Token retrieved successfully");
          console.log(`  Token type: ${tokenInfo.token_type}`);
          console.log(`  Expires in: ${tokenInfo.expires_in} seconds`);

          // Test token validation
          const token = await ensureValidToken();
          console.log("✓ Token validation successful");

          return true;
      } catch (error) {
          console.error("✗ Authentication failed:", error.message);
          return false;
      }
  }

  testAuthentication();
  ```

  ```typescript TypeScript theme={null}
  async function testAuthentication(): Promise<boolean> {
      try {
          // Test token retrieval
          const tokenInfo = await getAccessToken();
          console.log("✓ Token retrieved successfully");
          console.log(`  Token type: ${tokenInfo.token_type}`);
          console.log(`  Expires in: ${tokenInfo.expires_in} seconds`);

          // Test token validation
          const token = await ensureValidToken();
          console.log("✓ Token validation successful");

          return true;
      } catch (error: any) {
          console.error("✗ Authentication failed:", error.message);
          return false;
      }
  }

  testAuthentication();
  ```

  ```php PHP theme={null}
  function testAuthentication() {
      try {
          // Test token retrieval
          global $CLIENT_ID, $CLIENT_SECRET, $TOKEN_URL;
          $token_info = getAccessToken($CLIENT_ID, $CLIENT_SECRET, $TOKEN_URL);
          echo "✓ Token retrieved successfully\n";
          echo "  Token type: " . $token_info['token_type'] . "\n";
          echo "  Expires in: " . $token_info['expires_in'] . " seconds\n";

          // Test token validation
          $token = ensureValidToken();
          echo "✓ Token validation successful\n";

          return true;
      } catch (Exception $e) {
          echo "✗ Authentication failed: " . $e->getMessage() . "\n";
          return false;
      }
  }

  testAuthentication();
  ```

  ```go Go theme={null}
  func testAuthentication() bool {
  	fmt.Println("Testing authentication...")

  	// Test token retrieval
  	tokenInfo, err := getAccessToken()
  	if err != nil {
  		fmt.Printf("✗ Authentication failed: %v\n", err)
  		return false
  	}

  	fmt.Println("✓ Token retrieved successfully")
  	fmt.Printf("  Token type: %s\n", tokenInfo.TokenType)
  	fmt.Printf("  Expires in: %d seconds\n", tokenInfo.ExpiresIn)

  	// Test token validation
  	token, err := ensureValidToken()
  	if err != nil {
  		fmt.Printf("✗ Token validation failed: %v\n", err)
  		return false
  	}

  	fmt.Println("✓ Token validation successful")
  	return true
  }

  func main() {
  	testAuthentication()
  }
  ```

  ```java Java theme={null}
  public static boolean testAuthentication() {
      try {
          // Test token retrieval
          TokenInfo tokenInfo = getAccessToken();
          System.out.println("✓ Token retrieved successfully");
          System.out.println("  Token type: " + tokenInfo.token_type);
          System.out.println("  Expires in: " + tokenInfo.expires_in + " seconds");

          // Test token validation
          String token = ensureValidToken();
          System.out.println("✓ Token validation successful");

          return true;
      } catch (Exception e) {
          System.err.println("✗ Authentication failed: " + e.getMessage());
          return false;
      }
  }

  public static void main(String[] args) {
      testAuthentication();
  }
  ```
</CodeGroup>

## Working Code Sample

<Card title="View Complete Code" icon="github" href="https://github.com/GlooDeveloper/gloo-ai-docs-cookbook/tree/main/authentication-tutorial">
  Clone or browse the complete working examples for all 6 languages (JavaScript, TypeScript, Python, PHP, Go, Java) with setup instructions.
</Card>

## Next Steps

Now that you have authentication set up, you can use it in other Gloo AI tutorials:

1. **[Building Interactive Chat](/tutorials/chat)** - Create conversational experiences
2. **[Using the Completions API](/tutorials/completions)** - Generate text completions
3. **[API Reference](/api-reference)** - Explore all available endpoints

The authentication patterns shown here work across all Gloo AI API endpoints, providing a secure foundation for your applications.
