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

package v1

import (
	"fmt"
	"net/http"

	"github.com/sirupsen/logrus"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/yaml"

	v3 "github.com/projectcalico/api/pkg/apis/projectcalico/v3"

	"github.com/projectcalico/calico/lib/httpmachinery/pkg/apiutil"
	apictx "github.com/projectcalico/calico/lib/httpmachinery/pkg/context"
	whiskerv1 "github.com/projectcalico/calico/whisker-backend/pkg/apis/v1"
)

type policyHdlr struct {
	k8sClient ctrlclient.Reader
	scheme    *runtime.Scheme
}

func NewPolicy(k8sClient ctrlclient.Reader, scheme *runtime.Scheme) *policyHdlr {
	return &policyHdlr{k8sClient: k8sClient, scheme: scheme}
}

func (h *policyHdlr) APIs() []apiutil.Endpoint {
	return []apiutil.Endpoint{
		{
			Method:  http.MethodGet,
			Path:    whiskerv1.PolicyPath,
			Handler: apiutil.NewJSONListHandler(h.Get),
		},
	}
}

func (h *policyHdlr) Get(ctx apictx.Context, params whiskerv1.GetPolicyParams) apiutil.ListResponse[whiskerv1.PolicyResponse] {
	logger := ctx.Logger().WithFields(logrus.Fields{
		"kind": params.Kind, "name": params.Name,
		"namespace": params.Namespace, "tier": params.Tier,
	})
	logger.Debug("Get policy called.")

	if params.Kind == "" || params.Name == "" {
		return apiutil.NewListResponse[whiskerv1.PolicyResponse]().
			SetStatus(http.StatusBadRequest).
			SetError("kind and name are required")
	}

	// Use the name as-is from the flow log — it's already the K8s object name.
	yamlStr, err := h.fetchPolicy(ctx, params.Kind, params.Namespace, params.Name)
	if err != nil {
		logger.WithError(err).Warn("Failed to fetch policy.")
		return apiutil.NewListResponse[whiskerv1.PolicyResponse]().
			SetStatus(http.StatusNotFound).
			SetError(fmt.Sprintf("failed to fetch policy: %v", err))
	}

	resp := whiskerv1.PolicyResponse{
		Kind:      params.Kind,
		Name:      params.Name,
		Namespace: params.Namespace,
		Tier:      params.Tier,
		YAML:      yamlStr,
	}

	return apiutil.NewListResponse[whiskerv1.PolicyResponse]().
		SetStatus(http.StatusOK).
		SetItems([]whiskerv1.PolicyResponse{resp}).
		SetMeta(apiutil.ListMeta{TotalPages: 1})
}

func (h *policyHdlr) fetchPolicy(ctx apictx.Context, kind, namespace, name string) (string, error) {
	var obj ctrlclient.Object
	var key ctrlclient.ObjectKey

	switch kind {
	case "NetworkPolicy", "CalicoNetworkPolicy":
		obj = &v3.NetworkPolicy{}
		key = ctrlclient.ObjectKey{Namespace: namespace, Name: name}

	case "GlobalNetworkPolicy":
		obj = &v3.GlobalNetworkPolicy{}
		key = ctrlclient.ObjectKey{Name: name}

	case "StagedNetworkPolicy":
		obj = &v3.StagedNetworkPolicy{}
		key = ctrlclient.ObjectKey{Namespace: namespace, Name: name}

	case "StagedGlobalNetworkPolicy":
		obj = &v3.StagedGlobalNetworkPolicy{}
		key = ctrlclient.ObjectKey{Name: name}

	case "Profile":
		return "# Profile: default allow/deny\n# Profiles are system-managed.", nil

	default:
		return "", fmt.Errorf("unsupported kind: %s", kind)
	}

	if err := h.k8sClient.Get(ctx, key, obj); err != nil {
		return "", fmt.Errorf("get %s %s: %w", kind, name, err)
	}

	return toCleanYAML(obj, h.scheme)
}

// toCleanYAML converts a runtime.Object to YAML that looks like kubectl output,
// with proper apiVersion/kind/metadata/spec nesting.
func toCleanYAML(obj ctrlclient.Object, scheme *runtime.Scheme) (string, error) {
	// Convert typed object to unstructured to get proper K8s YAML layout
	u := &unstructured.Unstructured{}
	data, err := runtime.DefaultUnstructuredConverter.ToUnstructured(obj)
	if err != nil {
		return "", fmt.Errorf("convert to unstructured: %w", err)
	}
	u.Object = data

	// Set GVK from scheme if not already set
	if u.GetAPIVersion() == "" {
		gvks, _, _ := scheme.ObjectKinds(obj)
		if len(gvks) > 0 {
			u.SetGroupVersionKind(gvks[0])
		}
	}

	// Clean up noisy fields
	delete(u.Object, "status")
	if meta, ok := u.Object["metadata"].(map[string]interface{}); ok {
		delete(meta, "managedFields")
		delete(meta, "creationTimestamp")
		delete(meta, "resourceVersion")
		delete(meta, "uid")
		delete(meta, "generation")
		if annotations, ok := meta["annotations"].(map[string]interface{}); ok {
			delete(annotations, "kubectl.kubernetes.io/last-applied-configuration")
			if len(annotations) == 0 {
				delete(meta, "annotations")
			}
		}
	}

	b, err := yaml.Marshal(u.Object)
	return string(b), err
}

func filterAnnotations(annotations map[string]string) map[string]string {
	if annotations == nil {
		return nil
	}
	filtered := make(map[string]string, len(annotations))
	for k, v := range annotations {
		if k == "kubectl.kubernetes.io/last-applied-configuration" {
			continue
		}
		filtered[k] = v
	}
	if len(filtered) == 0 {
		return nil
	}
	return filtered
}
