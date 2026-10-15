FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS backend-download
RUN test "$(dpkg --print-architecture)" = amd64 \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fL --retry 3 https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.28/CLIProxyAPI_8.0.28_linux_amd64_no-plugin.tar.gz -o /tmp/backend.tar.gz \
    && echo '7d41095b7daaf61ea29cdcc691c238acda4da352acf8babe3f8d8720595f7d35  /tmp/backend.tar.gz' | sha256sum -c - \
    && mkdir /backend && tar -xzf /tmp/backend.tar.gz -C /backend

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/router4u /var/lib/router4u-transcripts && chown node:node /var/lib/router4u /var/lib/router4u-transcripts
WORKDIR /app
COPY --from=backend-download --chmod=0555 /backend/cli-proxy-api /usr/local/bin/cli-proxy-api
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chmod=0555 deploy/entrypoint.sh /usr/local/bin/router4u
USER node
EXPOSE 9470
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node /app/src/container-health.js
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/router4u"]
CMD ["start"]
