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
	"math"
	"slices"
)

// ipSet holds the IPs seen in one direction of a DiachronicFlow. A window's IPs stay pending until it
// closes, and every trim ranks IPs by their windows and hash, so arrival order never matters.
type ipSet struct {
	ips map[string]*ipEntry

	// open lists the windows that haven't closed yet; there are only ever a few. An IP's bits for
	// these windows are pending: they don't count toward the cap or affect eviction.
	open []openWindow

	// numKept counts the IPs seen in at least one closed window, which is what the cap applies to.
	numKept int
}

// ipEntry records the windows an IP was seen in, open or closed. lastSeen is the newest closed one,
// or notKept if there is none, and decides what gets evicted once the cap is reached.
type ipEntry struct {
	windows  windowSet
	lastSeen int64
}

const notKept = math.MinInt64

type openWindow struct {
	start int64
	slot  int

	// count is the number of IPs with this window's bit set, and pending holds their entries, so
	// closing the window touches only them. Entries trimmed since have the bit cleared.
	count   int
	pending []*ipEntry
}

func (s *ipSet) len() int {
	return len(s.ips)
}

// stage records ips as seen in the open window starting at start.
func (s *ipSet) stage(ips []string, slot int, start int64) {
	window := s.openWindow(slot, start)
	if s.ips == nil {
		s.ips = map[string]*ipEntry{}
	}
	for _, ip := range ips {
		if ip == "" {
			continue
		}
		e := s.ips[ip]
		if e == nil {
			e = &ipEntry{lastSeen: notKept}
			s.ips[ip] = e
		}
		if !e.windows.has(slot) {
			e.windows.set(slot)
			window.count++
			window.pending = append(window.pending, e)
		}
	}

	// Trimming at twice the cap keeps the work amortized. Only the top MaxIPsPerFlow by hash can
	// survive the close, so dropping the rest early doesn't change the outcome.
	if window.count > 2*MaxIPsPerFlow {
		s.trimOpen(window)
	}
}

func (s *ipSet) openWindow(slot int, start int64) *openWindow {
	for i := range s.open {
		if s.open[i].start == start {
			return &s.open[i]
		}
	}
	s.open = append(s.open, openWindow{start: start, slot: slot})
	return &s.open[len(s.open)-1]
}

// trimOpen keeps the MaxIPsPerFlow IPs with the highest rank in an open window.
func (s *ipSet) trimOpen(w *openWindow) {
	if w.count <= MaxIPsPerFlow {
		return
	}
	ranked := make([]rankedIP, 0, w.count)
	for ip, e := range s.ips {
		if e.windows.has(w.slot) {
			ranked = append(ranked, newRankedIP(ip, 0))
		}
	}
	for _, r := range newest(ranked)[MaxIPsPerFlow:] {
		e := s.ips[r.ip]
		e.windows.clear(w.slot)
		if e.windows.empty() {
			delete(s.ips, r.ip)
		}
	}
	w.count = MaxIPsPerFlow
}

// closeThrough closes every open window starting at or before start, oldest first, and trims the
// kept IPs to the newest MaxIPsPerFlow.
func (s *ipSet) closeThrough(start int64) {
	slices.SortFunc(s.open, func(a, b openWindow) int { return cmp.Compare(a.start, b.start) })
	for len(s.open) > 0 && s.open[0].start <= start {
		w := s.open[0]
		s.open = s.open[1:]
		s.close(&w)
	}
}

func (s *ipSet) close(w *openWindow) {
	s.trimOpen(w)
	for _, e := range w.pending {
		if !e.windows.has(w.slot) || e.lastSeen == w.start {
			continue
		}
		if e.lastSeen == notKept {
			s.numKept++
		}
		e.lastSeen = w.start
	}
	excess := s.numKept - MaxIPsPerFlow
	if excess <= 0 {
		return
	}

	// Only IPs last seen in the oldest windows can go, so sort the kept IPs by lastSeen alone and
	// rank by hash just the ones tied at the cutoff.
	kept := make([]rankedIP, 0, s.numKept)
	for ip, e := range s.ips {
		if e.lastSeen != notKept {
			kept = append(kept, rankedIP{lastSeen: e.lastSeen, ip: ip})
		}
	}
	slices.SortFunc(kept, func(a, b rankedIP) int { return cmp.Compare(a.lastSeen, b.lastSeen) })
	cutoff := kept[excess-1].lastSeen
	lo, _ := slices.BinarySearchFunc(kept, cutoff, func(r rankedIP, t int64) int { return cmp.Compare(r.lastSeen, t) })
	hi, _ := slices.BinarySearchFunc(kept, cutoff+1, func(r rankedIP, t int64) int { return cmp.Compare(r.lastSeen, t) })
	tied := kept[lo:hi]
	for i := range tied {
		tied[i].hash = ipHash(tied[i].ip)
	}

	// Evict every IP older than the cutoff, plus the lowest-ranked tied IPs.
	evict := append(kept[:lo:lo], newest(tied)[hi-excess:]...)
	open := s.openMask()
	for _, r := range evict {
		s.evict(r.ip, s.ips[r.ip], &open)
	}
}

// evict drops an IP's closed windows, keeping it only if it's pending in an open window.
func (s *ipSet) evict(ip string, e *ipEntry, open *windowSet) {
	s.numKept--
	e.lastSeen = notKept
	e.windows = e.windows.and(open)
	if e.windows.empty() {
		delete(s.ips, ip)
	}
}

func (s *ipSet) openMask() windowSet {
	var m windowSet
	for _, w := range s.open {
		m.set(w.slot)
	}
	return m
}

// expire clears the slots in mask from every IP and drops IPs left with no windows.
func (s *ipSet) expire(mask *windowSet) {
	open := s.openMask()
	for ip, e := range s.ips {
		e.windows.clearAll(mask)
		if e.lastSeen != notKept && e.windows.andNot(&open) == (windowSet{}) {
			e.lastSeen = notKept
			s.numKept--
		}
		if e.windows.empty() {
			delete(s.ips, ip)
		}
	}
}

// matching returns the sorted IPs seen in any of the slots in mask, including windows that are still
// open. Open windows can push the count past the cap, so it keeps the newest MaxIPsPerFlow.
func (s *ipSet) matching(mask *windowSet) []string {
	open := s.openMask()
	closed := mask.andNot(&open)
	lastSeen := map[string]int64{}
	for ip, e := range s.ips {
		if !e.windows.intersects(mask) {
			continue
		}
		seen := int64(notKept)
		if e.windows.intersects(&closed) {
			seen = e.lastSeen
		}
		for _, w := range s.open {
			if mask.has(w.slot) && e.windows.has(w.slot) {
				seen = max(seen, w.start)
			}
		}
		lastSeen[ip] = seen
	}
	if len(lastSeen) <= MaxIPsPerFlow {
		return slices.Sorted(maps.Keys(lastSeen))
	}
	ranked := make([]rankedIP, 0, len(lastSeen))
	for ip, seen := range lastSeen {
		ranked = append(ranked, newRankedIP(ip, seen))
	}
	ips := make([]string, MaxIPsPerFlow)
	for i, r := range newest(ranked)[:MaxIPsPerFlow] {
		ips[i] = r.ip
	}
	slices.Sort(ips)
	return ips
}

// rankedIP orders IPs for eviction by lastSeen, then hash, then address. The address only breaks
// hash collisions, so the order never depends on how the IPs arrived.
type rankedIP struct {
	lastSeen int64
	hash     uint64
	ip       string
}

func newRankedIP(ip string, lastSeen int64) rankedIP {
	return rankedIP{lastSeen: lastSeen, hash: ipHash(ip), ip: ip}
}

// newest sorts ranked from highest to lowest rank, so the IPs to keep come first.
func newest(ranked []rankedIP) []rankedIP {
	slices.SortFunc(ranked, func(a, b rankedIP) int {
		return cmp.Or(cmp.Compare(b.lastSeen, a.lastSeen), cmp.Compare(b.hash, a.hash), cmp.Compare(b.ip, a.ip))
	})
	return ranked
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
