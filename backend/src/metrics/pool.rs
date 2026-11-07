use diesel::r2d2::{
    event::{CheckoutEvent, HandleEvent, TimeoutEvent},
    ManageConnection, Pool,
};
use prometheus::{
    core::{Collector, Desc},
    proto::MetricFamily,
    register_histogram_with_registry, register_int_counter_with_registry, Histogram, IntCounter,
    IntGauge, Registry,
};

/// Pool-level checkout events, installed on the r2d2 builder before construction.
#[derive(Debug)]
pub struct PoolEvents {
    duration: Histogram,
    timeouts: IntCounter,
}

impl PoolEvents {
    pub fn new(registry: &Registry) -> Self {
        let duration = register_histogram_with_registry!(
            "db_pool_checkout_duration_seconds",
            "Elapsed time to successfully check out a pool connection in seconds",
            vec![
                0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0,
                10.0, 30.0
            ],
            registry
        )
        .expect("db_pool_checkout_duration_seconds registration should succeed");
        let timeouts = register_int_counter_with_registry!(
            "db_pool_checkout_timeouts_total",
            "Pool checkout attempts that timed out",
            registry
        )
        .expect("db_pool_checkout_timeouts_total registration should succeed");
        Self { duration, timeouts }
    }
}

impl HandleEvent for PoolEvents {
    fn handle_checkout(&self, event: CheckoutEvent) {
        self.duration.observe(event.duration().as_secs_f64());
    }

    fn handle_timeout(&self, _: TimeoutEvent) {
        // r2d2 does not expose the elapsed wait for failed checkout attempts.
        self.timeouts.inc();
    }
}

const GAUGES: [(&str, &str); 3] = [
    (
        "db_pool_connections_active",
        "Established pool connections not currently idle, including connections being validated",
    ),
    (
        "db_pool_connections_idle",
        "Established idle pool connections",
    ),
    (
        "db_pool_connections_max",
        "Configured maximum pool connections",
    ),
];

/// Registers a scrape-time snapshot of the pool. The registry retains a pool clone;
/// the event handler does not retain the registry or the pool, avoiding a cycle.
pub fn register_pool_state<M: ManageConnection>(registry: &Registry, pool: Pool<M>) {
    let gauges = GAUGES.map(|(name, help)| {
        IntGauge::new(name, help).expect("pool gauge description should be valid")
    });
    registry
        .register(Box::new(PoolState { pool, gauges }))
        .expect("pool state registration should succeed");
}

struct PoolState<M: ManageConnection> {
    pool: Pool<M>,
    // Descriptors are retained for registration; samples are built per scrape so
    // concurrent scrapes cannot overwrite one another's snapshot.
    gauges: [IntGauge; 3],
}

impl<M: ManageConnection> Collector for PoolState<M> {
    fn desc(&self) -> Vec<&Desc> {
        self.gauges.iter().flat_map(Collector::desc).collect()
    }

    fn collect(&self) -> Vec<MetricFamily> {
        let state = self.pool.state();
        let values = [
            state.connections - state.idle_connections,
            state.idle_connections,
            self.pool.max_size(),
        ];
        self.gauges
            .iter()
            .zip(values)
            .flat_map(|(gauge, value)| {
                let mut families = gauge.collect();
                families[0].mut_metric()[0]
                    .mut_gauge()
                    .set_value(f64::from(value));
                families
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io, time::Duration};

    struct TestManager;

    impl ManageConnection for TestManager {
        type Connection = ();
        type Error = io::Error;

        fn connect(&self) -> Result<Self::Connection, Self::Error> {
            Ok(())
        }

        fn is_valid(&self, _: &mut Self::Connection) -> Result<(), Self::Error> {
            Ok(())
        }

        fn has_broken(&self, _: &mut Self::Connection) -> bool {
            false
        }
    }

    #[test]
    fn records_checkout_outcomes_and_scrapes_pool_state() {
        let registry = Registry::new();
        let pool = Pool::builder()
            .max_size(1)
            .event_handler(Box::new(PoolEvents::new(&registry)))
            .build(TestManager)
            .expect("test pool should initialize");
        register_pool_state(&registry, pool.clone());

        let initial = crate::metrics::encode(&registry).unwrap();
        assert!(initial.contains("db_pool_connections_active 0"));
        assert!(initial.contains("db_pool_connections_idle 1"));
        assert!(initial.contains("db_pool_connections_max 1"));

        let connection = pool.get().unwrap();
        assert!(pool.get_timeout(Duration::from_millis(1)).is_err());
        let busy = crate::metrics::encode(&registry).unwrap();
        assert!(busy.contains("db_pool_connections_active 1"));
        assert!(busy.contains("db_pool_connections_idle 0"));
        assert!(busy.contains("db_pool_checkout_duration_seconds_count 1"));
        assert!(busy.contains("db_pool_checkout_timeouts_total 1"));
        drop(connection);

        let returned = crate::metrics::encode(&registry).unwrap();
        assert!(returned.contains("db_pool_connections_active 0"));
        assert!(returned.contains("db_pool_connections_idle 1"));
    }
}
