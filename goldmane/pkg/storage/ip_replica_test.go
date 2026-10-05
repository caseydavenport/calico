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

package storage_test

import (
	"fmt"
	"math/rand/v2"
	"slices"
	"testing"
	"unique"

	"github.com/stretchr/testify/require"

	"github.com/projectcalico/calico/goldmane/pkg/storage"
	"github.com/projectcalico/calico/goldmane/pkg/types"
	"github.com/projectcalico/calico/goldmane/proto"
	"github.com/projectcalico/calico/lib/std/time"
)

// TestBucketRing_IPsMatchAcrossReplicas feeds two rings the same flows, one on time and one shuffled
// with each flow up to one window late, and requires both to report the same IPs for every window.
func TestBucketRing_IPsMatchAcrossReplicas(t *testing.T) {
	const numWindows = 20
	rng := rand.New(rand.NewPCG(3, 5))
	for trial := range 25 {
		t.Run(fmt.Sprintf("trial-%d", trial), func(t *testing.T) {
			start := int64(1_000_000)
			numDistinctIPs := 80 + rng.IntN(300)

			type delivery struct {
				at   int
				flow *types.Flow
			}
			var onTime, late []delivery
			for w := range numWindows {
				for k := range 4 {
					for range 1 + rng.IntN(5) {
						ips := make([]string, rng.IntN(60))
						for i := range ips {
							n := rng.IntN(numDistinctIPs)
							ips[i] = fmt.Sprintf("10.%d.%d.1", n/256, n%256)
						}
						ws := start + int64(w*ipTestInterval)
						f := &types.Flow{
							Key: types.NewFlowKey(
								&types.FlowKeySource{SourceName: "src"},
								&types.FlowKeyDestination{DestName: fmt.Sprintf("dst-%d", k)},
								&types.FlowKeyMeta{},
								&proto.PolicyTrace{},
							),
							StartTime:    ws,
							EndTime:      ws + ipTestInterval,
							SourceLabels: unique.Make(""),
							DestLabels:   unique.Make(""),
							SourceIps:    ips,
							DestIps:      ips,
						}
						onTime = append(onTime, delivery{at: w, flow: f})
						late = append(late, delivery{at: w + rng.IntN(2), flow: f})
					}
				}
			}
			rng.Shuffle(len(late), func(i, j int) { late[i], late[j] = late[j], late[i] })

			replay := func(deliveries []delivery) *storage.BucketRing {
				now := start
				ring := storage.NewBucketRing(242, ipTestInterval, now, storage.WithNowFunc(func() time.Time { return time.Unix(now, 0) }))
				for tick := range numWindows + 3 {
					for _, d := range deliveries {
						if d.at == tick {
							ring.AddFlow(storage.FlowFromNode{Flow: d.flow})
						}
					}
					ring.Rollover(nil)
					now += ipTestInterval
				}
				return ring
			}
			a, b := replay(onTime), replay(late)

			for w := range numWindows {
				ws := start + int64(w*ipTestInterval)
				require.Equal(t, listIPs(t, a, ws, ws+ipTestInterval+1), listIPs(t, b, ws, ws+ipTestInterval+1), "window %d", w)
			}
			full := listIPs(t, a, 0, 0)
			require.Len(t, full, 4)
			for dst, ips := range full {
				require.NotEmpty(t, ips[0], "no IPs for %s", dst)
			}
			require.Equal(t, full, listIPs(t, b, 0, 0), "full range")
		})
	}
}

// listIPs returns each flow key's source and dest IPs over [gte, lt), keyed by destination name.
func listIPs(t *testing.T, ring *storage.BucketRing, gte, lt int64) map[string][2][]string {
	t.Helper()
	flows, _, err := ring.List(&proto.FlowListRequest{StartTimeGte: gte, StartTimeLt: lt})
	require.NoError(t, err)
	out := map[string][2][]string{}
	for _, f := range flows {
		out[f.Key.DestName()] = [2][]string{slices.Clone(f.SourceIps), slices.Clone(f.DestIps)}
	}
	return out
}

// TestBucketRing_LateFlowAddsStatsNotIPs verifies a flow that arrives after its window's IPs closed
// still counts toward the window's statistics, but adds no IPs.
func TestBucketRing_LateFlowAddsStatsNotIPs(t *testing.T) {
	defer setupTest(t)()

	start := int64(1_000_000)
	now := start
	ring := storage.NewBucketRing(242, ipTestInterval, now, storage.WithNowFunc(func() time.Time { return time.Unix(now, 0) }))
	key := types.NewFlowKey(
		&types.FlowKeySource{SourceName: "src"},
		&types.FlowKeyDestination{DestName: "dst"},
		&types.FlowKeyMeta{},
		&proto.PolicyTrace{},
	)
	send := func(ip string) {
		ring.AddFlow(storage.FlowFromNode{Flow: &types.Flow{
			Key:          key,
			StartTime:    start,
			EndTime:      start + ipTestInterval,
			SourceLabels: unique.Make(""),
			DestLabels:   unique.Make(""),
			PacketsIn:    1,
			SourceIps:    []string{ip},
		}})
	}
	roll := func() {
		ring.Rollover(nil)
		now += ipTestInterval
	}

	// On time, then exactly one window late (still open), then two windows late (closed).
	send("10.0.0.1")
	roll()
	send("10.0.0.2")
	roll()
	send("10.0.0.3")
	roll()

	flows, _, err := ring.List(&proto.FlowListRequest{StartTimeGte: start, StartTimeLt: start + ipTestInterval + 1})
	require.NoError(t, err)
	require.Len(t, flows, 1)
	require.Equal(t, int64(3), flows[0].PacketsIn, "every flow counts toward the statistics")
	require.Equal(t, []string{"10.0.0.1", "10.0.0.2"}, flows[0].SourceIps)
}
