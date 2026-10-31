# syntax=docker/dockerfile:1
FROM node:24.22.2-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.22.2-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/*
RUN git --version && rg --version
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --chmod=a+rX vault-template /app/vault-template
RUN mkdir -p /data/vault /data/auth \
    && chown node:node /data/vault /data/auth \
    && chmod 700 /data/auth
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=192
USER node
CMD ["node", "dist/index.js"]
