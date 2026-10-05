// Copyright (c) 2026 Tigera, Inc. All rights reserved.

package storage

import (
	"fmt"
	"runtime"
	"runtime/metrics"
	"sync"
	"sync/atomic"
	"testing"
	"unique"
	"unsafe"

	"github.com/sirupsen/logrus"

	"github.com/projectcalico/calico/goldmane/pkg/types"
	"github.com/projectcalico/calico/goldmane/proto"
)

const (
	benchWindowsPerFlow = 20
	benchInterval       = 15
)

// benchBucket is the bucket the benchmarks stream: the newest window on every flow.
var benchBucketStart, benchBucketEnd = bucketFor(benchWindowsPerFlow)

func bucketFor(windows int) (int64, int64) {
	return int64((windows - 1) * benchInterval), int64(windows * benchInterval)
}

func benchFlows(n int) ([]*DiachronicFlow, *types.Flow) {
	return benchFlowsWithHistory(n, benchWindowsPerFlow)
}

func benchFlowsWithHistory(n, windows int) ([]*DiachronicFlow, *types.Flow) {
	logrus.SetLevel(logrus.WarnLevel)
	src := unique.Make("app=frontend,env=prod,team=payments,tier=web,version=v1")
	dst := unique.Make("app=backend,env=prod,team=payments,tier=api,version=v2")
	ds := make([]*DiachronicFlow, n)
	var f *types.Flow
	for i := range n {
		k := types.NewFlowKey(
			&types.FlowKeySource{SourceName: fmt.Sprintf("src-%d", i), SourceNamespace: "default", SourceType: proto.EndpointType_WorkloadEndpoint},
			&types.FlowKeyDestination{DestName: fmt.Sprintf("dst-%d", i), DestNamespace: "default", DestType: proto.EndpointType_WorkloadEndpoint, DestPort: 8080},
			&types.FlowKeyMeta{Proto: "TCP", Reporter: proto.Reporter_Src, Action: proto.Action_Allow},
			&proto.PolicyTrace{},
		)
		f = &types.Flow{Key: k, PacketsIn: 10, PacketsOut: 20, BytesIn: 1000, BytesOut: 2000, NumConnectionsStarted: 1, SourceLabels: src, DestLabels: dst}
		ds[i] = NewDiachronicFlow(k, int64(i))
		for w := range windows {
			ds[i].AddFlow(f, int64(w*benchInterval), int64((w+1)*benchInterval))
		}
	}
	return ds, f
}

// valueBuilder holds the bucket's single window by value. A bucket maps to exactly one window,
// because BucketRing.AddFlow always passes the bucket's own start and end.
type valueBuilder struct {
	d  *DiachronicFlow
	w  Window
	ok bool
}

func snapshotValue(d *DiachronicFlow, s, e int64) valueBuilder {
	d.mu.RLock()
	defer d.mu.RUnlock()
	for _, w := range d.Windows {
		if w.start >= s && w.end <= e {
			return valueBuilder{d: d, w: w, ok: true}
		}
	}
	return valueBuilder{d: d}
}

func (v *valueBuilder) BuildInto(filter *proto.Filter, res *proto.FlowResult) bool {
	if !v.ok || (filter != nil && !types.Matches(filter, &v.d.Key)) {
		return false
	}
	types.FlowIntoProto(aggregateOne(v.d, &v.w), res.Flow)
	res.Id = v.d.ID
	return true
}

// ptrTrimmedBuilder keeps today's []*Window copies but drops the second lock in BuildInto.
type ptrTrimmedBuilder struct {
	d *DiachronicFlow
	w []*Window
}

func (p *ptrTrimmedBuilder) BuildInto(filter *proto.Filter, res *proto.FlowResult) bool {
	if len(p.w) == 0 || (filter != nil && !types.Matches(filter, &p.d.Key)) {
		return false
	}
	types.FlowIntoProto(aggregateOne(p.d, p.w[0]), res.Flow)
	res.Id = p.d.ID
	return true
}

func aggregateOne(d *DiachronicFlow, w *Window) *types.Flow {
	return &types.Flow{
		Key:                     &d.Key,
		StartTime:               w.start,
		EndTime:                 w.end,
		SourceLabels:            w.SourceLabels,
		DestLabels:              w.DestLabels,
		PacketsIn:               w.PacketsIn,
		PacketsOut:              w.PacketsOut,
		BytesIn:                 w.BytesIn,
		BytesOut:                w.BytesOut,
		NumConnectionsStarted:   w.NumConnectionsStarted,
		NumConnectionsCompleted: w.NumConnectionsCompleted,
		NumConnectionsLive:      w.NumConnectionsLive,
	}
}

// rolloverEmpty is Rollover and Empty under one lock acquisition.
func (d *DiachronicFlow) rolloverEmpty(limiter int64) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	for i, w := range d.Windows {
		if w.end > limiter {
			if i > 0 {
				d.Windows = d.Windows[i:]
			}
			return false
		}
	}
	d.Windows = d.Windows[:0]
	return true
}

// gcMeter reports the share of CPU the GC used across a benchmark.
type gcMeter struct {
	samples []metrics.Sample
	gc0     float64
	total0  float64
	cycles0 uint64
}

func startGCMeter() *gcMeter {
	m := &gcMeter{samples: []metrics.Sample{
		{Name: "/cpu/classes/gc/total:cpu-seconds"},
		{Name: "/cpu/classes/total:cpu-seconds"},
		{Name: "/gc/cycles/total:gc-cycles"},
	}}
	runtime.GC()
	metrics.Read(m.samples)
	m.gc0, m.total0, m.cycles0 = m.samples[0].Value.Float64(), m.samples[1].Value.Float64(), m.samples[2].Value.Uint64()
	return m
}

func (m *gcMeter) report(b *testing.B) {
	metrics.Read(m.samples)
	gc := m.samples[0].Value.Float64() - m.gc0
	total := m.samples[1].Value.Float64() - m.total0
	if total > 0 {
		b.ReportMetric(100*gc/total, "gc-cpu-%")
	}
	b.ReportMetric(float64(m.samples[2].Value.Uint64()-m.cycles0)/float64(b.N), "gc-cycles/op")
}

// BenchmarkAddFlowHotPath measures AddFlow into an existing window, the common ingest case.
func BenchmarkAddFlowHotPath(b *testing.B) {
	ds, f := benchFlows(10_000)
	b.ReportAllocs()
	i := 0
	for b.Loop() {
		ds[i%len(ds)].AddFlow(f, benchBucketStart, benchBucketEnd)
		i++
	}
}

// BenchmarkAddFlowContended measures AddFlow while stream goroutines snapshot the same flows.
func BenchmarkAddFlowContended(b *testing.B) {
	for _, readers := range []int{1, 4, 11, 100} {
		b.Run(fmt.Sprintf("readers=%d", readers), func(b *testing.B) {
			ds, f := benchFlows(10_000)
			var stop atomic.Bool
			var reads atomic.Int64
			var wg sync.WaitGroup
			for r := range readers {
				wg.Go(func() {
					var n int64
					for i := r * 997; !stop.Load(); i++ {
						_ = NewDeferredFlowBuilder(ds[i%len(ds)], benchBucketStart, benchBucketEnd)
						n++
					}
					reads.Add(n)
				})
			}
			b.ReportAllocs()
			i := 0
			for b.Loop() {
				ds[i%len(ds)].AddFlow(f, benchBucketStart, benchBucketEnd)
				i++
			}
			stop.Store(true)
			wg.Wait()
			b.ReportMetric(float64(reads.Load())/b.Elapsed().Seconds()/1e6, "Mreads/s")
		})
	}
}

// BenchmarkAddFlowContendedValue is BenchmarkAddFlowContended with readers that take a
// non-allocating value snapshot, so reader GC churn does not mask the lock cost.
func BenchmarkAddFlowContendedValue(b *testing.B) {
	for _, readers := range []int{1, 4, 11} {
		b.Run(fmt.Sprintf("readers=%d", readers), func(b *testing.B) {
			ds, f := benchFlows(10_000)
			var stop atomic.Bool
			var reads atomic.Int64
			var wg sync.WaitGroup
			for r := range readers {
				wg.Go(func() {
					var n int64
					for i := r * 997; !stop.Load(); i++ {
						_ = snapshotValue(ds[i%len(ds)], benchBucketStart, benchBucketEnd)
						n++
					}
					reads.Add(n)
				})
			}
			i := 0
			for b.Loop() {
				ds[i%len(ds)].AddFlow(f, benchBucketStart, benchBucketEnd)
				i++
			}
			stop.Store(true)
			wg.Wait()
			b.ReportMetric(float64(reads.Load())/b.Elapsed().Seconds()/1e6, "Mreads/s")
		})
	}
}

type streamStrategy struct {
	name string
	run  func(ds []*DiachronicFlow, s, e int64, streams int)
}

func consume(fb FlowBuilder, res *proto.FlowResult) {
	fb.BuildInto(nil, res)
}

var streamStrategies = []streamStrategy{
	{"pr", func(ds []*DiachronicFlow, s, e int64, streams int) {
		fanOut(streams, func() {
			res := &proto.FlowResult{Flow: &proto.Flow{}}
			for _, d := range ds {
				consume(NewDeferredFlowBuilder(d, s, e), res)
			}
		})
	}},
	{"ptr-trimmed", func(ds []*DiachronicFlow, s, e int64, streams int) {
		fanOut(streams, func() {
			res := &proto.FlowResult{Flow: &proto.Flow{}}
			for _, d := range ds {
				consume(&ptrTrimmedBuilder{d: d, w: d.GetWindows(s, e)}, res)
			}
		})
	}},
	{"value-per-stream", func(ds []*DiachronicFlow, s, e int64, streams int) {
		fanOut(streams, func() {
			res := &proto.FlowResult{Flow: &proto.Flow{}}
			for _, d := range ds {
				vb := snapshotValue(d, s, e)
				consume(&vb, res)
			}
		})
	}},
	{"value-shared", func(ds []*DiachronicFlow, s, e int64, streams int) {
		snap := make([]valueBuilder, len(ds))
		for i, d := range ds {
			snap[i] = snapshotValue(d, s, e)
		}
		fanOut(streams, func() {
			res := &proto.FlowResult{Flow: &proto.Flow{}}
			for i := range snap {
				consume(&snap[i], res)
			}
		})
	}},
}

func fanOut(streams int, fn func()) {
	var wg sync.WaitGroup
	for range streams {
		wg.Go(fn)
	}
	wg.Wait()
}

// BenchmarkStreamBucket delivers one bucket to every stream and builds every flow, as
// flushToStreams plus the gRPC consumers do on each rollover.
func BenchmarkStreamBucket(b *testing.B) {
	for _, n := range []int{10_000, 100_000} {
		ds, _ := benchFlows(n)
		for _, streams := range []int{1, 10, 100} {
			if n == 100_000 && streams == 100 {
				continue
			}
			for _, s := range streamStrategies {
				b.Run(fmt.Sprintf("flows=%d/streams=%d/%s", n, streams, s.name), func(b *testing.B) {
					b.ReportAllocs()
					m := startGCMeter()
					for b.Loop() {
						s.run(ds, benchBucketStart, benchBucketEnd, streams)
					}
					m.report(b)
					b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*n*streams), "ns/flow")
				})
			}
		}
	}
}

// BenchmarkStreamBucketLongHistory streams flows that have been active for the whole ring.
func BenchmarkStreamBucketLongHistory(b *testing.B) {
	const n, windows = 10_000, 242
	ds, _ := benchFlowsWithHistory(n, windows)
	start, end := bucketFor(windows)
	for _, streams := range []int{1, 10} {
		for _, s := range streamStrategies {
			b.Run(fmt.Sprintf("flows=%d/history=%d/streams=%d/%s", n, windows, streams, s.name), func(b *testing.B) {
				b.ReportAllocs()
				m := startGCMeter()
				for b.Loop() {
					s.run(ds, start, end, streams)
				}
				m.report(b)
				b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*n*streams), "ns/flow")
			})
		}
	}
}

// BenchmarkSnapshotBytes reports what one shared bucket snapshot holds live.
func BenchmarkSnapshotBytes(b *testing.B) {
	b.ReportMetric(float64(unsafe.Sizeof(valueBuilder{})), "B/flow")
}

// BenchmarkRingRollover runs the per-flow part of BucketRing.Rollover over many flows.
func BenchmarkRingRollover(b *testing.B) {
	ds, _ := benchFlows(100_000)
	orig := make([][]Window, len(ds))
	for i, d := range ds {
		orig[i] = d.Windows
	}
	limiter := int64(benchInterval)

	b.Run("rollover+empty", func(b *testing.B) {
		for b.Loop() {
			for i, d := range ds {
				d.Windows = orig[i]
				d.Rollover(limiter)
				_ = d.Empty()
			}
		}
		b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*len(ds)), "ns/flow")
	})
	b.Run("merged", func(b *testing.B) {
		for b.Loop() {
			for i, d := range ds {
				d.Windows = orig[i]
				_ = d.rolloverEmpty(limiter)
			}
		}
		b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*len(ds)), "ns/flow")
	})
}
