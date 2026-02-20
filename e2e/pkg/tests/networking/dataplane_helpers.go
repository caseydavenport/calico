// Copyright (c) 2025 Tigera, Inc. All rights reserved.
//
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

package networking

// Dataplane test helpers for workload egress and ingress verification.
//
// These helpers intentionally do NOT use the conncheck.ConnectionTester framework,
// which is the standard pattern for e2e connectivity tests. The dataplane tests
// have requirements that don't fit the ConnectionTester model:
//
//   - Self-loopback: The server pod also acts as the client (srcPod = serverPod),
//     requiring Alpine + busybox httpd instead of conncheck's test-webserver image.
//     The ConnectionTester enforces a strict Server/Client separation that prevents
//     using a Server as a connectivity source.
//
//   - Per-scenario lifecycle: Each scenario creates and destroys its own server,
//     service, and client pods with per-scenario configuration (e.g., different
//     externalTrafficPolicy settings). The ConnectionTester assumes deploy-once,
//     test-many, stop-once.
//
//   - Multi-step policy lifecycle: Each test applies and removes multiple policies
//     in sequence, checking connectivity after each change. The ConnectionTester's
//     ExpectSuccess/Execute/ResetExpectations cycle adds ceremony without benefit
//     for sequential single-connection checks.
//
// The helpers DO use conncheck.ExecInPod for kubectl exec, which is the public
// primitive underlying the ConnectionTester's connectivity checks.

import (
	"context"
	"fmt"
	"time"

	//nolint:staticcheck // Ignore ST1001: should not use dot imports
	. "github.com/onsi/gomega"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/kubernetes/test/e2e/framework"
	e2epod "k8s.io/kubernetes/test/e2e/framework/pod"

	"github.com/projectcalico/calico/e2e/pkg/utils/conncheck"
	"github.com/projectcalico/calico/e2e/pkg/utils/images"
)

// dataplanePort is the HTTP port used by all dataplane test server pods.
const dataplanePort = 8080

// createDataplaneServerPod creates an Alpine pod running busybox httpd on dataplanePort.
//
// This does NOT use conncheck.Server because conncheck servers use the test-webserver
// image, which cannot run wget. The dataplane tests need Alpine + busybox httpd so that
// the same pod can both serve HTTP and initiate wget connections for self-loopback
// scenarios (where the server pod accesses itself through a service).
func createDataplaneServerPod(f *framework.Framework, name, nodeName string, labels map[string]string, hostNetwork bool) *corev1.Pod {
	zero := int64(0)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: f.Namespace.Name,
			Labels:    labels,
		},
		Spec: corev1.PodSpec{
			NodeName:                      nodeName,
			HostNetwork:                   hostNetwork,
			RestartPolicy:                 corev1.RestartPolicyNever,
			TerminationGracePeriodSeconds: &zero,
			Containers: []corev1.Container{
				{
					Name:    "server",
					Image:   images.Alpine,
					Command: []string{"/bin/sh", "-c"},
					Args: []string{
						fmt.Sprintf("mkdir -p /www && echo ok > /www/index.html && httpd -f -p %d -h /www", dataplanePort),
					},
					ImagePullPolicy: corev1.PullIfNotPresent,
				},
			},
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	created, err := f.ClientSet.CoreV1().Pods(f.Namespace.Name).Create(ctx, pod, metav1.CreateOptions{})
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "failed to create server pod %s", name)

	waitCtx, waitCancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer waitCancel()
	err = e2epod.WaitTimeoutForPodRunningInNamespace(waitCtx, f.ClientSet, created.Name, created.Namespace, 2*time.Minute)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "server pod %s did not reach Running state", name)

	// Re-fetch to get PodIP and updated status.
	ctx, cancel = context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	created, err = f.ClientSet.CoreV1().Pods(f.Namespace.Name).Get(ctx, name, metav1.GetOptions{})
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "failed to re-fetch server pod %s", name)
	return created
}

// createDataplaneClientPod creates an Alpine pod that sleeps, for use as a connectivity
// test client.
//
// This does NOT use conncheck.Client because the ConnectionTester manages pod lifecycle
// through Deploy/Stop, while the dataplane tests create and destroy pods per-scenario
// with DeferCleanup. The pod spec is identical to what conncheck creates internally.
func createDataplaneClientPod(f *framework.Framework, name, nodeName string, labels map[string]string, hostNetwork bool) *corev1.Pod {
	zero := int64(0)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: f.Namespace.Name,
			Labels:    labels,
		},
		Spec: corev1.PodSpec{
			NodeName:                      nodeName,
			HostNetwork:                   hostNetwork,
			RestartPolicy:                 corev1.RestartPolicyNever,
			TerminationGracePeriodSeconds: &zero,
			Containers: []corev1.Container{
				{
					Name:            "client",
					Image:           images.Alpine,
					Command:         []string{"/bin/sleep"},
					Args:            []string{"3600"},
					ImagePullPolicy: corev1.PullIfNotPresent,
				},
			},
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	created, err := f.ClientSet.CoreV1().Pods(f.Namespace.Name).Create(ctx, pod, metav1.CreateOptions{})
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "failed to create client pod %s", name)

	waitCtx, waitCancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer waitCancel()
	err = e2epod.WaitTimeoutForPodRunningInNamespace(waitCtx, f.ClientSet, created.Name, created.Namespace, 2*time.Minute)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "client pod %s did not reach Running state", name)

	// Re-fetch to get PodIP and updated status.
	ctx, cancel = context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	created, err = f.ClientSet.CoreV1().Pods(f.Namespace.Name).Get(ctx, name, metav1.GetOptions{})
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "failed to re-fetch client pod %s", name)
	return created
}

// createDataplaneService creates a NodePort service targeting pods with the given selector.
// An optional tweak function can modify the service spec before creation (e.g., to set
// externalTrafficPolicy=Local).
//
// This does NOT use conncheck.Server's service creation because conncheck creates
// ClusterIP services by default and couples service creation to server pod creation.
// The dataplane tests need NodePort services with per-scenario tweaks (e.g.,
// externalTrafficPolicy=Local) and independent lifecycle management.
func createDataplaneService(f *framework.Framework, name string, selector map[string]string, port int, tweak func(*corev1.Service)) *corev1.Service {
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: f.Namespace.Name,
		},
		Spec: corev1.ServiceSpec{
			Type:     corev1.ServiceTypeNodePort,
			Selector: selector,
			Ports: []corev1.ServicePort{
				{
					Port:     int32(port),
					Protocol: corev1.ProtocolTCP,
				},
			},
		},
	}
	if tweak != nil {
		tweak(svc)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	created, err := f.ClientSet.CoreV1().Services(f.Namespace.Name).Create(ctx, svc, metav1.CreateOptions{})
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "failed to create service %s", name)
	return created
}

// waitForServiceEndpoints waits until the named service has at least one ready endpoint.
func waitForServiceEndpoints(f *framework.Framework, svcName string) {
	EventuallyWithOffset(1, func() error {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		ep, err := f.ClientSet.CoreV1().Endpoints(f.Namespace.Name).Get(ctx, svcName, metav1.GetOptions{})
		if err != nil {
			return fmt.Errorf("failed to get endpoints for %s: %w", svcName, err)
		}
		for _, subset := range ep.Subsets {
			if len(subset.Addresses) > 0 {
				return nil
			}
		}
		return fmt.Errorf("no ready addresses in endpoints for %s", svcName)
	}, 30*time.Second, 1*time.Second).Should(Succeed(),
		"timed out waiting for service %s to have ready endpoints", svcName)
}

// expectReachable asserts that srcPod can reach target (host:port) via HTTP.
// Retries for up to 30 seconds to account for policy propagation delays.
//
// Uses conncheck.ExecInPod for kubectl exec. This does not use the ConnectionTester's
// ExpectSuccess/Execute pattern because the dataplane tests check connectivity
// sequentially between policy changes in a multi-step lifecycle.
func expectReachable(srcPod *corev1.Pod, target string) {
	EventuallyWithOffset(1, func() error {
		cmd := fmt.Sprintf("wget -qO- -T 2 http://%s", target)
		_, err := conncheck.ExecInPod(srcPod, "sh", "-c", cmd)
		if err != nil {
			return fmt.Errorf("connection from %s to %s failed: %w", srcPod.Name, target, err)
		}
		return nil
	}, 30*time.Second, 1*time.Second).Should(Succeed(),
		"expected pod %s to reach %s", srcPod.Name, target)
}

// expectNotReachable asserts that srcPod cannot reach target (host:port) via HTTP.
// Retries for up to 30 seconds to account for policy propagation delays.
//
// Uses conncheck.ExecInPod for kubectl exec. See expectReachable for why this does
// not use the ConnectionTester's ExpectFailure/Execute pattern.
func expectNotReachable(srcPod *corev1.Pod, target string) {
	EventuallyWithOffset(1, func() error {
		cmd := fmt.Sprintf("wget -qO- -T 2 http://%s", target)
		_, err := conncheck.ExecInPod(srcPod, "sh", "-c", cmd)
		if err == nil {
			return fmt.Errorf("connection from %s to %s unexpectedly succeeded", srcPod.Name, target)
		}
		return nil
	}, 30*time.Second, 1*time.Second).Should(Succeed(),
		"expected pod %s to NOT reach %s", srcPod.Name, target)
}
