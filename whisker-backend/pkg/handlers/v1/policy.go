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
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/yaml"

	v3 "github.com/projectcalico/api/pkg/apis/projectcalico/v3"

	"github.com/projectcalico/calico/lib/httpmachinery/pkg/apiutil"
	apictx "github.com/projectcalico/calico/lib/httpmachinery/pkg/context"
	whiskerv1 "github.com/projectcalico/calico/whisker-backend/pkg/apis/v1"
)

type policyHdlr struct {
	k8sClient ctrlclient.Reader
}

func NewPolicy(k8sClient ctrlclient.Reader) *policyHdlr {
	return &policyHdlr{k8sClient: k8sClient}
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

	// For tiered namespaced policies, the K8s name is "tier.name".
	// Global policies don't use the tier prefix in their K8s name.
	qualifiedName := params.Name
	isNamespaced := params.Kind == "NetworkPolicy" || params.Kind == "CalicoNetworkPolicy" ||
		params.Kind == "StagedNetworkPolicy"
	if isNamespaced && params.Tier != "" && params.Tier != "default" {
		prefix := params.Tier + "."
		if len(params.Name) <= len(prefix) || params.Name[:len(prefix)] != prefix {
			qualifiedName = prefix + params.Name
		}
	}

	yamlStr, err := h.fetchPolicy(ctx, params.Kind, params.Namespace, qualifiedName)
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
	switch kind {
	case "NetworkPolicy", "CalicoNetworkPolicy":
		pol := &v3.NetworkPolicy{}
		if err := h.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: namespace, Name: name}, pol); err != nil {
			return "", fmt.Errorf("get NetworkPolicy %s/%s: %w", namespace, name, err)
		}
		pol.ManagedFields = nil
		pol.Annotations = filterAnnotations(pol.Annotations)
		b, err := yaml.Marshal(pol)
		return string(b), err

	case "GlobalNetworkPolicy":
		pol := &v3.GlobalNetworkPolicy{}
		if err := h.k8sClient.Get(ctx, ctrlclient.ObjectKey{Name: name}, pol); err != nil {
			return "", fmt.Errorf("get GlobalNetworkPolicy %s: %w", name, err)
		}
		pol.ManagedFields = nil
		pol.Annotations = filterAnnotations(pol.Annotations)
		b, err := yaml.Marshal(pol)
		return string(b), err

	case "StagedNetworkPolicy":
		pol := &v3.StagedNetworkPolicy{}
		if err := h.k8sClient.Get(ctx, ctrlclient.ObjectKey{Namespace: namespace, Name: name}, pol); err != nil {
			return "", fmt.Errorf("get StagedNetworkPolicy %s/%s: %w", namespace, name, err)
		}
		pol.ManagedFields = nil
		pol.Annotations = filterAnnotations(pol.Annotations)
		b, err := yaml.Marshal(pol)
		return string(b), err

	case "StagedGlobalNetworkPolicy":
		pol := &v3.StagedGlobalNetworkPolicy{}
		if err := h.k8sClient.Get(ctx, ctrlclient.ObjectKey{Name: name}, pol); err != nil {
			return "", fmt.Errorf("get StagedGlobalNetworkPolicy %s: %w", name, err)
		}
		pol.ManagedFields = nil
		pol.Annotations = filterAnnotations(pol.Annotations)
		b, err := yaml.Marshal(pol)
		return string(b), err

	case "Profile":
		return "# Profile: default allow/deny\n# Profiles are system-managed.", nil

	default:
		return "", fmt.Errorf("unsupported kind: %s", kind)
	}
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
