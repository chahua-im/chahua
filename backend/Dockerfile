ARG BUILDER_BASE_REPOSITORY=ghcr.io/chahua-im/chahua-backend-builder-base
ARG BUILDER_BASE_TAG=rust-1.95.0-trixie
ARG RUNTIME_BASE_IMAGE=ghcr.io/chahua-im/chahua-backend-runtime-base:trixie
ARG TARGETARCH
ARG BUILDPLATFORM

# Build stage
FROM --platform=$BUILDPLATFORM ${BUILDER_BASE_REPOSITORY}:${TARGETARCH}-${BUILDER_BASE_TAG} AS builder

ARG TARGETARCH

WORKDIR /app

# Map Docker TARGETARCH to Rust triple and pkg-config libdir
RUN if [ "$TARGETARCH" = "arm64" ]; then \
        echo "aarch64-unknown-linux-gnu" > /app/target-triple.txt && \
        echo "aarch64-linux-gnu-gcc" > /app/cargo-linker.txt && \
        echo "/usr/lib/aarch64-linux-gnu/pkgconfig" > /app/pkg-config-libdir.txt; \
    elif [ "$TARGETARCH" = "amd64" ]; then \
        echo "x86_64-unknown-linux-gnu" > /app/target-triple.txt && \
        echo "gcc" > /app/cargo-linker.txt && \
        echo "/usr/lib/x86_64-linux-gnu/pkgconfig" > /app/pkg-config-libdir.txt; \
    else \
        echo "Unsupported architecture: $TARGETARCH" && exit 1; \
    fi

# Copy manifests and source
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations

# Build release binary (migrations are embedded at compile time)
RUN export TARGET_TRIPLE=$(cat /app/target-triple.txt) && \
    export LINKER=$(cat /app/cargo-linker.txt) && \
    export PKG_CONFIG_ALLOW_CROSS=1 && \
    export PKG_CONFIG_SYSROOT_DIR=/ && \
    export PKG_CONFIG_LIBDIR=$(cat /app/pkg-config-libdir.txt):/usr/share/pkgconfig && \
    if [ "$TARGETARCH" = "arm64" ]; then \
        export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=$LINKER; \
    else \
        export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=$LINKER; \
    fi && \
    cargo build --release --target $TARGET_TRIPLE && \
    cp target/$TARGET_TRIPLE/release/wetty-chat-backend /app/wetty-chat-backend

# Runtime stage
FROM ${RUNTIME_BASE_IMAGE}

WORKDIR /app

# Copy the built binary from builder
COPY --from=builder /app/wetty-chat-backend /app/wetty-chat-backend

# Server listens on 3000 and exposes Prometheus metrics on 3001
EXPOSE 3000
EXPOSE 3001

# Runtime env vars such as DATABASE_URL and optional CORS_ALLOWED_ORIGINS
# must be set via docker run -e or compose environment.
ENV RUST_LOG=info
ENV BACKEND_LOG_FORMAT=json

ENTRYPOINT ["/app/wetty-chat-backend"]
