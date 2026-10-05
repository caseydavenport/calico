//go:build go1.21

// Copyright (c) 2026 Tigera, Inc. All rights reserved.

package storage

import "testing"

// getWindowsOldLoopVar is the GetWindows loop compiled with Go 1.21 loop variable semantics.
func getWindowsOldLoopVar(d *DiachronicFlow) []*Window {
	var out []*Window
	for _, w := range d.Windows {
		out = append(out, &w)
	}
	return out
}

func TestGetWindowsLoopVarPreGo122(t *testing.T) {
	d := buildDiachronicFlow(0)
	for _, s := range []int64{0, 15, 30} {
		d.AddFlow(semanticsFlow(s), s, s+15)
	}

	ws := getWindowsOldLoopVar(d)
	for i, w := range ws {
		t.Logf("window %d: ptr %p start %d", i, w, w.start)
	}
	if ws[0] != ws[2] || ws[0].start != 30 {
		t.Errorf("expected every pointer to alias the last window under go1.21 semantics")
	}
}
