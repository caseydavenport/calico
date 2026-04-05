// Copyright (c) 2026 Tigera, Inc. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package metrics

import (
	"context"
	"os"
	"time"

	"github.com/sirupsen/logrus"
)

const (
	EnvOTLPEndpoint    = "OTEL_EXPORTER_OTLP_ENDPOINT"
	EnvOTLPServiceName = "OTEL_SERVICE_NAME"
)

// noopShutdown is a no-op shutdown function returned when OTel is not enabled.
func noopShutdown(context.Context) error { return nil }

// InitFromEnv initializes the OTel Prometheus bridge using environment variables.
// If OTEL_EXPORTER_OTLP_ENDPOINT is not set, returns a no-op shutdown function
// and nil error (OTel is simply not enabled).
//
// serviceName is the default (e.g., "calico-felix"). Can be overridden by OTEL_SERVICE_NAME.
// version is the Calico build version string.
func InitFromEnv(ctx context.Context, serviceName, version string) (func(context.Context) error, error) {
	endpoint := os.Getenv(EnvOTLPEndpoint)
	if endpoint == "" {
		logrus.Debug("OTEL_EXPORTER_OTLP_ENDPOINT not set; OTel metrics disabled")
		return noopShutdown, nil
	}

	if override := os.Getenv(EnvOTLPServiceName); override != "" {
		serviceName = override
	}

	resourceAttrs := map[string]string{}
	if v := os.Getenv("NODE_NAME"); v != "" {
		resourceAttrs["k8s.node.name"] = v
	}
	if v := os.Getenv("POD_NAME"); v != "" {
		resourceAttrs["k8s.pod.name"] = v
	}
	if v := os.Getenv("POD_NAMESPACE"); v != "" {
		resourceAttrs["k8s.namespace.name"] = v
	}

	return InitBridge(ctx, Config{
		Endpoint:           endpoint,
		ServiceName:        serviceName,
		ServiceVersion:     version,
		ExportInterval:     60 * time.Second,
		Gatherer:           nil,
		ResourceAttributes: resourceAttrs,
	})
}
