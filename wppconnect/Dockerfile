ARG NODE_IMAGE=node:22.22.2-alpine

FROM ${NODE_IMAGE} AS build
ARG WPP_VERSION=v2.10.0
WORKDIR /build

RUN apk add --no-cache git python3 make g++ vips-dev fftw-dev pkgconfig
RUN git clone --depth 1 --branch "${WPP_VERSION}" \
    https://github.com/wppconnect-team/wppconnect-server.git .

COPY chatwoot-auth.patch /tmp/chatwoot-auth.patch
RUN git apply /tmp/chatwoot-auth.patch

COPY config.ts src/config.ts

RUN corepack enable \
    && corepack prepare yarn@4.14.1 --activate \
    && yarn install --immutable \
    && yarn build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /usr/src/wpp-server

RUN apk add --no-cache chromium vips fftw tini

COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package.json ./package.json

ENV NODE_ENV=production
EXPOSE 21465
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
