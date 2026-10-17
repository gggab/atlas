//! Deterministic Gregorian periods. No database, system clock or model access.
use anyhow::{bail, ensure, Context, Result};
use chrono::{Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Frequency {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MissingDayPolicy {
    LastDay,
    NextDay,
    Skip,
}
fn leads() -> Vec<u16> {
    vec![0]
}
fn tracked() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarSpec {
    pub frequency: Frequency,
    pub start_date: String,
    pub local_time: String,
    pub timezone: String,
    pub missing_day_policy: Option<MissingDayPolicy>,
    #[serde(default = "leads")]
    pub reminder_days: Vec<u16>,
    pub until_date: Option<String>,
    #[serde(default = "tracked")]
    pub track_completion: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarIssue {
    pub field: String,
    pub question: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarReminder {
    pub lead_days: u16,
    pub nominal_local: String,
    pub at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarPeriod {
    pub index: u64,
    pub local_date: String,
    pub timezone: String,
    pub due_at: i64,
    pub reminders: Vec<CalendarReminder>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarPreview {
    pub issues: Vec<CalendarIssue>,
    pub periods: Vec<CalendarPeriod>,
    pub frozen_periods: Vec<String>,
    pub timezone_version: String,
    pub dst_policy: String,
}

pub fn resolve_local(zone: Tz, nominal: NaiveDateTime) -> Result<i64> {
    // Covers non-hour DST gaps and complete skipped dates, without guessing an offset.
    for minute in 0..=2880 {
        let local = nominal
            .checked_add_signed(Duration::minutes(minute))
            .context("calendar overflow")?;
        match zone.from_local_datetime(&local) {
            LocalResult::Single(at) | LocalResult::Ambiguous(at, _) => {
                return Ok(at.timestamp_millis())
            }
            LocalResult::None => {}
        }
    }
    bail!("No valid local instant within two days of {nominal}")
}
impl CalendarSpec {
    pub fn issues(&self) -> Vec<CalendarIssue> {
        let mut issues = Vec::new();
        let mut issue = |field: &str, question: &str| {
            issues.push(CalendarIssue {
                field: field.into(),
                question: question.into(),
            })
        };
        let anchor = NaiveDate::parse_from_str(&self.start_date, "%Y-%m-%d");
        if anchor
            .as_ref()
            .map_or(true, |d| !(1900..=9998).contains(&d.year()))
        {
            issue("startDate", "请提供有效的公历起始日期（1900–9998年）。");
        }
        if NaiveTime::parse_from_str(&self.local_time, "%H:%M").is_err() {
            issue("localTime", "请确定每天的提醒时间（小时:分钟）。");
        }
        if self.timezone.parse::<Tz>().is_err() {
            issue(
                "timezone",
                "请确定固定的 IANA 时区，例如 Asia/Shanghai；计划不会自动跟随旅行改变时区。",
            );
        }
        if let Ok(date) = anchor {
            let sensitive = (self.frequency == Frequency::Monthly && date.day() >= 29)
                || (self.frequency == Frequency::Yearly && date.month() == 2 && date.day() == 29);
            if sensitive && self.missing_day_policy.is_none() {
                issue("missingDayPolicy", "遇到不存在的日期时，按当月最后一天还是跳过？2月29日的年度计划也可顺延至3月1日。");
            }
            if self.frequency == Frequency::Monthly
                && self.missing_day_policy == Some(MissingDayPolicy::NextDay)
            {
                issue(
                    "missingDayPolicy",
                    "月度计划请选择当月最后一天或跳过，不能顺延到下个月。",
                );
            }
            if let Some(until) = &self.until_date {
                if NaiveDate::parse_from_str(until, "%Y-%m-%d")
                    .map_or(true, |end| end < date || end.year() > 9998)
                {
                    issue("untilDate", "结束日期必须是不早于起始日期的有效公历日期。");
                }
            }
        }
        let maximum = match self.frequency {
            Frequency::Daily => 0,
            Frequency::Weekly => 6,
            _ => 30,
        };
        let unique: std::collections::HashSet<_> = self.reminder_days.iter().collect();
        if self.reminder_days.is_empty()
            || self.reminder_days.len() > 8
            || unique.len() != self.reminder_days.len()
            || !self.reminder_days.contains(&0)
            || self.reminder_days.iter().any(|d| *d > maximum)
        {
            issue("reminderDays", "提醒日期须包含当天且不重复，最多8次；每日仅当天、每周提前0–6天、每月或每年提前0–30天。");
        }
        issues
    }
    pub fn first_index(&self, now: i64) -> Result<u64> {
        let zone: Tz = self.timezone.parse()?;
        let local = chrono::DateTime::<Utc>::from_timestamp_millis(now)
            .context("invalid UTC timestamp")?
            .with_timezone(&zone)
            .date_naive();
        let anchor = NaiveDate::parse_from_str(&self.start_date, "%Y-%m-%d")?;
        let index = match self.frequency {
            Frequency::Daily => (local - anchor).num_days(),
            Frequency::Weekly => (local - anchor).num_days().div_euclid(7),
            Frequency::Monthly => {
                i64::from(local.year() - anchor.year()) * 12 + i64::from(local.month())
                    - i64::from(anchor.month())
            }
            Frequency::Yearly => i64::from(local.year() - anchor.year()),
        };
        let mut index = index.max(0) as u64;
        loop {
            let Some(period) = self.period(index)? else {
                return Ok(index);
            };
            if period.due_at > now {
                return Ok(period.index);
            }
            index = period
                .index
                .checked_add(1)
                .context("calendar index overflow")?;
        }
    }
    pub fn period(&self, mut index: u64) -> Result<Option<CalendarPeriod>> {
        ensure!(self.issues().is_empty(), "calendar requires clarification");
        let anchor = NaiveDate::parse_from_str(&self.start_date, "%Y-%m-%d")?;
        let time = NaiveTime::parse_from_str(&self.local_time, "%H:%M")?;
        let zone: Tz = self.timezone.parse()?;
        let until = self
            .until_date
            .as_ref()
            .map(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d"))
            .transpose()?;
        loop {
            let n = i64::try_from(index)?;
            let date = match self.frequency {
                Frequency::Daily | Frequency::Weekly => {
                    let days = n
                        .checked_mul(if self.frequency == Frequency::Weekly {
                            7
                        } else {
                            1
                        })
                        .context("calendar overflow")?;
                    anchor
                        .checked_add_signed(Duration::try_days(days).context("calendar overflow")?)
                }
                Frequency::Monthly | Frequency::Yearly => {
                    let month = i64::from(anchor.year()) * 12
                        + i64::from(anchor.month0())
                        + n.checked_mul(if self.frequency == Frequency::Yearly {
                            12
                        } else {
                            1
                        })
                        .context("calendar overflow")?;
                    let year = i32::try_from(month.div_euclid(12))?;
                    if year > 9998 {
                        return Ok(None);
                    }
                    let month = month.rem_euclid(12) as u32 + 1;
                    NaiveDate::from_ymd_opt(year, month, anchor.day()).or_else(|| {
                        let last = (28..=31)
                            .rev()
                            .find_map(|day| NaiveDate::from_ymd_opt(year, month, day))?;
                        match self.missing_day_policy {
                            Some(MissingDayPolicy::LastDay) => Some(last),
                            Some(MissingDayPolicy::NextDay) => last.succ_opt(),
                            _ => None,
                        }
                    })
                }
            };
            if let Some(date) = date {
                if date.year() > 9998 || until.is_some_and(|end| date > end) {
                    return Ok(None);
                }
                let mut reminders = Vec::new();
                for lead in &self.reminder_days {
                    let local = date
                        .checked_sub_signed(Duration::days(i64::from(*lead)))
                        .context("calendar overflow")?
                        .and_time(time);
                    reminders.push(CalendarReminder {
                        lead_days: *lead,
                        nominal_local: local.format("%Y-%m-%dT%H:%M").to_string(),
                        at: resolve_local(zone, local)?,
                    });
                }
                reminders.sort_by_key(|r| (r.at, std::cmp::Reverse(r.lead_days)));
                return Ok(Some(CalendarPeriod {
                    index,
                    local_date: date.to_string(),
                    timezone: self.timezone.clone(),
                    due_at: resolve_local(zone, date.and_time(time))?,
                    reminders,
                }));
            }
            // A skipped month/year consumes its nominal index, without shifting later identities.
            index = index.checked_add(1).context("calendar index overflow")?;
        }
    }
}
pub fn preview(spec: &CalendarSpec, now: i64) -> Result<CalendarPreview> {
    let mut result = CalendarPreview {
        issues: spec.issues(),
        periods: Vec::new(),
        frozen_periods: Vec::new(),
        timezone_version: chrono_tz::IANA_TZDB_VERSION.into(),
        dst_policy:
            "不存在的本地时刻顺延到下一个有效分钟；重复时刻只取第一次。提醒钟点不代表账单截止钟点。"
                .into(),
    };
    if !result.issues.is_empty() {
        return Ok(result);
    }
    let mut index = spec.first_index(now)?;
    for _ in 0..3 {
        let Some(mut p) = spec.period(index)? else {
            break;
        };
        index = p.index + 1;
        p.reminders.retain(|r| r.at > now);
        result.periods.push(p);
    }
    if result.periods.is_empty() {
        result.issues.push(CalendarIssue {
            field: "untilDate".into(),
            question: "此规则没有未来日期，请修改起始或结束日期。".into(),
        });
    }
    Ok(result)
}
