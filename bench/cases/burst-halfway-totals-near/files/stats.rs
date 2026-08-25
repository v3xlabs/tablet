pub struct Totals {
    pub views: i64,
    pub clicks: i64,
    pub likes: i32,
    pub shares: i32,
}

impl Totals {
    pub fn zero() -> Totals {
        Totals { views: 0, clicks: 0, likes: 0, shares: 0 }
    }

    pub fn merge(&mut self, other: &Totals) {
        self.views += other.views;
        self.clicks += other.clicks;
        self.likes += other.likes;
        self.shares += other.shares;
    }
}
