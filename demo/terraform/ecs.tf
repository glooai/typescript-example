# The proxy API as a Fargate service on the existing `genesis` cluster.
#
# This replaced a Lambda behind a Function URL. The account has an org-level
# guardrail that blocks CloudFront from invoking a Function URL at all, which
# no amount of resource policy or origin access control gets around, and
# every buffered alternative (API Gateway, ALB-to-Lambda) would have cost
# `/api/chat` its token-by-token streaming. A container writing into a
# chunked HTTP response keeps the streaming and needs no runtime-specific
# response-stream shim.
#
# The cluster is read, not managed: it belongs to another stack. A cluster is
# free, so this is about ownership rather than cost.

data "aws_ecs_cluster" "genesis" {
  cluster_name = var.ecs_cluster_name
}

resource "aws_ecr_repository" "api" {
  name                 = "${local.name_prefix}-api"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  # Demo infrastructure should be destroyable and re-creatable the same day.
  force_delete = true
}

# Image history here is deploy noise, not an artifact archive.
resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 5 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}

# Only the load balancer may reach the container, on the one port it serves.
# The task itself gets a public IP because the default VPC has no NAT
# gateway, so that address is its only route out to ECR, Secrets Manager, and
# the Gloo API. It is the same arrangement the genesis service already uses.
# Inbound is still closed to everything but the ALB's security group.
resource "aws_security_group" "api_task" {
  name        = "${local.name_prefix}-api-task"
  description = "Gloo AI demo API task: inbound from the shared ALB only"
  vpc_id      = data.aws_lb.genesis.vpc_id

  ingress {
    description     = "Container port, from the shared ALB"
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = data.aws_lb.genesis.security_groups
  }

  egress {
    description = "Outbound to ECR, Secrets Manager, DynamoDB, and the Gloo API"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name_prefix}-api"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "ecs_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Used by the ECS agent to start the task: pull the image, open the log
# stream. Nothing the application code runs as.
resource "aws_iam_role" "execution" {
  name               = "${local.name_prefix}-api-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Used by the process itself. Least privilege: read one secret and touch one
# table with the three actions it actually issues. No wildcards on resources,
# and no Scan.
resource "aws_iam_role" "task" {
  name               = "${local.name_prefix}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}

data "aws_iam_policy_document" "task" {
  statement {
    sid       = "ReadGlooApiKey"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.gloo_api_key.arn]
  }

  statement {
    sid    = "UseDemoTable"
    effect = "Allow"
    actions = [
      "dynamodb:PutItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:Query",
    ]
    resources = [aws_dynamodb_table.demo.arn]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "${local.name_prefix}-api-task"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# ARM64 because Fargate bills Graviton lower per vCPU-hour and nothing in a
# Node bundle is architecture-sensitive. The image has to be built for the
# same architecture; see demo/deploy.sh.
resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  # The Gloo API key is not here. It is read at startup from Secrets Manager
  # with the task role, so it never lands in the task definition, in a plan,
  # or in Terraform state.
  container_definitions = jsonencode([{
    name      = "api"
    image     = "${aws_ecr_repository.api.repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]

    environment = [
      { name = "PORT", value = tostring(var.container_port) },
      { name = "DEMO_TABLE_NAME", value = aws_dynamodb_table.demo.name },
      { name = "GLOO_API_KEY_SECRET_ID", value = aws_secretsmanager_secret.gloo_api_key.arn },
      { name = "ORIGIN_SECRET", value = random_password.origin_secret.result },
      { name = "VISITOR_SALT", value = random_password.visitor_salt.result },
    ]

    # Long enough for the server's own drain to finish an in-flight
    # completion before ECS escalates to SIGKILL.
    stopTimeout = 30

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "${local.name_prefix}-api"
  cluster         = data.aws_ecs_cluster.genesis.arn
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  # Rolling, one extra task at a time, old task kept until the new one is
  # healthy. A demo does not need blue/green and a second task costs money.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # Cold start is a container pull plus one Secrets Manager read, but ECR
  # pulls on a cold host are unpredictable; this stops the first health check
  # from failing the task before it has finished starting.
  health_check_grace_period_seconds = 60

  network_configuration {
    subnets          = data.aws_lb.genesis.subnets
    security_groups  = [aws_security_group.api_task.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = var.container_port
  }

  # The rule has to exist before the service registers targets, or the first
  # deployment's health checks run against a target group nothing routes to.
  depends_on = [aws_lb_listener_rule.api]
}
