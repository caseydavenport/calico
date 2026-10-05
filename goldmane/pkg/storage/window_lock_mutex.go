//go:build bench_mutex

package storage

import "sync"

type windowLock struct{ sync.Mutex }

func (l *windowLock) RLock()   { l.Lock() }
func (l *windowLock) RUnlock() { l.Unlock() }
