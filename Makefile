# jarvis — deploy convenience wrapper. See docs/deployment.md.
SHELL   := /bin/bash
COMPOSE := docker compose

.DEFAULT_GOAL := help
.PHONY: help env build ssl up down restart logs ps deploy rebuild local local-logs local-down

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

env: ## Create/fill the root .env (interactive). FORCE=1 to re-provision.
	@FORCE=$(FORCE) deploy/deploy.sh env

build: ## Build the app image
	@$(COMPOSE) build

ssl: ## Issue the Let's Encrypt certificate (idempotent)
	@deploy/init-letsencrypt.sh

up: ## Start all services
	@$(COMPOSE) up -d

down: ## Stop all services
	@$(COMPOSE) down

restart: ## Restart all services
	@$(COMPOSE) restart

logs: ## Tail service logs
	@$(COMPOSE) logs -f --tail=100

ps: ## Show service status
	@$(COMPOSE) ps

deploy: ## First-time deploy: env + build + SSL + start everything
	@deploy/deploy.sh all

rebuild: ## Rebuild the app image and restart just the app
	@$(COMPOSE) build app && $(COMPOSE) up -d app

local: ## Local test WITHOUT a domain/TLS — app only on :8080 (bot polling)
	@mkdir -p data/db && $(COMPOSE) -f docker-compose.local.yml up -d --build

local-logs: ## Follow the local app logs
	@$(COMPOSE) -f docker-compose.local.yml logs -f --tail=100

local-down: ## Stop the local app
	@$(COMPOSE) -f docker-compose.local.yml down
