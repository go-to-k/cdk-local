# Issue #847 — the run-task image-override for SameStackTask (an image from a
# same-stack AWS::ECR::Repository). This Dockerfile sits BELOW its build
# context: it COPYs `site/` from the context root, so it builds only with
# `--image-context <target>=context-app`.
FROM public.ecr.aws/nginx/nginx:alpine
COPY site/index.html /usr/share/nginx/html/index.html
