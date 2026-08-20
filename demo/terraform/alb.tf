# The API's slot on the shared `genesis` load balancer.
#
# Nothing about the load balancer itself is managed here. It, its listeners,
# its existing target group, and the `genesis` service behind it belong to a
# different stack; every reference below is a `data` source read. What this
# file adds is a target group of its own, one host-based rule on the
# existing HTTPS listener, and one extra SNI certificate on that listener.
#
# Sharing the ALB rather than provisioning a second one is deliberate: an ALB
# costs money by the hour whether or not anything is behind it, and this is a
# proof of concept with one service and single-digit requests per day.
#
# Traffic only reaches the new target group when the Host header matches, so
# a request that does not match falls through to the listener's unchanged
# default action and lands where it did before.

data "aws_lb" "genesis" {
  name = var.shared_alb_name
}

data "aws_lb_listener" "genesis_https" {
  load_balancer_arn = data.aws_lb.genesis.arn
  port              = 443
}

# The origin hostname, distinct from the site hostname.
#
# CloudFront sends the origin domain name as SNI and validates the origin's
# certificate against it, so the origin needs a name of its own that resolves
# to the ALB: `glooai.servant.run` itself is an alias for the distribution,
# and pointing it at the ALB instead would make the whole site bypass
# CloudFront. This record is the only public DNS entry for the API, and
# hitting it directly still fails the `x-demo-origin` check.
resource "aws_acm_certificate" "origin" {
  domain_name       = var.origin_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "origin_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.origin.domain_validation_options : dvo.domain_name => {
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

resource "aws_acm_certificate_validation" "origin" {
  certificate_arn         = aws_acm_certificate.origin.arn
  validation_record_fqdns = [for r in aws_route53_record.origin_cert_validation : r.fqdn]
}

resource "aws_route53_record" "origin" {
  zone_id = data.aws_route53_zone.root.zone_id
  name    = var.origin_domain_name
  type    = "A"

  alias {
    name                   = data.aws_lb.genesis.dns_name
    zone_id                = data.aws_lb.genesis.zone_id
    evaluate_target_health = false
  }
}

# An additional certificate on the shared listener, not a replacement for its
# default. ALB listeners serve one certificate per SNI name, so adding this
# one changes nothing about how the existing hostname is served.
resource "aws_lb_listener_certificate" "origin" {
  listener_arn    = data.aws_lb_listener.genesis_https.arn
  certificate_arn = aws_acm_certificate_validation.origin.certificate_arn
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name_prefix}-api"
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = data.aws_lb.genesis.vpc_id
  target_type = "ip"

  # `/healthz` reports process liveness only, and answers without the shared
  # origin header, which a health check cannot send. A Gloo or DynamoDB
  # outage deliberately does not fail it: replacing the task would not fix
  # either and would drop live streams to do it.
  health_check {
    path                = "/healthz"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # Long enough for an in-flight completion to finish streaming, short enough
  # that a deploy is not held open by an idle keep-alive connection.
  deregistration_delay = 30
}

# Matched on Host so the rule can never capture traffic meant for anything
# else on this listener.
#
# The name that actually matches in production is `origin_domain_name`:
# CloudFront's Managed-AllViewerExceptHostHeader policy replaces the viewer's
# Host with the origin domain name. `domain_name` is listed as well so that
# swapping to a policy that does forward the viewer Host, or pointing a
# client straight at the site name, does not silently fall through to this
# listener's default action and land on another service.
resource "aws_lb_listener_rule" "api" {
  listener_arn = data.aws_lb_listener.genesis_https.arn
  priority     = var.alb_listener_rule_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    host_header {
      values = [var.domain_name, var.origin_domain_name]
    }
  }
}
