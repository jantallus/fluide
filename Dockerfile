# ── Build stage ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Sécurité : user non-root
RUN addgroup -S fluide && adduser -S fluide -G fluide

WORKDIR /app

# Copie des dépendances de production uniquement
COPY --from=deps /app/node_modules ./node_modules

# Copie du code source (voir .dockerignore pour les exclusions)
COPY . .

# Ownership
RUN chown -R fluide:fluide /app
USER fluide

ENV NODE_ENV=production \
    PORT=3001 \
    TZ=Europe/Paris

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "index.js"]
