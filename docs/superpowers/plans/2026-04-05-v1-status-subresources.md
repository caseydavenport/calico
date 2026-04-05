# V1 Status Subresource Support for IPPool, Tier, CalicoNodeStatus

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add proper status subresource support to IPPool, Tier, and CalicoNodeStatus v1 CRDs so that status writes go through the `/status` endpoint, eliminating "unknown field status" API server warnings.

**Architecture:** Follow the KubeControllersConfiguration pattern: add `+kubebuilder:subresource:status` markers to v1 Go types, add StatusREST handlers in the API server, add UpdateStatus to the libcalico-go client interface, and update callers. The backend infrastructure already supports UpdateStatus via the StatusClient interface.

**Tech Stack:** Go, controller-gen (CRD generation), Kubernetes API server extensions, libcalico-go client library

**Branch:** `casey-v1-status-subresource` (worktree at `/tmp/wt-v1-status`)

**Reference implementation:** `KubeControllersConfiguration` - every file referenced below has a KCC equivalent to model after.

---

### Task 1: V1 Go Types - Add Status Fields and Subresource Markers

**Files:**
- Modify: `libcalico-go/lib/apis/crd.projectcalico.org/v1/ippool_types.go`
- Modify: `libcalico-go/lib/apis/crd.projectcalico.org/v1/tier_types.go`
- Modify: `libcalico-go/lib/apis/crd.projectcalico.org/v1/caliconodestatus_types.go`

- [ ] **Step 1: Add Status field and subresource marker to IPPool**

In `libcalico-go/lib/apis/crd.projectcalico.org/v1/ippool_types.go`, add the marker and Status field:

```go
// +kubebuilder:subresource:status
type IPPool struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              v3.IPPoolSpec `json:"spec,omitempty"`

	// +optional
	Status *v3.IPPoolStatus `json:"status,omitempty"`
}
```

- [ ] **Step 2: Add Status field and subresource marker to Tier**

In `libcalico-go/lib/apis/crd.projectcalico.org/v1/tier_types.go`, add the marker and Status field:

```go
// +kubebuilder:subresource:status
type Tier struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata"`
	Spec              v3.TierSpec   `json:"spec"`
	Status            v3.TierStatus `json:"status,omitempty"`
}
```

- [ ] **Step 3: Add subresource marker to CalicoNodeStatus**

In `libcalico-go/lib/apis/crd.projectcalico.org/v1/caliconodestatus_types.go`, add the marker (Status field already exists):

```go
// +kubebuilder:subresource:status
type CalicoNodeStatus struct {
```

- [ ] **Step 4: Regenerate CRDs and manifests**

Run: `make generate` (from repo root)

Verify: `grep "subresources:" libcalico-go/config/crd/crd.projectcalico.org_ippools.yaml` should show the subresource.

- [ ] **Step 5: Commit**

```
git add libcalico-go/lib/apis/crd.projectcalico.org/v1/ libcalico-go/config/crd/ manifests/
git commit -m "Add status subresource markers to IPPool, Tier, CalicoNodeStatus v1 types"
```

---

### Task 2: API Server - StatusREST for IPPool

Model after: `apiserver/pkg/registry/projectcalico/kubecontrollersconfig/storage.go` and `strategy.go`

**Files:**
- Modify: `apiserver/pkg/registry/projectcalico/ippool/storage.go`
- Modify: `apiserver/pkg/registry/projectcalico/ippool/strategy.go`
- Modify: `apiserver/pkg/registry/projectcalico/rest/storage_calico.go`

- [ ] **Step 1: Add StatusREST to ippool/storage.go**

Add a `StatusREST` struct and modify `NewREST` to return both `*REST` and `*StatusREST`. Model after kubecontrollersconfig/storage.go lines 47-132.

The StatusREST needs:
- A `store *registry.Store` field
- `New() runtime.Object` returning `&calico.IPPool{}`
- `Destroy()` no-op
- `Get()` delegating to `store.Get()`
- `Update()` delegating to `store.Update()`

`NewREST` signature changes from returning `*REST` to returning `(*REST, *StatusREST, error)`. Create a second store using `NewStatusStrategy(strategy)` for the status subresource.

- [ ] **Step 2: Add StatusStrategy to ippool/strategy.go**

Add `apiServerStatusStrategy` struct embedding `apiServerStrategy`, with a `PrepareForUpdate` that preserves Spec and only allows Status changes:

```go
type apiServerStatusStrategy struct {
	apiServerStrategy
}

func NewStatusStrategy(strategy apiServerStrategy) apiServerStatusStrategy {
	return apiServerStatusStrategy{strategy}
}

func (apiServerStatusStrategy) PrepareForUpdate(ctx context.Context, obj, old runtime.Object) {
	newPool := obj.(*calico.IPPool)
	oldPool := old.(*calico.IPPool)
	newPool.Spec = oldPool.Spec
	newPool.Labels = oldPool.Labels
}
```

- [ ] **Step 3: Register IPPool status in storage_calico.go**

In `apiserver/pkg/registry/projectcalico/rest/storage_calico.go`:

1. Add separate RESTOptions for `ippools/status` (copy the pattern from kubecontrollersconfigurations/status around lines 442-462)
2. Update the `NewREST` call to capture both storage and statusStorage
3. Register `storage["ippools/status"] = ipPoolsStatusStorage`

- [ ] **Step 4: Build and verify**

Run: `go build ./apiserver/...`

- [ ] **Step 5: Commit**

```
git commit -m "Add StatusREST for IPPool in API server"
```

---

### Task 3: API Server - StatusREST for Tier

Same pattern as Task 2 but for Tier.

**Files:**
- Modify: `apiserver/pkg/registry/projectcalico/tier/storage.go`
- Modify: `apiserver/pkg/registry/projectcalico/tier/strategy.go`
- Modify: `apiserver/pkg/registry/projectcalico/rest/storage_calico.go`

- [ ] **Step 1: Add StatusREST to tier/storage.go**

Same pattern as IPPool. `New()` returns `&calico.Tier{}`. Update `NewREST` to return `(*REST, *StatusREST, error)`.

- [ ] **Step 2: Add StatusStrategy to tier/strategy.go**

```go
func (apiServerStatusStrategy) PrepareForUpdate(ctx context.Context, obj, old runtime.Object) {
	newTier := obj.(*calico.Tier)
	oldTier := old.(*calico.Tier)
	newTier.Spec = oldTier.Spec
	newTier.Labels = oldTier.Labels
}
```

- [ ] **Step 3: Register Tier status in storage_calico.go**

Add RESTOptions for `tiers/status` and register `storage["tiers/status"]`.

- [ ] **Step 4: Build and verify**

Run: `go build ./apiserver/...`

- [ ] **Step 5: Commit**

```
git commit -m "Add StatusREST for Tier in API server"
```

---

### Task 4: API Server - StatusREST for CalicoNodeStatus

Same pattern as Tasks 2-3.

**Files:**
- Modify: `apiserver/pkg/registry/projectcalico/caliconodestatus/storage.go`
- Modify: `apiserver/pkg/registry/projectcalico/caliconodestatus/strategy.go`
- Modify: `apiserver/pkg/registry/projectcalico/rest/storage_calico.go`

- [ ] **Step 1: Add StatusREST to caliconodestatus/storage.go**

`New()` returns `&calico.CalicoNodeStatus{}`.

- [ ] **Step 2: Add StatusStrategy to caliconodestatus/strategy.go**

```go
func (apiServerStatusStrategy) PrepareForUpdate(ctx context.Context, obj, old runtime.Object) {
	newStatus := obj.(*calico.CalicoNodeStatus)
	oldStatus := old.(*calico.CalicoNodeStatus)
	newStatus.Spec = oldStatus.Spec
	newStatus.Labels = oldStatus.Labels
}
```

- [ ] **Step 3: Register CalicoNodeStatus status in storage_calico.go**

Add RESTOptions for `caliconodestatuses/status` and register `storage["caliconodestatuses/status"]`.

- [ ] **Step 4: Build and verify**

Run: `go build ./apiserver/...`

- [ ] **Step 5: Commit**

```
git commit -m "Add StatusREST for CalicoNodeStatus in API server"
```

---

### Task 5: libcalico-go Client - Add UpdateStatus Methods

**Files:**
- Modify: `libcalico-go/lib/clientv3/ippool.go`
- Modify: `libcalico-go/lib/clientv3/tier.go`
- Modify: `libcalico-go/lib/clientv3/caliconodestatus.go`

- [ ] **Step 1: Add UpdateStatus to IPPoolInterface and implementation**

In `libcalico-go/lib/clientv3/ippool.go`:

Add to interface:
```go
UpdateStatus(ctx context.Context, res *apiv3.IPPool, opts options.SetOptions) (*apiv3.IPPool, error)
```

Add implementation:
```go
func (r ipPools) UpdateStatus(ctx context.Context, res *apiv3.IPPool, opts options.SetOptions) (*apiv3.IPPool, error) {
	out, err := r.client.resources.UpdateStatus(ctx, opts, apiv3.KindIPPool, res)
	if out != nil {
		return out.(*apiv3.IPPool), err
	}
	return nil, err
}
```

- [ ] **Step 2: Add UpdateStatus to TierInterface and implementation**

Same pattern in `libcalico-go/lib/clientv3/tier.go` using `apiv3.KindTier`.

- [ ] **Step 3: Add UpdateStatus to CalicoNodeStatusInterface and implementation**

Same pattern in `libcalico-go/lib/clientv3/caliconodestatus.go` using `apiv3.KindCalicoNodeStatus`.

- [ ] **Step 4: Build and verify**

Run: `go build ./libcalico-go/...`

- [ ] **Step 5: Commit**

```
git commit -m "Add UpdateStatus to IPPool, Tier, CalicoNodeStatus libcalico-go clients"
```

---

### Task 6: Fix CalicoNodeStatus Reporter Caller

The node status reporter writes Status via regular `Update()`. With the status subresource, this needs to use `UpdateStatus()`.

**Files:**
- Modify: `node/pkg/status/reporter.go:225-226`

- [ ] **Step 1: Change Update to UpdateStatus in reporter.go**

At line ~226, change:
```go
updatedResource, err = r.client.CalicoNodeStatus().Update(ctx, &status, options.SetOptions{})
```
to:
```go
updatedResource, err = r.client.CalicoNodeStatus().UpdateStatus(ctx, &status, options.SetOptions{})
```

Note: The reporter also calls `Update()` for Spec changes (line ~212) - leave those as `Update()`. Only the status write at line ~226 needs to change.

- [ ] **Step 2: Build and verify**

Run: `go build ./node/...`

- [ ] **Step 3: Commit**

```
git commit -m "Use UpdateStatus for CalicoNodeStatus status writes in reporter"
```

---

### Task 7: Update CalicoNodeStatus E2E Tests

The existing tests create CalicoNodeStatus with Status in a single `Create` call and expect it back. With the status subresource, Create strips Status - a separate UpdateStatus is needed.

**Files:**
- Modify: `libcalico-go/lib/clientv3/caliconodestatus_e2e_test.go`

- [ ] **Step 1: Update tests to use two-step create+updateStatus**

In `caliconodestatus_e2e_test.go`, wherever a resource is created with Status and then the Status is asserted:

1. Create with Spec only (Status will be empty)
2. Call `UpdateStatus` to set the Status
3. Then assert the full resource

Also add dedicated UpdateStatus test cases that verify:
- Status can be updated without affecting Spec
- Spec can be updated without affecting Status
- Watch events fire for status updates

Model after: `libcalico-go/lib/clientv3/kubecontrollersconfig_e2e_test.go` lines 265-276.

- [ ] **Step 2: Run tests**

Run: `make -C libcalico-go ut GINKGO_FOCUS="CalicoNodeStatus"`

- [ ] **Step 3: Commit**

```
git commit -m "Update CalicoNodeStatus e2e tests for status subresource"
```

---

### Task 8: Add IPPool and Tier Status E2E Tests

**Files:**
- Modify: `libcalico-go/lib/clientv3/ippool_e2e_test.go`
- Modify: `libcalico-go/lib/clientv3/tier_e2e_test.go`

- [ ] **Step 1: Add UpdateStatus test to IPPool e2e tests**

Add a test case that:
1. Creates an IPPool
2. Calls `UpdateStatus` to set status conditions
3. Verifies status is persisted
4. Calls `Update` to modify Spec
5. Verifies status is preserved after Spec-only update

- [ ] **Step 2: Add UpdateStatus test to Tier e2e tests**

Same pattern for Tier using `TierStatus`.

- [ ] **Step 3: Run tests**

Run: `make -C libcalico-go ut GINKGO_FOCUS="IPPool|Tier"`

- [ ] **Step 4: Commit**

```
git commit -m "Add UpdateStatus e2e tests for IPPool and Tier"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Run full make generate to ensure consistency**

Run: `make generate`

- [ ] **Step 2: Run make check-dirty**

Run: `make check-dirty` (should pass - no uncommitted generated files)

- [ ] **Step 3: Run libcalico-go tests**

Run: `make -C libcalico-go ut`

- [ ] **Step 4: Run apiserver tests**

Run: `make -C apiserver ut`

- [ ] **Step 5: Run node tests**

Run: `make -C node ut`

- [ ] **Step 6: Push and update PR**

```
git push cd4 casey-v1-status-subresource
```
