# Copyright (c) 2026 Tigera, Inc. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Stage 1: Build with the OpenTelemetry Collector Builder (OCB).
FROM golang:1.24 AS builder
ARG TARGETARCH=amd64
ARG OCB_VERSION=0.149.0

WORKDIR /build

RUN go install go.opentelemetry.io/collector/cmd/builder@v${OCB_VERSION}

COPY manifest.yaml .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} builder --config=manifest.yaml

# Stage 2: Minimal runtime image.
FROM scratch
ARG GIT_VERSION

COPY --from=builder /build/build/calico-otel-collector /otel-collector
COPY bin/LICENSE /licenses/LICENSE

LABEL org.opencontainers.image.description="Calico OpenTelemetry Collector"
LABEL org.opencontainers.image.authors="maintainers@tigera.io"
LABEL org.opencontainers.image.source="https://github.com/projectcalico/calico"
LABEL org.opencontainers.image.title="Calico OTel Collector"
LABEL org.opencontainers.image.vendor="Project Calico"
LABEL org.opencontainers.image.version="${GIT_VERSION}"
LABEL org.opencontainers.image.licenses="Apache-2.0"

USER 10001:10001
ENTRYPOINT ["/otel-collector"]
