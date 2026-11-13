// Copyright (c) 2026 Tigera, Inc. All rights reserved.
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

package cronreadback

import (
	"testing"

	. "github.com/onsi/gomega"
)

// liveFixture has one cell that sets the config in its environment, one that
// only inherits the prologue default, one that sets no config, and a DAG that
// passes it as a task argument.
const liveFixture = `{
  "metadata": {"name": "e2e-bpf-master"},
  "spec": {"workflowSpec": {"templates": [
    {"name": "arm64-smoke-tests-aks-arm64-stable-1-azure-",
     "container": {"env": [
       {"name": "PROVISIONER", "value": "azr-aks"},
       {"name": "E2E_TEST_CONFIG", "value": "e2e/config/bpf/aks-bpf-nobgp.yaml"}],
      "args": ["export E2E_TEST_CONFIG=\"${E2E_TEST_CONFIG:-e2e/config/bpf/bpf.yaml}\"\n"]}},
    {"name": "wireguard",
     "script": {"source": "export FUNCTIONAL_AREA=\"${FUNCTIONAL_AREA:-bpf.yml}\"\nexport E2E_TEST_CONFIG=\"${E2E_TEST_CONFIG:-e2e/config/bpf/bpf.yaml}\"\n"}},
    {"name": "no-config",
     "container": {"env": [{"name": "PROVISIONER", "value": "gcp-kubeadm"}]}},
    {"name": "entrypoint",
     "dag": {"tasks": [
       {"name": "from-task", "template": "shared",
        "arguments": {"parameters": [{"name": "E2E_TEST_CONFIG", "value": "e2e/config/a.yaml"}]}},
       {"name": "no-arg", "template": "shared",
        "arguments": {"parameters": [{"name": "OTHER", "value": "x"}]}}]}}
  ]}}
}`

func TestParseLive(t *testing.T) {
	RegisterTestingT(t)

	live, err := ParseLive([]byte(liveFixture))
	Expect(err).NotTo(HaveOccurred())
	Expect(live.Name).To(Equal("e2e-bpf-master"))

	// The environment wins over a prologue default in the same template.
	Expect(live.Cells).To(HaveKeyWithValue("arm64-smoke-tests-aks-arm64-stable-1-azure-", "e2e/config/bpf/aks-bpf-nobgp.yaml"))
	Expect(live.Cells).To(HaveKeyWithValue("wireguard", "e2e/config/bpf/bpf.yaml"))
	Expect(live.Cells).To(HaveKeyWithValue("from-task", "e2e/config/a.yaml"))
}

func TestParseLiveSkipsCellsWithoutConfig(t *testing.T) {
	RegisterTestingT(t)

	live, err := ParseLive([]byte(liveFixture))
	Expect(err).NotTo(HaveOccurred())

	Expect(live.Cells).NotTo(HaveKey("no-config"))
	Expect(live.Cells).NotTo(HaveKey("no-arg"))
	Expect(live.Cells).NotTo(HaveKey("entrypoint"))
	Expect(live.Cells).To(HaveLen(3))
}

func TestParseLiveRejectsBadJSON(t *testing.T) {
	RegisterTestingT(t)

	_, err := ParseLive([]byte("not json"))
	Expect(err).To(HaveOccurred())
}
