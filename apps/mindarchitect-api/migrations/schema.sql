-- MindArchitect Studio Database Contract: PostgreSQL 16 + TimescaleDB
-- Enterprise Monorepo Migration & Model Registry Specification
-- Powered by HussnainTechVertex Pvt Ltd

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";
-- Note: In managed environments where timescaledb is loaded via shared_preload_libraries
CREATE EXTENSION IF NOT EXISTS "timescaledb" CASCADE;

-- 1. Multi-Tenant Organization Core
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL UNIQUE,
    tier VARCHAR(50) NOT NULL DEFAULT 'enterprise_tier',
    status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deprovisioned')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Cryptographic API Key Ledger
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key_prefix VARCHAR(16) NOT NULL,
    key_hash VARCHAR(64) NOT NULL UNIQUE,
    label VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
    rate_limit_rpm INT NOT NULL DEFAULT 1200,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_lookup ON api_keys(key_hash, status);

-- 3. Sovereign Model Registry
-- Governs the sovereign V-Series and M-Series competitive positioning
CREATE TABLE IF NOT EXISTS model_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id VARCHAR(100) NOT NULL UNIQUE,
    display_name VARCHAR(255) NOT NULL,
    series VARCHAR(50) NOT NULL CHECK (series IN ('V-Series', 'M-Series', 'Specialized', 'Development')),
    version VARCHAR(50) NOT NULL,
    competitor_target VARCHAR(100) NOT NULL,
    specialization TEXT NOT NULL,
    status VARCHAR(50) NOT NULL CHECK (status IN ('ACTIVE', 'CHECKPOINT_REQUIRED', 'DEVELOPMENT_ONLY', 'DEPRECATED')),
    context_window INT NOT NULL DEFAULT 131072,
    parameter_scale VARCHAR(50) NOT NULL,
    tensor_parallel_size INT NOT NULL DEFAULT 1,
    pipeline_parallel_size INT NOT NULL DEFAULT 1,
    checkpoint_path VARCHAR(500),
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_registry_status ON model_registry(status, series);

-- 4. High-Throughput Usage Ledger (TimescaleDB Hypertable)
CREATE TABLE IF NOT EXISTS usage_ledger (
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tenant_id UUID NOT NULL,
    api_key_id UUID NOT NULL,
    model_id VARCHAR(100) NOT NULL,
    prompt_tokens INT NOT NULL,
    completion_tokens INT NOT NULL,
    total_tokens INT NOT NULL,
    latency_ms INT NOT NULL,
    status_code INT NOT NULL,
    cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0.000000
);

-- Hypertable creation conditional on timescaledb presence
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        PERFORM create_hypertable('usage_ledger', 'recorded_at', if_not_exists => TRUE);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_usage_tenant_time ON usage_ledger(tenant_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_model_time ON usage_ledger(model_id, recorded_at DESC);
