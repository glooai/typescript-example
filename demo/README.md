# Gloo AI demo

A small hosted proof of concept for the Gloo Completions V2 API, intended for
`https://glooai.servant.run`.

Two things are on show, both against live traffic:

1. **Chat** streams a completion token by token and, when the stream ends,
   reports the model that actually handled it, the routing tier, time to
   first token, token counts, and the estimated cost of that one call.
2. **Compare** sends one prompt across several routing mechanisms at the same
   time (auto routing, a provider family, an exact model) and puts the real
   answers side by side with measured latency and cost, flagging the fastest
   and cheapest.

A third view, **Observed**, reads back the request ledger so the cost and
latency figures are averages over calls this demo actually made, not list
price arithmetic on invented token counts.

## Layout

| Path         | What it is                                                          |
| ------------ | ------------------------------------------------------------------- |
| `web/`       | `@glooai/demo-web`, a static React SPA built with Vite              |
| `api/`       | `@glooai/demo-api`, the proxy HTTP server (bundled, containerized)  |
| `terraform/` | S3, CloudFront, ACM, Route53, ECR, ECS, ALB rule, DynamoDB, Secrets |
| `deploy.sh`  | Pushes the API image and redeploys ECS, then syncs the SPA to S3    |

## Architecture

```
browser -> CloudFront (Basic Auth viewer function, X-Robots-Tag)
             |- default behavior  -> S3 (private, origin access control)
             `- /api/*            -> shared `genesis` ALB, host-based rule
                                       `- ECS Fargate task (Node, ARM64)
                                            |- Gloo Completions V2
                                            |- Secrets Manager (Gloo API key)
                                            `- DynamoDB (ledger + sessions)
```

The SPA holds no credentials. Every Gloo call goes through the API service,
which reads the API key from Secrets Manager at startup using its ECS task
role.

### Why Fargate and not Lambda

It was a Lambda behind a Function URL. This account has an org-level
guardrail that blocks CloudFront from invoking a Function URL at all, which
neither a correctly scoped resource policy nor a CloudFront origin access
control gets around: the invoke returns `AccessDeniedException` either way.

The alternatives that keep Lambda (API Gateway, ALB-to-Lambda) both buffer
the response, which would have cost `/api/chat` its token-by-token
streaming, and that is the whole point of the Chat panel. A container writing
into a chunked HTTP response streams natively and drops the
`awslambda.HttpResponseStream` shim with it.

### Why the shared ALB

The `genesis` ALB in this account already runs, so a second one would be a
fixed hourly cost for one service and single-digit requests per day. This
stack reads it with `data` sources and adds three things it owns: a target
group, one host-based listener rule, and one extra SNI certificate on the
existing HTTPS listener. The listener's default action is unchanged, so
anything that does not match the rule's host still lands where it did.

### The origin hostname

`/api/*` is served from `glooai-origin.servant.run`, not from the ALB's own
`*.elb.amazonaws.com` name. CloudFront sends the origin domain name as SNI
and validates the origin certificate against it, and an ALB serves
certificates for named hosts. `glooai.servant.run` cannot be that name: it is
already an alias for the distribution.

Reaching that hostname directly skips CloudFront's Basic Auth gate but still
fails the `x-demo-origin` check, which is what the header is for.

### Why the frontend is Vite and not Next.js

The `chatbot/` package in this repo already demonstrates the Next.js server
rendered pattern. This one is deliberately the other shape: a static bundle on
S3 with no server runtime, so the only compute is the proxy API service.

### Light and dark

The palette is a set of semantic CSS variables (`--surface`, `--line`,
`--muted-text`, `--accent`) that Tailwind's theme tokens point at, so the
components name a role rather than a colour and the two themes are two blocks
of variable values in `web/src/index.css`. The alternative, a `dark:` variant
on every className, doubles every class string in the app for the same result.

The brand gold stays `#FFD727` wherever it is a background with dark text on
it. Gold as _text_ is about 1.5:1 on white, so the accent variable resolves to
a darkened gold in light mode; every text pair in both themes clears WCAG AA.

An inline script in `web/index.html` resolves the theme before the first
paint, because the module bundle loads too late to avoid a flash of the wrong
one. An explicit choice in `localStorage` wins; with no choice stored the OS
`prefers-color-scheme` decides, including when it changes mid-visit. The
toggle in the header shows the theme it switches to.

### Streaming vs buffering

`/api/chat` streams. The server writes Gloo's SSE straight into a chunked
response as its own three-event protocol (`delta`, `meta`, `error`), and
CloudFront passes it through with compression disabled on that behavior so
nothing buffers.

`/api/compare` buffers on purpose. It fans one prompt out to several routing
variants concurrently and the comparison is only meaningful once every variant
has finished, so streaming it would add moving parts for no user-visible gain.

### Why there is a shared origin header

There is no origin-access-control equivalent for an ALB origin, and the ALB
is internet-facing and shared, so the network is not the gate. CloudFront
injects a shared `x-demo-origin` header on every origin request and the
server rejects anything without it. The task's own security group still
allows inbound only from the ALB's security group, so the container itself is
not addressable.

That header value is generated by Terraform and lives in Terraform state. The
Gloo API key does not: Terraform creates an empty Secrets Manager secret and
a human populates it.

`GET /healthz` is the one route that answers without the header, because an
ALB health check cannot send it. It reports process liveness only: a Gloo or
DynamoDB outage deliberately does not fail it, since replacing the task would
not fix either and would drop live streams to do it.

## Data model

One DynamoDB table, pay-per-request, TTL on `expires_at`. Two entity types:

| Key                                        | Why it exists                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `pk = LEDGER#<UTC date>`, `sk = <ts>#<id>` | One row per proxied call, so the cost and latency view reports measured traffic instead of registry arithmetic. Expires after 7 days.   |
| `pk = SESSION#<id>`, `sk = MSG#<seq>`      | One row per chat message, so a demo conversation survives a page refresh without any server-side session store. Expires after 12 hours. |

Both entity types also carry an anonymous visitor trace, described below.

DynamoDB rather than Postgres because it costs nothing at rest, needs no
migration before a deploy, and there is nothing relational about two
independent key-addressed entity types. No secondary indexes, because every
read is a Query against a known partition key. The ledger partition is the UTC calendar day rather than a constant, so
writes rotate instead of concentrating on one partition forever; reads cover
today and yesterday and merge.

Costs are computed from the live `platform/v2/models` registry (which
publishes per-million-token rates) multiplied by the token counts Gloo
reports, with cached prompt tokens billed at the cache-read rate. A model the
registry does not price shows as `unpriced` rather than `$0`.

## Anonymous visitor tracking

Every proxied call is tagged with an opaque anonymous visitor id so a
person's activity can be followed across requests when debugging something
or reviewing how much this proof of concept is being used.

### Where the cookie is set, and why there

The proxy API mints it, not CloudFront. `functions/basic-auth.js` is a
viewer-request function, so it runs before the origin and can only mutate the
request; it cannot attach a `Set-Cookie` to the response at all. A second
CloudFront function on viewer-response could, but CloudFront Functions have
no `crypto`, so the id would come out of `Math.random()`, and it would mean a
second published function and a second behavior association to maintain. The
API has real `crypto.randomUUID()` and is the only component that writes
the rows the id is a trace key for. The trade is that a visitor who loads the
page and never sends a prompt never gets an id, which is exactly the visitor
who leaves no rows to correlate.

`GET /api/models` is the one route that deliberately sends no `Set-Cookie`,
because it is the one cacheable response and a replayed cache hit should not
replay a cookie. The next uncached call issues it.

### Cookie

`gloo_demo_vid`, holding `v-` plus 32 random hex characters from
`crypto.randomUUID()`. Nothing about it is derived from anything personal.
`Path=/`, `Max-Age` 30 days, `Secure`, `HttpOnly`, `SameSite=Lax`.

`HttpOnly` because the SPA never reads it: the browser attaches it to the
same-origin `/api/*` calls and the API reads it there. `SameSite=Lax`
rather than `Strict` because both work for the app's own same-origin
requests, and `Lax` additionally keeps the cookie attached when someone opens
the demo link from an email or a chat message, which is how this demo gets
visited and is exactly the continuity the id is for.

### What is captured, and what is not

Technical signals only: the anonymous id, a salted hash of the client IP, the
User-Agent, and the request timestamp. Nothing is parsed out of message text
to enrich a visitor's record. The chat transcript is stored separately and
only so the SPA can replay a conversation after a refresh.

The IP is stored as a salted, truncated SHA-256 rather than the address
itself. Telling calls from one client apart, and spotting one client hammering
the demo, both work off a hash, and recovering the address has no use here.
The salt is a per-deployment `random_password`, so the hashes are not
reversible with a precomputed table and do not correlate across a rebuild.

All of it rides on the existing rows and the existing `expires_at` TTL, so it
expires with them: 7 days for ledger rows, 12 hours for conversations. The
`/api/ledger` response strips the trace, so an IP hash never reaches a
browser.

### With no cookie

The cookie is optional everywhere. Safari private browsing, ITP, a blocker,
or a visitor who clears cookies mid-session all behave the same way: the
API mints an id for that request, records it as `visitor_id_source:
"issued"` rather than `"cookie"`, and offers the cookie again. Nothing about
the response changes, no error surfaces, and chat and compare work exactly as
they do otherwise. Marking the source is what stops a reader from mistaking a
string of one-request ids for one visitor who came back.

When that happens the SPA's `localStorage` session id, already sent in the
request body, is recorded next to the visitor id as the fallback correlator.
The two ids stay separate on purpose: the session id keys a transcript and
dies with `localStorage`, the visitor id spans sessions and lives in a cookie,
and either can be missing without the other becoming useless. The frontend
was not changed for any of this.

## Local development

The SPA needs the API. Point it at the deployed origin:

```bash
export DEMO_API_URL="$(terraform -chdir=terraform output -raw api_origin_url)"
export DEMO_ORIGIN_SECRET="$(terraform -chdir=terraform output -raw origin_secret)"
pnpm --filter @glooai/demo-web dev
```

Vite proxies `/api/*` to that URL and adds the origin header, so the app runs
on the same relative paths it uses in production.

Or run the API itself, which needs the same four variables the ECS task
definition sets and AWS credentials that can read the secret and the table:

```bash
pnpm --filter @glooai/demo-api build

DEMO_TABLE_NAME="$(terraform -chdir=terraform output -raw dynamodb_table_name)" \
GLOO_API_KEY_SECRET_ID="$(terraform -chdir=terraform output -raw gloo_api_key_secret_id)" \
ORIGIN_SECRET=local VISITOR_SALT=local PORT=5174 \
AWS_PROFILE=servant-internal \
  node api/dist/server/index.mjs
```

## Deploying

The stack is applied and live. A full deploy from a machine with the
`servant-internal` profile configured (the DNS records go into a hosted zone
in a second account, reached through the `personal` profile):

```bash
aws sso login --profile servant-internal

cd demo/terraform
terraform init
terraform plan
terraform apply

# Populate the Gloo API key (Terraform creates the secret, never its value).
aws secretsmanager put-secret-value \
  --profile servant-internal \
  --secret-id "$(terraform output -raw gloo_api_key_secret_id)" \
  --secret-string 'YOUR_GLOO_AI_API_KEY'

cd ..
./deploy.sh
```

`terraform apply` creates the ECR repository but no image, so the first ECS
service comes up with nothing to pull and stays unhealthy until `deploy.sh`
pushes one. That is one cycle of failed tasks on a first apply, not a broken
deploy.

`deploy.sh` builds the API image for `linux/arm64`, pushes it tagged with the
short commit sha and `latest`, forces a new ECS deployment, then builds and
syncs the SPA and invalidates the distribution. It needs Docker with `buildx`
available. The task definition runs `:latest`, so routine backend deploys do
not need a Terraform apply; set `image_tag` to a specific tag to pin or roll
back one.

`terraform apply` blocks on ACM DNS validation, which usually clears in a few
minutes since the validation records go into the same hosted zone.

State is local to `demo/terraform/` and gitignored, matching the pattern used
by the sibling `patrick.servant.run` site. Move it to a remote backend if this
stops being single-owner.

## Access

The distribution sits behind an HTTP Basic Auth gate, username `gloo`,
password `ai`. These are deliberately not secret. They keep the demo out of
search engine crawls and casual traffic, alongside `X-Robots-Tag: noindex` and
`robots.txt`. Nothing behind the gate is sensitive and this is not access
control.
