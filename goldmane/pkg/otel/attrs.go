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
	"go.opentelemetry.io/otel/attribute"

	"github.com/projectcalico/calico/goldmane/pkg/types"
	"github.com/projectcalico/calico/goldmane/proto"
)

// FlowAttributes converts a Goldmane Flow to a slice of OTel log record attributes.
func FlowAttributes(f *types.Flow) []attribute.KeyValue {
	attrs := make([]attribute.KeyValue, 0, 24)

	attrs = append(attrs,
		attribute.String("calico.source.name", f.Key.SourceName()),
		attribute.String("calico.source.namespace", f.Key.SourceNamespace()),
		attribute.String("calico.source.type", endpointTypeName(f.Key.SourceType())),
		attribute.String("calico.destination.name", f.Key.DestName()),
		attribute.String("calico.destination.namespace", f.Key.DestNamespace()),
		attribute.String("calico.destination.type", endpointTypeName(f.Key.DestType())),
		attribute.String("network.transport", f.Key.Proto()),
		attribute.Int64("server.port", f.Key.DestPort()),
		attribute.String("calico.policy.action", actionName(f.Key.Action())),
		attribute.String("calico.reporter", reporterName(f.Key.Reporter())),
		attribute.Int64("calico.flow.packets_in", f.PacketsIn),
		attribute.Int64("calico.flow.packets_out", f.PacketsOut),
		attribute.Int64("calico.flow.bytes_in", f.BytesIn),
		attribute.Int64("calico.flow.bytes_out", f.BytesOut),
		attribute.Int64("calico.flow.connections_started", f.NumConnectionsStarted),
		attribute.Int64("calico.flow.connections_completed", f.NumConnectionsCompleted),
		attribute.Int64("calico.flow.connections_live", f.NumConnectionsLive),
	)

	if svcName := f.Key.DestServiceName(); svcName != "" {
		attrs = append(attrs,
			attribute.String("calico.destination.service.name", svcName),
			attribute.String("calico.destination.service.namespace", f.Key.DestServiceNamespace()),
			attribute.String("calico.destination.service.port_name", f.Key.DestServicePortName()),
			attribute.Int64("calico.destination.service.port", f.Key.DestServicePort()),
		)
	}

	if srcLabels := f.SourceLabels.Value(); srcLabels != "" {
		attrs = append(attrs, attribute.String("calico.source.labels", srcLabels))
	}

	if dstLabels := f.DestLabels.Value(); dstLabels != "" {
		attrs = append(attrs, attribute.String("calico.destination.labels", dstLabels))
	}

	return attrs
}

func endpointTypeName(t proto.EndpointType) string {
	switch t {
	case proto.EndpointType_WorkloadEndpoint:
		return "wep"
	case proto.EndpointType_HostEndpoint:
		return "hep"
	case proto.EndpointType_NetworkSet:
		return "ns"
	case proto.EndpointType_Network:
		return "net"
	default:
		return "unknown"
	}
}

func actionName(a proto.Action) string {
	switch a {
	case proto.Action_Allow:
		return "allow"
	case proto.Action_Deny:
		return "deny"
	case proto.Action_Pass:
		return "pass"
	default:
		return "unknown"
	}
}

func reporterName(r proto.Reporter) string {
	switch r {
	case proto.Reporter_Src:
		return "src"
	case proto.Reporter_Dst:
		return "dst"
	default:
		return "unknown"
	}
}
