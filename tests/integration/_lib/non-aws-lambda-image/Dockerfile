# A Lambda function image on a NON-AWS base, with no Lambda Runtime Interface
# Emulator of its own (go-to-k/cdk-local#867). cdk-local mounts one at
# /var/rapid/aws-lambda-rie and runs this image's ENTRYPOINT + CMD under it.
# Shared by the local-invoke-container, local-start-api-container and
# local-start-alb-lambda fixtures. The base image is multi-arch, so it builds
# natively at whichever architecture the fixture declares.
FROM python:3.12-alpine

COPY runtime.py /app/runtime.py

ENTRYPOINT ["/usr/local/bin/python3", "/app/runtime.py"]
CMD ["from-image-cmd"]
