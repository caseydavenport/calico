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
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/sirupsen/logrus"
)

const (
	// DefaultServer is the ArgoCI Argo server.
	DefaultServer = "https://argoci.dev.calicocloud.io"

	// DefaultNamespace is the namespace every cron lives in, whatever its repo.
	DefaultNamespace = "argoci"

	// RepoLabel is the label ArgoCI stamps on a cron with its repo's name.
	RepoLabel = "CI_GIT_REPO_NAME"
)

// ErrNotFound is returned when the Argo server has no such CronWorkflow.
var ErrNotFound = errors.New("cron workflow not found")

// ErrUnauthorized is returned when the Argo server rejects the token.
var ErrUnauthorized = errors.New("argo server rejected the token")

// Client reads CronWorkflows from the Argo server's REST API. It only issues
// GET requests.
type Client struct {
	server    string
	namespace string
	token     string
	http      *http.Client
}

// NewClient returns a client for the Argo server at server, which may be a bare
// host:port as the argo CLI's ARGO_SERVER is. The token is the Authorization
// header value or a bare bearer token, as the argo CLI's ARGO_TOKEN is.
func NewClient(server, namespace, token string) *Client {
	if !strings.Contains(server, "://") {
		server = "https://" + server
	}
	if token != "" && !strings.HasPrefix(token, "Bearer ") && !strings.HasPrefix(token, "Basic ") {
		token = "Bearer " + token
	}
	return &Client{
		server:    strings.TrimSuffix(server, "/"),
		namespace: namespace,
		token:     token,
		http:      &http.Client{Timeout: 60 * time.Second},
	}
}

// GetRaw returns the JSON of the named CronWorkflow.
func (c *Client) GetRaw(ctx context.Context, name string) ([]byte, error) {
	path := fmt.Sprintf("/api/v1/cron-workflows/%s/%s", url.PathEscape(c.namespace), url.PathEscape(name))
	return c.get(ctx, path, nil)
}

// Get returns the named CronWorkflow, or ErrNotFound.
func (c *Client) Get(ctx context.Context, name string) (LiveCron, error) {
	data, err := c.GetRaw(ctx, name)
	if err != nil {
		return LiveCron{}, err
	}
	live, err := ParseLive(data)
	if err != nil {
		return LiveCron{}, fmt.Errorf("%s: %w", name, err)
	}
	live.Name = name
	return live, nil
}

// ListNames returns the names of the CronWorkflows that carry repo's name in
// their repo label.
func (c *Client) ListNames(ctx context.Context, repo string) ([]string, error) {
	query := url.Values{"listOptions.labelSelector": {RepoLabel + "=" + repo}}
	data, err := c.get(ctx, fmt.Sprintf("/api/v1/cron-workflows/%s", url.PathEscape(c.namespace)), query)
	if err != nil {
		return nil, err
	}
	return ParseNames(data)
}

// CronList is the part of an Argo CronWorkflow list response the check reads.
type CronList struct {
	Items []ListedCron `json:"items"`
}

// ListedCron is the metadata of one listed CronWorkflow.
type ListedCron struct {
	Metadata ListedCronMeta `json:"metadata"`
}

// ListedCronMeta is the name of one listed CronWorkflow.
type ListedCronMeta struct {
	Name string `json:"name"`
}

// ParseNames returns the names in an Argo CronWorkflow list response.
func ParseNames(data []byte) ([]string, error) {
	var list CronList
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, fmt.Errorf("decoding CronWorkflow list: %w", err)
	}
	names := make([]string, 0, len(list.Items))
	for _, item := range list.Items {
		names = append(names, item.Metadata.Name)
	}
	return names, nil
}

// get issues one authenticated GET and maps the statuses a caller acts on.
func (c *Client) get(ctx context.Context, path string, query url.Values) ([]byte, error) {
	u := c.server + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	if c.token != "" {
		req.Header.Set("Authorization", c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			logrus.WithError(err).Debug("Closing the response body failed")
		}
	}()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	switch resp.StatusCode {
	case http.StatusOK:
		return body, nil
	case http.StatusNotFound:
		return nil, ErrNotFound
	case http.StatusUnauthorized, http.StatusForbidden:
		return nil, fmt.Errorf("%w (HTTP %d): %s", ErrUnauthorized, resp.StatusCode, strings.TrimSpace(string(body)))
	default:
		return nil, fmt.Errorf("GET %s: HTTP %d: %s", path, resp.StatusCode, strings.TrimSpace(string(body)))
	}
}

// ReadLive fetches every expected cron and the names of the repo's live crons
// on branch.
func ReadLive(ctx context.Context, c *Client, expected []ExpectedCron, repo, branch string) (LiveSet, error) {
	live := LiveSet{Crons: map[string]LiveCron{}}
	for _, want := range expected {
		cron, err := c.Get(ctx, want.Name)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return LiveSet{}, err
		}
		live.Crons[want.Name] = cron
	}

	names, err := c.ListNames(ctx, repo)
	if err != nil {
		return LiveSet{}, err
	}
	suffix := "-" + sanitizeBranch(branch)
	for _, name := range names {
		if strings.HasSuffix(name, suffix) {
			live.Names = append(live.Names, name)
		}
	}
	return live, nil
}
