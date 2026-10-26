# Cross-compile on the build host's arch so multi-arch builds don't need emulation.
ARG BUILDPLATFORM=linux/amd64
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/usage-server . \
 && mkdir -p /out/data

FROM scratch
COPY --from=build /out/usage-server /usage-server
# Pre-create /data owned by the non-root user so a fresh named volume inherits it.
COPY --from=build --chown=65532:65532 /out/data /data
USER 65532:65532
ENV LISTEN_ADDR=:8080 DATA_FILE=/data/usage.jsonl
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["/usage-server"]
