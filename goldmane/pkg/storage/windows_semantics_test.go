// Copyright (c) 2026 Tigera, Inc. All rights reserved.

package storage

import (
	"testing"
	"unique"
	"unsafe"

	"github.com/projectcalico/calico/goldmane/pkg/types"
)

func semanticsFlow(packets int64) *types.Flow {
	return &types.Flow{
		PacketsIn:    packets,
		SourceLabels: unique.Make("app=a"),
		DestLabels:   unique.Make("app=b"),
	}
}

// GetWindows must hand back copies: distinct from the backing array and from each other.
func TestGetWindowsReturnsCopies(t *testing.T) {
	d := buildDiachronicFlow(0)
	for _, s := range []int64{0, 15, 30} {
		d.AddFlow(semanticsFlow(1), s, s+15)
	}

	ws := d.GetWindows(0, 0)
	if len(ws) != 3 {
		t.Fatalf("expected 3 windows, got %d", len(ws))
	}
	for i := range ws {
		if ws[i] == &d.Windows[i] {
			t.Errorf("window %d aliases the backing array", i)
		}
		for j := range i {
			if ws[i] == ws[j] {
				t.Errorf("windows %d and %d share one pointer", i, j)
			}
		}
		if ws[i].start != d.Windows[i].start {
			t.Errorf("window %d: copy start %d, backing start %d", i, ws[i].start, d.Windows[i].start)
		}
	}

	// A later AddFlow into window 1 must not show up in the copy.
	d.AddFlow(semanticsFlow(100), 15, 30)
	if d.Windows[1].PacketsIn != 101 {
		t.Fatalf("expected backing window to have 101 packets, got %d", d.Windows[1].PacketsIn)
	}
	if ws[1].PacketsIn != 1 {
		t.Errorf("copy changed after AddFlow: got %d packets, want 1", ws[1].PacketsIn)
	}
}

// A pointer into d.Windows reads a different window after insertWindow shifts the array in place.
func TestBackingArrayPointerShiftsOnInsert(t *testing.T) {
	d := buildDiachronicFlow(0)
	for _, s := range []int64{0, 30, 45} {
		d.AddFlow(semanticsFlow(s), s, s+15)
	}
	if cap(d.Windows) <= len(d.Windows) {
		t.Fatalf("test needs spare capacity: len %d cap %d", len(d.Windows), cap(d.Windows))
	}

	alias := &d.Windows[1]
	copied := d.GetWindows(30, 45)[0]
	if alias.start != 30 || copied.start != 30 {
		t.Fatalf("setup: alias start %d, copy start %d, want 30", alias.start, copied.start)
	}

	// A late flow for the 15-30 window inserts at index 1.
	d.AddFlow(semanticsFlow(999), 15, 30)

	if alias.start != 15 || alias.PacketsIn != 999 {
		t.Errorf("expected alias to now read the inserted window, got start %d packets %d", alias.start, alias.PacketsIn)
	}
	if copied.start != 30 || copied.PacketsIn != 30 {
		t.Errorf("copy should be unaffected, got start %d packets %d", copied.start, copied.PacketsIn)
	}
}

// GetWindows heap-allocates its loop variable on every iteration, so its cost grows with the
// flow's history even though only one window matches the bucket.
func TestGetWindowsAllocsScaleWithHistory(t *testing.T) {
	for _, n := range []int{1, 20, 242} {
		d := buildDiachronicFlow(n)
		s, e := int64((n-1)*15), int64(n*15)
		if got := len(d.GetWindows(s, e)); got != 1 {
			t.Fatalf("n=%d: expected 1 matching window, got %d", n, got)
		}
		getWindows := testing.AllocsPerRun(100, func() { _ = d.GetWindows(s, e) })
		snapshot := testing.AllocsPerRun(100, func() { _ = snapshotValue(d, s, e) })
		t.Logf("history=%d windows: GetWindows %.0f allocs, value snapshot %.0f allocs", n, getWindows, snapshot)
		if getWindows < float64(n) {
			t.Errorf("n=%d: expected at least %d allocs from GetWindows, got %.0f", n, n, getWindows)
		}
		if snapshot != 0 {
			t.Errorf("n=%d: expected value snapshot not to allocate, got %.0f", n, snapshot)
		}
	}
}

func TestReportSizes(t *testing.T) {
	t.Logf("DiachronicFlow=%d Window=%d windowLock=%d DeferredFlowBuilder=%d valueBuilder=%d",
		unsafe.Sizeof(DiachronicFlow{}), unsafe.Sizeof(Window{}), unsafe.Sizeof(windowLock{}),
		unsafe.Sizeof(DeferredFlowBuilder{}), unsafe.Sizeof(valueBuilder{}))
}
