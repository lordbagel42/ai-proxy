FROM node:22.23.2-bookworm@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src/ ./src/
COPY server/ ./server/
COPY tools/build-server.mjs ./tools/build-server.mjs
RUN npm run build:server

FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/lordbagel42/ai-proxy" \
      org.opencontainers.image.revision=$VCS_REF
ENV NODE_ENV=production AI_PROXY_ENV_FILE=/run/secrets/ai-proxy.env
WORKDIR /app
COPY --from=build /app/dist-server/*.mjs ./dist-server/
COPY public/ ./public/
COPY migrations/ ./migrations/
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "dist-server/healthcheck.mjs"]
CMD ["node", "dist-server/main.mjs"]
