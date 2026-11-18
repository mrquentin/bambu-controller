# --- build the frontend ---
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime ---
FROM node:24-alpine
# ffmpeg is used to transcode RTSPS cameras (X1 / H2 / P2S) to MJPEG.
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server/index.ts"]
