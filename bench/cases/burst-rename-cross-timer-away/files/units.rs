pub const MILLIS_PER_SEC: u64 = 1_000;

pub fn to_millis(seconds: u64) -> u64 {
    seconds * MILLIS_PER_SEC
}

pub fn to_seconds(millis: u64) -> u64 {
    millis / MILLIS_PER_SEC
}
