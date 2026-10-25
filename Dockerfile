# Build one product:  docker build --build-arg APP=dunningdesk -t dunningdesk .
FROM node:22-slim
ARG APP
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
WORKDIR /srv
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --omit=dev --no-audit --no-fund
RUN test -n "$APP" && mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 3000
ENV APP=$APP
CMD ["sh", "-c", "node --disable-warning=ExperimentalWarning apps/$APP/server.js"]
