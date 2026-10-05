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
	"testing"
	"unique"

	"github.com/stretchr/testify/require"

	"github.com/projectcalico/calico/goldmane/pkg/storage"
	"github.com/projectcalico/calico/goldmane/pkg/types"
	"github.com/projectcalico/calico/goldmane/proto"
	"github.com/projectcalico/calico/lib/std/time"
)

// TestBucketRing_ListIncludesIPs verifies every paginated List result carries its own key's IPs,
// through both the time-sorted and the field-sorted indices.
func TestBucketRing_ListIncludesIPs(t *testing.T) {
	defer setupTest(t)()

	now := int64(1_000_000)
	ring := storage.NewBucketRing(10, ipTestInterval, now, storage.WithNowFunc(func() time.Time { return time.Unix(now, 0) }))

	want := map[string][]string{}
	for i := range 5 {
		dst := fmt.Sprintf("dst-%d", i)
		ips := []string{fmt.Sprintf("10.0.%d.1", i), fmt.Sprintf("10.0.%d.2", i)}
		want[dst] = ips

		// Separate buckets give each flow a distinct start time, so time-sorted pages are stable.
		ring.AddFlow(storage.FlowFromNode{Flow: &types.Flow{
			Key:          types.NewFlowKey(&types.FlowKeySource{SourceName: "src"}, &types.FlowKeyDestination{DestName: dst}, &types.FlowKeyMeta{}, &proto.PolicyTrace{}),
			StartTime:    now,
			EndTime:      now + ipTestInterval,
			SourceLabels: unique.Make(""),
			DestLabels:   unique.Make(""),
			SourceIps:    ips,
			DestIps:      ips,
		}})
		ring.Rollover(nil)
		now += ipTestInterval
	}

	for _, sortBy := range []proto.SortBy{proto.SortBy_Time, proto.SortBy_DestName} {
		t.Run(sortBy.String(), func(t *testing.T) {
			seen := map[string]bool{}
			for page := range int64(3) {
				flows, meta, err := ring.List(&proto.FlowListRequest{
					PageSize: 2,
					Page:     page,
					SortBy:   []*proto.SortOption{{SortBy: sortBy}},
				})
				require.NoError(t, err)
				require.Equal(t, 5, meta.TotalResults)
				for _, f := range flows {
					dst := f.Key.DestName()
					require.Equal(t, want[dst], f.SourceIps, "source IPs for %s", dst)
					require.Equal(t, want[dst], f.DestIps, "dest IPs for %s", dst)
					seen[dst] = true
				}
			}
			require.Len(t, seen, 5)
		})
	}
}
