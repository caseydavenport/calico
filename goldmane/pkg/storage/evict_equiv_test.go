// Copyright (c) 2026 Tigera, Inc. All rights reserved.

package storage

import (
	"fmt"
	"maps"
	"math"
	"math/rand/v2"
	"testing"
)

// recordIPSetSequential is the per-IP eviction loop from f0a740a, kept as the reference.
func recordIPSetSequential(m map[string]*ipEntry, ips []string, slot int, start int64) map[string]*ipEntry {
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
			m = make(map[string]*ipEntry, min(len(ips), MaxIPsPerFlow))
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

func TestRecordIPSetMatchesSequential(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for trial := range 2000 {
		var got, want map[string]*ipEntry
		pool := 50 + r.IntN(400)
		for step := range 40 {
			// Mostly advancing windows, with some late arrivals and repeats of the same window.
			window := step - r.IntN(4)
			start := int64(window * 15)
			ips := make([]string, r.IntN(150))
			for i := range ips {
				ips[i] = fmt.Sprintf("10.0.%d.%d", r.IntN(pool)/256, r.IntN(pool)%256)
				if r.IntN(50) == 0 {
					ips[i] = ""
				}
			}
			slot := bitIndex(start, start+15)
			got = recordIPSet(got, ips, slot, start)
			want = recordIPSetSequential(want, ips, slot, start)

			if !maps.EqualFunc(got, want, func(a, b *ipEntry) bool { return *a == *b }) {
				t.Fatalf("trial %d step %d: batch and sequential eviction diverge (%d vs %d entries)", trial, step, len(got), len(want))
			}
		}
	}
}
