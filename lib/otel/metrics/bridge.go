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
	"fmt"
	"time"

	promclient "github.com/prometheus/client_golang/prometheus"
	"github.com/sirupsen/logrus"
	otelprom "go.opentelemetry.io/contrib/bridges/prometheus"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.40.0"
)

const defaultExportInterval = 60 * time.Second

// Config holds the configuration for the Prometheus-to-OTLP metrics bridge.
type Config struct {
	// Endpoint is the OTLP gRPC endpoint to export metrics to.
	Endpoint string

	// ServiceName identifies the service in OTel resource attributes.
	ServiceName string

	// ServiceVersion optionally identifies the service version.
	ServiceVersion string

	// ExportInterval controls how often metrics are exported. Defaults to 60s.
	ExportInterval time.Duration

	// Gatherer is the Prometheus gatherer to bridge. Defaults to prometheus.DefaultGatherer.
	Gatherer promclient.Gatherer

	// ResourceAttributes are additional OTel resource attributes to include.
	ResourceAttributes map[string]string

	// testExporter is for internal testing only. When set, it's used instead of creating an OTLP exporter.
	testExporter metric.Exporter
}

// InitBridge creates a Prometheus-to-OTLP metrics bridge. It returns a shutdown
// function that should be called to flush pending metrics and release resources.
func InitBridge(ctx context.Context, cfg Config) (func(context.Context) error, error) {
	if cfg.Endpoint == "" {
		return nil, fmt.Errorf("endpoint is required")
	}
	if cfg.ServiceName == "" {
		return nil, fmt.Errorf("service name is required")
	}

	if cfg.ExportInterval == 0 {
		cfg.ExportInterval = defaultExportInterval
	}
	if cfg.Gatherer == nil {
		cfg.Gatherer = promclient.DefaultGatherer
	}

	var exporter metric.Exporter
	if cfg.testExporter != nil {
		exporter = cfg.testExporter
	} else {
		var err error
		exporter, err = otlpmetricgrpc.New(ctx,
			otlpmetricgrpc.WithEndpoint(cfg.Endpoint),
			otlpmetricgrpc.WithInsecure(),
		)
		if err != nil {
			return nil, fmt.Errorf("creating OTLP metric exporter: %w", err)
		}
	}

	res, err := buildResource(cfg)
	if err != nil {
		return nil, fmt.Errorf("building OTel resource: %w", err)
	}

	bridge := otelprom.NewMetricProducer(otelprom.WithGatherer(cfg.Gatherer))

	reader := metric.NewPeriodicReader(exporter,
		metric.WithInterval(cfg.ExportInterval),
		metric.WithProducer(bridge),
	)

	provider := metric.NewMeterProvider(
		metric.WithResource(res),
		metric.WithReader(reader),
	)

	logrus.WithFields(logrus.Fields{
		"endpoint":       cfg.Endpoint,
		"serviceName":    cfg.ServiceName,
		"exportInterval": cfg.ExportInterval,
	}).Info("OTel metrics bridge initialized")

	return provider.Shutdown, nil
}

func buildResource(cfg Config) (*resource.Resource, error) {
	baseAttrs := []attribute.KeyValue{
		semconv.ServiceName(cfg.ServiceName),
	}
	if cfg.ServiceVersion != "" {
		baseAttrs = append(baseAttrs, semconv.ServiceVersion(cfg.ServiceVersion))
	}
	for k, v := range cfg.ResourceAttributes {
		baseAttrs = append(baseAttrs, attribute.String(k, v))
	}

	return resource.Merge(
		resource.Default(),
		resource.NewWithAttributes(semconv.SchemaURL, baseAttrs...),
	)
}
