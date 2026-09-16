FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY scripts ./scripts
RUN npm run typecheck && npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3410 ATTACHMENT_ROOT=/app/runtime/attachments
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY scripts/container-entry.sh ./container-entry.sh
COPY package.json LICENSE NOTICE.md ./
RUN mkdir -p /app/runtime/attachments && chown -R node:node /app/runtime
USER node
EXPOSE 3410
CMD ["sh", "container-entry.sh"]
