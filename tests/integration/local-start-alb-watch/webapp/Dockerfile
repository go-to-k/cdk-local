FROM public.ecr.aws/docker/library/busybox:1.36
WORKDIR /app
COPY server.sh /app/server.sh
RUN chmod +x /app/server.sh
EXPOSE 8080
CMD ["/bin/sh", "/app/server.sh"]
