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
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// testExporter is a no-op metric exporter for testing.
type testExporter struct{}

func (t *testExporter) Aggregation(kind metric.InstrumentKind) metric.Aggregation {
	return nil
}

func (t *testExporter) Temporality(kind metric.InstrumentKind) metricdata.Temporality {
	return metricdata.DeltaTemporality
}

func (t *testExporter) Export(ctx context.Context, rm *metricdata.ResourceMetrics) error {
	return nil
}

func (t *testExporter) ForceFlush(ctx context.Context) error {
	return nil
}

func (t *testExporter) Shutdown(ctx context.Context) error {
	return nil
}

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
		Endpoint:           "localhost:4317",
		ServiceName:        "test-service",
		ServiceVersion:     "1.0.0",
		ResourceAttributes: map[string]string{"k8s.node.name": "test-node"},
		Gatherer:           reg,
		testExporter:       &testExporter{},
	})
	require.NoError(t, err)
	require.NotNil(t, shutdown)

	// Use a short timeout for shutdown since there's no real collector.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	require.NoError(t, shutdown(ctx))
}

func TestInitBridge_DefaultExportInterval(t *testing.T) {
	shutdown, err := InitBridge(context.Background(), Config{
		Endpoint:     "localhost:4317",
		ServiceName:  "test-service",
		testExporter: &testExporter{},
	})
	require.NoError(t, err)
	require.NotNil(t, shutdown)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	require.NoError(t, shutdown(ctx))
}
