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

import (
	"context"
	"fmt"
	"time"

	//nolint:staticcheck // Ignore ST1001: should not use dot imports
	. "github.com/onsi/ginkgo/v2"
	//nolint:staticcheck // Ignore ST1001: should not use dot imports
	. "github.com/onsi/gomega"
	"github.com/sirupsen/logrus"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/kubernetes/test/e2e/framework"
	e2enode "k8s.io/kubernetes/test/e2e/framework/node"

	"github.com/projectcalico/calico/e2e/pkg/describe"
	"github.com/projectcalico/calico/e2e/pkg/utils"
)

// Dataplane ingress tests verify that Kubernetes NetworkPolicy ingress rules correctly
// identify the source pod when traffic arrives through ClusterIP and NodePort services.
// The test creates two clients (client-a and client-b) and an ingress policy that allows
// only client-b. Depending on the access path and SNAT behavior, the policy may or may
// not correctly identify the source.
//
// Topology (3 nodes required):
//
//	+--------+ +--------+ +----------+
//	| node0  | | node1  | | svcNode  |
//	|        | |        | | +------+ |
//	|        | |        | | |server| |
//	+--------+ +--------+ +----------+
//
// Expectations for iptables mode (kind clusters):
//   - policyWorks:   ingress policy correctly distinguishes client-a from client-b
//   - policyBroken:  SNAT obscures the source IP, so the policy can't distinguish clients
//   - alwaysAllowed: host-to-local-pod traffic bypasses service DNAT entirely
//
// Migrated from tigera/k8s-e2e datapath/workload_ingress.go. Scenarios 13 (localhost
// NodePort), 14, and 15 (external node) are omitted because they require localhost
// binding or SSH access to nodes outside the cluster.
var _ = describe.CalicoDescribe(
	describe.WithTeam(describe.Core),
	describe.WithFeature("Datapath"),
	describe.WithCategory(describe.Networking),
	"Dataplane ingress through services",
	func() {
		f := utils.NewDefaultFramework("dataplane-ingress")

		// Ingress policy expectation modes.
		const (
			// policyWorks means the ingress policy correctly identifies source pods:
			// client-a is blocked, client-b is allowed. For host-networked clients,
			// both clients share the host IP so both are allowed by the ipBlock rule.
			policyWorks = "policyWorks"

			// policyBroken means SNAT obscures the source IP so the ingress policy
			// can't identify the real source: client-b is blocked even though the
			// policy allows it.
			policyBroken = "policyBroken"

			// alwaysAllowed means host-to-local-pod traffic bypasses kube-proxy DNAT
			// entirely, so both clients succeed regardless of ingress policy.
			alwaysAllowed = "alwaysAllowed"
		)

		type testNodeInfo struct {
			name     string
			ip       string
			tunnelIP string
		}

		var (
			node0   testNodeInfo
			node1   testNodeInfo
			svcNode testNodeInfo

			serverLabels map[string]string
			svcClusterIP string
			svcNodePort  int32
		)

		BeforeEach(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			nodes, err := e2enode.GetBoundedReadySchedulableNodes(ctx, f.ClientSet, 3)
			Expect(err).NotTo(HaveOccurred(), "failed to list schedulable nodes")
			nodesInfo := utils.GetNodesInfo(f, nodes, true)
			nodeNames := nodesInfo.GetNames()
			nodeIPs := nodesInfo.GetIPv4s()
			tunnelIPs := nodesInfo.GetTunnelIPs()
			Expect(len(nodeNames)).To(BeNumerically(">=", 3),
				"dataplane ingress tests require at least 3 nodes")

			node0 = testNodeInfo{name: nodeNames[0], ip: nodeIPs[0]}
			node1 = testNodeInfo{name: nodeNames[1], ip: nodeIPs[1]}
			svcNode = testNodeInfo{name: nodeNames[2], ip: nodeIPs[2]}
			if len(tunnelIPs) > 0 {
				node0.tunnelIP = tunnelIPs[0]
				node1.tunnelIP = tunnelIPs[1]
				svcNode.tunnelIP = tunnelIPs[2]
			}

			// Create the server pod and service on svcNode.
			serverLabels = map[string]string{"role": "server", "test": "ingress"}
			serverPod := createDataplaneServerPod(f, "server", svcNode.name, serverLabels, false)
			DeferCleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				if err := f.ClientSet.CoreV1().Pods(f.Namespace.Name).Delete(ctx, serverPod.Name, metav1.DeleteOptions{}); err != nil {
					framework.Logf("WARNING: failed to delete server pod: %v", err)
				}
			})

			svc := createDataplaneService(f, "server-svc", serverLabels, dataplanePort, nil)
			DeferCleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				if err := f.ClientSet.CoreV1().Services(f.Namespace.Name).Delete(ctx, svc.Name, metav1.DeleteOptions{}); err != nil {
					framework.Logf("WARNING: failed to delete service: %v", err)
				}
			})
			waitForServiceEndpoints(f, svc.Name)

			svcClusterIP = svc.Spec.ClusterIP
			svcNodePort = svc.Spec.Ports[0].NodePort

			logrus.Infof("Ingress test setup: svcNode=%s, clusterIP=%s, nodePort=%d",
				svcNode.name, svcClusterIP, svcNodePort)
		})

		// testIngressPolicy creates two clients on srcNode and applies an ingress policy
		// that allows only client-b. It then verifies connectivity based on the expected
		// behavior mode.
		testIngressPolicy := func(srcNode testNodeInfo, srcHostNetworked bool, destTarget string, expectation string) {
			ns := f.Namespace.Name

			// Create client-a and client-b on the source node.
			clientALabels := map[string]string{"pod-name": "client-a"}
			clientBLabels := map[string]string{"pod-name": "client-b"}
			clientA := createDataplaneClientPod(f, "client-a", srcNode.name, clientALabels, srcHostNetworked)
			DeferCleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				if err := f.ClientSet.CoreV1().Pods(ns).Delete(ctx, clientA.Name, metav1.DeleteOptions{}); err != nil {
					framework.Logf("WARNING: failed to delete client-a: %v", err)
				}
			})
			clientB := createDataplaneClientPod(f, "client-b", srcNode.name, clientBLabels, srcHostNetworked)
			DeferCleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				if err := f.ClientSet.CoreV1().Pods(ns).Delete(ctx, clientB.Name, metav1.DeleteOptions{}); err != nil {
					framework.Logf("WARNING: failed to delete client-b: %v", err)
				}
			})

			By("Verifying both clients can reach the server before policy")
			expectReachable(clientA, destTarget)
			expectReachable(clientB, destTarget)

			// Create an ingress policy on the server allowing only client-b.
			// For host-networked clients, use ipBlock with the node IP (and tunnel IP if
			// present) since host-networked pods share the node's IP address. For regular
			// pods, use podSelector to match client-b's labels.
			By("Creating ingress policy allowing only client-b")
			var policy *networkingv1.NetworkPolicy
			if srcHostNetworked {
				from := []networkingv1.NetworkPolicyPeer{
					{IPBlock: &networkingv1.IPBlock{CIDR: srcNode.ip + "/32"}},
				}
				if srcNode.tunnelIP != "" {
					from = append(from, networkingv1.NetworkPolicyPeer{
						IPBlock: &networkingv1.IPBlock{CIDR: srcNode.tunnelIP + "/32"},
					})
				}
				policy = &networkingv1.NetworkPolicy{
					ObjectMeta: metav1.ObjectMeta{
						Name:      "allow-client-b-via-ip",
						Namespace: ns,
					},
					Spec: networkingv1.NetworkPolicySpec{
						PodSelector: metav1.LabelSelector{
							MatchLabels: serverLabels,
						},
						Ingress: []networkingv1.NetworkPolicyIngressRule{{
							From: from,
						}},
					},
				}
			} else {
				policy = &networkingv1.NetworkPolicy{
					ObjectMeta: metav1.ObjectMeta{
						Name:      "allow-client-b-via-selector",
						Namespace: ns,
					},
					Spec: networkingv1.NetworkPolicySpec{
						PodSelector: metav1.LabelSelector{
							MatchLabels: serverLabels,
						},
						Ingress: []networkingv1.NetworkPolicyIngressRule{{
							From: []networkingv1.NetworkPolicyPeer{{
								PodSelector: &metav1.LabelSelector{
									MatchLabels: map[string]string{"pod-name": "client-b"},
								},
							}},
						}},
					},
				}
			}

			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_, err := f.ClientSet.NetworkingV1().NetworkPolicies(ns).Create(ctx, policy, metav1.CreateOptions{})
			Expect(err).NotTo(HaveOccurred(), "failed to create ingress allow policy")
			DeferCleanup(func() {
				if err := f.ClientSet.NetworkingV1().NetworkPolicies(ns).Delete(
					context.Background(), policy.Name, metav1.DeleteOptions{}); err != nil {
					framework.Logf("WARNING: failed to delete ingress policy: %v", err)
				}
			})

			switch expectation {
			case alwaysAllowed:
				// Host-to-local-pod traffic bypasses kube-proxy DNAT entirely,
				// so both clients succeed regardless of the ingress policy.
				By("Verifying both clients are always allowed (host-to-local bypass)")
				expectReachable(clientA, destTarget)
				expectReachable(clientB, destTarget)

			case policyWorks:
				if !srcHostNetworked {
					// Regular pods: client-a should be blocked by the ingress policy.
					By("Verifying client-a is blocked by ingress policy")
					expectNotReachable(clientA, destTarget)
				} else {
					// Host-networked: client-a and client-b share the node IP, so
					// the ipBlock rule allows both.
					By("Verifying client-a is also allowed (shares host IP with client-b)")
					expectReachable(clientA, destTarget)
				}
				By("Verifying client-b is allowed by ingress policy")
				expectReachable(clientB, destTarget)

			case policyBroken:
				if !srcHostNetworked {
					By("Verifying client-a is blocked")
					expectNotReachable(clientA, destTarget)
				}
				// SNAT obscures the source IP, so even client-b is blocked because
				// the ingress policy can't identify it as the allowed source.
				By("Verifying client-b is also blocked (SNAT breaks source identification)")
				expectNotReachable(clientB, destTarget)
			}
		}

		// ===== ClusterIP access =====

		// Pod on the same node as the server accesses it via ClusterIP. No SNAT occurs,
		// so the ingress policy correctly identifies the source pod.
		It("1 ClusterIP from pod on svcNode", func() {
			target := fmt.Sprintf("%s:%d", svcClusterIP, dataplanePort)
			testIngressPolicy(svcNode, false, target, policyWorks)
		})

		// Host-networked pod on the same node as the server accesses it via ClusterIP.
		// Host-to-local-pod traffic bypasses kube-proxy entirely.
		It("2 ClusterIP from host-networked pod on svcNode", func() {
			target := fmt.Sprintf("%s:%d", svcClusterIP, dataplanePort)
			testIngressPolicy(svcNode, true, target, alwaysAllowed)
		})

		// Pod on a different node accesses the server via ClusterIP. No SNAT occurs for
		// ClusterIP traffic, so the ingress policy works correctly.
		It("3 ClusterIP from pod on node1", func() {
			target := fmt.Sprintf("%s:%d", svcClusterIP, dataplanePort)
			testIngressPolicy(node1, false, target, policyWorks)
		})

		// Host-networked pod on a different node accesses the server via ClusterIP.
		// In iptables mode, the source IP is preserved (no SNAT), so policy works.
		It("4 ClusterIP from host-networked pod on node1", func() {
			target := fmt.Sprintf("%s:%d", svcClusterIP, dataplanePort)
			testIngressPolicy(node1, true, target, policyWorks)
		})

		// ===== NodePort on svcNode (same node as server) =====

		// Pod on svcNode accesses the server via svcNode's NodePort. In iptables mode,
		// SNAT occurs but the source is local so policy still works.
		It("5 NodePort(svcNode) from pod on svcNode", func() {
			target := fmt.Sprintf("%s:%d", svcNode.ip, svcNodePort)
			testIngressPolicy(svcNode, false, target, policyWorks)
		})

		// Host-networked pod on svcNode accesses via svcNode's NodePort. Host-to-local
		// traffic bypasses DNAT entirely.
		It("6 NodePort(svcNode) from host-networked pod on svcNode", func() {
			target := fmt.Sprintf("%s:%d", svcNode.ip, svcNodePort)
			testIngressPolicy(svcNode, true, target, alwaysAllowed)
		})

		// Pod on node1 accesses the server via svcNode's NodePort. In iptables mode,
		// SNAT occurs and the source IP is rewritten, breaking ingress policy.
		It("7 NodePort(svcNode) from pod on node1", func() {
			target := fmt.Sprintf("%s:%d", svcNode.ip, svcNodePort)
			testIngressPolicy(node1, false, target, policyBroken)
		})

		// Host-networked pod on node1 accesses via svcNode's NodePort. In iptables mode
		// without IPVS, the source IP is preserved, so policy works.
		It("8 NodePort(svcNode) from host-networked pod on node1", func() {
			target := fmt.Sprintf("%s:%d", svcNode.ip, svcNodePort)
			testIngressPolicy(node1, true, target, policyWorks)
		})

		// ===== NodePort on node1 (not the server's node) =====

		// Pod on node1 accesses via node1's own NodePort. kube-proxy on node1 does DNAT
		// to the server on svcNode, with SNAT that breaks source identification.
		It("9 NodePort(node1) from pod on node1", func() {
			target := fmt.Sprintf("%s:%d", node1.ip, svcNodePort)
			testIngressPolicy(node1, false, target, policyBroken)
		})

		// Host-networked pod on node1 accesses via node1's NodePort. In iptables mode
		// without IPVS, the source IP is preserved, so policy works.
		It("10 NodePort(node1) from host-networked pod on node1", func() {
			target := fmt.Sprintf("%s:%d", node1.ip, svcNodePort)
			testIngressPolicy(node1, true, target, policyWorks)
		})

		// Pod on node0 accesses via node1's NodePort. The traffic traverses node1's
		// kube-proxy which does SNAT, breaking source identification.
		It("11 NodePort(node1) from pod on node0", func() {
			target := fmt.Sprintf("%s:%d", node1.ip, svcNodePort)
			testIngressPolicy(node0, false, target, policyBroken)
		})

		// Host-networked pod on node0 accesses via node1's NodePort. In iptables mode,
		// SNAT on node1 rewrites the source, breaking ingress policy.
		It("12 NodePort(node1) from host-networked pod on node0", func() {
			target := fmt.Sprintf("%s:%d", node1.ip, svcNodePort)
			testIngressPolicy(node0, true, target, policyBroken)
		})
	})
