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

package app

import (
	"context"

	"github.com/sirupsen/logrus"
	"google.golang.org/grpc"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	v3 "github.com/projectcalico/api/pkg/apis/projectcalico/v3"

	"github.com/projectcalico/calico/goldmane/pkg/client"
	"github.com/projectcalico/calico/lib/httpmachinery/pkg/apiutil"
	"github.com/projectcalico/calico/lib/httpmachinery/pkg/server"
	gorillaadpt "github.com/projectcalico/calico/lib/httpmachinery/pkg/server/adaptors/gorilla"
	"github.com/projectcalico/calico/whisker-backend/pkg/config"
	v1 "github.com/projectcalico/calico/whisker-backend/pkg/handlers/v1"
)

func Run(ctx context.Context, cfg *config.Config) {
	logrus.WithField("cfg", cfg.String()).Info("Applying configuration...")

	// Generate credentials for the Goldmane client.
	creds, err := client.ClientCredentials(cfg.TLSCertPath, cfg.TLSKeyPath, cfg.CACertPath)
	if err != nil {
		logrus.WithError(err).Fatal("Failed to create goldmane TLS credentials.")
	}

	gmCli, err := client.NewFlowsAPIClient(cfg.GoldmaneHost, grpc.WithTransportCredentials(creds))
	if err != nil {
		logrus.WithError(err).Fatal("Failed to create goldmane client.")
	}

	opts := []server.Option{
		server.WithAddr(cfg.HostAddr()),
	}

	// TODO maybe we can push getting tls files to the common http utilities package?
	if cfg.TLSKeyPath != "" && cfg.TLSCertPath != "" {
		opts = append(opts, server.WithTLSFiles(cfg.TLSCertPath, cfg.TLSKeyPath))
	}

	// Create a controller-runtime client for fetching policy objects.
	scheme := runtime.NewScheme()
	if err := v3.AddToScheme(scheme); err != nil {
		logrus.WithError(err).Fatal("Failed to add Calico v3 scheme.")
	}

	k8sCfg, err := ctrl.GetConfig()
	if err != nil {
		logrus.WithError(err).Warn("Failed to get in-cluster K8s config, policy endpoint will be unavailable.")
	}

	var allAPIs []apiutil.Endpoint

	flowsAPI := v1.NewFlows(gmCli)
	allAPIs = append(allAPIs, flowsAPI.APIs()...)

	if k8sCfg != nil {
		k8sClient, err := ctrlclient.New(k8sCfg, ctrlclient.Options{Scheme: scheme})
		if err != nil {
			logrus.WithError(err).Warn("Failed to create K8s client, policy endpoint will be unavailable.")
		} else {
			policyAPI := v1.NewPolicy(k8sClient)
			allAPIs = append(allAPIs, policyAPI.APIs()...)
			logrus.Info("Policy API endpoint enabled.")
		}
	}

	srv, err := server.NewHTTPServer(
		gorillaadpt.NewRouter(),
		allAPIs,
		opts...,
	)
	if err != nil {
		logrus.WithError(err).Fatal("Failed to create server.")
	}

	// TODO Should we require that this is TLS? It will be in the same pod as nginx.
	logrus.Infof("Listening on %s.", cfg.HostAddr())
	if err := srv.ListenAndServe(ctx); err != nil {
		logrus.WithError(err).Fatal("Failed to start server.")
	}

	if err := srv.WaitForShutdown(); err != nil {
		logrus.WithError(err).Fatal("An unexpected error occurred while waiting for shutdown.")
	}
}
