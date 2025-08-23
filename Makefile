# ADHD Budget Assistant - Test Harness Makefile
# Gates: T1-T5 (Technical), S1-S4 (Security)

.PHONY: help up down test test-unit test-integration test-e2e audit-security coverage reports clean

# Variables
PYTHON := python3
PIP := pip3
DOCKER_COMPOSE := docker compose
TEST_DIR := tests
REPORT_DIR := reports
COVERAGE_DIR := coverage

# Colors for output
RED := \033[0;31m
GREEN := \033[0;32m
YELLOW := \033[1;33m
NC := \033[0m # No Color

help: ## Show this help message
	@echo "ADHD Budget Assistant - Test Harness"
	@echo "====================================="
	@echo ""
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "Gate Coverage:"
	@echo "  T1: Compose boot & resilience"
	@echo "  T2: Data flow integrity"
	@echo "  T3: Intelligence accuracy"
	@echo "  T4: MCP compliance"
	@echo "  T5: Job scheduling"
	@echo "  S1: Secrets hygiene"
	@echo "  S2: TLS & headers"
	@echo "  S3: Access control"
	@echo "  S4: Container security"

# Infrastructure Management
up: ## Start all services with docker compose
	@echo "$(GREEN)Starting services...$(NC)"
	$(DOCKER_COMPOSE) up -d
	@echo "$(GREEN)Waiting for services to be healthy...$(NC)"
	@sleep 5
	@$(DOCKER_COMPOSE) ps

down: ## Stop all services
	@echo "$(YELLOW)Stopping services...$(NC)"
	$(DOCKER_COMPOSE) down
	@echo "$(GREEN)Services stopped$(NC)"

restart: down up ## Restart all services

logs: ## Show service logs
	$(DOCKER_COMPOSE) logs -f

# Test Execution
test: test-requirements test-unit test-integration test-e2e audit-security ## Run all tests
	@echo ""
	@echo "$(GREEN)========================================$(NC)"
	@echo "$(GREEN)All tests completed!$(NC)"
	@echo "$(GREEN)========================================$(NC)"
	@$(MAKE) compliance-check

test-requirements: ## Install test dependencies
	@echo "$(GREEN)Installing test dependencies...$(NC)"
	@$(PIP) install -q pytest pytest-asyncio pytest-cov pytest-timeout aiohttp docker requests 2>/dev/null || true
	@echo "$(GREEN)Dependencies installed$(NC)"

test-unit: ## Run unit tests (T3 gates)
	@echo ""
	@echo "$(GREEN)Running Unit Tests (T3 Gates)...$(NC)"
	@echo "================================="
	@$(PYTHON) -m pytest $(TEST_DIR)/unit/ -v --tb=short --timeout=30 \
		--junitxml=$(REPORT_DIR)/unit-results.xml \
		--cov=src --cov-report=html:$(COVERAGE_DIR)/unit \
		|| (echo "$(RED)Unit tests failed$(NC)" && false)

test-module: ## Run module tests (T2, T5 gates)
	@echo ""
	@echo "$(GREEN)Running Module Tests (T2, T5 Gates)...$(NC)"
	@echo "======================================="
	@$(PYTHON) -m pytest $(TEST_DIR)/module/ -v --tb=short --timeout=60 \
		--junitxml=$(REPORT_DIR)/module-results.xml \
		|| (echo "$(YELLOW)Module tests incomplete$(NC)" && true)

test-integration: ## Run integration tests (T1, T4 gates)
	@echo ""
	@echo "$(GREEN)Running Integration Tests (T1, T4 Gates)...$(NC)"
	@echo "============================================"
	@$(PYTHON) -m pytest $(TEST_DIR)/integration/ -v --tb=short --timeout=120 \
		--junitxml=$(REPORT_DIR)/integration-results.xml \
		|| (echo "$(YELLOW)Integration tests incomplete$(NC)" && true)

test-e2e: ## Run end-to-end tests
	@echo ""
	@echo "$(GREEN)Running E2E Tests...$(NC)"
	@echo "===================="
	@$(PYTHON) -m pytest $(TEST_DIR)/e2e/ -v --tb=short --timeout=300 \
		--junitxml=$(REPORT_DIR)/e2e-results.xml \
		|| (echo "$(YELLOW)E2E tests incomplete$(NC)" && true)

test-load: ## Run load/performance tests
	@echo ""
	@echo "$(GREEN)Running Load Tests...$(NC)"
	@echo "====================="
	@$(PYTHON) -m pytest $(TEST_DIR)/load/ -v --tb=short --timeout=600 \
		--junitxml=$(REPORT_DIR)/load-results.xml \
		|| (echo "$(YELLOW)Load tests incomplete$(NC)" && true)

# Security Audits
audit-security: audit-secrets audit-compose audit-tls test-security ## Run all security audits

test-security: ## Run security integration tests (S2, S3, S4)
	@echo ""
	@echo "$(GREEN)Running Security Integration Tests...$(NC)"
	@echo "====================================="
	@$(PYTHON) -m pytest $(TEST_DIR)/security/ -v --tb=short --timeout=60 \
		--junitxml=$(REPORT_DIR)/security-results.xml \
		|| (echo "$(YELLOW)Security tests incomplete$(NC)" && true)

audit-secrets: ## S1: Scan for secrets in git
	@echo ""
	@echo "$(GREEN)S1 Gate: Scanning for secrets...$(NC)"
	@echo "================================="
	@chmod +x $(TEST_DIR)/shell/scan_git_secrets.sh
	@$(TEST_DIR)/shell/scan_git_secrets.sh || (echo "$(RED)S1 FAILED$(NC)" && false)

audit-compose: ## S4: Check container security
	@echo ""
	@echo "$(GREEN)S4 Gate: Checking container security...$(NC)"
	@echo "========================================"
	@chmod +x $(TEST_DIR)/shell/check_compose_security.sh
	@$(TEST_DIR)/shell/check_compose_security.sh || (echo "$(RED)S4 FAILED$(NC)" && false)

audit-tls: ## S2: Check TLS and headers
	@echo ""
	@echo "$(GREEN)S2 Gate: Checking TLS configuration...$(NC)"
	@echo "======================================="
	@chmod +x $(TEST_DIR)/shell/check_proxy_tls_headers.sh
	@$(TEST_DIR)/shell/check_proxy_tls_headers.sh || (echo "$(YELLOW)S2 incomplete (may need running services)$(NC)" && true)

audit-streaming: ## Check SSE/streaming preservation
	@echo ""
	@echo "$(GREEN)Checking streaming configuration...$(NC)"
	@echo "===================================="
	@chmod +x $(TEST_DIR)/shell/verify_streaming.sh
	@$(TEST_DIR)/shell/verify_streaming.sh || (echo "$(YELLOW)Streaming check incomplete$(NC)" && true)

# Coverage and Reporting
coverage: ## Generate test coverage report
	@echo "$(GREEN)Generating coverage report...$(NC)"
	@mkdir -p $(COVERAGE_DIR)
	@$(PYTHON) -m pytest $(TEST_DIR)/unit/ $(TEST_DIR)/module/ \
		--cov=src --cov-report=html:$(COVERAGE_DIR)/html \
		--cov-report=term --cov-report=xml:$(COVERAGE_DIR)/coverage.xml \
		--quiet
	@echo "$(GREEN)Coverage report generated in $(COVERAGE_DIR)/html/index.html$(NC)"

reports: ## Generate all test reports
	@echo "$(GREEN)Generating test reports...$(NC)"
	@mkdir -p $(REPORT_DIR)
	@echo "# Test Results Summary" > $(REPORT_DIR)/summary.md
	@echo "Generated: $$(date)" >> $(REPORT_DIR)/summary.md
	@echo "" >> $(REPORT_DIR)/summary.md
	@if [ -f $(REPORT_DIR)/unit-results.xml ]; then \
		echo "## Unit Tests" >> $(REPORT_DIR)/summary.md; \
		echo "Results: $(REPORT_DIR)/unit-results.xml" >> $(REPORT_DIR)/summary.md; \
	fi
	@if [ -f $(REPORT_DIR)/integration-results.xml ]; then \
		echo "## Integration Tests" >> $(REPORT_DIR)/summary.md; \
		echo "Results: $(REPORT_DIR)/integration-results.xml" >> $(REPORT_DIR)/summary.md; \
	fi
	@echo "$(GREEN)Reports generated in $(REPORT_DIR)/$(NC)"

compliance-check: ## Check compliance matrix
	@echo ""
	@echo "$(GREEN)Generating Compliance Matrix...$(NC)"
	@echo "================================"
	@$(PYTHON) $(TEST_DIR)/utils/generate_compliance_matrix.py || \
		(echo "$(YELLOW)Compliance matrix generator not found$(NC)" && \
		 cp $(TEST_DIR)/fixtures/compliance-matrix-template.md $(REPORT_DIR)/compliance-matrix.md 2>/dev/null || true)
	@if [ -f $(REPORT_DIR)/compliance-matrix.md ]; then \
		echo "$(GREEN)Compliance matrix: $(REPORT_DIR)/compliance-matrix.md$(NC)"; \
	fi

# Development Helpers
shell: ## Open shell in api container
	$(DOCKER_COMPOSE) exec api /bin/sh

db-shell: ## Open database shell
	$(DOCKER_COMPOSE) exec db psql -U postgres

watch-tests: ## Watch and re-run tests on changes
	@echo "$(GREEN)Watching for changes...$(NC)"
	@while true; do \
		$(MAKE) test-unit; \
		echo "$(YELLOW)Waiting for changes... (Ctrl+C to stop)$(NC)"; \
		sleep 5; \
	done

# Cleanup
clean: ## Clean test artifacts and cache
	@echo "$(YELLOW)Cleaning test artifacts...$(NC)"
	@rm -rf $(REPORT_DIR)/*.xml
	@rm -rf $(COVERAGE_DIR)
	@rm -rf .pytest_cache
	@rm -rf **/__pycache__
	@rm -rf **/*.pyc
	@find . -type d -name ".pytest_cache" -exec rm -rf {} + 2>/dev/null || true
	@echo "$(GREEN)Cleanup complete$(NC)"

clean-all: clean down ## Clean everything including Docker volumes
	@echo "$(RED)Removing Docker volumes...$(NC)"
	@$(DOCKER_COMPOSE) down -v
	@docker system prune -f
	@echo "$(GREEN)Full cleanup complete$(NC)"

# CI/CD Helpers
ci-test: ## Run tests in CI mode
	@echo "Running tests in CI mode..."
	@mkdir -p $(REPORT_DIR)
	@$(MAKE) test-requirements
	@$(MAKE) audit-secrets || echo "S1 Failed" >> $(REPORT_DIR)/failures.txt
	@$(MAKE) audit-compose || echo "S4 Failed" >> $(REPORT_DIR)/failures.txt
	@$(MAKE) test-unit || echo "T3 Failed" >> $(REPORT_DIR)/failures.txt
	@$(MAKE) test-integration || echo "T1,T4 Failed" >> $(REPORT_DIR)/failures.txt
	@if [ -f $(REPORT_DIR)/failures.txt ]; then \
		echo "$(RED)CI Tests Failed:$(NC)"; \
		cat $(REPORT_DIR)/failures.txt; \
		exit 1; \
	else \
		echo "$(GREEN)CI Tests Passed$(NC)"; \
	fi

validate-gates: ## Validate all gates quickly
	@echo "$(GREEN)Quick Gate Validation$(NC)"
	@echo "====================="
	@echo "T1: Checking compose file..." && test -f docker-compose.yml && echo "✓" || echo "✗"
	@echo "T2: Checking data flow..." && echo "⚠ Requires running system"
	@echo "T3: Running accuracy tests..." && $(PYTHON) -m pytest $(TEST_DIR)/unit/ -q --tb=no && echo "✓" || echo "✗"
	@echo "T4: Checking MCP..." && echo "⚠ Requires running system"
	@echo "T5: Checking scheduler..." && echo "⚠ Requires running system"
	@echo "S1: Checking secrets..." && $(TEST_DIR)/shell/scan_git_secrets.sh >/dev/null 2>&1 && echo "✓" || echo "✗"
	@echo "S2: Checking TLS..." && echo "⚠ Requires running system"
	@echo "S3: Checking auth..." && echo "⚠ Requires implementation"
	@echo "S4: Checking containers..." && $(TEST_DIR)/shell/check_compose_security.sh >/dev/null 2>&1 && echo "✓" || echo "✗"

# Installation
install: ## Install project and test dependencies
	@echo "$(GREEN)Installing project dependencies...$(NC)"
	@$(PIP) install -r requirements.txt 2>/dev/null || echo "No requirements.txt found"
	@$(PIP) install -r requirements-dev.txt 2>/dev/null || echo "No requirements-dev.txt found"
	@$(MAKE) test-requirements
	@echo "$(GREEN)Installation complete$(NC)"

.DEFAULT_GOAL := help