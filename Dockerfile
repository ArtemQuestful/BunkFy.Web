# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM node:24.22.2-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ARG VITE_BUNKFY_API_BASE_URL=/
ENV VITE_BUNKFY_API_BASE_URL=$VITE_BUNKFY_API_BASE_URL
RUN pnpm build

FROM nginx:1.30.6-alpine@sha256:0e52bd054126cdc040b1276c0af347aeb02a41b9cfe305d6094767ac30e97949 AS web
ENV NGINX_ENVSUBST_FILTER=^BUNKFY_RELEASE_ID$ \
    BUNKFY_RELEASE_ID=local-unversioned
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/templates/default.conf.template
RUN apk upgrade --no-cache \
    && sed -i '/^user  nginx;/d' /etc/nginx/nginx.conf \
    && rm -f /etc/nginx/conf.d/default.conf \
    && touch /run/nginx.pid \
    && chown nginx:nginx /run/nginx.pid \
    && chown -R nginx:nginx /etc/nginx/conf.d \
    && chown -R nginx:nginx /var/cache/nginx
USER nginx
EXPOSE 8080
