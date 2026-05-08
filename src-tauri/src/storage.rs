use std::path::Path;

use chrono::{Datelike, Local, Timelike};
use rusqlite::{params, Connection, Result};

use crate::models::{AppSettings, DownloadJob, DownloadState};

pub struct Storage {
    connection: Connection,
}

impl Storage {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let connection = Connection::open(path)?;
        let storage = Self { connection };
        storage.migrate()?;
        Ok(storage)
    }

    fn migrate(&self) -> Result<()> {
        self.connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS downloads (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                file_name TEXT NOT NULL,
                output_folder TEXT NOT NULL,
                output_path TEXT NOT NULL,
                state TEXT NOT NULL,
                queue_position INTEGER NOT NULL DEFAULT 0,
                priority INTEGER NOT NULL DEFAULT 1,
                connection_count INTEGER NOT NULL DEFAULT 4,
                speed_limit_kbps INTEGER NOT NULL DEFAULT 0,
                downloaded_bytes INTEGER NOT NULL DEFAULT 0,
                total_bytes INTEGER,
                speed_bps INTEGER NOT NULL DEFAULT 0,
                is_resumable INTEGER NOT NULL DEFAULT 0,
                scheduler_enabled INTEGER NOT NULL DEFAULT 0,
                schedule_days TEXT NOT NULL DEFAULT '[]',
                schedule_from TEXT,
                schedule_to TEXT,
                retry_count INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS host_profiles (
                hostname TEXT PRIMARY KEY,
                recommended_connection_count INTEGER NOT NULL DEFAULT 4,
                success_count INTEGER NOT NULL DEFAULT 0,
                failure_count INTEGER NOT NULL DEFAULT 0,
                last_average_speed_bps INTEGER NOT NULL DEFAULT 0,
                last_failure_reason TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            ",
        )?;

        self.add_column_if_missing(
            "downloads",
            "queue_position",
            "ALTER TABLE downloads ADD COLUMN queue_position INTEGER NOT NULL DEFAULT 0;",
        )?;
        self.add_column_if_missing(
            "downloads",
            "priority",
            "ALTER TABLE downloads ADD COLUMN priority INTEGER NOT NULL DEFAULT 1;",
        )?;
        self.add_column_if_missing(
            "downloads",
            "connection_count",
            "ALTER TABLE downloads ADD COLUMN connection_count INTEGER NOT NULL DEFAULT 4;",
        )?;
        self.add_column_if_missing(
            "downloads",
            "speed_limit_kbps",
            "ALTER TABLE downloads ADD COLUMN speed_limit_kbps INTEGER NOT NULL DEFAULT 0;",
        )?;
        self.add_column_if_missing(
            "downloads",
            "speed_bps",
            "ALTER TABLE downloads ADD COLUMN speed_bps INTEGER NOT NULL DEFAULT 0;",
        )?;
        self.add_column_if_missing(
            "downloads",
            "error_message",
            "ALTER TABLE downloads ADD COLUMN error_message TEXT;",
        )?;
        self.add_column_if_missing(
            "downloads",
            "is_resumable",
            "ALTER TABLE downloads ADD COLUMN is_resumable INTEGER NOT NULL DEFAULT 0;",
        )?;
        self.add_column_if_missing(
            "downloads",
            "retry_count",
            "ALTER TABLE downloads ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;",
        )?;
        self.add_column_if_missing(
            "downloads",
            "scheduler_enabled",
            "ALTER TABLE downloads ADD COLUMN scheduler_enabled INTEGER NOT NULL DEFAULT 0;",
        )?;
        self.add_column_if_missing(
            "downloads",
            "schedule_days",
            "ALTER TABLE downloads ADD COLUMN schedule_days TEXT NOT NULL DEFAULT '[]';",
        )?;
        self.add_column_if_missing(
            "downloads",
            "schedule_from",
            "ALTER TABLE downloads ADD COLUMN schedule_from TEXT;",
        )?;
        self.add_column_if_missing(
            "downloads",
            "schedule_to",
            "ALTER TABLE downloads ADD COLUMN schedule_to TEXT;",
        )?;
        self.add_column_if_missing(
            "downloads",
            "next_retry_at",
            "ALTER TABLE downloads ADD COLUMN next_retry_at TEXT;",
        )?;
        self.connection.execute(
            "
            UPDATE downloads
            SET queue_position = rowid
            WHERE queue_position = 0;
            ",
            [],
        )?;
        self.seed_default_settings()
    }

    fn seed_default_settings(&self) -> Result<()> {
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('max_concurrent_downloads', '3');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('retry_enabled', '1');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('retry_attempts', '3');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('retry_delay_seconds', '5');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('default_connection_count', '4');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('default_download_speed_limit_kbps', '0');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('bandwidth_schedule_enabled', '0');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('bandwidth_schedule_start', '22:00');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('bandwidth_schedule_end', '06:00');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('bandwidth_schedule_limit_kbps', '512');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('close_to_tray', '1');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('launch_at_startup', '0');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('start_minimized', '0');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('startup_prompt_answered', '0');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('default_folder_mode', 'automatic');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('fixed_download_folder', '');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('show_save_as_button', '1');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('delete_button_action', 'ask');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('file_exists_action', 'rename');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('browser_intercept_downloads', '1');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('browser_start_without_confirmation', '0');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('browser_skip_domains', 'accounts.google.com, drive.google.com');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('browser_skip_extensions', '.tmp, .part');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('browser_capture_extensions', '.zip, .exe, .iso, .7z');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('browser_minimum_size_mb', '1');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('browser_use_native_fallback', '1');
            ",
            [],
        )?;
        self.connection.execute(
            "
            INSERT OR IGNORE INTO settings (key, value)
            VALUES ('browser_ignore_insert_key', '1');
            ",
            [],
        )?;

        Ok(())
    }

    fn add_column_if_missing(&self, table: &str, column: &str, alter_sql: &str) -> Result<()> {
        let mut statement = self
            .connection
            .prepare(&format!("PRAGMA table_info({table});"))?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>>>()?;

        if !columns.iter().any(|existing| existing == column) {
            self.connection.execute_batch(alter_sql)?;
        }

        Ok(())
    }

    pub fn create_download_job(&self, job: &DownloadJob) -> Result<()> {
        self.connection.execute(
            "
            INSERT INTO downloads (
                id,
                url,
                file_name,
                output_folder,
                output_path,
                state,
                queue_position,
                priority,
                connection_count,
                speed_limit_kbps,
                downloaded_bytes,
                total_bytes,
                speed_bps,
                is_resumable,
                scheduler_enabled,
                schedule_days,
                schedule_from,
                schedule_to,
                retry_count,
                next_retry_at,
                error_message
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21);
            ",
            params![
                job.id,
                job.url,
                job.file_name,
                job.output_folder,
                job.output_path,
                job.state.as_str(),
                job.queue_position,
                job.priority,
                job.connection_count,
                job.speed_limit_kbps,
                job.downloaded_bytes,
                job.total_bytes,
                job.speed_bps,
                job.is_resumable,
                job.scheduler_enabled,
                schedule_days_to_text(&job.schedule_days),
                job.schedule_from,
                job.schedule_to,
                job.retry_count,
                job.next_retry_at,
                job.error_message,
            ],
        )?;

        Ok(())
    }

    pub fn list_download_jobs(&self) -> Result<Vec<DownloadJob>> {
        let mut statement = self.connection.prepare(
            "
            SELECT
                id,
                url,
                file_name,
                output_folder,
                output_path,
                state,
                queue_position,
                priority,
                connection_count,
                speed_limit_kbps,
                downloaded_bytes,
                total_bytes,
                speed_bps,
                is_resumable,
                scheduler_enabled,
                schedule_days,
                schedule_from,
                schedule_to,
                retry_count,
                next_retry_at,
                error_message,
                created_at,
                updated_at
            FROM downloads
            ORDER BY
                CASE
                    WHEN state = 'running' THEN 0
                    WHEN state = 'queued' THEN 1
                    WHEN state = 'paused' THEN 2
                    WHEN state = 'failed' THEN 3
                    WHEN state = 'canceled' THEN 4
                    ELSE 5
                END ASC,
                CASE
                    WHEN state IN ('queued', 'paused', 'failed', 'canceled') THEN priority
                    ELSE 0
                END DESC,
                CASE
                    WHEN state IN ('queued', 'paused', 'failed', 'canceled') THEN queue_position
                    ELSE 0
                END ASC,
                datetime(updated_at) DESC;
            ",
        )?;

        let jobs = statement
            .query_map([], |row| {
                let state_text: String = row.get(5)?;
                let state = DownloadState::try_from(state_text.as_str()).map_err(|message| {
                    rusqlite::Error::FromSqlConversionFailure(
                        5,
                        rusqlite::types::Type::Text,
                        Box::new(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            message,
                        )),
                    )
                })?;

                Ok(DownloadJob {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    file_name: row.get(2)?,
                    output_folder: row.get(3)?,
                    output_path: row.get(4)?,
                    state,
                    queue_position: row.get(6)?,
                    priority: row.get(7)?,
                    connection_count: row.get::<_, i64>(8)? as u32,
                    speed_limit_kbps: row.get::<_, i64>(9)? as u64,
                    downloaded_bytes: row.get::<_, i64>(10)? as u64,
                    total_bytes: row.get::<_, Option<i64>>(11)?.map(|value| value as u64),
                    speed_bps: row.get::<_, i64>(12)? as u64,
                    is_resumable: row.get::<_, i64>(13)? != 0,
                    scheduler_enabled: row.get::<_, i64>(14)? != 0,
                    schedule_days: schedule_days_from_text(row.get::<_, String>(15)?.as_str()),
                    schedule_from: row.get(16)?,
                    schedule_to: row.get(17)?,
                    retry_count: row.get::<_, i64>(18)? as u32,
                    next_retry_at: row.get(19)?,
                    error_message: row.get(20)?,
                    created_at: row.get(21)?,
                    updated_at: row.get(22)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;

        Ok(jobs)
    }

    pub fn get_download_job(&self, id: &str) -> Result<Option<DownloadJob>> {
        let mut statement = self.connection.prepare(
            "
            SELECT
                id,
                url,
                file_name,
                output_folder,
                output_path,
                state,
                queue_position,
                priority,
                connection_count,
                speed_limit_kbps,
                downloaded_bytes,
                total_bytes,
                speed_bps,
                is_resumable,
                scheduler_enabled,
                schedule_days,
                schedule_from,
                schedule_to,
                retry_count,
                next_retry_at,
                error_message,
                created_at,
                updated_at
            FROM downloads
            WHERE id = ?1;
            ",
        )?;

        let mut rows = statement.query(params![id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };

        let state_text: String = row.get(5)?;
        let state = DownloadState::try_from(state_text.as_str()).map_err(|message| {
            rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    message,
                )),
            )
        })?;

        Ok(Some(DownloadJob {
            id: row.get(0)?,
            url: row.get(1)?,
            file_name: row.get(2)?,
            output_folder: row.get(3)?,
            output_path: row.get(4)?,
            state,
            queue_position: row.get(6)?,
            priority: row.get(7)?,
            connection_count: row.get::<_, i64>(8)? as u32,
            speed_limit_kbps: row.get::<_, i64>(9)? as u64,
            downloaded_bytes: row.get::<_, i64>(10)? as u64,
            total_bytes: row.get::<_, Option<i64>>(11)?.map(|value| value as u64),
            speed_bps: row.get::<_, i64>(12)? as u64,
            is_resumable: row.get::<_, i64>(13)? != 0,
            scheduler_enabled: row.get::<_, i64>(14)? != 0,
            schedule_days: schedule_days_from_text(row.get::<_, String>(15)?.as_str()),
            schedule_from: row.get(16)?,
            schedule_to: row.get(17)?,
            retry_count: row.get::<_, i64>(18)? as u32,
            next_retry_at: row.get(19)?,
            error_message: row.get(20)?,
            created_at: row.get(21)?,
            updated_at: row.get(22)?,
        }))
    }

    pub fn list_queued_download_jobs(&self, limit: usize) -> Result<Vec<DownloadJob>> {
        let mut statement = self.connection.prepare(
            "
            SELECT
                id,
                url,
                file_name,
                output_folder,
                output_path,
                state,
                queue_position,
                priority,
                connection_count,
                speed_limit_kbps,
                downloaded_bytes,
                total_bytes,
                speed_bps,
                is_resumable,
                scheduler_enabled,
                schedule_days,
                schedule_from,
                schedule_to,
                retry_count,
                next_retry_at,
                error_message,
                created_at,
                updated_at
            FROM downloads
            WHERE state = 'queued'
              AND (next_retry_at IS NULL OR datetime(next_retry_at) <= CURRENT_TIMESTAMP)
            ORDER BY priority DESC, queue_position ASC, datetime(created_at) ASC
            ",
        )?;

        let jobs = statement
            .query_map([], |row| {
                Ok(DownloadJob {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    file_name: row.get(2)?,
                    output_folder: row.get(3)?,
                    output_path: row.get(4)?,
                    state: DownloadState::Queued,
                    queue_position: row.get(6)?,
                    priority: row.get(7)?,
                    connection_count: row.get::<_, i64>(8)? as u32,
                    speed_limit_kbps: row.get::<_, i64>(9)? as u64,
                    downloaded_bytes: row.get::<_, i64>(10)? as u64,
                    total_bytes: row.get::<_, Option<i64>>(11)?.map(|value| value as u64),
                    speed_bps: row.get::<_, i64>(12)? as u64,
                    is_resumable: row.get::<_, i64>(13)? != 0,
                    scheduler_enabled: row.get::<_, i64>(14)? != 0,
                    schedule_days: schedule_days_from_text(row.get::<_, String>(15)?.as_str()),
                    schedule_from: row.get(16)?,
                    schedule_to: row.get(17)?,
                    retry_count: row.get::<_, i64>(18)? as u32,
                    next_retry_at: row.get(19)?,
                    error_message: row.get(20)?,
                    created_at: row.get(21)?,
                    updated_at: row.get(22)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .filter(is_schedule_ready)
            .take(limit)
            .collect::<Vec<_>>();

        Ok(jobs)
    }

    pub fn queue_download_job(&self, id: &str) -> Result<()> {
        self.connection.execute(
            "
            UPDATE downloads
            SET state = 'queued',
                speed_bps = 0,
                error_message = NULL,
                next_retry_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1
              AND state IN ('queued', 'paused', 'failed', 'canceled');
            ",
            params![id],
        )?;

        Ok(())
    }

    pub fn next_queue_position(&self) -> Result<i64> {
        self.connection.query_row(
            "SELECT COALESCE(MAX(queue_position), 0) + 1 FROM downloads;",
            [],
            |row| row.get(0),
        )
    }

    pub fn move_download_job_up(&self, id: &str) -> Result<bool> {
        self.move_download_job(id, -1)
    }

    pub fn move_download_job_down(&self, id: &str) -> Result<bool> {
        self.move_download_job(id, 1)
    }

    pub fn reorder_download_job(&self, dragged_id: &str, target_id: &str) -> Result<bool> {
        let ordered_jobs = self.list_ordered_queue_jobs()?;
        let Some(dragged_index) = ordered_jobs
            .iter()
            .position(|(job_id, _, _)| job_id == dragged_id)
        else {
            return Ok(false);
        };
        let Some(target_index) = ordered_jobs
            .iter()
            .position(|(job_id, _, _)| job_id == target_id)
        else {
            return Ok(false);
        };

        if dragged_index == target_index {
            return Ok(false);
        }

        let dragged_priority = ordered_jobs[dragged_index].2;
        let target_priority = ordered_jobs[target_index].2;
        if dragged_priority != target_priority {
            return Ok(false);
        }

        let mut priority_bucket = ordered_jobs
            .iter()
            .filter(|(_, _, priority)| *priority == dragged_priority)
            .cloned()
            .collect::<Vec<_>>();
        let Some(dragged_bucket_index) = priority_bucket
            .iter()
            .position(|(job_id, _, _)| job_id == dragged_id)
        else {
            return Ok(false);
        };
        let Some(target_bucket_index) = priority_bucket
            .iter()
            .position(|(job_id, _, _)| job_id == target_id)
        else {
            return Ok(false);
        };

        let dragged_job = priority_bucket.remove(dragged_bucket_index);
        let insertion_index = if dragged_bucket_index < target_bucket_index {
            target_bucket_index.saturating_sub(1)
        } else {
            target_bucket_index
        };
        priority_bucket.insert(insertion_index, dragged_job);

        for (offset, (job_id, _, _)) in priority_bucket.iter().enumerate() {
            self.connection.execute(
                "
                UPDATE downloads
                SET queue_position = ?2,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?1;
                ",
                params![job_id, (offset as i64) + 1],
            )?;
        }

        Ok(true)
    }

    pub fn update_download_priority(&self, id: &str, priority: i32) -> Result<bool> {
        let normalized_priority = priority.clamp(0, 2);
        let next_position = self.next_queue_position()?;
        let affected_rows = self.connection.execute(
            "
            UPDATE downloads
            SET priority = ?2,
                queue_position = ?3,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1
              AND state IN ('queued', 'paused', 'failed', 'canceled');
            ",
            params![id, normalized_priority, next_position],
        )?;

        Ok(affected_rows > 0)
    }

    pub fn update_download_speed_limit(&self, id: &str, speed_limit_kbps: u64) -> Result<bool> {
        let normalized_limit = speed_limit_kbps.min(1024 * 1024);
        let affected_rows = self.connection.execute(
            "
            UPDATE downloads
            SET speed_limit_kbps = ?2,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1;
            ",
            params![id, normalized_limit],
        )?;

        Ok(affected_rows > 0)
    }

    pub fn update_download_state(
        &self,
        id: &str,
        state: DownloadState,
        total_bytes: Option<u64>,
        error_message: Option<&str>,
    ) -> Result<()> {
        self.connection.execute(
            "
            UPDATE downloads
            SET state = ?2,
                total_bytes = COALESCE(?3, total_bytes),
                speed_bps = CASE WHEN ?2 = 'running' THEN speed_bps ELSE 0 END,
                error_message = ?4,
                next_retry_at = CASE WHEN ?2 = 'running' THEN NULL ELSE next_retry_at END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1;
            ",
            params![id, state.as_str(), total_bytes, error_message],
        )?;

        Ok(())
    }

    pub fn schedule_download_retry(
        &self,
        id: &str,
        error_message: &str,
        delay_seconds: u64,
    ) -> Result<()> {
        self.connection.execute(
            "
            UPDATE downloads
            SET state = 'queued',
                retry_count = retry_count + 1,
                speed_bps = 0,
                error_message = ?2,
                next_retry_at = datetime('now', '+' || ?3 || ' seconds'),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1;
            ",
            params![id, error_message, delay_seconds.to_string()],
        )?;

        Ok(())
    }

    pub fn update_download_output(
        &self,
        id: &str,
        file_name: &str,
        output_path: &str,
        total_bytes: Option<u64>,
        is_resumable: bool,
    ) -> Result<()> {
        self.connection.execute(
            "
            UPDATE downloads
            SET file_name = ?2,
                output_path = ?3,
                total_bytes = COALESCE(?4, total_bytes),
                is_resumable = ?5,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1;
            ",
            params![id, file_name, output_path, total_bytes, is_resumable],
        )?;

        Ok(())
    }

    pub fn update_download_progress(
        &self,
        id: &str,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
        speed_bps: u64,
    ) -> Result<()> {
        self.connection.execute(
            "
            UPDATE downloads
            SET downloaded_bytes = ?2,
                total_bytes = COALESCE(?3, total_bytes),
                speed_bps = ?4,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1;
            ",
            params![id, downloaded_bytes, total_bytes, speed_bps],
        )?;

        Ok(())
    }

    pub fn recommended_connection_count_for_host(
        &self,
        hostname: &str,
        fallback: u32,
    ) -> Result<u32> {
        let mut statement = self.connection.prepare(
            "
            SELECT recommended_connection_count
            FROM host_profiles
            WHERE hostname = ?1;
            ",
        )?;
        let mut rows = statement.query(params![hostname])?;
        let Some(row) = rows.next()? else {
            return Ok(fallback.clamp(1, 16));
        };

        let recommended = row.get::<_, i64>(0)? as u32;
        Ok(recommended.clamp(1, 16))
    }

    pub fn record_host_download_success(
        &self,
        hostname: &str,
        used_connection_count: u32,
        average_speed_bps: u64,
    ) -> Result<()> {
        let existing_recommendation =
            self.recommended_connection_count_for_host(hostname, used_connection_count)?;
        let recommended_connection_count = if average_speed_bps >= 4 * 1024 * 1024 {
            existing_recommendation.max(used_connection_count).saturating_add(1)
        } else if average_speed_bps >= 1024 * 1024 {
            existing_recommendation.max(used_connection_count)
        } else if average_speed_bps < 256 * 1024 {
            existing_recommendation.min(used_connection_count).saturating_sub(1).max(1)
        } else {
            existing_recommendation
        }
        .clamp(1, 16);

        self.connection.execute(
            "
            INSERT INTO host_profiles (
                hostname,
                recommended_connection_count,
                success_count,
                failure_count,
                last_average_speed_bps,
                last_failure_reason,
                updated_at
            )
            VALUES (?1, ?2, 1, 0, ?3, NULL, CURRENT_TIMESTAMP)
            ON CONFLICT(hostname) DO UPDATE SET
                recommended_connection_count = ?2,
                success_count = success_count + 1,
                last_average_speed_bps = ?3,
                last_failure_reason = NULL,
                updated_at = CURRENT_TIMESTAMP;
            ",
            params![
                hostname,
                recommended_connection_count,
                average_speed_bps.min(i64::MAX as u64) as i64,
            ],
        )?;

        Ok(())
    }

    pub fn record_host_download_failure(
        &self,
        hostname: &str,
        used_connection_count: u32,
        failure_reason: &str,
    ) -> Result<()> {
        let existing_recommendation =
            self.recommended_connection_count_for_host(hostname, used_connection_count)?;
        let recommended_connection_count = existing_recommendation
            .min(used_connection_count)
            .saturating_sub(1)
            .max(1);

        self.connection.execute(
            "
            INSERT INTO host_profiles (
                hostname,
                recommended_connection_count,
                success_count,
                failure_count,
                last_average_speed_bps,
                last_failure_reason,
                updated_at
            )
            VALUES (?1, ?2, 0, 1, 0, ?3, CURRENT_TIMESTAMP)
            ON CONFLICT(hostname) DO UPDATE SET
                recommended_connection_count = ?2,
                failure_count = failure_count + 1,
                last_failure_reason = ?3,
                updated_at = CURRENT_TIMESTAMP;
            ",
            params![hostname, recommended_connection_count, failure_reason],
        )?;

        Ok(())
    }

    pub fn recover_running_downloads(&self) -> Result<()> {
        self.connection.execute(
            "
            UPDATE downloads
            SET state = 'paused',
                speed_bps = 0,
                error_message = 'Download interrupted. Resume is available.',
                updated_at = CURRENT_TIMESTAMP
            WHERE state = 'running';
            ",
            [],
        )?;

        Ok(())
    }

    pub fn delete_download_job(&self, id: &str) -> Result<bool> {
        let affected_rows = self
            .connection
            .execute("DELETE FROM downloads WHERE id = ?1;", params![id])?;

        Ok(affected_rows > 0)
    }

    pub fn get_app_settings(&self) -> Result<AppSettings> {
        let defaults = AppSettings::default();
        let max_concurrent_downloads = self
            .get_setting("max_concurrent_downloads")?
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(defaults.max_concurrent_downloads)
            .clamp(1, 10);
        let retry_enabled = self
            .get_setting("retry_enabled")?
            .and_then(|value| value.parse::<u8>().ok())
            .map(|value| value != 0)
            .unwrap_or(defaults.retry_enabled);
        let retry_attempts = self
            .get_setting("retry_attempts")?
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(defaults.retry_attempts)
            .clamp(0, 10);
        let retry_delay_seconds = self
            .get_setting("retry_delay_seconds")?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(defaults.retry_delay_seconds)
            .clamp(0, 3600);
        let default_connection_count = self
            .get_setting("default_connection_count")?
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(defaults.default_connection_count)
            .clamp(1, 16);
        let default_download_speed_limit_kbps = self
            .get_setting("default_download_speed_limit_kbps")?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(defaults.default_download_speed_limit_kbps)
            .min(1024 * 1024);
        let bandwidth_schedule_enabled = self
            .get_setting("bandwidth_schedule_enabled")?
            .and_then(|value| value.parse::<u8>().ok())
            .map(|value| value != 0)
            .unwrap_or(defaults.bandwidth_schedule_enabled);
        let bandwidth_schedule_start = self
            .get_setting("bandwidth_schedule_start")?
            .unwrap_or(defaults.bandwidth_schedule_start);
        let bandwidth_schedule_end = self
            .get_setting("bandwidth_schedule_end")?
            .unwrap_or(defaults.bandwidth_schedule_end);
        let bandwidth_schedule_limit_kbps = self
            .get_setting("bandwidth_schedule_limit_kbps")?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(defaults.bandwidth_schedule_limit_kbps)
            .min(1024 * 1024);
        let close_to_tray = self
            .get_setting("close_to_tray")?
            .and_then(|value| value.parse::<u8>().ok())
            .map(|value| value != 0)
            .unwrap_or(defaults.close_to_tray);
        let launch_at_startup = self
            .get_setting("launch_at_startup")?
            .and_then(|value| value.parse::<u8>().ok())
            .map(|value| value != 0)
            .unwrap_or(defaults.launch_at_startup);
        let start_minimized = self
            .get_setting("start_minimized")?
            .and_then(|value| value.parse::<u8>().ok())
            .map(|value| value != 0)
            .unwrap_or(defaults.start_minimized);
        let startup_prompt_answered = self
            .get_setting("startup_prompt_answered")?
            .and_then(|value| value.parse::<u8>().ok())
            .map(|value| value != 0)
            .unwrap_or(defaults.startup_prompt_answered);
        let default_folder_mode = self
            .get_setting("default_folder_mode")?
            .map(|value| match value.trim() {
                "fixed" => "fixed".to_string(),
                _ => "automatic".to_string(),
            })
            .unwrap_or(defaults.default_folder_mode);
        let fixed_download_folder = self
            .get_setting("fixed_download_folder")?
            .unwrap_or(defaults.fixed_download_folder);
        let show_save_as_button = self
            .get_setting("show_save_as_button")?
            .and_then(|value| value.parse::<u8>().ok())
            .map(|value| value != 0)
            .unwrap_or(defaults.show_save_as_button);
        let delete_button_action = self
            .get_setting("delete_button_action")?
            .map(|value| match value.trim() {
                "remove" => "remove".to_string(),
                "delete" => "delete".to_string(),
                _ => "ask".to_string(),
            })
            .unwrap_or(defaults.delete_button_action);
        let file_exists_action = self
            .get_setting("file_exists_action")?
            .map(|value| match value.trim() {
                "overwrite" => "overwrite".to_string(),
                "ask" => "ask".to_string(),
                _ => "rename".to_string(),
            })
            .unwrap_or(defaults.file_exists_action);
        let browser_intercept_downloads = self
            .get_setting("browser_intercept_downloads")?
            .and_then(|value| value.parse::<u8>().ok())
            .map(|value| value != 0)
            .unwrap_or(defaults.browser_intercept_downloads);
        let browser_start_without_confirmation = self
            .get_setting("browser_start_without_confirmation")?
            .and_then(|value| value.parse::<u8>().ok())
            .map(|value| value != 0)
            .unwrap_or(defaults.browser_start_without_confirmation);
        let browser_skip_domains = self
            .get_setting("browser_skip_domains")?
            .unwrap_or(defaults.browser_skip_domains);
        let browser_skip_extensions = self
            .get_setting("browser_skip_extensions")?
            .unwrap_or(defaults.browser_skip_extensions);
        let browser_capture_extensions = self
            .get_setting("browser_capture_extensions")?
            .unwrap_or(defaults.browser_capture_extensions);
        let browser_minimum_size_mb = self
            .get_setting("browser_minimum_size_mb")?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(defaults.browser_minimum_size_mb)
            .min(1024 * 1024);
        let browser_use_native_fallback = self
            .get_setting("browser_use_native_fallback")?
            .and_then(|value| value.parse::<u8>().ok())
            .map(|value| value != 0)
            .unwrap_or(defaults.browser_use_native_fallback);
        let browser_ignore_insert_key = self
            .get_setting("browser_ignore_insert_key")?
            .and_then(|value| value.parse::<u8>().ok())
            .map(|value| value != 0)
            .unwrap_or(defaults.browser_ignore_insert_key);

        Ok(AppSettings {
            max_concurrent_downloads,
            retry_enabled,
            retry_attempts,
            retry_delay_seconds,
            default_connection_count,
            default_download_speed_limit_kbps,
            bandwidth_schedule_enabled,
            bandwidth_schedule_start,
            bandwidth_schedule_end,
            bandwidth_schedule_limit_kbps,
            close_to_tray,
            launch_at_startup,
            start_minimized,
            startup_prompt_answered,
            default_folder_mode,
            fixed_download_folder,
            show_save_as_button,
            delete_button_action,
            file_exists_action,
            browser_intercept_downloads,
            browser_start_without_confirmation,
            browser_skip_domains,
            browser_skip_extensions,
            browser_capture_extensions,
            browser_minimum_size_mb,
            browser_use_native_fallback,
            browser_ignore_insert_key,
        })
    }

    pub fn update_app_settings(&self, settings: &AppSettings) -> Result<()> {
        self.upsert_setting(
            "max_concurrent_downloads",
            settings.max_concurrent_downloads.to_string(),
        )?;
        self.upsert_setting("retry_enabled", if settings.retry_enabled { "1" } else { "0" })?;
        self.upsert_setting("retry_attempts", settings.retry_attempts.to_string())?;
        self.upsert_setting("retry_delay_seconds", settings.retry_delay_seconds.to_string())?;
        self.upsert_setting(
            "default_connection_count",
            settings.default_connection_count.to_string(),
        )?;
        self.upsert_setting(
            "default_download_speed_limit_kbps",
            settings.default_download_speed_limit_kbps.to_string(),
        )?;
        self.upsert_setting(
            "bandwidth_schedule_enabled",
            if settings.bandwidth_schedule_enabled { "1" } else { "0" },
        )?;
        self.upsert_setting("bandwidth_schedule_start", &settings.bandwidth_schedule_start)?;
        self.upsert_setting("bandwidth_schedule_end", &settings.bandwidth_schedule_end)?;
        self.upsert_setting(
            "bandwidth_schedule_limit_kbps",
            settings.bandwidth_schedule_limit_kbps.to_string(),
        )?;
        self.upsert_setting(
            "close_to_tray",
            if settings.close_to_tray { "1" } else { "0" },
        )?;
        self.upsert_setting(
            "launch_at_startup",
            if settings.launch_at_startup { "1" } else { "0" },
        )?;
        self.upsert_setting(
            "start_minimized",
            if settings.start_minimized { "1" } else { "0" },
        )?;
        self.upsert_setting(
            "startup_prompt_answered",
            if settings.startup_prompt_answered { "1" } else { "0" },
        )?;
        self.upsert_setting("default_folder_mode", &settings.default_folder_mode)?;
        self.upsert_setting("fixed_download_folder", &settings.fixed_download_folder)?;
        self.upsert_setting(
            "show_save_as_button",
            if settings.show_save_as_button { "1" } else { "0" },
        )?;
        self.upsert_setting("delete_button_action", &settings.delete_button_action)?;
        self.upsert_setting("file_exists_action", &settings.file_exists_action)?;
        self.upsert_setting(
            "browser_intercept_downloads",
            if settings.browser_intercept_downloads { "1" } else { "0" },
        )?;
        self.upsert_setting(
            "browser_start_without_confirmation",
            if settings.browser_start_without_confirmation {
                "1"
            } else {
                "0"
            },
        )?;
        self.upsert_setting("browser_skip_domains", &settings.browser_skip_domains)?;
        self.upsert_setting("browser_skip_extensions", &settings.browser_skip_extensions)?;
        self.upsert_setting("browser_capture_extensions", &settings.browser_capture_extensions)?;
        self.upsert_setting(
            "browser_minimum_size_mb",
            settings.browser_minimum_size_mb.to_string(),
        )?;
        self.upsert_setting(
            "browser_use_native_fallback",
            if settings.browser_use_native_fallback {
                "1"
            } else {
                "0"
            },
        )?;
        self.upsert_setting(
            "browser_ignore_insert_key",
            if settings.browser_ignore_insert_key { "1" } else { "0" },
        )?;

        Ok(())
    }

    fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let mut statement = self
            .connection
            .prepare("SELECT value FROM settings WHERE key = ?1;")?;
        let mut rows = statement.query(params![key])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };

        Ok(Some(row.get(0)?))
    }

    fn upsert_setting(&self, key: &str, value: impl AsRef<str>) -> Result<()> {
        self.connection.execute(
            "
            INSERT INTO settings (key, value)
            VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value;
            ",
            params![key, value.as_ref()],
        )?;

        Ok(())
    }

    fn move_download_job(&self, id: &str, direction: i64) -> Result<bool> {
        let ordered_jobs = self.list_ordered_queue_jobs()?;

        let Some(current_index) = ordered_jobs.iter().position(|(job_id, _, _)| job_id == id) else {
            return Ok(false);
        };

        let current_priority = ordered_jobs[current_index].2;
        let mut swap_index = current_index as i64 + direction;
        while swap_index >= 0 && (swap_index as usize) < ordered_jobs.len() {
            if ordered_jobs[swap_index as usize].2 == current_priority {
                break;
            }
            swap_index += direction;
        }

        if swap_index < 0 || (swap_index as usize) >= ordered_jobs.len() {
            return Ok(false);
        }

        let swap_index = swap_index as usize;
        if swap_index == current_index {
            return Ok(false);
        }

        let current_position = ordered_jobs[current_index].1;
        let swap_position = ordered_jobs[swap_index].1;

        self.connection.execute(
            "UPDATE downloads SET queue_position = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1;",
            params![ordered_jobs[current_index].0, swap_position],
        )?;
        self.connection.execute(
            "UPDATE downloads SET queue_position = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1;",
            params![ordered_jobs[swap_index].0, current_position],
        )?;

        Ok(true)
    }

    fn list_ordered_queue_jobs(&self) -> Result<Vec<(String, i64, i32)>> {
        let mut statement = self.connection.prepare(
            "
            SELECT id, queue_position, priority
            FROM downloads
            WHERE state IN ('queued', 'paused', 'failed', 'canceled')
            ORDER BY priority DESC, queue_position ASC, datetime(created_at) ASC;
            ",
        )?;

        let ordered_jobs = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i32>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>>>()?;

        Ok(ordered_jobs)
    }
}

fn schedule_days_to_text(days: &[String]) -> String {
    serde_json::to_string(days).unwrap_or_else(|_| "[]".to_string())
}

fn schedule_days_from_text(value: &str) -> Vec<String> {
    serde_json::from_str(value).unwrap_or_default()
}

fn is_schedule_ready(job: &DownloadJob) -> bool {
    if !job.scheduler_enabled {
        return true;
    }

    let now = Local::now();
    let today = match now.weekday().num_days_from_sunday() {
        0 => "Sun",
        1 => "Mon",
        2 => "Tue",
        3 => "Wed",
        4 => "Thu",
        5 => "Fri",
        _ => "Sat",
    };

    if !job
        .schedule_days
        .iter()
        .any(|day| day == "Everyday" || day == today)
    {
        return false;
    }

    let Some(start_minutes) = job.schedule_from.as_deref().and_then(time_to_minutes) else {
        return false;
    };
    let Some(end_minutes) = job.schedule_to.as_deref().and_then(time_to_minutes) else {
        return false;
    };
    let now_minutes = now.hour() * 60 + now.minute();

    if start_minutes <= end_minutes {
        now_minutes >= start_minutes && now_minutes <= end_minutes
    } else {
        now_minutes >= start_minutes || now_minutes <= end_minutes
    }
}

fn time_to_minutes(value: &str) -> Option<u32> {
    let (hour, minute) = value.split_once(':')?;
    let hour = hour.parse::<u32>().ok()?;
    let minute = minute.parse::<u32>().ok()?;

    (hour < 24 && minute < 60).then_some(hour * 60 + minute)
}
