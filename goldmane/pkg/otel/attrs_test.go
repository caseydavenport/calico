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

package otel_test

import (
	"testing"
	"unique"

	"go.opentelemetry.io/otel/attribute"

	calicootel "github.com/projectcalico/calico/goldmane/pkg/otel"
	"github.com/projectcalico/calico/goldmane/pkg/types"
	"github.com/projectcalico/calico/goldmane/proto"
)

func makeTestFlow(srcLabels, dstLabels, svcName string) types.Flow {
	key := types.NewFlowKey(
		&types.FlowKeySource{
			SourceName:      "pod-a",
			SourceNamespace: "default",
			SourceType:      proto.EndpointType_WorkloadEndpoint,
		},
		&types.FlowKeyDestination{
			DestName:             "pod-b",
			DestNamespace:        "default",
			DestType:             proto.EndpointType_WorkloadEndpoint,
			DestPort:             8080,
			DestServiceName:      svcName,
			DestServiceNamespace: "default",
			DestServicePortName:  "http",
			DestServicePort:      80,
		},
		&types.FlowKeyMeta{
			Proto:    "tcp",
			Reporter: proto.Reporter_Src,
			Action:   proto.Action_Allow,
		},
		nil,
	)
	return types.Flow{
		Key:                     key,
		StartTime:               1000,
		EndTime:                 1060,
		SourceLabels:            unique.Make(srcLabels),
		DestLabels:              unique.Make(dstLabels),
		PacketsIn:               100,
		PacketsOut:              50,
		BytesIn:                 10240,
		BytesOut:                5120,
		NumConnectionsStarted:   5,
		NumConnectionsCompleted: 3,
		NumConnectionsLive:      2,
	}
}

// attrMap converts a slice of attribute.KeyValue into a map for easy lookup.
func attrMap(attrs []attribute.KeyValue) map[attribute.Key]attribute.Value {
	m := make(map[attribute.Key]attribute.Value, len(attrs))
	for _, kv := range attrs {
		m[kv.Key] = kv.Value
	}
	return m
}

func TestFlowAttributes_BasicFlow(t *testing.T) {
	flow := makeTestFlow("app=frontend", "app=backend", "svc-b")
	attrs := calicootel.FlowAttributes(&flow)
	m := attrMap(attrs)

	checks := []struct {
		key  string
		want attribute.Value
	}{
		{"calico.source.name", attribute.StringValue("pod-a")},
		{"calico.source.namespace", attribute.StringValue("default")},
		{"calico.source.type", attribute.StringValue("wep")},
		{"calico.destination.name", attribute.StringValue("pod-b")},
		{"calico.destination.namespace", attribute.StringValue("default")},
		{"calico.destination.type", attribute.StringValue("wep")},
		{"network.transport", attribute.StringValue("tcp")},
		{"server.port", attribute.Int64Value(8080)},
		{"calico.policy.action", attribute.StringValue("allow")},
		{"calico.reporter", attribute.StringValue("src")},
		{"calico.flow.packets_in", attribute.Int64Value(100)},
		{"calico.flow.packets_out", attribute.Int64Value(50)},
		{"calico.flow.bytes_in", attribute.Int64Value(10240)},
		{"calico.flow.bytes_out", attribute.Int64Value(5120)},
		{"calico.flow.connections_started", attribute.Int64Value(5)},
		{"calico.flow.connections_completed", attribute.Int64Value(3)},
		{"calico.flow.connections_live", attribute.Int64Value(2)},
		{"calico.destination.service.name", attribute.StringValue("svc-b")},
		{"calico.destination.service.namespace", attribute.StringValue("default")},
		{"calico.destination.service.port_name", attribute.StringValue("http")},
		{"calico.destination.service.port", attribute.Int64Value(80)},
		{"calico.source.labels", attribute.StringValue("app=frontend")},
		{"calico.destination.labels", attribute.StringValue("app=backend")},
	}

	for _, c := range checks {
		got, ok := m[attribute.Key(c.key)]
		if !ok {
			t.Errorf("missing attribute %q", c.key)
			continue
		}
		if got != c.want {
			t.Errorf("attribute %q: got %v, want %v", c.key, got, c.want)
		}
	}
}

func TestFlowAttributes_NoService(t *testing.T) {
	flow := makeTestFlow("app=frontend", "app=backend", "")
	attrs := calicootel.FlowAttributes(&flow)
	m := attrMap(attrs)

	serviceKeys := []string{
		"calico.destination.service.name",
		"calico.destination.service.namespace",
		"calico.destination.service.port_name",
		"calico.destination.service.port",
	}
	for _, k := range serviceKeys {
		if _, ok := m[attribute.Key(k)]; ok {
			t.Errorf("unexpected attribute %q when no service name set", k)
		}
	}

	// Verify non-service attributes are still present.
	if _, ok := m["calico.source.name"]; !ok {
		t.Error("missing calico.source.name")
	}
}

func TestFlowAttributes_EmptyLabels(t *testing.T) {
	flow := makeTestFlow("", "", "svc-b")
	attrs := calicootel.FlowAttributes(&flow)
	m := attrMap(attrs)

	if _, ok := m["calico.source.labels"]; ok {
		t.Error("unexpected calico.source.labels when labels are empty")
	}
	if _, ok := m["calico.destination.labels"]; ok {
		t.Error("unexpected calico.destination.labels when labels are empty")
	}

	// Service attrs should still be present.
	if _, ok := m["calico.destination.service.name"]; !ok {
		t.Error("missing calico.destination.service.name")
	}
}
