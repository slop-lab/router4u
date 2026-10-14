FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chmod=0555 deploy/entrypoint.sh /usr/local/bin/router4u
USER node
EXPOSE 9470
ENTRYPOINT ["/usr/local/bin/router4u"]
CMD ["serve", "--config", "/config/router4u.json"]
