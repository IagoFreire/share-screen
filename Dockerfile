# Kept for local dev parity / a future move to a bigger instance. Production on the
# 1GB Lightsail box uses bare systemd + Caddy instead -- see docs/DEPLOY.md for why
# (Docker daemon overhead competes with the relay for a thin RAM budget).
FROM node:22-slim AS build
WORKDIR /app

COPY package.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm install

COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN useradd --system --create-home appuser

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/shared/package.json ./shared/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/client/dist ./client/dist

USER appuser
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--max-old-space-size=256", "server/dist/index.js"]
