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
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

const envConfig = "E2E_TEST_CONFIG"

// LiveCron is a CronWorkflow read back from ArgoCI, reduced to what the check
// compares.
type LiveCron struct {
	// Name is the CronWorkflow's name.
	Name string

	// Cells maps each expanded step to the E2E_TEST_CONFIG it runs with.
	Cells map[string]string
}

// NameValue is one entry of an env or parameter list.
type NameValue struct {
	Name  string
	Value string
}

// prologueDefault matches a `export E2E_TEST_CONFIG="${E2E_TEST_CONFIG:-value}"`
// line, which is how a file's globalPrologue reaches the live object.
var prologueDefault = regexp.MustCompile(`(?m)^\s*export\s+E2E_TEST_CONFIG="?\$\{E2E_TEST_CONFIG:-(.*?)\}"?\s*$`)

// ParseLive reduces the JSON of one CronWorkflow to its cells. A template is a
// cell when its environment names E2E_TEST_CONFIG, or when its script text
// carries the prologue default. A DAG task is a cell when its arguments do.
// The expansion's exact shape is not documented, so this walks each template
// rather than reading fixed paths.
func ParseLive(data []byte) (LiveCron, error) {
	var doc map[string]any
	if err := json.Unmarshal(data, &doc); err != nil {
		return LiveCron{}, fmt.Errorf("decoding CronWorkflow: %w", err)
	}
	live := LiveCron{Cells: map[string]string{}}
	live.Name, _ = lookup(doc, "metadata", "name").(string)

	templates, _ := lookup(doc, "spec", "workflowSpec", "templates").([]any)
	for _, raw := range templates {
		tmpl, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name, _ := tmpl["name"].(string)
		if dag, ok := tmpl["dag"].(map[string]any); ok {
			addTaskCells(live.Cells, dag)
			continue
		}
		if config, ok := templateConfig(tmpl); ok && name != "" {
			live.Cells[normalizeName(name)] = config
		}
	}
	return live, nil
}

// addTaskCells records the DAG tasks that pass E2E_TEST_CONFIG as an argument.
func addTaskCells(cells map[string]string, dag map[string]any) {
	tasks, _ := dag["tasks"].([]any)
	for _, raw := range tasks {
		task, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name, _ := task["name"].(string)
		params, _ := lookup(task, "arguments", "parameters").([]any)
		for _, p := range nameValuePairs(params) {
			if p.Name == envConfig && name != "" {
				cells[normalizeName(name)] = p.Value
			}
		}
	}
}

// templateConfig returns the E2E_TEST_CONFIG a template runs with: its
// environment first, as the shell would resolve it, then the prologue default
// in its script text.
func templateConfig(tmpl map[string]any) (string, bool) {
	var texts []string
	var config string
	var found bool
	walk(tmpl, func(node any) {
		switch v := node.(type) {
		case []any:
			for _, p := range nameValuePairs(v) {
				if p.Name == envConfig && !found {
					config, found = p.Value, true
				}
			}
		case string:
			texts = append(texts, v)
		}
	})
	if found {
		return config, true
	}
	for _, text := range texts {
		if m := prologueDefault.FindStringSubmatch(text); m != nil {
			return strings.Trim(m[1], `"`), true
		}
	}
	return "", false
}

// nameValuePairs returns the entries of a list that are objects with a string
// name and a string value, which is the shape of both env and parameters.
func nameValuePairs(list []any) []NameValue {
	var out []NameValue
	for _, raw := range list {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name, nameOK := m["name"].(string)
		value, valueOK := m["value"].(string)
		if nameOK && valueOK {
			out = append(out, NameValue{Name: name, Value: value})
		}
	}
	return out
}

// walk calls visit on every node of a decoded JSON tree.
func walk(node any, visit func(any)) {
	visit(node)
	switch v := node.(type) {
	case map[string]any:
		for _, child := range v {
			walk(child, visit)
		}
	case []any:
		for _, child := range v {
			walk(child, visit)
		}
	}
}

// lookup follows a path of object keys, returning nil when any step is absent.
func lookup(node any, path ...string) any {
	for _, key := range path {
		m, ok := node.(map[string]any)
		if !ok {
			return nil
		}
		node = m[key]
	}
	return node
}
