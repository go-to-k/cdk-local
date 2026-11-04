# Issue #847 — a monorepo Dockerfile BELOW its build context: it COPYs
# `shared/` from the context root, so it builds only with
# `--image-context SameStackService=./monorepo` (the default context, this
# file's own directory, has no `shared/`).
FROM public.ecr.aws/docker/library/node:22-alpine
WORKDIR /app
COPY shared/payload.txt /app/payload.txt
COPY apps/api/server.cjs /app/server.cjs
EXPOSE 8080
CMD ["node", "/app/server.cjs"]
