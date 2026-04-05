// Copyright (c) 2026 Tigera, Inc. All rights reserved.

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

package otel

import (
	"context"
	"fmt"
	"time"

	promclient "github.com/prometheus/client_golang/prometheus"
	"github.com/sirupsen/logrus"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/log"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.40.0"

	"github.com/projectcalico/calico/goldmane/pkg/storage"
	"github.com/projectcalico/calico/goldmane/proto"
)

var droppedFlowLogs = promclient.NewCounter(promclient.CounterOpts{
	Name: "goldmane_otel_dropped_logs",
	Help: "Flow log records dropped due to OTel export errors.",
})

func init() {
	promclient.MustRegister(droppedFlowLogs)
}

// SinkConfig holds configuration for the OTLP flow log sink.
type SinkConfig struct {
	// Endpoint is the OTLP gRPC endpoint to export flow logs to. Required.
	Endpoint string

	// ServiceVersion is the Calico version string included in the OTel resource.
	ServiceVersion string
}

// Sink implements storage.Sink by converting FlowCollections to OTel LogRecords
// and exporting them via OTLP gRPC.
type Sink struct {
	logger   log.Logger
	provider *sdklog.LoggerProvider
}

// NewSink creates and initializes an OTLP flow log sink.
func NewSink(ctx context.Context, cfg SinkConfig) (*Sink, error) {
	if cfg.Endpoint == "" {
		return nil, fmt.Errorf("endpoint is required")
	}

	exporter, err := otlploggrpc.New(ctx,
		otlploggrpc.WithEndpoint(cfg.Endpoint),
		otlploggrpc.WithInsecure(),
	)
	if err != nil {
		return nil, fmt.Errorf("creating OTLP log exporter: %w", err)
	}

	res, err := buildLogResource(cfg)
	if err != nil {
		return nil, fmt.Errorf("building OTel resource: %w", err)
	}

	provider := sdklog.NewLoggerProvider(
		sdklog.WithResource(res),
		sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)),
	)

	logger := provider.Logger("calico-goldmane-flows")

	logrus.WithFields(logrus.Fields{
		"endpoint":       cfg.Endpoint,
		"serviceVersion": cfg.ServiceVersion,
	}).Info("OTel flow log sink initialized")

	return &Sink{
		logger:   logger,
		provider: provider,
	}, nil
}

// Receive converts each flow in the collection to an OTel LogRecord and emits it.
// The caller (bucket_ring.go) is responsible for calling fc.Complete() after all
// sinks have processed.
func (s *Sink) Receive(fc *storage.FlowCollection) {
	for i := range fc.Flows {
		flow := &fc.Flows[i]

		var record log.Record
		record.SetTimestamp(time.Unix(flow.StartTime, 0))
		record.SetObservedTimestamp(time.Now())
		record.SetSeverity(SeverityForAction(flow.Key.Action()))
		record.AddAttributes(attrsToLogKV(FlowAttributes(flow))...)

		s.logger.Emit(context.Background(), record)
	}
}

// Shutdown flushes pending log records and releases resources.
func (s *Sink) Shutdown(ctx context.Context) error {
	return s.provider.Shutdown(ctx)
}

func buildLogResource(cfg SinkConfig) (*resource.Resource, error) {
	attrs := []attribute.KeyValue{
		semconv.ServiceName("calico-goldmane"),
	}
	if cfg.ServiceVersion != "" {
		attrs = append(attrs, semconv.ServiceVersion(cfg.ServiceVersion))
	}

	return resource.Merge(
		resource.Default(),
		resource.NewWithAttributes(semconv.SchemaURL, attrs...),
	)
}

func attrsToLogKV(attrs []attribute.KeyValue) []log.KeyValue {
	kvs := make([]log.KeyValue, len(attrs))
	for i, a := range attrs {
		switch a.Value.Type() {
		case attribute.STRING:
			kvs[i] = log.String(string(a.Key), a.Value.AsString())
		case attribute.INT64:
			kvs[i] = log.Int64(string(a.Key), a.Value.AsInt64())
		case attribute.FLOAT64:
			kvs[i] = log.Float64(string(a.Key), a.Value.AsFloat64())
		case attribute.BOOL:
			kvs[i] = log.Bool(string(a.Key), a.Value.AsBool())
		default:
			kvs[i] = log.String(string(a.Key), a.Value.Emit())
		}
	}
	return kvs
}

// SeverityForAction maps a Calico policy action to an OTel log severity level.
func SeverityForAction(a proto.Action) log.Severity {
	if a == proto.Action_Deny {
		return log.SeverityWarn
	}
	return log.SeverityInfo
}
