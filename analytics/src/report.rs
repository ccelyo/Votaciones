//! Cálculo puro de las analíticas de una elección cerrada. No toca Mongo ni
//! RabbitMQ: recibe los datos ya agregados y devuelve el informe.
//!
//! Todas las proporciones son fracciones entre 0 y 1 redondeadas a 4 decimales;
//! los márgenes en puntos porcentuales (0–100). El voto en blanco cuenta como
//! voto válido; los nulos (`invalid_ballots`) no.

use chrono::{DateTime, Duration, DurationRound, Timelike, Utc};
use serde::{Deserialize, Serialize};

use crate::events::OptionVotes;

/// Lo que analytics sabe de una elección a partir de los eventos.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ElectionMeta {
    pub election_id: String,
    pub name: Option<String>,
    #[serde(default)]
    pub options: Vec<String>,
    pub blank_option: Option<String>,
    pub opens_at: Option<DateTime<Utc>>,
    pub closes_at: Option<DateTime<Utc>>,
    pub closed_at: Option<DateTime<Utc>>,
    pub eligible_voters: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tally {
    pub total_ballots: u64,
    pub invalid_ballots: u64,
    pub results: Vec<OptionVotes>,
    pub tallied_at: DateTime<Utc>,
}

/// Papeletas recibidas en una hora (inicio de la hora, UTC).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HourBucket {
    pub start: DateTime<Utc>,
    pub ballots: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ElectionReport {
    pub election_id: String,
    pub name: Option<String>,
    pub status: String,
    pub schedule: Schedule,
    pub totals: Totals,
    pub rates: Rates,
    pub results: Vec<OptionResult>,
    pub outcome: Outcome,
    pub competitiveness: Competitiveness,
    pub participation: Participation,
    pub tallied_at: DateTime<Utc>,
    pub generated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Schedule {
    pub opens_at: Option<DateTime<Utc>>,
    pub closes_at: Option<DateTime<Utc>>,
    pub closed_at: Option<DateTime<Utc>>,
    pub duration_hours: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Totals {
    pub eligible_voters: Option<u64>,
    pub total_ballots: u64,
    pub valid_ballots: u64,
    pub invalid_ballots: u64,
    pub blank_ballots: Option<u64>,
    pub abstentions: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Rates {
    pub turnout: Option<f64>,
    pub abstention: Option<f64>,
    pub valid: f64,
    pub invalid: f64,
    pub blank: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OptionResult {
    pub option: String,
    pub votes: u64,
    pub rank: u32,
    pub share_of_valid: f64,
    pub share_of_total: f64,
    pub is_blank: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Outcome {
    pub winner: Option<String>,
    pub winner_votes: Option<u64>,
    pub tie: bool,
    pub tied_options: Vec<String>,
    pub runner_up: Option<String>,
    pub margin_votes: Option<u64>,
    pub margin_points: Option<f64>,
    pub blank_won: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Competitiveness {
    pub options_with_votes: u32,
    pub herfindahl_index: Option<f64>,
    pub effective_number_of_options: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Participation {
    pub bucket: String,
    pub recorded_ballots: u64,
    pub matches_tally: bool,
    pub first_ballot_at: Option<DateTime<Utc>>,
    pub last_ballot_at: Option<DateTime<Utc>>,
    pub peak: Option<TimelinePoint>,
    pub by_hour_of_day_utc: Vec<u64>,
    pub timeline: Vec<TimelinePoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TimelinePoint {
    pub start: DateTime<Utc>,
    pub ballots: u64,
    pub cumulative: u64,
    pub cumulative_turnout: Option<f64>,
}

pub fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

fn ratio(part: u64, whole: u64) -> Option<f64> {
    (whole > 0).then(|| round4(part as f64 / whole as f64))
}

pub fn hour_start(at: DateTime<Utc>) -> DateTime<Utc> {
    at.duration_trunc(Duration::hours(1)).unwrap_or(at)
}

pub fn build_report(
    meta: &ElectionMeta,
    tally: &Tally,
    buckets: &[HourBucket],
    now: DateTime<Utc>,
) -> ElectionReport {
    let valid = tally.total_ballots.saturating_sub(tally.invalid_ballots);
    let eligible = meta.eligible_voters.filter(|&n| n > 0);
    let blank = meta.blank_option.as_deref();

    // Orden base: el de la elección; opciones que solo aparecen en el conteo, al final.
    let mut ordered: Vec<(String, u64)> = meta
        .options
        .iter()
        .map(|option| {
            let votes = tally
                .results
                .iter()
                .filter(|r| &r.option == option)
                .map(|r| r.votes)
                .sum();
            (option.clone(), votes)
        })
        .collect();
    for r in &tally.results {
        if !ordered.iter().any(|(option, _)| option == &r.option) {
            ordered.push((r.option.clone(), r.votes));
        }
    }
    // sort_by es estable: los empates conservan el orden de la elección.
    ordered.sort_by(|a, b| b.1.cmp(&a.1));

    let mut results = Vec::with_capacity(ordered.len());
    for (i, (option, votes)) in ordered.iter().enumerate() {
        let rank = if i > 0 && ordered[i - 1].1 == *votes {
            results.last().map(|r: &OptionResult| r.rank).unwrap_or(1)
        } else {
            i as u32 + 1
        };
        results.push(OptionResult {
            option: option.clone(),
            votes: *votes,
            rank,
            share_of_valid: ratio(*votes, valid).unwrap_or(0.0),
            share_of_total: ratio(*votes, tally.total_ballots).unwrap_or(0.0),
            is_blank: Some(option.as_str()) == blank,
        });
    }

    let blank_ballots = blank.map(|b| {
        results
            .iter()
            .filter(|r| r.option == b)
            .map(|r| r.votes)
            .sum()
    });
    let outcome = outcome(&results, valid);
    let shares: Vec<f64> = results
        .iter()
        .map(|r| r.votes as f64 / valid.max(1) as f64)
        .collect();
    let hhi: f64 = shares.iter().map(|s| s * s).sum();

    ElectionReport {
        election_id: meta.election_id.clone(),
        name: meta.name.clone(),
        status: "final".into(),
        schedule: Schedule {
            opens_at: meta.opens_at,
            closes_at: meta.closes_at,
            closed_at: meta.closed_at.or(Some(tally.tallied_at)),
            duration_hours: match (meta.opens_at, meta.closed_at.or(meta.closes_at)) {
                (Some(open), Some(close)) if close > open => {
                    Some(round4((close - open).num_seconds() as f64 / 3600.0))
                }
                _ => None,
            },
        },
        totals: Totals {
            eligible_voters: eligible,
            total_ballots: tally.total_ballots,
            valid_ballots: valid,
            invalid_ballots: tally.invalid_ballots,
            blank_ballots,
            abstentions: eligible.map(|e| e.saturating_sub(tally.total_ballots)),
        },
        rates: Rates {
            turnout: eligible.and_then(|e| ratio(tally.total_ballots, e)),
            abstention: eligible.and_then(|e| ratio(e.saturating_sub(tally.total_ballots), e)),
            valid: ratio(valid, tally.total_ballots).unwrap_or(0.0),
            invalid: ratio(tally.invalid_ballots, tally.total_ballots).unwrap_or(0.0),
            blank: blank_ballots.map(|b| ratio(b, valid).unwrap_or(0.0)),
        },
        outcome,
        competitiveness: Competitiveness {
            options_with_votes: results.iter().filter(|r| r.votes > 0).count() as u32,
            herfindahl_index: (valid > 0).then(|| round4(hhi)),
            effective_number_of_options: (valid > 0 && hhi > 0.0).then(|| round4(1.0 / hhi)),
        },
        participation: participation(buckets, tally.total_ballots, eligible),
        results,
        tallied_at: tally.tallied_at,
        generated_at: now,
    }
}

fn outcome(results: &[OptionResult], valid: u64) -> Outcome {
    let first = results.first().filter(|_| valid > 0);
    let tied: Vec<String> = match first {
        Some(top) => results
            .iter()
            .filter(|r| r.votes == top.votes)
            .map(|r| r.option.clone())
            .collect(),
        None => Vec::new(),
    };
    let tie = tied.len() > 1;
    let winner = first.filter(|_| !tie);
    let runner_up = results.get(1).filter(|_| valid > 0);
    Outcome {
        winner: winner.map(|w| w.option.clone()),
        winner_votes: winner.map(|w| w.votes),
        tie,
        tied_options: if tie { tied } else { Vec::new() },
        runner_up: runner_up.filter(|_| !tie).map(|r| r.option.clone()),
        margin_votes: first.zip(runner_up).map(|(a, b)| a.votes - b.votes),
        margin_points: first
            .zip(runner_up)
            .map(|(a, b)| round4((a.votes - b.votes) as f64 * 100.0 / valid as f64)),
        blank_won: winner.is_some_and(|w| w.is_blank),
    }
}

fn participation(
    buckets: &[HourBucket],
    total_ballots: u64,
    eligible: Option<u64>,
) -> Participation {
    let mut sorted: Vec<HourBucket> = buckets.iter().copied().filter(|b| b.ballots > 0).collect();
    sorted.sort_by_key(|b| b.start);

    let mut by_hour = vec![0u64; 24];
    let mut cumulative = 0u64;
    let timeline: Vec<TimelinePoint> = sorted
        .iter()
        .map(|b| {
            by_hour[b.start.hour() as usize] += b.ballots;
            cumulative += b.ballots;
            TimelinePoint {
                start: b.start,
                ballots: b.ballots,
                cumulative,
                cumulative_turnout: eligible.and_then(|e| ratio(cumulative, e)),
            }
        })
        .collect();

    // El primer máximo gana en caso de empate.
    let peak = timeline
        .iter()
        .fold(None::<&TimelinePoint>, |best, p| match best {
            Some(b) if b.ballots >= p.ballots => Some(b),
            _ => Some(p),
        });

    Participation {
        bucket: "hour".into(),
        recorded_ballots: cumulative,
        matches_tally: cumulative == total_ballots,
        first_ballot_at: timeline.first().map(|p| p.start),
        last_ballot_at: timeline.last().map(|p| p.start + Duration::hours(1)),
        peak: peak.cloned(),
        by_hour_of_day_utc: by_hour,
        timeline,
    }
}

/// Participación en tiempo real (plan P2, SR-04), calculada con los `votes.cast`.
/// Nunca incluye resultados por opción: esos solo existen tras `tally.completed`.
#[derive(Debug, Clone, Serialize)]
pub struct LiveParticipation {
    pub election_id: String,
    pub name: Option<String>,
    pub status: String,
    pub opens_at: Option<DateTime<Utc>>,
    pub closes_at: Option<DateTime<Utc>>,
    pub closed_at: Option<DateTime<Utc>>,
    pub eligible_voters: Option<u64>,
    pub ballots_received: u64,
    pub turnout: Option<f64>,
    pub timeline: Vec<TimelinePoint>,
    pub as_of: DateTime<Utc>,
}

/// `status`: `final` (hay conteo), `closed` (cerró, conteo pendiente), `open`,
/// `scheduled` (aún no abre) o `unknown` (votos sin `election.created`).
///
/// Mientras la urna no ha cerrado, la línea de tiempo omite la hora en curso:
/// un contador que sube voto a voto permitiría correlacionar cada papeleta con
/// la emisión de su credencial (plan P2, riesgo 10.4).
pub fn live_participation(
    election_id: &str,
    meta: Option<&ElectionMeta>,
    buckets: &[HourBucket],
    has_tally: bool,
    now: DateTime<Utc>,
) -> LiveParticipation {
    let eligible = meta.and_then(|m| m.eligible_voters).filter(|&n| n > 0);
    let closed =
        meta.is_some_and(|m| m.closed_at.is_some() || m.closes_at.is_some_and(|c| c <= now));
    let status = match meta {
        _ if has_tally => "final",
        _ if closed => "closed",
        Some(m) if m.opens_at.is_some_and(|o| o > now) => "scheduled",
        Some(_) => "open",
        None => "unknown",
    };
    let current_hour = hour_start(now);
    let visible: Vec<HourBucket> = buckets
        .iter()
        .copied()
        .filter(|b| has_tally || closed || b.start < current_hour)
        .collect();
    let ballots_received = buckets.iter().map(|b| b.ballots).sum();
    LiveParticipation {
        election_id: election_id.to_owned(),
        name: meta.and_then(|m| m.name.clone()),
        status: status.into(),
        opens_at: meta.and_then(|m| m.opens_at),
        closes_at: meta.and_then(|m| m.closes_at),
        closed_at: meta.and_then(|m| m.closed_at),
        eligible_voters: eligible,
        ballots_received,
        turnout: eligible.and_then(|e| ratio(ballots_received, e)),
        timeline: participation(&visible, ballots_received, eligible).timeline,
        as_of: now,
    }
}

/// Reagrupa la línea de tiempo horaria por día (UTC).
pub fn daily_timeline(hourly: &[TimelinePoint], eligible: Option<u64>) -> Vec<TimelinePoint> {
    let mut days: Vec<TimelinePoint> = Vec::new();
    for point in hourly {
        let day = point
            .start
            .duration_trunc(Duration::days(1))
            .unwrap_or(point.start);
        match days.last_mut() {
            Some(last) if last.start == day => {
                last.ballots += point.ballots;
                last.cumulative = point.cumulative;
                last.cumulative_turnout = point.cumulative_turnout;
            }
            _ => days.push(TimelinePoint {
                start: day,
                ..point.clone()
            }),
        }
    }
    for day in &mut days {
        day.cumulative_turnout = eligible.and_then(|e| ratio(day.cumulative, e));
    }
    days
}

/// Resumen corto de una elección para listados.
#[derive(Debug, Clone, Serialize)]
pub struct ElectionSummary {
    pub election_id: String,
    pub name: Option<String>,
    pub closed_at: Option<DateTime<Utc>>,
    pub total_ballots: u64,
    pub turnout: Option<f64>,
    pub winner: Option<String>,
    pub tie: bool,
    pub margin_points: Option<f64>,
}

impl From<&ElectionReport> for ElectionSummary {
    fn from(r: &ElectionReport) -> Self {
        Self {
            election_id: r.election_id.clone(),
            name: r.name.clone(),
            closed_at: r.schedule.closed_at,
            total_ballots: r.totals.total_ballots,
            turnout: r.rates.turnout,
            winner: r.outcome.winner.clone(),
            tie: r.outcome.tie,
            margin_points: r.outcome.margin_points,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ElectionMetric {
    pub election_id: String,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GlobalSummary {
    pub elections: u64,
    pub total_ballots: u64,
    pub valid_ballots: u64,
    pub invalid_ballots: u64,
    pub eligible_voters: u64,
    pub average_turnout: Option<f64>,
    pub weighted_turnout: Option<f64>,
    pub average_invalid_rate: Option<f64>,
    pub ties: u64,
    pub highest_turnout: Option<ElectionMetric>,
    pub lowest_turnout: Option<ElectionMetric>,
    pub closest_race: Option<ElectionMetric>,
    pub largest_election: Option<ElectionMetric>,
    pub generated_at: DateTime<Utc>,
}

pub fn summarize(reports: &[ElectionReport], now: DateTime<Utc>) -> GlobalSummary {
    let with_turnout: Vec<(&ElectionReport, f64)> = reports
        .iter()
        .filter_map(|r| r.rates.turnout.map(|t| (r, t)))
        .collect();
    let metric = |r: &ElectionReport, value: f64| ElectionMetric {
        election_id: r.election_id.clone(),
        value,
    };
    let mean = |values: &[f64]| {
        (!values.is_empty()).then(|| round4(values.iter().sum::<f64>() / values.len() as f64))
    };

    let censused_ballots: u64 = with_turnout
        .iter()
        .map(|(r, _)| r.totals.total_ballots)
        .sum();
    let eligible: u64 = reports
        .iter()
        .filter_map(|r| r.totals.eligible_voters)
        .sum();
    let invalid_rates: Vec<f64> = reports
        .iter()
        .filter(|r| r.totals.total_ballots > 0)
        .map(|r| r.rates.invalid)
        .collect();
    let turnouts: Vec<f64> = with_turnout.iter().map(|(_, t)| *t).collect();

    GlobalSummary {
        elections: reports.len() as u64,
        total_ballots: reports.iter().map(|r| r.totals.total_ballots).sum(),
        valid_ballots: reports.iter().map(|r| r.totals.valid_ballots).sum(),
        invalid_ballots: reports.iter().map(|r| r.totals.invalid_ballots).sum(),
        eligible_voters: eligible,
        average_turnout: mean(&turnouts),
        weighted_turnout: ratio(censused_ballots, eligible),
        average_invalid_rate: mean(&invalid_rates),
        ties: reports.iter().filter(|r| r.outcome.tie).count() as u64,
        highest_turnout: with_turnout
            .iter()
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(r, t)| metric(r, *t)),
        lowest_turnout: with_turnout
            .iter()
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(r, t)| metric(r, *t)),
        closest_race: reports
            .iter()
            .filter_map(|r| r.outcome.margin_points.map(|m| (r, m)))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(r, m)| metric(r, m)),
        largest_election: reports
            .iter()
            .max_by_key(|r| r.totals.total_ballots)
            .map(|r| metric(r, r.totals.total_ballots as f64)),
        generated_at: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(h: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 20, h, 0, 0).unwrap()
    }

    fn meta() -> ElectionMeta {
        ElectionMeta {
            election_id: "e1".into(),
            name: Some("Consejo".into()),
            options: vec!["a".into(), "b".into(), "blanco".into()],
            blank_option: Some("blanco".into()),
            opens_at: Some(at(8)),
            closes_at: Some(at(16)),
            closed_at: Some(at(16)),
            eligible_voters: Some(20),
        }
    }

    fn tally(a: u64, b: u64, blank: u64, invalid: u64) -> Tally {
        Tally {
            total_ballots: a + b + blank + invalid,
            invalid_ballots: invalid,
            results: vec![
                OptionVotes {
                    option: "a".into(),
                    votes: a,
                },
                OptionVotes {
                    option: "b".into(),
                    votes: b,
                },
                OptionVotes {
                    option: "blanco".into(),
                    votes: blank,
                },
            ],
            tallied_at: at(16),
        }
    }

    #[test]
    fn computes_shares_turnout_and_margin() {
        let buckets = [
            HourBucket {
                start: at(9),
                ballots: 3,
            },
            HourBucket {
                start: at(8),
                ballots: 2,
            },
            HourBucket {
                start: at(12),
                ballots: 5,
            },
        ];
        let report = build_report(&meta(), &tally(5, 3, 1, 1), &buckets, at(17));

        assert_eq!(report.totals.valid_ballots, 9);
        assert_eq!(report.totals.blank_ballots, Some(1));
        assert_eq!(report.totals.abstentions, Some(10));
        assert_eq!(report.rates.turnout, Some(0.5));
        assert_eq!(report.rates.invalid, 0.1);
        assert_eq!(report.results[0].option, "a");
        assert_eq!(report.results[0].share_of_valid, 0.5556);
        assert_eq!(report.outcome.winner.as_deref(), Some("a"));
        assert_eq!(report.outcome.runner_up.as_deref(), Some("b"));
        assert_eq!(report.outcome.margin_votes, Some(2));
        assert_eq!(report.outcome.margin_points, Some(22.2222));
        assert_eq!(report.schedule.duration_hours, Some(8.0));

        let p = &report.participation;
        assert!(p.matches_tally);
        assert_eq!(p.timeline[0].start, at(8));
        assert_eq!(p.timeline[2].cumulative, 10);
        assert_eq!(p.peak.as_ref().unwrap().start, at(12));
        assert_eq!(p.by_hour_of_day_utc[12], 5);
        assert_eq!(p.last_ballot_at, Some(at(13)));
    }

    #[test]
    fn detects_ties_and_shares_rank() {
        let report = build_report(&meta(), &tally(4, 4, 0, 0), &[], at(17));
        assert!(report.outcome.tie);
        assert_eq!(report.outcome.winner, None);
        assert_eq!(report.outcome.tied_options, vec!["a", "b"]);
        assert_eq!(report.outcome.margin_votes, Some(0));
        assert_eq!(report.results[1].rank, 1);
        assert_eq!(report.results[2].rank, 3);
        assert!(!report.participation.matches_tally);
    }

    #[test]
    fn handles_empty_election_and_unknown_census() {
        let mut m = meta();
        m.eligible_voters = None;
        let report = build_report(&m, &tally(0, 0, 0, 0), &[], at(17));
        assert_eq!(report.outcome.winner, None);
        assert!(!report.outcome.tie);
        assert_eq!(report.rates.turnout, None);
        assert_eq!(report.competitiveness.effective_number_of_options, None);
        assert_eq!(report.participation.peak, None);
    }

    #[test]
    fn blank_vote_can_win() {
        let report = build_report(&meta(), &tally(1, 1, 5, 0), &[], at(17));
        assert!(report.outcome.blank_won);
        assert_eq!(report.rates.blank, Some(0.7143));
    }

    #[test]
    fn rebuckets_daily_and_summarizes() {
        let buckets = [
            HourBucket {
                start: at(8),
                ballots: 2,
            },
            HourBucket {
                start: at(15),
                ballots: 8,
            },
        ];
        let report = build_report(&meta(), &tally(5, 3, 1, 1), &buckets, at(17));
        let daily = daily_timeline(&report.participation.timeline, Some(20));
        assert_eq!(daily.len(), 1);
        assert_eq!(daily[0].ballots, 10);
        assert_eq!(daily[0].cumulative_turnout, Some(0.5));

        let mut other = build_report(&meta(), &tally(1, 1, 0, 0), &[], at(17));
        other.election_id = "e2".into();
        let summary = summarize(&[report, other], at(18));
        assert_eq!(summary.elections, 2);
        assert_eq!(summary.total_ballots, 12);
        assert_eq!(summary.ties, 1);
        assert_eq!(summary.weighted_turnout, Some(0.3));
        assert_eq!(summary.highest_turnout.unwrap().election_id, "e1");
        assert_eq!(summary.closest_race.unwrap().election_id, "e2");
    }

    #[test]
    fn live_participation_hides_current_hour_while_open() {
        let mut m = meta();
        m.closed_at = None;
        let buckets = [
            HourBucket {
                start: at(8),
                ballots: 2,
            },
            HourBucket {
                start: at(9),
                ballots: 3,
            },
            HourBucket {
                start: at(10),
                ballots: 1,
            },
        ];
        let now = at(10) + Duration::minutes(30);
        let live = live_participation("e1", Some(&m), &buckets, false, now);
        assert_eq!(live.status, "open");
        assert_eq!(live.ballots_received, 6);
        assert_eq!(live.turnout, Some(0.3));
        assert_eq!(live.timeline.len(), 2);
        assert_eq!(live.timeline[1].cumulative, 5);

        let closed = live_participation("e1", Some(&meta()), &buckets, false, now);
        assert_eq!(closed.status, "closed");
        assert_eq!(closed.timeline.len(), 3);

        assert_eq!(
            live_participation("e1", Some(&m), &[], false, at(7)).status,
            "scheduled"
        );
        assert_eq!(
            live_participation("e1", None, &buckets, false, now).status,
            "unknown"
        );
        assert_eq!(
            live_participation("e1", Some(&m), &buckets, true, now).status,
            "final"
        );
    }
}
