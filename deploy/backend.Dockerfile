FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
COPY --chmod=0555 cli-proxy-api /usr/local/bin/cli-proxy-api
USER node
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/cli-proxy-api"]
CMD ["-config", "/config/cliproxyapi.yaml", "-local-model"]
