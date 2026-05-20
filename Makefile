.PHONY: image image-if-needed image-push watch pause pretrain pretrain-light campaign status memory trace reset clean test typecheck help

IMAGE_TAG ?= catallaxy-agent:latest
PI_VERSION ?= 0.70.6

help:
	@echo "Targets:"
	@echo "  image         build the agent container image (multi-arch if buildx)"
	@echo "  image-push    build and push to registry"
	@echo "  watch         start the orchestrator watcher, or attach to its live log if already running"
	@echo "  pause         stop watcher/campaign/reopen loops and active containers without wiping state"
	@echo "  pretrain      run the full pretrain bootstrap (stop watcher first)"
	@echo "  pretrain-light run smaller existing-repo pretrain tasks"
	@echo "  campaign      run the campaign task producer (optional args: --once)"
	@echo "  status        summarize live market / agents / review queue"
	@echo "  memory        show memory (all agents by default; AGENT=alice, optional KEY=core.md)"
	@echo "  trace         show per-task timeline (TASK=task-001)"
	@echo "  reset         wipe runtime state (market/, ledgers, sockets, containers)"
	@echo "  clean         reset + remove the agent image and bridge network"
	@echo "  test          run unit tests"
	@echo "  typecheck     run TypeScript typecheck"

image:
	docker/build.sh

image-if-needed:
	@docker image inspect $(IMAGE_TAG) >/dev/null 2>&1 || $(MAKE) image

image-push:
	docker/build.sh --push

watch:
	@docker image inspect $(IMAGE_TAG) >/dev/null 2>&1 || $(MAKE) image
	bun orchestrator/watch-live.ts

pause:
	bun orchestrator/pause.ts

pretrain:
	@docker image inspect $(IMAGE_TAG) >/dev/null 2>&1 || $(MAKE) image
	bun orchestrator/pretrain.ts $(filter-out $@,$(MAKECMDGOALS))

pretrain-light:
	@docker image inspect $(IMAGE_TAG) >/dev/null 2>&1 || $(MAKE) image
	bun orchestrator/pretrain.ts --light $(filter-out $@,$(MAKECMDGOALS))

campaign:
	bun orchestrator/campaign.ts $(filter-out $@,$(MAKECMDGOALS))

status:
	bun orchestrator/status.ts

memory:
	bun orchestrator/memory.ts $(if $(AGENT),$(AGENT),--all) $(KEY)

trace:
ifndef TASK
	$(error TASK required: make trace TASK=task-001)
endif
	bun orchestrator/trace.ts $(TASK)

reset:
	bun orchestrator/reset.ts

clean: reset
	-docker rm -f $(shell docker ps -a --filter "name=catallaxy-agent-" --format "{{.ID}}") 2>/dev/null || true
	-docker network rm catallaxy-agents 2>/dev/null || true
	-docker rmi $(IMAGE_TAG) 2>/dev/null || true

test:
	bun test

typecheck:
	bun run typecheck

# Catch-all so extra target-style args (e.g. `make campaign -- --once`) don't error.
%:
	@:
