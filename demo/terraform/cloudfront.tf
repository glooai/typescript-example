data "aws_route53_zone" "root" {
  name         = "${var.root_zone_name}."
  private_zone = false
}

resource "aws_acm_certificate" "site" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.site.domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }

  zone_id = data.aws_route53_zone.root.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.value]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "site" {
  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_cloudfront_function" "basic_auth" {
  name    = "${local.name_prefix}-basic-auth"
  runtime = "cloudfront-js-2.0"
  comment = "Basic Auth gate (gloo/ai) to keep the demo out of search indexes"
  publish = true
  code    = file("${path.module}/functions/basic-auth.js")
}

# Search engines that ignore robots.txt still honour X-Robots-Tag. Belt and
# braces with the Basic Auth gate and the meta tag in index.html.
resource "aws_cloudfront_response_headers_policy" "noindex" {
  name = "${local.name_prefix}-noindex"

  custom_headers_config {
    items {
      header   = "X-Robots-Tag"
      value    = "noindex, nofollow"
      override = true
    }
  }

  security_headers_config {
    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
  }
}

locals {
  s3_origin_id     = "s3-${aws_s3_bucket.site.id}"
  lambda_origin_id = "lambda-${aws_lambda_function.api.function_name}"

  # AWS managed policies, referenced by their well-known ids.
  cache_policy_optimized    = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  cache_policy_disabled     = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  origin_request_all_viewer = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  default_root_object = "index.html"
  aliases             = [var.domain_name]
  comment             = "Gloo AI demo (${var.domain_name})"
  price_class         = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = local.s3_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    domain_name = replace(
      replace(aws_lambda_function_url.api.function_url, "https://", ""),
      "/",
      "",
    )
    origin_id = local.lambda_origin_id

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }

    # Proves the request came through this distribution. The Function URL is
    # publicly addressable (see the note in lambda.tf), so this is what stops
    # anyone who finds the URL from spending our Gloo tokens.
    custom_header {
      name  = "x-demo-origin"
      value = random_password.origin_secret.result
    }
  }

  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    compress                   = true
    cache_policy_id            = local.cache_policy_optimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.noindex.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.basic_auth.arn
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = local.lambda_origin_id
    viewer_protocol_policy = "https-only"

    # Compression would make CloudFront buffer the response, which defeats
    # the point of streaming the chat endpoint.
    compress = false

    cache_policy_id            = local.cache_policy_disabled
    origin_request_policy_id   = local.origin_request_all_viewer
    response_headers_policy_id = aws_cloudfront_response_headers_policy.noindex.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.basic_auth.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "site" {
  zone_id = data.aws_route53_zone.root.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
