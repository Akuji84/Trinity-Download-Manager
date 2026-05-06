#![allow(dead_code)]

use crate::models::{DownloadJob, DownloadState};

#[derive(Default)]
pub struct TaskManager {
    queued_jobs: Vec<DownloadJob>,
}

impl TaskManager {
    pub fn new() -> Self {
        Self {
            queued_jobs: Vec::new(),
        }
    }

    pub fn enqueue(&mut self, mut job: DownloadJob) {
        job.state = DownloadState::Queued;
        self.queued_jobs.push(job);
    }

    pub fn queued_count(&self) -> usize {
        self.queued_jobs.len()
    }
}
