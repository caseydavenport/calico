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

package types_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/projectcalico/calico/goldmane/pkg/types"
	"github.com/projectcalico/calico/goldmane/proto"
)

// matchesCase is one Matches scenario. mutate, when set, edits the base key from
// matchesTestKey before matching.
type matchesCase struct {
	name   string
	mutate func(*proto.FlowKey)
	filter *proto.Filter
	want   bool
}

func exact(v string) *proto.StringMatch {
	return &proto.StringMatch{Value: v, Type: proto.MatchType_Exact}
}

func fuzzy(v string) *proto.StringMatch {
	return &proto.StringMatch{Value: v, Type: proto.MatchType_Fuzzy}
}

// matchesTestKey returns a flow with one enforced Allow hit and one pending Deny hit, so policy
// and pending-action filters can tell the two lists apart.
func matchesTestKey() *proto.FlowKey {
	return &proto.FlowKey{
		SourceName:      "client-1",
		SourceNamespace: "ns-1",
		DestName:        "server-1",
		DestNamespace:   "ns-2",
		DestPort:        443,
		Proto:           "tcp",
		Reporter:        proto.Reporter_Src,
		Action:          proto.Action_Allow,
		Policies: &proto.PolicyTrace{
			EnforcedPolicies: []*proto.PolicyHit{{
				Kind:      proto.PolicyKind_CalicoNetworkPolicy,
				Name:      "allow-dns",
				Namespace: "ns-1",
				Tier:      "default",
				Action:    proto.Action_Allow,
			}},
			PendingPolicies: []*proto.PolicyHit{{
				Kind:      proto.PolicyKind_NetworkPolicy,
				Name:      "staged-deny",
				Namespace: "ns-1",
				Tier:      "security",
				Action:    proto.Action_Deny,
			}},
		},
	}
}

func TestMatches(t *testing.T) {
	sourceName := func(n string) func(*proto.FlowKey) {
		return func(k *proto.FlowKey) { k.SourceName = n }
	}
	noPolicies := func(k *proto.FlowKey) { k.Policies = &proto.PolicyTrace{} }
	globalSrc := func(k *proto.FlowKey) { k.SourceNamespace = "Global" }
	globalDst := func(k *proto.FlowKey) { k.DestNamespace = "Global" }

	cases := []matchesCase{
		{name: "nil filter", filter: nil, want: true},
		{name: "empty filter", filter: &proto.Filter{}, want: true},

		// UI aliases: "pub", "pvt" and "Global" also match their displayed values.
		{name: "public alias exact", mutate: sourceName("pub"), filter: &proto.Filter{SourceNames: []*proto.StringMatch{exact("PUBLIC NETWORK")}}, want: true},
		{name: "public stored value exact", mutate: sourceName("pub"), filter: &proto.Filter{SourceNames: []*proto.StringMatch{exact("pub")}}, want: true},
		{name: "private alias fuzzy", mutate: func(k *proto.FlowKey) { k.DestName = "pvt" }, filter: &proto.Filter{DestNames: []*proto.StringMatch{fuzzy("NET")}}, want: true},
		{name: "alias of another value", mutate: sourceName("pvt"), filter: &proto.Filter{SourceNames: []*proto.StringMatch{exact("PUBLIC NETWORK")}}, want: false},
		{name: "alias on a name without one", filter: &proto.Filter{SourceNames: []*proto.StringMatch{exact("PUBLIC NETWORK")}}, want: false},
		{name: "global namespace alias", mutate: globalSrc, filter: &proto.Filter{SourceNamespaces: []*proto.StringMatch{exact("-")}}, want: true},
		{name: "global dest namespace alias", mutate: globalDst, filter: &proto.Filter{DestNamespaces: []*proto.StringMatch{exact("-")}}, want: true},
		{name: "global alias on another namespace", filter: &proto.Filter{SourceNamespaces: []*proto.StringMatch{exact("-")}}, want: false},

		// A name with no alias must not match an exact empty value through the missing alias.
		{name: "exact empty value", filter: &proto.Filter{SourceNames: []*proto.StringMatch{exact("")}}, want: false},
		{name: "fuzzy empty value", filter: &proto.Filter{SourceNames: []*proto.StringMatch{fuzzy("")}}, want: true},
		{name: "fuzzy substring", filter: &proto.Filter{DestNames: []*proto.StringMatch{fuzzy("server")}}, want: true},
		{name: "any of several names", filter: &proto.Filter{SourceNames: []*proto.StringMatch{exact("other"), exact("client-1")}}, want: true},
		{name: "none of several names", filter: &proto.Filter{SourceNames: []*proto.StringMatch{exact("other"), fuzzy("server")}}, want: false},

		{name: "protocol match", filter: &proto.Filter{Protocols: []*proto.StringMatch{exact("tcp")}}, want: true},
		{name: "protocol mismatch", filter: &proto.Filter{Protocols: []*proto.StringMatch{exact("udp")}}, want: false},
		{name: "action match", filter: &proto.Filter{Actions: []proto.Action{proto.Action_Deny, proto.Action_Allow}}, want: true},
		{name: "action mismatch", filter: &proto.Filter{Actions: []proto.Action{proto.Action_Deny}}, want: false},
		{name: "reporter match", filter: &proto.Filter{Reporter: proto.Reporter_Src}, want: true},
		{name: "reporter mismatch", filter: &proto.Filter{Reporter: proto.Reporter_Dst}, want: false},
		{name: "port match", filter: &proto.Filter{DestPorts: []*proto.PortMatch{{Port: 80}, {Port: 443}}}, want: true},
		{name: "port mismatch", filter: &proto.Filter{DestPorts: []*proto.PortMatch{{Port: 80}}}, want: false},
		{name: "every field must match", filter: &proto.Filter{SourceNamespaces: []*proto.StringMatch{exact("ns-1")}, DestPorts: []*proto.PortMatch{{Port: 80}}}, want: false},

		// Pending actions read only the pending hits, not the enforced ones.
		{name: "pending action match", filter: &proto.Filter{PendingActions: []proto.Action{proto.Action_Deny}}, want: true},
		{name: "pending action only enforced", filter: &proto.Filter{PendingActions: []proto.Action{proto.Action_Allow}}, want: false},
		{name: "pending action without pending hits", mutate: noPolicies, filter: &proto.Filter{PendingActions: []proto.Action{proto.Action_Deny}}, want: false},

		{name: "empty policy filter", filter: &proto.Filter{Policies: []*proto.PolicyMatch{}}, want: false},
		{name: "policy on enforced hit", filter: &proto.Filter{Policies: []*proto.PolicyMatch{{Name: exact("allow-dns")}}}, want: true},
		{name: "policy on pending hit", filter: &proto.Filter{Policies: []*proto.PolicyMatch{{Name: exact("staged-deny")}}}, want: true},
		{name: "policy name mismatch", filter: &proto.Filter{Policies: []*proto.PolicyMatch{{Name: exact("deny-all")}}}, want: false},
		{name: "policy tier fuzzy", filter: &proto.Filter{Policies: []*proto.PolicyMatch{{Tier: fuzzy("sec")}}}, want: true},
		{name: "policy fields split across hits", filter: &proto.Filter{Policies: []*proto.PolicyMatch{{Name: exact("allow-dns"), Action: proto.Action_Deny}}}, want: false},
		{name: "policy kind mismatch", filter: &proto.Filter{Policies: []*proto.PolicyMatch{{Name: exact("allow-dns"), Kind: proto.PolicyKind_NetworkPolicy}}}, want: false},
		{name: "unset policy match on a hit", filter: &proto.Filter{Policies: []*proto.PolicyMatch{{}}}, want: true},
		{name: "unset policy match without hits", mutate: noPolicies, filter: &proto.Filter{Policies: []*proto.PolicyMatch{{}}}, want: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			k := matchesTestKey()
			if tc.mutate != nil {
				tc.mutate(k)
			}
			require.Equal(t, tc.want, types.Matches(tc.filter, types.ProtoToFlowKey(k)))
		})
	}
}
