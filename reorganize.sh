#!/bin/bash


# DEFINE SOME CONSTANTS TO USE THROUGHOUT
CORE_PKGS="github.com/projectcalico/calico/internal/core"
DOCKER_CORE="docker/core"

function announce() {
  echo ""
  echo "====== ${1} ======"
  echo ""
}

function cleanup_empty_dirs() {
  announce "Cleaning up empty directories"
  find . -type d -empty -delete -print
}

function move_file_map() {
  local -n filemap=$1
  for srcfile in "${!filemap[@]}";
  do
    newfile=${filemap[$srcfile]}
    echo "$srcfile -> $newfile"
    mkdir -p $(dirname $newfile)
    git mv $srcfile $newfile
  done
}

function run_sed_map() {
  local -n sedmap=$1
  for pattern in "${!sedmap[@]}";
  do
    replace=${sedmap[$pattern]}
    echo "sed $pattern -> $replace"
    find . -name '*.go' | xargs sed -i "s~${pattern}~${replace}~g"
    find . -name 'Makefile' | xargs sed -i "s~${pattern}~${replace}~g"
  done
}

# flatten_pkg_dirs iterates through the new internal/core package structure and removes the now
# unnecessary pkg/ subdirectories lingering from the old file structure.
function flatten_pkg_dirs() {
  announce "Removing legacy pkg/ directories"

  # Find all matching /pkg/*/pkg directories
  find "./internal/core" -type d -path "*/pkg" | while read -r inner_dir; do
    # Get the parent component directory, e.g., /pkg/component
    component_dir="$(dirname "$inner_dir")"

    echo "Processing $inner_dir"

    # Move all contents from /pkg/<component>/pkg/<subdir> to /pkg/<component>/<subdir>
    for subdir in "$inner_dir"/*; do
      if [ -d "$subdir" ]; then
        basename=$(basename "$subdir")
        dest="$component_dir/$basename"

        # Avoid overwriting anything
        if [ -e "$dest" ]; then
          echo "$subdir -> $dest (already exists)"
          exit 1
        else
          mv "$subdir" "$dest"
          echo "Moved $subdir -> $dest"
        fi
      fi
    done

    # Remove the now-empty /pkg/<component>/pkg directory
    rmdir "$inner_dir" && echo "Removed empty dir: $inner_dir"
  done
}

function move_libcalico() {
  announce "Moving libcalico-go"

  mkdir -p ./internal/lib

  # Move all directories in libcalico-go/lib to internal/lib/
  for dir in ./libcalico-go/lib/*; do
    base=$(basename "$dir")
    dest="internal/lib/$base"

    # Move it to the parent directory
    echo "Moving $dir -> $dest"
    mv $dir $dest
  done

  # Clean up remaining libcalico-go files.
  git mv libcalico-go/test internal/lib/test
  git mv libcalico-go/Makefile internal/lib/Makefile # TODO: Remove this.
  git mv libcalico-go/config internal/lib/customresources
  git mv libcalico-go/docs/* docs/
  git mv libcalico-go/patches internal/lib/patches # TODO: Consolidate with customresource package.
  rm -rf ./libcalico-go/

  # TODO: Some packages should be public, instead of going into internal/lib
  # e.g., selectors
}

set -e

# NOTES:
# - Can we get rid of flexvol?
# - Consolidate the various "health" binaries (kube-controllers, goldmane, dikastes)

# #################################################
# Mapping of existing main.go file to new location in reorg.
# #################################################
declare -A cmd_files
cmd_files["kube-controllers/cmd/kube-controllers/main.go"]="cmd/core/kube-controllers/main.go"
cmd_files["guardian/cmd/guardian/main.go"]="cmd/core/guardian/main.go"
cmd_files["key-cert-provisioner/cmd/main.go"]="cmd/core/key-cert-provisioner/main.go"
cmd_files["goldmane/cmd/main.go"]="cmd/core/goldmane/main.go"
cmd_files["felix/cmd/calico-bpf/main.go"]="cmd/core/calico-bpf/main.go"
cmd_files["felix/cmd/calico-felix/calico-felix.go"]="cmd/core/calico-felix/main.go"
cmd_files["node/cmd/mountns/main.go"]="cmd/core/mountns/main.go"
cmd_files["node/cmd/calico-node/main.go"]="cmd/core/calico-node/main.go"
cmd_files["whisker-backend/cmd/main.go"]="cmd/core/whisker-backend/main.go"
cmd_files["pod2daemon/csidriver/main.go"]="cmd/core/csi/main.go"
cmd_files["calicoctl/calicoctl/calicoctl.go"]="cmd/core/calicoctl/main.go"
cmd_files["cni-plugin/cmd/install/install.go"]="cmd/core/cni-plugin/install.go"
cmd_files["cni-plugin/cmd/calico/calico.go"]="cmd/core/cni-plugin/calico.go"
cmd_files["typha/cmd/calico-typha/typha.go"]="cmd/core/typha/main.go"
cmd_files["apiserver/cmd/apiserver/apiserver.go"]="cmd/core/apiserver/main.go"
cmd_files["kube-controllers/cmd/wrapper/wrapper.go"]="cmd/core/wrapper/main.go"
cmd_files["app-policy/cmd/dikastes/dikastes.go"]="cmd/core/dikastes/main.go"

# ##################################################
# TODO - these probably belong in hack/ or elsewhere.
# ##################################################
# cmd_files["test-tools/mocknode/cmd/mocknode/main.go"]
# cmd_files["hack/test/spider/main.go"]
# cmd_files["goldmane/cmd/flowgen/main.go"]
# cmd_files["release/cmd/main.go"]
# felix/docgen
# cmd_files["crypto/fv/main/main.go"]

# #################################################
# TODO - Can we consolidate these?
# #################################################
# cmd_files["goldmane/cmd/health/main.go"]
# dikastes/healthz
# cmd_files["kube-controllers/cmd/check-status/main.go"]="cmd/core/healthz/main.go"

# #################################################
# Declare the directories that will be moved into pkg/
# #################################################
declare -A pkgs
pkgs["apiserver"]="internal/core/apiserver"
pkgs["app-policy"]="internal/core/app-policy"
pkgs["calicoctl"]="internal/core/calicoctl"
pkgs["cni-plugin"]="internal/core/cni-plugin"
pkgs["felix"]="internal/core/felix"
pkgs["goldmane"]="internal/core/goldmane"
pkgs["guardian"]="internal/core/guardian"
pkgs["key-cert-provisioner"]="internal/core/key-cert-provisioner"
pkgs["kube-controllers"]="internal/core/kube-controllers"
pkgs["node"]="internal/core/node"
pkgs["pod2daemon"]="internal/core/pod2daemon"
pkgs["typha"]="internal/core/typha"
pkgs["whisker-backend"]="internal/core/whisker-backend"
pkgs["third_party"]="pkg/third_party"

# #################################################
# Declare packages that belong in hack/
# #################################################
pkgs["test-tools"]="hack/test-tools"
pkgs["process"]="hack/process"

# #################################################
# Declare packages that belong in staging/
# #################################################
pkgs["api"]="staging/api"

# #################################################
# Declare documentation structure.
# #################################################
declare -A docs
docs["CONTRIBUTING.md"]="docs/CONTRIBUTING.md"
docs["DEVELOPER_GUIDE.md"]="docs/DEVELOPER_GUIDE.md"
docs["CONTRIBUTING_DOCS.md"]="docs/CONTRIBUTING_DOCS.md"
docs["SECURITY.md"]="docs/SECURITY.md"

# #################################################
# Declare library directories.
# #################################################
declare -A libs
libs["crypto"]="lib/crypto"

# #################################################
# Declare directories that can just be deleted.
# #################################################
DELETE_DIRS="
calico/
"

# #################################################
# Declare wholesale package replacements
# #################################################
declare -A seds

# Core component packages.
seds["github.com/projectcalico/calico/cni-plugin"]="$CORE_PKGS/cni-plugin"
seds["github.com/projectcalico/calico/felix"]="$CORE_PKGS/felix"
seds["github.com/projectcalico/calico/typha"]="$CORE_PKGS/typha"
seds["github.com/projectcalico/calico/goldmane"]="$CORE_PKGS/goldmane"
seds["github.com/projectcalico/calico/apiserver"]="$CORE_PKGS/apiserver"
seds["github.com/projectcalico/calico/node"]="$CORE_PKGS/node"
seds["github.com/projectcalico/calico/confd"]="$CORE_PKGS/node/confd"
seds["github.com/projectcalico/calico/pod2daemon"]="$CORE_PKGS/pod2daemon"
seds["github.com/projectcalico/calico/whisker-backend"]="$CORE_PKGS/whisker-backend"
seds["github.com/projectcalico/calico/kube-controllers"]="$CORE_PKGS/kube-controllers"
seds["github.com/projectcalico/calico/calicoctl"]="$CORE_PKGS/calicoctl"
seds["github.com/projectcalico/calico/app-policy"]="$CORE_PKGS/app-policy"
seds["github.com/projectcalico/calico/guardian"]="$CORE_PKGS/guardian"
seds["github.com/projectcalico/calico/key-cert-provisioner"]="$CORE_PKGS/key-cert-provisioner"

# Library packages.
seds["github.com/projectcalico/calico/crypto"]="github.com/projectcalico/calico/lib/crypto"
seds["github.com/projectcalico/calico/libcalico-go/lib"]="github.com/projectcalico/calico/internal"
seds["github.com/projectcalico/calico/libcalico-go/config"]="github.com/projectcalico/calico/internal/customresources"

# #################################################
# Declare dockerfiles that should be moved.
# #################################################
declare -A dockerfiles

# Thse dockerfiles are not used for production images - do they belong in the same structure?
# dockerfiles["hack/postrelease/Dockerfile"]
# dockerfiles["pod2daemon/nodeagent/docker/Dockerfile.debug"]=""
# dockerfiles["node/windows-packaging/Dockerfile"]
# dockerfiles["node/calico_test/Dockerfile"]
# dockerfiles["node/workload/Dockerfile"]
# dockerfiles["networking-calico/Dockerfile"]
# dockerfiles["felix/docker-image/Dockerfile"]
# dockerfiles["test-tools/mocknode/Dockerfile"]
# dockerfiles["key-cert-provisioner/test-signer/Dockerfile"]="$DOCKER_CORE/"
# dockerfiles["goldmane/docker/flowgen/Dockerfile"]="$DOCKER_CORE/"

dockerfiles["whisker-backend/docker/Dockerfile"]="$DOCKER_CORE/whisker-backend/Dockerfile"
dockerfiles["guardian/docker-image/guardian/Dockerfile"]="$DOCKER_CORE/guardian/Dockerfile"
dockerfiles["calicoctl/Dockerfile"]="$DOCKER_CORE/calicoctl/Dockerfile"
dockerfiles["pod2daemon/csidriver/Dockerfile"]="$DOCKER_CORE/csi/Dockerfile"
dockerfiles["pod2daemon/node-driver-registrar-docker/Dockerfile"]="$DOCKER_CORE/node-driver-registrar/Dockerfile"
dockerfiles["pod2daemon/flexvol/docker-image/Dockerfile"]="$DOCKER_CORE/flexvol/Dockerfile"
dockerfiles["node/Dockerfile.s390x"]="$DOCKER_CORE/node/Dockerfile.s390x"
dockerfiles["node/Dockerfile-windows"]="$DOCKER_CORE/node/Dockerfile-windows"
dockerfiles["node/Dockerfile.ppc64le"]="$DOCKER_CORE/node/Dockerfile.ppc64le"
dockerfiles["node/Dockerfile.arm64"]="$DOCKER_CORE/node/Dockerfile.arm64"
dockerfiles["node/Dockerfile.amd64"]="$DOCKER_CORE/node/Dockerfile.amd64"
dockerfiles["cni-plugin/Dockerfile-windows"]="$DOCKER_CORE/cni-plugin/Dockerfile-windows"
dockerfiles["cni-plugin/Dockerfile"]="$DOCKER_CORE/cni-plugin/Dockerfile"
dockerfiles["third_party/envoy-proxy/Dockerfile"]="$DOCKER_CORE/third_party/envoy-proxy/Dockerfile"
dockerfiles["third_party/envoy-gateway/Dockerfile"]="$DOCKER_CORE/third_party/envoy-gateway/Dockerfile"
dockerfiles["third_party/envoy-ratelimit/Dockerfile"]="$DOCKER_CORE/third_party/envoy-ratelimit/Dockerfile"
dockerfiles["typha/docker-image/Dockerfile"]="$DOCKER_CORE/typha/Dockerfile"
dockerfiles["whisker/docker-image/Dockerfile"]="$DOCKER_CORE/whisker/Dockerfile"
dockerfiles["kube-controllers/docker-image/flannel-migration/Dockerfile"]="$DOCKER_CORE/flannel-migration/Dockerfile"
dockerfiles["kube-controllers/Dockerfile"]="$DOCKER_CORE/kube-controllers/Dockerfile"
dockerfiles["apiserver/Dockerfile"]="$DOCKER_CORE/apiserver/Dockerfile"
dockerfiles["key-cert-provisioner/Dockerfile"]="$DOCKER_CORE/key-cert-provisioner/Dockerfile"
dockerfiles["app-policy/Dockerfile"]="$DOCKER_CORE/dikastes/Dockerfile"
dockerfiles["goldmane/docker/Dockerfile"]="$DOCKER_CORE/goldmane/Dockerfile"

announce "Deleting outdated files"
for dir in $DELETE_DIRS;
do
  echo "Deleting $dir"
  git rm -fr $dir
done

# Move dockerfiles
announce "Moving Dockerfiles"
move_file_map dockerfiles

# Move cmd/ files into cmd/core/ per mappings above.
announce "Moving cmd/ files into cmd/core/"
move_file_map cmd_files
cleanup_empty_dirs

# Create internal/core/ directories.
announce "Moving pkg/ files into internal/core"
move_file_map pkgs
git mv confd internal/core/node/confd/               # Do this after, since it's moving within another directory.

# Create internal/core/ directories.
announce "Building library packages"
move_file_map libs

# Move docs into place.
announce "Moving docs into place"
move_file_map docs

cleanup_empty_dirs

# ###############################################
# We now have a structure of pkg/<component>/pkg - we can flatten that.
# ###############################################
flatten_pkg_dirs

# ###############################################
# Move libcalico-go into its new home(s).
# ###############################################
move_libcalico

# ###############################################
# Time to get things building.
# ###############################################

# 1. Update go.mod replace statements.
sed -i 's~\.\/api~./staging/api~g' go.mod

# 2. Run wholesale sed commands from above.
run_sed_map seds

# 3. Replace internal/core/<component>/pkg/<dir> with internal/core/<component>/<dir>
find . -name '*.go' | xargs sed -r -i -e 's~(github.com/projectcalico/calico/internal/core.*/)pkg/~\1~g'

# 4. Fix up lib.Makefile references now that things have moved.
find ./internal/core -name Makefile | xargs sed -i 's~include ../lib.Makefile~include ../../../lib.Makefile~g'
find ./internal/core -name Makefile | xargs sed -i 's~include ../metadata.mk~include ../../../metadata.mk~g'
find ./internal/lib -name Makefile | xargs sed -i 's~include ../lib.Makefile~include ../../lib.Makefile~g'
find ./internal/lib -name Makefile | xargs sed -i 's~include ../metadata.mk~include ../../metadata.mk~g'

# Commit what we've got so far.
announce "Committing changes to git"
git add .
# git commit -m "Move projects into new filesystem"

set +e
