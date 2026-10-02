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

package storage

import (
	"fmt"
	"maps"
	"math"
	"math/rand/v2"
	"testing"
)

// recordIPSetOneAtATime is a deliberately naive recordIPSet: it rescans the whole map for the
// oldest entry each time a new IP needs a slot.
func recordIPSetOneAtATime(m map[string]*ipEntry, ips []string, slot int, start int64) map[string]*ipEntry {
	for _, ip := range ips {
		if e, ok := m[ip]; ok {
			e.windows.set(slot)
			e.lastSeen = max(e.lastSeen, start)
		}
	}
	for _, ip := range ips {
		if ip == "" {
			continue
		}
		if e, ok := m[ip]; ok {
			e.windows.set(slot)
			continue
		}
		if m == nil {
			m = map[string]*ipEntry{}
		}
		if len(m) >= MaxIPsPerFlow {
			oldestIP, oldest := "", int64(math.MaxInt64)
			for k, e := range m {
				if e.lastSeen < oldest || (e.lastSeen == oldest && k < oldestIP) {
					oldestIP, oldest = k, e.lastSeen
				}
			}
			if oldest > start || (oldest == start && ip < oldestIP) {
				continue
			}
			delete(m, oldestIP)
		}
		e := &ipEntry{lastSeen: start}
		e.windows.set(slot)
		m[ip] = e
	}
	return m
}

func TestRecordIPSetMatchesOneAtATime(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	for trial := range 300 {
		var got, want map[string]*ipEntry
		pool := 50 + rng.IntN(400)
		for step := range 60 {
			// Mostly advancing windows, with some repeats and late arrivals.
			start := int64((step - rng.IntN(4)) * 15)
			ips := make([]string, rng.IntN(150))
			for i := range ips {
				n := rng.IntN(pool)
				ips[i] = fmt.Sprintf("10.0.%d.%d", n/256, n%256)
				if rng.IntN(50) == 0 {
					ips[i] = ""
				}
			}
			slot := bitIndex(start, start+15)
			got = recordIPSet(got, ips, slot, start)
			want = recordIPSetOneAtATime(want, ips, slot, start)

			if rng.IntN(5) == 0 {
				expired := int64((step - rng.IntN(8)) * 15)
				var mask windowSet
				mask.set(bitIndex(expired, expired+15))
				clearSlots(got, &mask)
				clearSlots(want, &mask)
			}

			if !maps.EqualFunc(got, want, func(a, b *ipEntry) bool { return *a == *b }) {
				t.Fatalf("trial %d step %d: recordIPSet kept a different set (%d vs %d entries)", trial, step, len(got), len(want))
			}
		}
	}
}
