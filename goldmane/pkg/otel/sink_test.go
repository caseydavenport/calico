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
	"context"
	"testing"

	"go.opentelemetry.io/otel/log"

	calicootel "github.com/projectcalico/calico/goldmane/pkg/otel"
	"github.com/projectcalico/calico/goldmane/proto"
)

func TestNewSink_MissingEndpoint(t *testing.T) {
	_, err := calicootel.NewSink(context.Background(), calicootel.SinkConfig{})
	if err == nil {
		t.Fatal("expected error for missing endpoint, got nil")
	}
}

func TestNewSink_InitAndShutdown(t *testing.T) {
	sink, err := calicootel.NewSink(context.Background(), calicootel.SinkConfig{
		Endpoint:       "localhost:4317",
		ServiceVersion: "v3.30.0",
	})
	if err != nil {
		t.Fatalf("NewSink returned unexpected error: %v", err)
	}

	// Shutdown may return an error since the endpoint is not reachable, but it must not panic.
	_ = sink.Shutdown(context.Background())
}

func TestSeverityForAction(t *testing.T) {
	cases := []struct {
		action proto.Action
		want   log.Severity
	}{
		{proto.Action_Deny, log.SeverityWarn},
		{proto.Action_Allow, log.SeverityInfo},
		{proto.Action_Pass, log.SeverityInfo},
	}

	for _, tc := range cases {
		got := calicootel.SeverityForAction(tc.action)
		if got != tc.want {
			t.Errorf("SeverityForAction(%v): got %v, want %v", tc.action, got, tc.want)
		}
	}
}
