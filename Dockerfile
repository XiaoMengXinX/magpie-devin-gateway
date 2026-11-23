# The upstream plugin's own tests and the gateway's run first; an upstream
# change that breaks either leaves the running image in place.
FROM oven/bun:1-alpine AS test
WORKDIR /app
COPY upstream/packages/devin upstream/packages/devin
COPY src src
COPY test test
RUN HOME=/tmp/home bun test ./upstream/packages/devin ./test

FROM node:22-alpine
WORKDIR /app
COPY --from=test /app/upstream/packages/devin/index.mjs /app/upstream/packages/devin/package.json upstream/packages/devin/
COPY src src
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8790/health >/dev/null || exit 1
CMD ["node", "src/main.mjs"]
