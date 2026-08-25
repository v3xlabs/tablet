use crate::units::to_ms;

pub struct Timer {
    pub started_ms: u64,
}

impl Timer {
    pub fn from_seconds(seconds: u64) -> Timer {
        Timer { started_ms: to_ms(seconds) }
    }

    pub fn elapsed(&self, now_ms: u64) -> u64 {
        now_ms - self.started_ms
    }
}
