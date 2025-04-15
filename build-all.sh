#!/bin/bash
#
# Usage:
#  ./build-all.sh [unit]
#
#  [unit]: Optional unit to build, e.g., ./cmd/<unit>

# Extra CLI args.
unit=$1

# Determine files to build.
main_files=$(find ./cmd/$unit -name "*.go")

function announce() {
  echo "===> $1"
}

# Declare which binaaries require CGO.
declare -A cgo
cgo["./cmd/core/mountns/main.go"]="1"
# cgo["./cmd/core/calico-node/main.go"]="1"   # TODO: Relies on built BPF code.
# cgo["./cmd/core/calico-felix/main.go"]="1"

# TODO: Specify these. We should be able to use a consistent set by making a common flags package.
LDFLAGS="-X main.VERSION=TODO"

for f in $main_files; do
  # Get the base directory, which will decide where to place the binary.
  d=$(dirname $f | sed s~cmd~bin/${ARCH:-amd64}~g)
  ff=$(basename $f | sed s/.go$//g)
  announce "Building $d/$ff"
  mkdir -p $d

  if [[ -v cgo[$f] ]]; then
    CGO_ENABLED=1 go build -o $d/$ff -v -buildvcs=false -ldflags="$LDFLAGS" $f
  else
    CGO_ENABLED=0 go build -o $d/$ff -v -buildvcs=false -ldflags="$LDFLAGS" $f
  fi
done
