//! Trigger scheduling and execution.
//!
//! Phase 4 of the migration moves the cron-style scheduler from
//! [src/services/triggers/scheduler.ts](src/services/triggers/scheduler.ts)
//! into the embedded Rust server so triggers fire whether or not any
//! client is open. The model call already runs server-side (Phase 3's
//! `executeViaServer({ skipPersist: true })`); only the timer loop and
//! YAML write-back are new in this phase.

pub mod executor;
pub mod logs;
pub mod model;
pub mod scheduler;
