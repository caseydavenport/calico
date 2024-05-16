package commands

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/docopt/docopt-go"
	"github.com/projectcalico/calico/calicoctl/calicoctl/commands/constants"
	"github.com/projectcalico/calico/calicoctl/calicoctl/util"
	"github.com/sirupsen/logrus"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/clientcmd"

	v1 "github.com/tigera/operator/api/v1"

	"sigs.k8s.io/controller-runtime/pkg/client"
)

func Install(args []string) error {
	doc := constants.DatastoreIntro + `Usage:
  <BINARY_NAME> install |
                [--context=<context>] [--allow-version-mismatch]

Examples:
  <BINARY_NAME> install

Options:
  -h --help                    Show this screen.
     --context=<context>       The name of the kubeconfig context to use.
     --allow-version-mismatch  Allow client and cluster versions mismatch.

Description:
	TODO
`
	// Replace all instances of BINARY_NAME with the name of the binary.
	name, _ := util.NameAndDescription()
	doc = strings.ReplaceAll(doc, "<BINARY_NAME>", name)

	// -a option Backward compatibility
	for k, v := range args {
		if v == "-a" {
			args[k] = "-A"
		}
	}

	parsedArgs, err := docopt.ParseArgs(doc, args, "")
	if err != nil {
		return fmt.Errorf("Invalid option: 'calicoctl %s'. Use flag '--help' to read about a specific subcommand.", strings.Join(args, " "))
	}
	if len(parsedArgs) == 0 {
		return nil
	}
	if context := parsedArgs["--context"]; context != nil {
		os.Setenv("K8S_CURRENT_CONTEXT", context.(string))
	}

	// Create a config.
	scheme := runtime.NewScheme()
	if err = v1.AddToScheme(scheme); err != nil {
		logrus.WithError(err).Fatal("Failed to configure controller runtime client")
	}
	v1.SchemeBuilder.Register(&v1.TigeraStatus{}, &v1.TigeraStatusList{})

	config, err := clientcmd.BuildConfigFromFlags("", os.Getenv("KUBECONFIG"))
	if err != nil {
		return err
	}
	c, err := client.NewWithWatch(config, client.Options{Scheme: scheme})
	if err != nil {
		return err
	}

	if err := install(c); err != nil {
		return err
	}

	return nil
}

func install(c client.Client) error {
	operatorURL := "https://docs.projectcalico.org/manifests/tigera-operator.yaml"
	resourcesURL := "https://docs.projectcalico.org/manifests/custom-resources.yaml"

	// Test that Calico isn't already installed.
	objs := v1.TigeraStatusList{}
	if err := c.List(context.TODO(), &objs); err != nil {
		if !errors.IsNotFound(err) {
			logrus.WithError(err).Error("Failed to list TigeraStatus")
			return err
		}
	}
	if len(objs.Items) > 0 {
		logrus.Error("Calico is already installed. Did you mean 'calicoctl upgrade'?")
		return nil
	}

	// Run a kubectl create onf the manifestURL
	cmd := exec.Command("kubectl", "create", "-f", operatorURL)
	cmd.Env = os.Environ()
	logrus.Info("Running command: ", cmd.String())
	if out, err := cmd.CombinedOutput(); err != nil {
		logrus.WithError(err).Error(string(out))
		return err
	}

	cmd = exec.Command("kubectl", "create", "-f", resourcesURL)
	cmd.Env = os.Environ()
	logrus.Info("Running command: ", cmd.String())
	if out, err := cmd.CombinedOutput(); err != nil {
		logrus.WithError(err).Error(string(out))
		return err
	}

	// Wait for tigera status to all be ready.
	logrus.Info("Waiting for Calico to be ready")
	for {
		objs := v1.TigeraStatusList{}
		if err := c.List(context.TODO(), &objs); err != nil {
			logrus.WithError(err).Error("Failed to list TigeraStatus")
			return err
		}
		numReady := 0
		for _, obj := range objs.Items {
			for _, condition := range obj.Status.Conditions {
				if condition.Type != v1.ComponentAvailable {
					continue
				}
				if condition.Status != v1.ConditionTrue {
					logrus.Debugf("Waiting for TigeraStatus '%s' to be ready", obj.Name)
					continue
				}
				numReady++
			}
		}
		if len(objs.Items) > 0 && numReady == len(objs.Items) {
			// All components are ready.
			break
		}
		time.Sleep(1 * time.Second)
	}

	logrus.Info("Calico installation complete!")
	return nil
}
