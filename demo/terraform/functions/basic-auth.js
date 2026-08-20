// CloudFront viewer-request function: HTTP Basic Auth gate.
//
// The credentials (gloo / ai) are deliberately not secret and are documented
// in the repo README. They exist to keep a public demo out of search engine
// crawls and casual drive-by traffic, layered on top of X-Robots-Tag and
// robots.txt. They are not access control and nothing behind them is
// sensitive.
//
// CloudFront Functions have no crypto or Buffer, so the expected header
// value is a precomputed literal: base64("gloo:ai").
var EXPECTED = "Basic Z2xvbzphaQ==";

function handler(event) {
  var headers = event.request.headers;

  if (headers.authorization && headers.authorization.value === EXPECTED) {
    return event.request;
  }

  return {
    statusCode: 401,
    statusDescription: "Unauthorized",
    headers: {
      "www-authenticate": { value: 'Basic realm="Gloo AI demo"' },
      "cache-control": { value: "no-store" },
      "x-robots-tag": { value: "noindex, nofollow" },
    },
  };
}
