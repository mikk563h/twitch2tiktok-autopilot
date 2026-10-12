# syntax=docker/dockerfile:1.7
# ---------- whisper.cpp (speech-to-text, CPU) ----------
FROM debian:bookworm-slim AS whisper
ARG WHISPER_CPP_VERSION=v1.9.5
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${WHISPER_CPP_VERSION} https://github.com/ggml-org/whisper.cpp /src \
 && cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DGGML_NATIVE=OFF \
 && cmake --build /build -j"$(nproc)" --target whisper-cli \
 && cp /build/bin/whisper-cli /usr/local/bin/whisper-cli

# ---------- node dependencies ----------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=optional --no-audit --no-fund || npm ci --no-audit --no-fund

# ---------- Next.js build ----------
FROM deps AS build
COPY . .
RUN npx next build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:24-bookworm-slim AS runtime
ARG YTDLP_VERSION=2026.08.19
ARG TARGETARCH
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 DATA_DIR=/data FONTS_DIR=/app/assets/fonts \
    WHISPER_BIN=/usr/local/bin/whisper-cli YTDLP_PATH=/usr/local/bin/yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl tini fontconfig \
 && rm -rf /var/lib/apt/lists/* \
 && YT=$([ "$TARGETARCH" = "arm64" ] && echo yt-dlp_linux_aarch64 || echo yt-dlp_linux) \
 && curl -fsSL -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${YT}" \
 && chmod +x /usr/local/bin/yt-dlp
COPY --from=whisper /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
