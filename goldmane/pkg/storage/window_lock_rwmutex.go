//go:build !bench_mutex && !bench_nolock

package storage

import "sync"

type windowLock = sync.RWMutex
