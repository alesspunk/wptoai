CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  site_url TEXT NOT NULL,
  email TEXT,
  plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  addons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  setup_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  monthly_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'checkout_started', 'paid')),
  scan_status TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'scanning', 'completed', 'failed')),
  preview_image_url TEXT,
  detected_pages INTEGER,
  detected_pages_data JSONB NOT NULL DEFAULT '[]'::jsonb,
  site_title TEXT,
  site_description TEXT,
  stripe_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS detected_pages_data JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_quotes_site_url ON quotes(site_url);
CREATE INDEX IF NOT EXISTS idx_quotes_email ON quotes(email);
CREATE INDEX IF NOT EXISTS idx_quotes_stripe_session_id ON quotes(stripe_session_id);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  site_url TEXT,
  quote_id TEXT,
  lead_status TEXT NOT NULL DEFAULT 'captured' CHECK (lead_status IN ('captured', 'checkout_started', 'paid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_quote_id ON leads(quote_id);
CREATE INDEX IF NOT EXISTS idx_leads_lead_status ON leads(lead_status);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  quote_id TEXT,
  user_id TEXT,
  customer_email TEXT,
  wordpress_url TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'scanning', 'building', 'deploying', 'ready', 'failed')),
  publish_status TEXT NOT NULL DEFAULT 'ready_to_publish',
  frozen_at TIMESTAMPTZ,
  publish_started_at TIMESTAMPTZ,
  package_assembled_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  package_version TEXT,
  package_schema_version TEXT,
  build_job_id TEXT,
  access_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  queue_status TEXT NOT NULL DEFAULT 'idle' CHECK (queue_status IN ('idle', 'processing')),
  queue_locked_at TIMESTAMPTZ,
  vercel_deployment_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS publish_status TEXT NOT NULL DEFAULT 'ready_to_publish';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS publish_started_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS package_assembled_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS package_version TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS package_schema_version TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS build_job_id TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS access_token TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS access_token_expires_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS queue_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS queue_locked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_projects_quote_id ON projects(quote_id);
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_publish_status ON projects(publish_status);
CREATE INDEX IF NOT EXISTS idx_projects_build_job_id ON projects(build_job_id);
CREATE INDEX IF NOT EXISTS idx_projects_access_token ON projects(access_token);
CREATE INDEX IF NOT EXISTS idx_projects_queue_status ON projects(queue_status);

CREATE TABLE IF NOT EXISTS project_pages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  type TEXT NOT NULL CHECK (type IN ('homepage', 'page', 'section')),
  parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  screenshot_url TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_pages_project_id ON project_pages(project_id);
CREATE INDEX IF NOT EXISTS idx_project_pages_parent_id ON project_pages(parent_id);
CREATE INDEX IF NOT EXISTS idx_project_pages_order_index ON project_pages(order_index);

CREATE TABLE IF NOT EXISTS project_packages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE,
  quote_id TEXT,
  package_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'package_assembled',
  validation_status TEXT NOT NULL DEFAULT 'pending',
  validation_errors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  storage_manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  package_key TEXT,
  package_url TEXT,
  package_generated_at TIMESTAMPTZ,
  source_domain TEXT,
  approved_page_count INTEGER NOT NULL DEFAULT 0,
  build_job_id TEXT,
  submitted_at TIMESTAMPTZ,
  manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  files_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE project_packages ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE project_packages ADD COLUMN IF NOT EXISTS validation_errors_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE project_packages ADD COLUMN IF NOT EXISTS storage_manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE project_packages ADD COLUMN IF NOT EXISTS package_key TEXT;
ALTER TABLE project_packages ADD COLUMN IF NOT EXISTS package_url TEXT;
ALTER TABLE project_packages ADD COLUMN IF NOT EXISTS package_generated_at TIMESTAMPTZ;
ALTER TABLE project_packages ADD COLUMN IF NOT EXISTS source_domain TEXT;
ALTER TABLE project_packages ADD COLUMN IF NOT EXISTS approved_page_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_packages ADD COLUMN IF NOT EXISTS build_job_id TEXT;
ALTER TABLE project_packages ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_project_packages_project_id ON project_packages(project_id);
CREATE INDEX IF NOT EXISTS idx_project_packages_status ON project_packages(status);
CREATE INDEX IF NOT EXISTS idx_project_packages_validation_status ON project_packages(validation_status);

CREATE TABLE IF NOT EXISTS build_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE,
  quote_id TEXT,
  package_key TEXT NOT NULL,
  package_url TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  provider TEXT NOT NULL DEFAULT 'openai',
  target TEXT NOT NULL DEFAULT 'static-html',
  retry_count INTEGER NOT NULL DEFAULT 0,
  build_started_at TIMESTAMPTZ,
  build_completed_at TIMESTAMPTZ,
  build_output_key TEXT,
  build_output_url TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE build_jobs ADD COLUMN IF NOT EXISTS build_started_at TIMESTAMPTZ;
ALTER TABLE build_jobs ADD COLUMN IF NOT EXISTS build_completed_at TIMESTAMPTZ;
ALTER TABLE build_jobs ADD COLUMN IF NOT EXISTS build_output_key TEXT;
ALTER TABLE build_jobs ADD COLUMN IF NOT EXISTS build_output_url TEXT;
ALTER TABLE build_jobs ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_build_jobs_project_id ON build_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_build_jobs_status ON build_jobs(status);

CREATE TABLE IF NOT EXISTS build_outputs (
  id TEXT PRIMARY KEY,
  build_job_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  quote_id TEXT,
  provider TEXT NOT NULL DEFAULT 'openai',
  status TEXT NOT NULL DEFAULT 'building',
  output_key TEXT,
  output_url TEXT,
  page_count_built INTEGER NOT NULL DEFAULT 0,
  files_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  build_log_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_build_outputs_build_job_id ON build_outputs(build_job_id);
CREATE INDEX IF NOT EXISTS idx_build_outputs_project_id ON build_outputs(project_id);

CREATE TABLE IF NOT EXISTS email_update_tokens (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  new_email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_update_tokens_project_id ON email_update_tokens(project_id);
CREATE INDEX IF NOT EXISTS idx_email_update_tokens_expires_at ON email_update_tokens(expires_at);
