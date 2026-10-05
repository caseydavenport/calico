//go:build bench_nolock

package storage

// windowLock is a no-op, matching master before the PR added the lock.
type windowLock struct{}

func (l *windowLock) Lock()    {}
func (l *windowLock) Unlock()  {}
func (l *windowLock) RLock()   {}
func (l *windowLock) RUnlock() {}
