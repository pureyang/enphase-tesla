FROM node:24-alpine

# Local time matters: the advisor plans "until midnight" and learns per hour of day.
RUN apk add --no-cache tzdata

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY proto ./proto
COPY scripts ./scripts

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
VOLUME /app/data
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
