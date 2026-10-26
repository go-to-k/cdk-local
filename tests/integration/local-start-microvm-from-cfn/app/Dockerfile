# The MicroVM image's application layers. The multi-arch node:24-slim from ECR
# Public builds in the cloud (on the managed AL2023 base) and locally on either
# host architecture; Lambda's own container base is arm64-only and ships no
# language runtime.
FROM public.ecr.aws/docker/library/node:24-slim

WORKDIR /app
COPY app.js .
EXPOSE 8080
CMD ["node", "app.js"]
