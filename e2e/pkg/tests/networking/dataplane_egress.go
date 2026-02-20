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
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/kubernetes/test/e2e/framework"
	e2enode "k8s.io/kubernetes/test/e2e/framework/node"

	"github.com/projectcalico/calico/e2e/pkg/describe"
	"github.com/projectcalico/calico/e2e/pkg/utils"
)

// Dataplane egress tests verify that Kubernetes NetworkPolicy egress rules correctly
// block and allow traffic when a client pod accesses a server through ClusterIP and
// NodePort services. The tests exercise the interaction between kube-proxy DNAT and
// Calico's policy enforcement on the egress path.
//
// Topology:
//
//	+-------------------+ +----------+
//	|       node0       | |  node1   |
//	| +------+ +------+ | | +------+ |
//	| | pod0 | | pod1 | | | | pod2 | |
//	| +------+ +------+ | | +------+ |
//	+-------------------+ +----------+
//
// pod0 is always the client (on node0). When dstPod=0, the server pod IS the client
// (self-loopback). For each scenario, traffic is tested through the 5-step egress
// policy lifecycle: no policy -> deny all -> allow specific -> remove allow -> remove deny.
//
// Migrated from tigera/k8s-e2e datapath/workload_egress.go. ExternalIP scenarios
// (0EL0, 0EC0, 0EL1, 0EC1, 0EC2) are omitted because kind clusters lack routable
// external IPs.
var _ = describe.CalicoDescribe(
	describe.WithTeam(describe.Core),
	describe.WithFeature("Datapath"),
	describe.WithCategory(describe.Networking),
	"Dataplane egress through services",
	func() {
		f := utils.NewDefaultFramework("dataplane-egress")
		var nodeNames []string
		var nodeIPs []string

		BeforeEach(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			nodes, err := e2enode.GetBoundedReadySchedulableNodes(ctx, f.ClientSet, 2)
			Expect(err).NotTo(HaveOccurred(), "failed to list schedulable nodes")
			nodesInfo := utils.GetNodesInfo(f, nodes, true)
			nodeNames = nodesInfo.GetNames()
			nodeIPs = nodesInfo.GetIPv4s()
			Expect(len(nodeNames)).To(BeNumerically(">=", 2),
				"dataplane egress tests require at least 2 nodes")
		})

		type egressScenario struct {
			// dstPod is the destination pod number: 0 and 1 are on node0, 2 is on node1.
			// When dstPod=0, the server pod is also the client (self-loopback).
			dstPod int
			// accessType determines how the client reaches the server:
			//   "clusterIP"     - via the service's ClusterIP
			//   "node0NodePort" - via node0's IP at the service's NodePort
			//   "node1NodePort" - via node1's IP at the service's NodePort
			accessType string
			// svcTweak optionally modifies the service before creation (e.g., set externalTrafficPolicy=Local).
			svcTweak func(*corev1.Service)
			// dstHostNetworked makes the server pod use the host network namespace.
			dstHostNetworked bool
		}

		describeEgressScenario := func(name string, s egressScenario) {
			// Each Context creates a server pod, service, and (for non-self-loopback) a client pod,
			// then runs the 5-step policy lifecycle test.
			Context(name, func() {
				var srcPod *corev1.Pod
				var target string
				var srcLabels map[string]string
				var serverLabels map[string]string

				BeforeEach(func() {
					// Determine which node the server belongs on based on pod number.
					var serverNode string
					if s.dstPod <= 1 {
						serverNode = nodeNames[0]
					} else {
						serverNode = nodeNames[1]
					}

					serverLabels = map[string]string{"role": "server", "test": "egress"}
					serverPod := createDataplaneServerPod(f, "server", serverNode, serverLabels, s.dstHostNetworked)
					DeferCleanup(func() {
						ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
						defer cancel()
						if err := f.ClientSet.CoreV1().Pods(f.Namespace.Name).Delete(ctx, serverPod.Name, metav1.DeleteOptions{}); err != nil {
							framework.Logf("WARNING: failed to delete server pod: %v", err)
						}
					})

					svc := createDataplaneService(f, "server-svc", serverLabels, dataplanePort, s.svcTweak)
					DeferCleanup(func() {
						ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
						defer cancel()
						if err := f.ClientSet.CoreV1().Services(f.Namespace.Name).Delete(ctx, svc.Name, metav1.DeleteOptions{}); err != nil {
							framework.Logf("WARNING: failed to delete service: %v", err)
						}
					})
					waitForServiceEndpoints(f, svc.Name)

					// Build the target URL based on access type.
					switch s.accessType {
					case "clusterIP":
						target = fmt.Sprintf("%s:%d", svc.Spec.ClusterIP, dataplanePort)
					case "node0NodePort":
						target = fmt.Sprintf("%s:%d", nodeIPs[0], svc.Spec.Ports[0].NodePort)
					case "node1NodePort":
						target = fmt.Sprintf("%s:%d", nodeIPs[1], svc.Spec.Ports[0].NodePort)
					default:
						Fail("unknown access type: " + s.accessType)
					}

					if s.dstPod == 0 {
						// Self-loopback: the server pod is also the client. The Alpine image
						// has wget, so the server pod can initiate connections.
						srcPod = serverPod
						srcLabels = serverLabels
					} else {
						// Separate client pod on node0.
						srcLabels = map[string]string{"role": "client", "test": "egress"}
						srcPod = createDataplaneClientPod(f, "client", nodeNames[0], srcLabels, false)
						DeferCleanup(func() {
							ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
							defer cancel()
							if err := f.ClientSet.CoreV1().Pods(f.Namespace.Name).Delete(ctx, srcPod.Name, metav1.DeleteOptions{}); err != nil {
								framework.Logf("WARNING: failed to delete client pod: %v", err)
							}
						})
					}

					logrus.Infof("Egress scenario %s: srcPod=%s on %s, target=%s",
						name, srcPod.Name, srcPod.Spec.NodeName, target)
				})

				// Tests the 5-step egress policy lifecycle:
				//   1. No policy        -> traffic allowed
				//   2. Default deny      -> traffic blocked
				//   3. Allow to server   -> traffic allowed  (skipped for some scenarios)
				//   4. Remove allow      -> traffic blocked  (skipped for some scenarios)
				//   5. Remove deny       -> traffic allowed  (skipped for some scenarios)
				//
				// Steps 3-5 are skipped when the destination is host-networked (egress allow
				// policy for host targets is not implemented) or when access goes through
				// node1's NodePort (NAT happens on the remote node, so the egress allow
				// policy can't match the real destination pod).
				It("should correctly enforce egress NetworkPolicy", func() {
					ctx := context.Background()
					ns := f.Namespace.Name

					By("Step 1: verifying access is allowed with no policy")
					expectReachable(srcPod, target)

					By("Step 2: creating default-deny egress policy")
					denyPolicy := &networkingv1.NetworkPolicy{
						ObjectMeta: metav1.ObjectMeta{
							Name:      "egress-default-deny",
							Namespace: ns,
						},
						Spec: networkingv1.NetworkPolicySpec{
							PodSelector: metav1.LabelSelector{
								MatchLabels: srcLabels,
							},
							PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
						},
					}
					_, err := f.ClientSet.NetworkingV1().NetworkPolicies(ns).Create(ctx, denyPolicy, metav1.CreateOptions{})
					Expect(err).NotTo(HaveOccurred(), "failed to create default-deny egress policy")
					DeferCleanup(func() {
						if err := f.ClientSet.NetworkingV1().NetworkPolicies(ns).Delete(
							context.Background(), denyPolicy.Name, metav1.DeleteOptions{}); err != nil {
							framework.Logf("WARNING: failed to delete deny policy: %v", err)
						}
					})

					expectNotReachable(srcPod, target)

					// Skip allow/remove cycle for scenarios where the allow policy can't work.
					if s.dstHostNetworked {
						By("Skipping allow policy test: not implemented for host-networked destinations")
						return
					}
					if s.accessType == "node1NodePort" {
						By("Skipping allow policy test: NAT happens on remote node")
						return
					}

					By("Step 3: creating target-specific allow egress policy")
					allowPolicy := &networkingv1.NetworkPolicy{
						ObjectMeta: metav1.ObjectMeta{
							Name:      "egress-allow-target",
							Namespace: ns,
						},
						Spec: networkingv1.NetworkPolicySpec{
							PodSelector: metav1.LabelSelector{
								MatchLabels: srcLabels,
							},
							PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
							Egress: []networkingv1.NetworkPolicyEgressRule{{
								To: []networkingv1.NetworkPolicyPeer{{
									PodSelector: &metav1.LabelSelector{
										MatchLabels: serverLabels,
									},
								}},
							}},
						},
					}
					_, err = f.ClientSet.NetworkingV1().NetworkPolicies(ns).Create(ctx, allowPolicy, metav1.CreateOptions{})
					Expect(err).NotTo(HaveOccurred(), "failed to create target-specific allow policy")
					DeferCleanup(func() {
						if err := f.ClientSet.NetworkingV1().NetworkPolicies(ns).Delete(
							context.Background(), allowPolicy.Name, metav1.DeleteOptions{}); err != nil {
							framework.Logf("WARNING: failed to delete allow policy: %v", err)
						}
					})

					expectReachable(srcPod, target)

					By("Step 4: removing target-specific allow policy")
					err = f.ClientSet.NetworkingV1().NetworkPolicies(ns).Delete(ctx, allowPolicy.Name, metav1.DeleteOptions{})
					Expect(err).NotTo(HaveOccurred(), "failed to delete allow policy")

					expectNotReachable(srcPod, target)

					By("Step 5: removing default-deny policy")
					err = f.ClientSet.NetworkingV1().NetworkPolicies(ns).Delete(ctx, denyPolicy.Name, metav1.DeleteOptions{})
					Expect(err).NotTo(HaveOccurred(), "failed to delete deny policy")

					expectReachable(srcPod, target)
				})
			})
		}

		setLocalOnly := func(svc *corev1.Service) {
			svc.Spec.ExternalTrafficPolicy = corev1.ServiceExternalTrafficPolicyLocal
		}

		// ===== ClusterIP scenarios =====

		describeEgressScenario("0C0: pod0 -> ClusterIP -> pod0 (self-loopback)",
			egressScenario{dstPod: 0, accessType: "clusterIP"})

		describeEgressScenario("0C1: pod0 -> ClusterIP -> pod1 (same node)",
			egressScenario{dstPod: 1, accessType: "clusterIP"})

		describeEgressScenario("0C2: pod0 -> ClusterIP -> pod2 (other node)",
			egressScenario{dstPod: 2, accessType: "clusterIP"})

		// ===== NodePort via local node (node0) =====

		describeEgressScenario("0N00: pod0 -> node0 NodePort -> pod0 (self-loopback)",
			egressScenario{dstPod: 0, accessType: "node0NodePort"})

		describeEgressScenario("0N01: pod0 -> node0 NodePort -> pod1 (same node)",
			egressScenario{dstPod: 1, accessType: "node0NodePort"})

		describeEgressScenario("0N02: pod0 -> node0 NodePort -> pod2 (other node)",
			egressScenario{dstPod: 2, accessType: "node0NodePort"})

		// ===== NodePort via remote node (node1) =====
		// Allow policy is skipped for these: NAT happens on node1 so egress policy
		// on node0 can't match the real destination after DNAT.

		describeEgressScenario("0N10: pod0 -> node1 NodePort -> pod0 (self-loopback via remote)",
			egressScenario{dstPod: 0, accessType: "node1NodePort"})

		describeEgressScenario("0N11: pod0 -> node1 NodePort -> pod1 (hairpin via remote)",
			egressScenario{dstPod: 1, accessType: "node1NodePort"})

		describeEgressScenario("0N12: pod0 -> node1 NodePort -> pod2 (remote node)",
			egressScenario{dstPod: 2, accessType: "node1NodePort"})

		// ===== NodePort with externalTrafficPolicy=Local =====

		describeEgressScenario("0L00: pod0 -> node0 NodePort local-only -> pod0 (self-loopback)",
			egressScenario{dstPod: 0, accessType: "node0NodePort", svcTweak: setLocalOnly})

		describeEgressScenario("0L01: pod0 -> node0 NodePort local-only -> pod1 (same node)",
			egressScenario{dstPod: 1, accessType: "node0NodePort", svcTweak: setLocalOnly})

		describeEgressScenario("0L12: pod0 -> node1 NodePort local-only -> pod2 (other node)",
			egressScenario{dstPod: 2, accessType: "node1NodePort", svcTweak: setLocalOnly})

		// ===== Host-networked destinations =====
		// Allow policy is skipped: Calico doesn't implement egress allow policy for
		// host-networked targets (it detects the destination as outside the cluster).

		describeEgressScenario("0H1: pod0 -> ClusterIP -> host-networked pod1 (same node)",
			egressScenario{dstPod: 1, dstHostNetworked: true, accessType: "clusterIP"})

		describeEgressScenario("0H2: pod0 -> ClusterIP -> host-networked pod2 (other node)",
			egressScenario{dstPod: 2, dstHostNetworked: true, accessType: "clusterIP"})
	})
