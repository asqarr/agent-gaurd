FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/demo-store/package.json apps/demo-store/package.json
COPY packages/agentguard-sdk/package.json packages/agentguard-sdk/package.json
RUN npm ci

COPY apps/api apps/api
COPY apps/web apps/web
COPY packages/agentguard-sdk packages/agentguard-sdk
COPY scripts/launch-preflight.mjs scripts/launch-preflight.mjs
COPY docker-compose.prod.yml Caddyfile ./

# Build the React application into apps/web/dist so the API can serve the
# dashboard when deployed as a single Render Web Service.
RUN npm run build
RUN npm prune --omit=dev

ENV NODE_ENV=production
USER node

EXPOSE 4100
STOPSIGNAL SIGTERM
CMD ["node", "apps/api/src/server.mjs"]

