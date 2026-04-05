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
	"testing"
	"time"

	promclient "github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/require"
)

func TestInitBridge_MissingEndpoint(t *testing.T) {
	_, err := InitBridge(context.Background(), Config{
		ServiceName: "test-service",
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "endpoint is required")
}

func TestInitBridge_MissingServiceName(t *testing.T) {
	_, err := InitBridge(context.Background(), Config{
		Endpoint: "localhost:4317",
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "service name is required")
}

func TestInitBridge_DefaultGatherer(t *testing.T) {
	reg := promclient.NewRegistry()
	counter := promclient.NewCounter(promclient.CounterOpts{
		Name: "test_requests_total",
		Help: "Total test requests.",
	})
	require.NoError(t, reg.Register(counter))
	counter.Inc()

	shutdown, err := InitBridge(context.Background(), Config{
		Endpoint:       "localhost:4317",
		ServiceName:    "test-service",
		ServiceVersion: "1.0.0",
		Gatherer:       reg,
		ResourceAttributes: map[string]string{
			"k8s.node.name": "test-node",
		},
	})
	require.NoError(t, err)
	require.NotNil(t, shutdown)

	// Shutdown may return an error because the OTLP endpoint is unreachable,
	// but it should complete without hanging.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	shutdown(ctx)
}

func TestInitBridge_DefaultExportInterval(t *testing.T) {
	shutdown, err := InitBridge(context.Background(), Config{
		Endpoint:    "localhost:4317",
		ServiceName: "test-service",
	})
	require.NoError(t, err)
	require.NotNil(t, shutdown)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	shutdown(ctx)
}

func TestInitFromEnv_NotSet(t *testing.T) {
	// No env vars set; OTel should be disabled with no error.
	shutdown, err := InitFromEnv(context.Background(), "calico-test", "v0.0.0")
	require.NoError(t, err)
	require.NotNil(t, shutdown)
	// Returned shutdown must be a no-op.
	require.NoError(t, shutdown(context.Background()))
}

func TestInitFromEnv_WithEndpoint(t *testing.T) {
	t.Setenv(EnvOTLPEndpoint, "localhost:4317")
	t.Setenv("NODE_NAME", "test-node")
	t.Setenv("POD_NAME", "test-pod")
	t.Setenv("POD_NAMESPACE", "test-ns")

	shutdown, err := InitFromEnv(context.Background(), "calico-test", "v0.0.0")
	require.NoError(t, err)
	require.NotNil(t, shutdown)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	// Shutdown may return an error because the OTLP endpoint is unreachable during tests.
	shutdown(ctx)
}

func TestInitFromEnv_ServiceNameOverride(t *testing.T) {
	t.Setenv(EnvOTLPEndpoint, "localhost:4317")
	t.Setenv(EnvOTLPServiceName, "overridden-service")

	shutdown, err := InitFromEnv(context.Background(), "calico-test", "v0.0.0")
	require.NoError(t, err)
	require.NotNil(t, shutdown)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	// Shutdown may return an error because the OTLP endpoint is unreachable during tests.
	shutdown(ctx)
}
