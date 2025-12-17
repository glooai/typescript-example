# Gloo AI Data Engine Real-Time Ingestion v2 API - PoC Implementation Plan

## Overview

Implement a proof of concept integration with the Gloo AI Data Engine Real-Time Ingestion v2 API, enabling file uploads to a publisher for manual smoke testing.

## API Details

| Property     | Value                                                                    |
| ------------ | ------------------------------------------------------------------------ |
| Endpoint     | `https://api.gloo.ai/ingestion/v2/files`                                 |
| Method       | `POST`                                                                   |
| Content-Type | `multipart/form-data`                                                    |
| Auth         | Bearer token (JWT with `sub` = Client ID, `scope` includes `api/access`) |

### Request Parameters

| Field          | Type   | Description              |
| -------------- | ------ | ------------------------ |
| `publisher_id` | string | Target publisher ID      |
| `files`        | File[] | Array of files to ingest |

### Response Schema

```json
{
  "success": boolean,
  "message": string,
  "ingesting": string[],   // Files accepted for ingestion
  "duplicates": string[]   // Files already ingested (skipped)
}
```

## Target Configuration

| Property          | Value                                  |
| ----------------- | -------------------------------------- |
| Organization ID   | `ee3649bc-c859-471b-8de3-721198228930` |
| Organization Name | Servant                                |
| Publisher ID      | `46bb3153-04e4-4c9d-9465-1034f0213f99` |
| Publisher Name    | Servant                                |

---

## Implementation Steps

### Step 1: Update Environment Configuration

**File:** `.env.example`

Add the new environment variables alongside existing ones:

```env
# Existing
GLOO_AI_CLIENT_ID=your-client-id
GLOO_AI_CLIENT_SECRET=your-client-secret

# New - Ingestion API
GLOO_CLIENT_ID=your-ingestion-client-id
GLOO_CLIENT_SECRET=your-ingestion-client-secret
GLOO_PUBLISHER_ID=your-publisher-id
```

**Rationale:** The ingestion API may use different credentials than the chat API. Keeping them separate allows flexibility.

---

### Step 2: Create Ingestion Module

**File:** `src/ingestion.ts`

Implement the following exports:

```typescript
// Types
export interface IngestionCredentials {
  clientId: string;
  clientSecret: string;
}

export interface IngestionResponse {
  success: boolean;
  message: string;
  ingesting: string[];
  duplicates: string[];
}

// Functions
export function loadIngestionCredentials(): IngestionCredentials;
export function getIngestionToken(
  credentials: IngestionCredentials
): Promise<string>;
export function uploadFiles(
  token: string,
  publisherId: string,
  files: { name: string; content: Buffer | string }[]
): Promise<IngestionResponse>;
```

#### Implementation Details

1. **Token Acquisition**
   - Reuse the OAuth2 client credentials flow from existing code
   - Token endpoint: `https://platform.ai.gloo.com/oauth2/token`
   - Scope: `api/access`

2. **File Upload**
   - Use native `fetch` with `FormData`
   - Build multipart request with:
     - `publisher_id` field
     - Multiple `files` entries (one per file)
   - Set `Authorization: Bearer <token>` header
   - Parse JSON response

3. **Error Handling**
   - Throw on non-2xx responses with status and body
   - Validate response shape

---

### Step 3: Create CLI Script for Manual Testing

**File:** `src/ingest-files.ts`

A CLI script that:

1. Loads credentials from `.env.local`
2. Accepts file paths as command-line arguments
3. Reads files from disk
4. Uploads to the configured publisher
5. Prints formatted results

**Usage:**

```bash
pnpm ingest ./test-files/sample1.txt ./test-files/sample2.txt
```

**Output Example:**

```
Gloo AI Ingestion v2 - File Upload
==================================
Publisher: 46bb3153-04e4-4c9d-9465-1034f0213f99

Uploading 2 file(s)...

Response:
  Success: true
  Message: Files accepted for ingestion

  Ingesting (2):
    - sample1.txt
    - sample2.txt

  Duplicates (0):
    (none)
```

---

### Step 4: Create Test Files Directory

**Directory:** `test-files/`

Create sample text files for smoke testing:

| File          | Content                            |
| ------------- | ---------------------------------- |
| `sample1.txt` | Short sample text (~100 words)     |
| `sample2.txt` | Different sample text (~100 words) |
| `sample3.txt` | Third sample for batch testing     |

Add to `.gitignore`:

```
test-files/
```

---

### Step 5: Add npm Script

**File:** `package.json`

```json
{
  "scripts": {
    "ingest": "tsx src/ingest-files.ts"
  }
}
```

---

### Step 6: Write Unit Tests

**File:** `tests/ingestion.test.ts`

Test coverage for:

1. `loadIngestionCredentials()` - throws on missing env vars
2. `getIngestionToken()` - mocked OAuth flow
3. `uploadFiles()` - mocked multipart upload
4. Error handling scenarios
5. Response parsing

---

## File Structure After Implementation

```
typescript-example/
├── src/
│   ├── index.ts           # Existing chat API
│   ├── ingestion.ts       # NEW: Ingestion API module
│   └── ingest-files.ts    # NEW: CLI script
├── tests/
│   ├── gloo.test.ts       # Existing tests
│   └── ingestion.test.ts  # NEW: Ingestion tests
├── test-files/            # NEW: Sample files (gitignored)
│   ├── sample1.txt
│   ├── sample2.txt
│   └── sample3.txt
├── .env.example           # UPDATED: Add ingestion vars
└── .env.local             # UPDATED: Add real credentials
```

---

## Manual Testing Checklist

After implementation, verify:

- [ ] `.env.local` contains correct credentials
- [ ] `pnpm build` succeeds
- [ ] `pnpm test` passes
- [ ] `pnpm ingest test-files/sample1.txt` uploads successfully
- [ ] Response shows file in `ingesting` array
- [ ] Re-running same file shows it in `duplicates` array
- [ ] Multiple files upload works: `pnpm ingest test-files/*.txt`

---

## Security Considerations

1. **Credentials in `.env.local`** - Already gitignored
2. **Test files** - Gitignored to avoid accidental commits of sensitive test data
3. **Publisher ID validation** - API validates org membership server-side

---

## Future Enhancements (Out of Scope for PoC)

- File size validation before upload
- Progress indicators for large files
- Retry logic with exponential backoff
- Batch upload chunking
- Streaming uploads for large files
