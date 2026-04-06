include ../metadata.mk

PACKAGE_NAME = github.com/projectcalico/calico/otel-collector
IMAGE_BUILD_MARKER = otel-collector_container-$(ARCH).created

# Configure variables used by ci/cd common targets from lib.Makefile.
BUILD_IMAGES=otel-collector

###############################################################################
# include ../lib.Makefile
#   Additions to EXTRA_DOCKER_ARGS need to happen before the include since
#   that variable is evaluated when we declare DOCKER_RUN and siblings.
###############################################################################
include ../lib.Makefile

.PHONY: image build clean

image: $(IMAGE_BUILD_MARKER)
build: image

image-all: $(addprefix sub-image-,$(VALIDARCHES))
sub-image-%:
	$(MAKE) image ARCH=$*

# The OCB builder handles all Go compilation inside Docker, so there are no
# pre-built binaries to depend on — just the manifest and Dockerfile.
IMAGE_DEPS = docker/Dockerfile manifest.yaml
$(IMAGE_BUILD_MARKER): $(IMAGE_DEPS) bin/LICENSE
	$(DOCKER_BUILD) --build-arg TARGETARCH=$(ARCH) --build-arg OCB_VERSION=$(OCB_VERSION) -t otel-collector:latest-$(ARCH) -f docker/Dockerfile .
	$(MAKE) retag-build-images-with-registries BUILD_IMAGES=$(BUILD_IMAGES) VALIDARCHES=$(ARCH) IMAGETAG=latest
	touch $@

bin/LICENSE: ../LICENSE.md
	mkdir -p bin
	cp ../LICENSE.md $@

clean:
	rm -rf bin build
	rm -f $(IMAGE_BUILD_MARKER)

###############################################################################
# Release
###############################################################################
cd: image-all cd-common

release-build: .release-$(VERSION).created
.release-$(VERSION).created:
	$(MAKE) clean image-all RELEASE=true
	$(MAKE) retag-build-images-with-registries RELEASE=true IMAGETAG=$(VERSION)
	$(MAKE) retag-build-images-with-registries RELEASE=true IMAGETAG=latest
	touch $@

release-publish: release-prereqs .release-$(VERSION).published
.release-$(VERSION).published:
	$(MAKE) push-images-to-registries push-manifests IMAGETAG=$(VERSION) RELEASE=$(RELEASE) CONFIRM=$(CONFIRM)
	touch $@
