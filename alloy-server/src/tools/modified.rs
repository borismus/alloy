//! Modified-time filters shared by `search_directory` and `list_directory`.
//!
//! Dates mean the file's modified time. Creation time isn't usable: in a vault
//! migrated across machines and sync tools, many old notes report a placeholder
//! creation date (1984), so they couldn't be told apart or found by date.

use std::time::SystemTime;

use chrono::{NaiveDate, TimeZone, Utc};
use serde_json::Value;

use crate::tools::input_string;

/// Parse `"2015"`, `"2015-06"`, or `"2015-06-30"` as the start of that period,
/// in UTC.
pub fn parse_date_bound(raw: &str) -> Option<SystemTime> {
    let raw = raw.trim();
    let mut parts = raw.split('-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u32 = match parts.next() {
        Some(m) => m.parse().ok()?,
        None => 1,
    };
    let day: u32 = match parts.next() {
        Some(d) => d.parse().ok()?,
        None => 1,
    };
    if parts.next().is_some() || !(1000..=9999).contains(&year) {
        return None;
    }
    let date = NaiveDate::from_ymd_opt(year, month, day)?;
    let start = Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0)?);
    Some(start.into())
}

/// `modified_after` (inclusive) and `modified_before` (exclusive) from a tool
/// call's input.
#[derive(Debug, Default, Clone, Copy)]
pub struct ModifiedRange {
    after: Option<SystemTime>,
    before: Option<SystemTime>,
}

impl ModifiedRange {
    pub fn from_input(input: &Value) -> Result<Self, String> {
        let bound = |key: &str| -> Result<Option<SystemTime>, String> {
            match input_string(input, key).map(str::trim).filter(|s| !s.is_empty()) {
                None => Ok(None),
                Some(raw) => parse_date_bound(raw).map(Some).ok_or_else(|| {
                    format!("Invalid {key} \"{raw}\": use YYYY, YYYY-MM, or YYYY-MM-DD")
                }),
            }
        };
        Ok(Self {
            after: bound("modified_after")?,
            before: bound("modified_before")?,
        })
    }

    pub fn is_set(&self) -> bool {
        self.after.is_some() || self.before.is_some()
    }

    pub fn contains(&self, t: SystemTime) -> bool {
        self.after.is_none_or(|a| t >= a) && self.before.is_none_or(|b| t < b)
    }
}

/// `YYYY-MM-DD` (UTC) for a modified time.
pub fn date(t: SystemTime) -> String {
    chrono::DateTime::<Utc>::from(t).format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn at(s: &str) -> SystemTime {
        chrono::DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc).into()
    }

    #[test]
    fn date_bounds_accept_year_month_and_day() {
        assert_eq!(parse_date_bound("2015"), Some(at("2015-01-01T00:00:00Z")));
        assert_eq!(parse_date_bound("2015-06"), Some(at("2015-06-01T00:00:00Z")));
        assert_eq!(parse_date_bound("2015-06-30"), Some(at("2015-06-30T00:00:00Z")));
        for bad in ["", "15", "2015-13", "2015-02-30", "June 2015", "2015-06-30-1"] {
            assert_eq!(parse_date_bound(bad), None, "{bad}");
        }
    }

    #[test]
    fn after_is_inclusive_and_before_is_exclusive() {
        let r = ModifiedRange::from_input(&json!({
            "modified_after": "2010", "modified_before": "2015"
        }))
        .unwrap();
        assert!(r.contains(at("2010-01-01T00:00:00Z")));
        assert!(r.contains(at("2014-12-31T23:59:59Z")));
        assert!(!r.contains(at("2015-01-01T00:00:00Z")));
        assert!(!r.contains(at("2009-12-31T23:59:59Z")));
    }

    #[test]
    fn an_invalid_date_is_a_clear_error() {
        let err = ModifiedRange::from_input(&json!({ "modified_before": "last year" })).unwrap_err();
        assert!(err.contains("modified_before") && err.contains("YYYY"), "{err}");
    }
}
