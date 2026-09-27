# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim AS harness
RUN npm install -g @openai/codex@0.155.1

FROM rust:1.94-bookworm AS backend
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler libprotobuf-dev clang cmake libssl-dev pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY backend/ backend/
COPY vendor/ vendor/
COPY migrations/ migrations/
ENV PROTOC=/usr/bin/protoc RUST_MIN_STACK=67108864
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/build/target cargo build --locked --jobs 2 && cp target/debug/agentic-enterprise /usr/local/bin/agentic-enterprise

FROM debian:bookworm-slim AS platform
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl perl libssl3 libgomp1 git openssh-client && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 10001 agent && mkdir /data /workdir && chown agent:agent /data /workdir
COPY scripts/install-onnx.sh /tmp/install-onnx.sh
RUN bash /tmp/install-onnx.sh /usr/local/lib && ldconfig && rm /tmp/install-onnx.sh
ENV ORT_DYLIB_PATH=/usr/local/lib/libonnxruntime.so
COPY --from=backend /usr/local/bin/agentic-enterprise /usr/local/bin/
COPY --from=frontend /build/frontend/dist /app/frontend
USER agent
WORKDIR /app
VOLUME ["/data", "/workdir"]
EXPOSE 8765
ENTRYPOINT ["agentic-enterprise"]
CMD ["--org", "/data/org", "--bind", "0.0.0.0", "--frontend", "/app/frontend"]

FROM platform AS worker
USER root
COPY --from=harness /usr/local/bin/node /usr/local/bin/node
COPY --from=harness /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s /usr/local/lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex && mkdir -p /home/agent/.codex && chown agent:agent /home/agent/.codex
USER agent
CMD ["--worker", "--worker-state", "/data/worker", "--worker-root", "/workdir"]
