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
	"cmp"
	"maps"
	"slices"
)

// ipSet holds the IPs seen in one direction of a DiachronicFlow. A window's IPs are staged until it
// closes, and every trim ranks IPs by their windows and hash, so arrival order never matters.
type ipSet struct {
	kept map[string]*ipEntry

	// open holds the staging sets of windows that haven't closed yet; there are only ever a few.
	open []stagedWindow
}

// ipEntry records the windows an IP was seen in, plus the newest such window (lastSeen), which
// decides what gets evicted once the per-key cap is reached.
type ipEntry struct {
	windows  windowSet
	lastSeen int64
}

type stagedWindow struct {
	start int64
	slot  int
	ips   map[string]struct{}
}

func (s *ipSet) len() int {
	n := len(s.kept)
	for _, w := range s.open {
		n += len(w.ips)
	}
	return n
}

// stage records ips as seen in the open window starting at start.
func (s *ipSet) stage(ips []string, slot int, start int64) {
	w := s.openWindow(slot, start)
	for _, ip := range ips {
		if ip != "" {
			w.ips[ip] = struct{}{}
		}
	}

	// Trimming at twice the cap keeps the work amortized. Only the top MaxIPsPerFlow by hash can
	// survive the close, so dropping the rest early doesn't change the outcome.
	if len(w.ips) > 2*MaxIPsPerFlow {
		trimStaged(w.ips)
	}
}

func (s *ipSet) openWindow(slot int, start int64) *stagedWindow {
	for i := range s.open {
		if s.open[i].start == start {
			return &s.open[i]
		}
	}
	s.open = append(s.open, stagedWindow{start: start, slot: slot, ips: map[string]struct{}{}})
	return &s.open[len(s.open)-1]
}

// closeThrough merges every open window starting at or before start into kept, oldest first, and
// trims kept to the newest MaxIPsPerFlow IPs.
func (s *ipSet) closeThrough(start int64) {
	slices.SortFunc(s.open, func(a, b stagedWindow) int { return cmp.Compare(a.start, b.start) })
	n := 0
	for _, w := range s.open {
		if w.start > start {
			break
		}
		s.merge(w)
		n++
	}
	s.open = slices.Delete(s.open, 0, n)
}

func (s *ipSet) merge(w stagedWindow) {
	trimStaged(w.ips)
	if s.kept == nil && len(w.ips) > 0 {
		s.kept = make(map[string]*ipEntry, len(w.ips))
	}
	for ip := range w.ips {
		e, ok := s.kept[ip]
		if !ok {
			e = &ipEntry{}
			s.kept[ip] = e
		}
		e.windows.set(w.slot)
		e.lastSeen = max(e.lastSeen, w.start)
	}
	if len(s.kept) <= MaxIPsPerFlow {
		return
	}
	ips := slices.Collect(maps.Keys(s.kept))
	slices.SortFunc(ips, func(a, b string) int {
		return cmp.Or(cmp.Compare(s.kept[a].lastSeen, s.kept[b].lastSeen), cmp.Compare(ipHash(a), ipHash(b)))
	})
	for _, ip := range ips[:len(ips)-MaxIPsPerFlow] {
		delete(s.kept, ip)
	}
}

// expire clears the slots in mask from every kept IP and drops IPs left with no windows.
func (s *ipSet) expire(mask *windowSet) {
	for ip, e := range s.kept {
		e.windows.clearAll(mask)
		if e.windows.empty() {
			delete(s.kept, ip)
		}
	}
}

// matching returns the sorted IPs seen in any of the slots in mask, including windows that are still
// open. Open windows can push the count past the cap, so it keeps the newest MaxIPsPerFlow.
func (s *ipSet) matching(mask *windowSet) []string {
	lastSeen := map[string]int64{}
	for ip, e := range s.kept {
		if e.windows.intersects(mask) {
			lastSeen[ip] = e.lastSeen
		}
	}
	for _, w := range s.open {
		var ws windowSet
		ws.set(w.slot)
		if !ws.intersects(mask) {
			continue
		}
		for ip := range w.ips {
			lastSeen[ip] = max(lastSeen[ip], w.start)
		}
	}
	ips := slices.Collect(maps.Keys(lastSeen))
	if len(ips) > MaxIPsPerFlow {
		slices.SortFunc(ips, func(a, b string) int {
			return cmp.Or(cmp.Compare(lastSeen[b], lastSeen[a]), cmp.Compare(ipHash(b), ipHash(a)))
		})
		ips = ips[:MaxIPsPerFlow]
	}
	slices.Sort(ips)
	return ips
}

// trimStaged keeps the MaxIPsPerFlow IPs with the highest hash.
func trimStaged(ips map[string]struct{}) {
	if len(ips) <= MaxIPsPerFlow {
		return
	}
	all := slices.Collect(maps.Keys(ips))
	slices.SortFunc(all, func(a, b string) int { return cmp.Compare(ipHash(a), ipHash(b)) })
	for _, ip := range all[:len(all)-MaxIPsPerFlow] {
		delete(ips, ip)
	}
}

// FNV-1a parameters. Hashing inline avoids hash/fnv's per-call allocation.
const (
	fnvOffset64 = 14695981039346656037
	fnvPrime64  = 1099511628211
)

// ipHash is 64-bit FNV-1a. It must give the same value in every process and release, since replicas
// use it to agree on which IPs to keep.
func ipHash(ip string) uint64 {
	h := uint64(fnvOffset64)
	for i := 0; i < len(ip); i++ {
		h ^= uint64(ip[i])
		h *= fnvPrime64
	}
	return h
}
