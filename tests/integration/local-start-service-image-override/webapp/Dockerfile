FROM public.ecr.aws/docker/library/node:22-alpine
# Issue #659 — verify.sh sets this through the PER-SERVICE build-arg form
# (`--image-build-arg AppService:OVERRIDE_PAYLOAD=...`), so the response proves
# the short service key reached this target's `docker build`.
ARG OVERRIDE_PAYLOAD=OVERRIDE_OK
ENV OVERRIDE_PAYLOAD=${OVERRIDE_PAYLOAD}
WORKDIR /app
COPY server.cjs /app/server.cjs
EXPOSE 8080
CMD ["node", "/app/server.cjs"]
