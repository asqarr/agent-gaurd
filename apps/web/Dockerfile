FROM node:24-alpine AS build

ARG VITE_SITE_URL=https://agentguard.dev
ENV VITE_SITE_URL=${VITE_SITE_URL}

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/demo-store/package.json apps/demo-store/package.json
COPY packages/agentguard-sdk/package.json packages/agentguard-sdk/package.json
RUN npm ci

COPY apps/web apps/web
RUN npm run build

FROM nginx:1.30.5-alpine3.24

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

